/** @vitest-environment node */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { McpClientLike, McpClientOptions } from '../../src/surfaces/mcp';
import type { AppliedAction } from '../../src/surfaces/types';
import type { ExecutionPlan, MockAction } from '../../src/work/types';
import { TileDriver } from '../fixtures/browser-phase-split-2026-09-16';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * Finding M of the second full run (19 September): four work items of one
 * employee each ran the whole sign-in, fill, Save sequence on the Looker tile
 * within 92 seconds (audit lines 21:43:27, 21:43:33, 21:44:11, 21:44:59 UTC).
 * A page field has no intake row, so no claim reached it and "one work item
 * writes an external item" did not hold there.
 *
 * The items, their declared obligations and their action lists are the run's
 * own rows: REVOPS-27 (the ticket whose job the refresh is), the
 * `#revops-asks` ask and REVOPS-28 (the audit note, whose tile step is a
 * conditional write). The documentation is the tracked runbook the bed syncs.
 * The executor double ignores the held-items block, as the run's model did
 * for FIN-1, so the apply guard is what is tested; the prompt is read too.
 */

const SLUG = 'looker-pipeline-tile';
const RUNBOOK = readFileSync(join(process.cwd(), 'bed/company/folder/revops/runbooks/how-to-refresh-the-tile.md'), 'utf8');

const recorded = vi.hoisted(() => ({
  driver: undefined as undefined | import('../fixtures/browser-phase-split-2026-09-16').TileDriver,
  prompts: new Map<string, string>(),
}));

const tile = (tool: string, toolArgs: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call',
  args: { surface: SLUG, tool, toolArgsJson: JSON.stringify(toolArgs) },
});
/** The sequence every one of the four items emitted, from the `#revops-asks` ask's row. */
const TILE_SEQUENCE: MockAction[] = [
  tile('browser_navigate', { url: 'http://looker-tile:8080/' }),
  tile('browser_fill_form', { fields: [{ name: 'Username', value: 'revops' }, { name: 'Password', value: '{{secret}}' }] }),
  tile('browser_click', { element: 'Sign in' }),
  tile('browser_fill_form', { fields: [{ name: 'Pipeline coverage', value: '74%' }] }),
  tile('browser_click', { element: 'Save' }),
  tile('browser_snapshot', {}),
];

vi.mock('../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async <T>(args: { agent: { name: string }; user: string; schema: { parse(value: unknown): unknown } }): Promise<T> => {
    if (args.agent.name.endsWith('-dependent')) {
      return args.schema.parse({
        draft: 'The tile was read back in the same session.', notes: '', actions: [], procedureTrails: [],
        planStepOutcomes: [
          { step: 1, status: 'satisfied', basis: 'ledger', evidence: 'ledger rows 0 to 4: the documented sequence ran on the tile' },
          { step: 2, status: 'satisfied', basis: 'ledger', evidence: 'ledger row 5: the snapshot with the visible figure' },
        ],
      }) as T;
    }
    if (!args.agent.name.endsWith('-initial')) throw new Error(`unscripted agent ${args.agent.name}`);
    recorded.prompts.set(args.agent.name, args.user);
    return args.schema.parse({
      draft: 'Signing in to the tile, entering 74%, saving and reading it back.',
      notes: '',
      needsDependentPhase: false,
      deferredActions: [],
      actions: TILE_SEQUENCE,
      procedureTrails: [],
    }) as T;
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (_ctx: unknown, credentialId: string): Promise<string> => `plain-${credentialId}`,
}));

vi.mock('../../src/surfaces/mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/surfaces/mcp')>();
  return {
    ...original,
    createMastraMcpClient: (options: McpClientOptions): McpClientLike => {
      if (!recorded.driver) throw new Error('no driver double for this test');
      return recorded.driver.client(options.serverName);
    },
  };
});

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };

const planWith = (tileStep: 'write' | 'conditional-write'): ExecutionPlan => ({
  summary: 'Work the Looker pipeline tile per the runbook and read it back.',
  steps: ['Run the documented sequence on looker-pipeline-tile in one browser session.', 'Read back the snapshot and quote the figure and the audit line.'],
  expectedOutputType: 'message',
  riskNotes: '',
  reversibility: 'Re-enter the previous figure.',
  estimatedMinutes: 5,
  obligations: {
    steps: [
      { kind: tileStep, reads: tileStep === 'write' ? [] : [SLUG], writes: [SLUG] },
      { kind: 'read', reads: [SLUG], writes: [] },
    ],
    transition: 'none',
    transitionStep: null,
    basis: 'judgement',
  },
});

interface Seeded { agentId: Id<'agents'>; revops27: Id<'workItems'>; ask: Id<'workItems'>; revops28: Id<'workItems'> }

async function seed(harness: Harness): Promise<Seeded> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local', name: 'Priya', userId: 'owner', state: 'active', autonomousActions: true, createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId, version: 'v1', approved: true, approvedAt: 1, createdAt: 1,
      body: {
        proposedFunction: 'Own routine revenue operations work for the RevOps team.',
        proposedBoundaries: { willDo: ['Keep the Looker pipeline tile at the approved figure.'], willNotDo: [], escalationTriggers: [] },
        approvalChain: { boss: 'boss@day0.local' },
      },
    });
    await ctx.db.insert('mockDocs', {
      agentId, slug: 'revops-runbooks-how-to-refresh-the-tile-md', title: 'How to refresh the Looker pipeline tile',
      category: 'how-to-guide', body: RUNBOOK, updatedAt: 1,
    } as never);
    // The three shaped skills the run registered for these items.
    for (const [surfaceClass, operation, targetSurface] of [
      ['chat', 'thread-reply', 'slack'],
      ['analytics', 'refresh-value', SLUG],
      ['kanban', 'comment-and-close', 'linear'],
    ] as const) {
      await ctx.db.insert('skills', {
        agentId, name: `${surfaceClass}-${operation}`, surfaceClass, operation,
        description: 'Do the work the item names on its connected surfaces.',
        body: `# ${surfaceClass}-${operation}\nOn ${SLUG}: browser_navigate, browser_fill_form the login with {{secret}}, browser_click Sign in, browser_fill_form Pipeline coverage, browser_click Save, browser_snapshot.`,
        requiredScopes: ['boss:message', `${SLUG}:read`, `${SLUG}:write`], targetSurface,
        sourceType: 'agent-authored', state: 'registered', createdAt: 1, registeredAt: 1,
      } as never);
    }
    for (const scope of ['boss:message', 'slack:read', 'slack:write', 'linear:read', 'linear:write', 'docs:read', `${SLUG}:read`, `${SLUG}:write`]) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    await ctx.db.insert('surfaces', {
      agentId, slug: SLUG, displayName: 'Looker pipeline tile', class: 'analytics', verdict: 'connected',
      endpoint: 'http://looker-tile:8080/', path: 'browser-driven',
      toolAllowlist: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form'],
      toolArguments: [
        { arguments: ['url'], tool: 'browser_navigate' },
        { arguments: ['boxes', 'depth', 'filename', 'target'], tool: 'browser_snapshot' },
        { arguments: ['button', 'doubleClick', 'element', 'modifiers', 'target'], tool: 'browser_click' },
        { arguments: ['element', 'slowly', 'submit', 'target', 'text'], tool: 'browser_type' },
        { arguments: ['fields'], tool: 'browser_fill_form' },
      ],
      credentialId: 'cred-looker', credentialKind: 'value', credentialLanded: true, lastVerifiedAt: Date.now(), whereFound: [], createdAt: 1,
      discoveryEvidence: [{ kind: 'documentation', ref: 'systems/looker-pipeline-tile.md', quote: 'The Looker pipeline tile holds the single pipeline coverage figure', current: true, firstSeenAt: 1, lastSeenAt: 1 }],
    } as never);
    const item = async (fields: Record<string, unknown>): Promise<Id<'workItems'>> =>
      await ctx.db.insert('workItems', {
        agentId, contentRefs: [], state: 'plan-approved', observedAt: 1, createdAt: 1,
        verdict: { decision: 'claim', value: 60, risk: 30, requiredPermissions: ['boss:message'] },
        ...fields,
      } as never);
    const revops27 = await item({
      sourceCategory: 'ticket-queue', sourceSystem: 'linear', externalId: 'REVOPS-27', title: 'Refresh the Looker pipeline tile',
      contentSummary: 'Update the pipeline coverage figure on the Looker pipeline tile to the figure in the Friday standup coverage summary.',
      plan: planWith('write'),
    });
    const ask = await item({
      sourceCategory: 'event-stream', sourceSystem: 'slack', externalId: 'C0BSF04TZ19:1789761481.815889', title: 'Slack mention in #revops-asks',
      contentSummary: '<@U0BTFK6FLNL> can you confirm pipeline coverage for the three Friday standup deals before the Q3 close summary goes out?',
      replyTarget: { channel: 'C0BSF04TZ19', threadTs: '1789761481.815889' }, plan: planWith('write'),
    });
    const revops28 = await item({
      sourceCategory: 'ticket-queue', sourceSystem: 'linear', externalId: 'REVOPS-28', title: 'Add the Q3 close-summary audit note',
      contentSummary: 'Summarise the Q3 close checks as a comment on this ticket, then move it to Done after manager approval.',
      plan: planWith('conditional-write'),
    });
    return { agentId, revops27, ask, revops28 };
  });
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}
const ledger = (row: Doc<'workItems'>): AppliedAction[] => ((row.output ?? {}) as { applied?: AppliedAction[] }).applied ?? [];
const saves = (): number => recorded.driver!.calls.filter((call) => call.tool === 'browser_click' && call.args.element === 'Save').length;
const fieldFills = (): number =>
  recorded.driver!.calls.filter((call) => call.tool === 'browser_fill_form' && JSON.stringify(call.args).includes('Pipeline coverage')).length;
const promptOf = (externalId: string): string =>
  [...recorded.prompts.entries()].find(([name]) => name.includes(externalId))?.[1] ?? '';

async function author(harness: Harness, workItemId: Id<'workItems'>): Promise<void> {
  await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
}
async function apply(harness: Harness, workItemId: Id<'workItems'>): Promise<void> {
  await harness.action(internal.workActions.applyApprovedActions, { workItemId });
  await harness.finishAllScheduledFunctions(vi.runAllTimers);
}

describe('one work item writes a documented page field (finding M, 19 September second sitting)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    vi.useFakeTimers();
    recorded.driver = new TileDriver('plain-cred-looker');
    recorded.prompts.clear();
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    recorded.driver = undefined;
    restoreSurfaceMode();
  });

  it('two items, one tile, one Save: the other signs in and reads, and its fill and Save are withheld naming the holder', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { revops27, ask } = await seed(t);

    // Both author before either applies, as the run's parallel items did.
    await author(t, revops27);
    await author(t, ask);
    await apply(t, ask);
    await apply(t, revops27);

    expect(saves()).toBe(1);
    expect(fieldFills()).toBe(1);
    expect(recorded.driver!.tile.value).toBe('74%');

    const askRows = ledger(await readItem(t, ask));
    expect(askRows.slice(0, 3).every((row) => row.ok && !row.held)).toBe(true);
    for (const index of [3, 4]) {
      expect(askRows[index]).toMatchObject({ ok: true, held: true });
      expect(askRows[index]!.authority).toBeUndefined();
      expect(askRows[index]!.reason).toContain(`withheld for another work item's claim: the page field "pipeline coverage" on ${SLUG} is held by this employee's work item "Refresh the Looker pipeline tile"`);
    }
    // It still read the tile, in its own signed-in session.
    expect(askRows[5]).toMatchObject({ ok: true });
    expect(askRows[5]!.held).toBeUndefined();
    expect(askRows[5]!.effect).toContain('visible figure');
    expect((await readItem(t, ask)).state).toBe('completed');

    const holderRows = ledger(await readItem(t, revops27));
    expect(holderRows.every((row) => row.ok && !row.held)).toBe(true);

    // The ask was told before it authored; the holder was told nothing about its own field.
    expect(promptOf('c0bsf04tz19')).toContain(`${SLUG} · page field "Pipeline coverage" · this employee · "Refresh the Looker pipeline tile"`);
    expect(promptOf('c0bsf04tz19')).toContain('A page field listed here is filled and saved by its holder alone');
    expect(promptOf('revops-27')).not.toContain('page field');
  }, 30_000);

  it('an audit item that must read after the refresh still reads, takes no claim for its conditional write, and does not Save again', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { revops27, revops28 } = await seed(t);

    // The audit item runs first and alone: its step writes only if the read says so, so it holds nothing.
    await author(t, revops27);
    await apply(t, revops27);
    expect(saves()).toBe(1);

    await author(t, revops28);
    await apply(t, revops28);

    expect(saves()).toBe(1);
    const rows = ledger(await readItem(t, revops28));
    expect(rows[3]).toMatchObject({ ok: true, held: true });
    expect(rows[4]).toMatchObject({ ok: true, held: true });
    expect(rows[4]!.reason).toContain('(completed)');
    expect(rows[5]!.effect).toContain('visible figure 74%');
    expect(rows[5]!.effect).toContain('Last updated by revops at');

    const claims = await t.run(async (ctx) => await ctx.db.query('externalClaims').collect());
    const fields = claims.filter((claim) => claim.writeTarget !== undefined);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      key: 'http://looker-tile:8080|pipeline coverage', workItemId: revops27,
      writeTarget: { surface: SLUG, field: 'Pipeline coverage' },
    });
    expect(fields[0]!.settledAt).toBeTypeOf('number');
    expect(fields[0]!.releasedAt).toBeUndefined();
  }, 30_000);

  it('gives way to work raised after the holder finished, and still holds against the work that ran beside it', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { agentId, revops27, ask } = await seed(t);
    await author(t, revops27);
    await apply(t, revops27);
    expect(saves()).toBe(1);

    // A ticket raised after the refresh finished is new work on the same field
    // (an hour on, inside the surface's verification window).
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    const later = await t.run(async (ctx) => {
      const old = await ctx.db.get(revops27);
      return await ctx.db.insert('workItems', {
        agentId, sourceCategory: 'ticket-queue', sourceSystem: 'linear', externalId: 'REVOPS-41', title: 'Refresh the Looker pipeline tile',
        contentSummary: 'Update the pipeline coverage figure on the Looker pipeline tile to the corrected standup figure.', contentRefs: [], state: 'plan-approved',
        plan: old!.plan, verdict: old!.verdict, observedAt: Date.now(), createdAt: Date.now(),
      } as never);
    });
    await author(t, later);
    await apply(t, later);
    expect(saves()).toBe(2);
    expect(ledger(await readItem(t, later)).every((row) => row.ok && !row.held)).toBe(true);

    // The ask that existed beside the first holder is still not the one to write it.
    await author(t, ask);
    await apply(t, ask);
    expect(saves()).toBe(2);

    const claims = await t.run(async (ctx) => await ctx.db.query('externalClaims').collect());
    const live = claims.filter((claim) => claim.writeTarget !== undefined && claim.releasedAt === undefined);
    expect(live.map((claim) => claim.workItemId)).toEqual([later]);
  }, 30_000);

  it('holds across employees whose cards name the dashboard differently: the key is the origin and the field', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { revops27 } = await seed(t);
    const colleagueItem = await t.run(async (ctx) => {
      const holder = await ctx.db.get(revops27);
      const surface = await ctx.db.query('surfaces').withIndex('by_agent_slug', (q) => q.eq('agentId', holder!.agentId).eq('slug', SLUG)).first();
      const { _id: _surfaceId, _creationTime: _surfaceCreated, ...card } = surface!;
      const agentId = await ctx.db.insert('agents', { bossEmail: 'boss@day0.local', name: 'Mateo', userId: 'owner', state: 'active', createdAt: 1 });
      await ctx.db.insert('surfaces', { ...card, agentId, slug: 'looker' } as never);
      const { _id: _itemId, _creationTime: _itemCreated, ...item } = holder!;
      return await ctx.db.insert('workItems', { ...item, agentId, externalId: 'FIN-9', title: 'Quote pipeline coverage in the close pack' } as never);
    });

    expect(await t.mutation(internal.work.takeWriteTargetClaims, {
      workItemId: revops27, targets: [{ surfaceSlug: SLUG, field: 'Pipeline coverage' }],
    })).toEqual(['http://looker-tile:8080|pipeline coverage']);
    // The colleague asks for the same field through its own card and is given nothing.
    expect(await t.mutation(internal.work.takeWriteTargetClaims, {
      workItemId: colleagueItem, targets: [{ surfaceSlug: 'looker', field: 'pipeline coverage' }],
    })).toEqual([]);
    expect(await t.query(internal.work.writeClaimHolder, {
      workItemId: colleagueItem, surfaceSlug: 'looker', targets: ['pipeline coverage'],
    })).toMatchObject({ holderName: 'Priya', sameEmployee: false, title: 'Refresh the Looker pipeline tile' });
    // The claim is taken as execution begins, and that is when the colleague's prompt lists it.
    await t.run(async (ctx) => await ctx.db.patch(revops27, { state: 'executing' }));
    expect(await t.query(internal.work.itemsHeldElsewhere, { workItemId: colleagueItem })).toEqual([
      expect.objectContaining({ externalId: 'Pipeline coverage', sourceSystem: SLUG, holderName: 'Priya', sameEmployee: false, pageField: true }),
    ]);
  });

  it('takes nothing in mock mode', async (): Promise<void> => {
    restoreSurfaceMode();
    useSurfaceMode('mock');
    const t = convexTest(contractSchema(), allConvexModules());
    const { revops27 } = await seed(t);
    expect(await t.mutation(internal.work.takeWriteTargetClaims, {
      workItemId: revops27, targets: [{ surfaceSlug: SLUG, field: 'Pipeline coverage' }],
    })).toEqual([]);
    expect(await t.run(async (ctx) => await ctx.db.query('externalClaims').collect())).toEqual([]);
  });
});
