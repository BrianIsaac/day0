import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UndoLedger } from '../../../../scripts/lib/cleanup';
import { LinearClient } from '../../../../scripts/lib/linear';
import { parseRehearsalArguments } from '../../../../scripts/bed/rehearsal/options';
import { RunDirectory } from '../../../../scripts/bed/rehearsal/output';
import {
  TILE_SLUG,
  type BackendReader,
  type SurfaceRow,
} from '../../../../scripts/bed/rehearsal/backend';
import type { Dashboard } from '../../../../scripts/bed/rehearsal/driver';
import type { RunRecord } from '../../../../scripts/bed/rehearsal/report';
import {
  BOUNDARY,
  declaredWrites,
  DRY_RUN_NOTE,
  PHASES,
  runPhases,
  type Phase,
  type RehearsalContext,
} from '../../../../scripts/bed/rehearsal/run';

function context(argv: string[], out: RunDirectory): RehearsalContext {
  const record: RunRecord = {
    startedAt: '2026-09-15T10:00:00Z',
    commit: '',
    ref: 'HEAD',
    project: 'day0-rehearsal-abc123',
    clone: '/tmp/day0-rehearsal-abc123',
    ports: { backend: 0, site: 0, dashboard: 0, app: 0 },
    dryRun: argv.includes('--dry-run'),
    status: 'running',
    phases: [],
    checks: [],
    writes: [],
    cleanup: [],
    notes: [],
  };
  let clock = 0;
  return {
    options: parseRehearsalArguments(argv),
    secrets: { linearApiKey: 'lin_api_test' },
    primary: '/home/op/day0',
    source: '/home/op/day0',
    record,
    out,
    log: () => undefined,
    runner: () => ({ status: 0, stdout: '', stderr: '' }),
    startServer: () => ({ pid: 1, output: () => '', stop: async () => undefined }),
    fetchImpl: fetch,
    now: () => (clock += 1000),
    sleep: async () => undefined,
    linear: new LinearClient('lin_api_test', async () => new Response('{}')),
    ledger: new UndoLedger(),
    dockerInventory: () => ({ composeProjects: [], volumes: [], labelledContainers: [] }),
    portIsFree: async () => true,
    openDashboard: async () => {
      throw new Error('no browser in a test');
    },
    connectBackend: async () => {
      throw new Error('no backend in a test');
    },
    primaryProject: 'day0',
    sourceEnv: { OPENAI_API_KEY: 'sk', NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'boss@example.com' },
    state: { shots: 0 },
  };
}

describe('the phase list', (): void => {
  it('runs the bring-up and the onboarding before the boundary and every provider write after it', (): void => {
    const names = PHASES.map((phase: Phase): string => phase.name);
    expect(names).toEqual([
      'preflight',
      'clone',
      'env',
      'warm-volumes',
      'stack',
      'app',
      'documentation',
      'deploy',
      'day-one',
      'charter',
      'orientation',
      'cards',
      'assign-ticket',
      'intake',
      'plan',
      'approve-plan',
      'approve-batch',
      'approve-closing',
      'export',
    ]);
    const boundary = names.indexOf(BOUNDARY);
    for (const phase of PHASES.slice(0, boundary)) expect(phase.writes).toEqual([]);
    expect(PHASES[boundary].writes[0]).toContain('issueUpdate REVOPS-7 assigneeId');
    const writes = declaredWrites();
    expect(writes[0]).toMatch(/^assign-ticket: Linear issueUpdate/);
    expect(writes.some((line) => line.startsWith('approve-closing: Linear save_comment'))).toBe(
      true,
    );
    expect(writes.some((line) => line.includes('moved to Done'))).toBe(true);
    expect(
      writes.every((line) => /undone|deleted|moved back|held|restores|repaired|emitted/.test(line)),
    ).toBe(true);
  });
});

describe('running the phases', (): void => {
  const created: string[] = [];
  afterEach((): void => {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function directory(): RunDirectory {
    const primary = mkdtempSync(join(tmpdir(), 'rehearsal-run-'));
    created.push(primary);
    const out = new RunDirectory(join(primary, 'run'));
    out.prepare();
    return out;
  }

  const phases: Phase[] = [
    { name: 'preflight', writes: [], run: async () => 'ready' },
    {
      name: 'cards',
      writes: [],
      run: async (ctx) => {
        ctx.state.agentId = 'a1';
      },
    },
    {
      name: BOUNDARY,
      writes: ['Linear issueUpdate REVOPS-7 assigneeId (undone at cleanup)'],
      run: async (ctx) => {
        ctx.record.writes.push('assigned');
      },
    },
    {
      name: 'approve-closing',
      writes: ['Linear save_comment (deleted at cleanup)'],
      run: async () => undefined,
    },
  ];

  it('stops a dry run at the boundary and lists the writes it did not make, from the same declarations', async (): Promise<void> => {
    const out = directory();
    const ctx = context(['--secrets', 's', '--dry-run'], out);
    await runPhases(ctx, phases);
    expect(ctx.record.status).toBe('dry-run');
    expect(ctx.record.stoppedAt).toBe(`the boundary, before ${BOUNDARY}`);
    expect(ctx.record.phases.map((phase) => `${phase.name}:${phase.status}`)).toEqual([
      'preflight:ok',
      'cards:ok',
      'assign-ticket:skipped',
      'approve-closing:skipped',
    ]);
    expect(ctx.record.writes).toEqual([
      'assign-ticket: Linear issueUpdate REVOPS-7 assigneeId (undone at cleanup)',
      'approve-closing: Linear save_comment (deleted at cleanup)',
    ]);
    expect(ctx.record.notes).toEqual([DRY_RUN_NOTE]);
    expect(ctx.state.agentId).toBe('a1');
    const summary = readFileSync(join(out.path, 'summary.md'), 'utf8');
    expect(summary).toContain('Dry run: stopped before the first provider write');
    expect(summary).toContain('| preflight | ok | 1.0 s | ready |');
  });

  it('runs every phase live, times each, and passes only with five passing checks', async (): Promise<void> => {
    const out = directory();
    const ctx = context(['--secrets', 's'], out);
    await runPhases(ctx, phases);
    expect(ctx.record.phases.every((phase) => phase.status === 'ok')).toBe(true);
    expect(ctx.record.writes).toEqual(['assigned']);
    expect(ctx.record.status).toBe('failed');
    ctx.record.checks = ['a', 'b', 'c', 'd', 'e'].map((check) => ({
      check,
      passed: true,
      detail: '',
      rows: null,
    }));
    await runPhases(ctx, []);
    expect(ctx.record.status).toBe('passed');
  });

  it('records where a failing phase stopped, keeps the record, and runs nothing after it', async (): Promise<void> => {
    const out = directory();
    const ctx = context(['--secrets', 's'], out);
    let ran = false;
    await runPhases(ctx, [
      phases[0],
      {
        name: 'stack',
        writes: [],
        run: async () => {
          throw new Error('the backend did not answer');
        },
      },
      {
        name: 'app',
        writes: [],
        run: async () => {
          ran = true;
        },
      },
    ]);
    expect(ran).toBe(false);
    expect(ctx.record.status).toBe('failed');
    expect(ctx.record.stoppedAt).toBe('stack: the backend did not answer');
    expect(ctx.record.phases[1]).toMatchObject({
      name: 'stack',
      status: 'failed',
      detail: 'the backend did not answer',
    });
    expect(readFileSync(join(out.path, 'summary.md'), 'utf8')).toContain(
      'Stopped at: stack: the backend did not answer',
    );
  });
});

describe('the cards phase against the split page (M5)', (): void => {
  const created: string[] = [];
  afterEach((): void => {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  /** A card as the backend lists it, and what the fake page does to it. */
  interface FakeCard {
    slug: string;
    verdict: string;
    probeGeneration: number;
    credentialLanded: boolean;
    approvalRefusal?: string;
  }

  /**
   * The page and the backend behind it, as the phase meets them: approving a card runs a probe
   * with no credential (which a Linear key it has not got answers `ungranted`), and landing one
   * runs the probe that connects it.
   */
  function office(cards: FakeCard[]): {
    dashboard: Dashboard;
    backend: BackendReader;
    calls: string[];
  } {
    const calls: string[] = [];
    const bySlug = (slug: string): FakeCard => {
      const card = cards.find((candidate) => candidate.slug === slug);
      if (!card) throw new Error(`no ${slug} card on the page`);
      return card;
    };
    const unused = async (): Promise<never> => {
      throw new Error('not a step of the cards phase');
    };
    const dashboard: Dashboard = {
      unlock: unused,
      linkFolder: unused,
      deploy: unused,
      chooseChat: unused,
      waitForAgentTurn: unused,
      sendReply: unused,
      lastAgentMessage: unused,
      approveCharter: unused,
      approveSkill: unused,
      approvePlan: unused,
      approveAll: unused,
      takeAnyway: unused,
      cancelPlan: unused,
      showTab: unused,
      close: unused,
      openSurfaces: async () => {
        calls.push('open surfaces');
      },
      screenshot: async () => undefined,
      approveCard: async (slug) => {
        const card = bySlug(slug);
        if (card.approvalRefusal) throw new Error(`the ${slug} card cannot be approved`);
        calls.push(`approve ${slug}`);
        card.probeGeneration += 1;
        card.verdict = slug === TILE_SLUG ? 'connected' : 'ungranted';
      },
      landCredential: async (slug) => {
        const card = bySlug(slug);
        if (card.verdict === 'proposed')
          throw new Error(`no credential field on ${slug} before approval`);
        calls.push(`land ${slug}`);
        card.credentialLanded = true;
        card.probeGeneration += 1;
        card.verdict = 'connected';
      },
    };
    const backend = {
      surfaces: async (): Promise<SurfaceRow[]> =>
        cards.map((card) => ({
          _id: card.slug,
          displayName: card.slug,
          class: 'kanban',
          ...card,
        })),
    } as unknown as BackendReader;
    return { dashboard, backend, calls };
  }

  function proposed(slug: string, fields: Partial<FakeCard> = {}): FakeCard {
    return { slug, verdict: 'proposed', probeGeneration: 0, credentialLanded: false, ...fields };
  }

  function cardsPhase(): Phase {
    const phase = PHASES.find((candidate) => candidate.name === 'cards');
    if (!phase) throw new Error('no cards phase');
    return phase;
  }

  function run(dashboard: Dashboard, backend: BackendReader, secrets: RehearsalContext['secrets']) {
    const primary = mkdtempSync(join(tmpdir(), 'rehearsal-cards-'));
    created.push(primary);
    const out = new RunDirectory(join(primary, 'run'));
    out.prepare();
    const ctx = context(['--secrets', 's', '--dry-run'], out);
    ctx.secrets = secrets;
    ctx.state = { shots: 0, dashboard, backend, agentId: 'a1' };
    return cardsPhase().run(ctx);
  }

  it('approves each card before it lands the credential, and judges only the probe after the landing', async (): Promise<void> => {
    const page = office([proposed('linear'), proposed(TILE_SLUG), proposed('slack')]);
    const outcome = await run(page.dashboard, page.backend, {
      linearApiKey: 'lin_api_test',
      slackBotToken: 'xoxb-test',
    });
    expect(page.calls).toEqual([
      'open surfaces',
      'approve linear',
      'land linear',
      `approve ${TILE_SLUG}`,
      'approve slack',
      'land slack',
    ]);
    expect(outcome).toBe(`linear: connected, ${TILE_SLUG}: connected, slack: connected`);
  });

  it('leaves the Slack card unapproved without a token, whatever its approval would say', async (): Promise<void> => {
    const page = office([
      proposed('linear'),
      proposed(TILE_SLUG),
      proposed('slack', { approvalRefusal: 'the manager lookup failed' }),
    ]);
    const outcome = await run(page.dashboard, page.backend, { linearApiKey: 'lin_api_test' });
    expect(page.calls).not.toContain('approve slack');
    expect(outcome).toContain('slack: left unapproved (no token)');
  });

  it('stops on the refusal the listing carries before it presses anything', async (): Promise<void> => {
    const refusal =
      'A documented intake queue changed; reject this card and re-run orientation before approval.';
    const page = office([
      proposed('linear', { approvalRefusal: refusal }),
      proposed(TILE_SLUG),
      proposed('slack'),
    ]);
    await expect(
      run(page.dashboard, page.backend, {
        linearApiKey: 'lin_api_test',
        slackBotToken: 'xoxb-test',
      }),
    ).rejects.toThrow(`the linear card cannot be approved: ${refusal}`);
    expect(page.calls).toEqual(['open surfaces']);
  });
});
