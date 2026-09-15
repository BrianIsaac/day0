import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UndoLedger } from '../../../scripts/rehearsal/cleanup';
import { LinearClient } from '../../../scripts/rehearsal/linear';
import { parseRehearsalArguments } from '../../../scripts/rehearsal/options';
import { RunDirectory } from '../../../scripts/rehearsal/output';
import type { RunRecord } from '../../../scripts/rehearsal/report';
import {
  BOUNDARY,
  declaredWrites,
  DRY_RUN_NOTE,
  PHASES,
  runPhases,
  type Phase,
  type RehearsalContext,
} from '../../../scripts/rehearsal/run';

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
      'preflight', 'clone', 'env', 'warm-volumes', 'stack', 'app', 'documentation', 'deploy',
      'day-one', 'charter', 'orientation', 'cards', 'assign-ticket', 'intake', 'plan',
      'approve-plan', 'approve-batch', 'approve-closing', 'export',
    ]);
    const boundary = names.indexOf(BOUNDARY);
    for (const phase of PHASES.slice(0, boundary)) expect(phase.writes).toEqual([]);
    expect(PHASES[boundary].writes[0]).toContain('issueUpdate REVOPS-7 assigneeId');
    const writes = declaredWrites();
    expect(writes[0]).toMatch(/^assign-ticket: Linear issueUpdate/);
    expect(writes.some((line) => line.startsWith('approve-closing: Linear save_comment'))).toBe(true);
    expect(writes.some((line) => line.includes('moved to Done'))).toBe(true);
    expect(writes.every((line) => /undone|deleted|moved back|held|restores|repaired|emitted/.test(line))).toBe(true);
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
    { name: 'cards', writes: [], run: async (ctx) => { ctx.state.agentId = 'a1'; } },
    { name: BOUNDARY, writes: ['Linear issueUpdate REVOPS-7 assigneeId (undone at cleanup)'], run: async (ctx) => { ctx.record.writes.push('assigned'); } },
    { name: 'approve-closing', writes: ['Linear save_comment (deleted at cleanup)'], run: async () => undefined },
  ];

  it('stops a dry run at the boundary and lists the writes it did not make, from the same declarations', async (): Promise<void> => {
    const out = directory();
    const ctx = context(['--secrets', 's', '--dry-run'], out);
    await runPhases(ctx, phases);
    expect(ctx.record.status).toBe('dry-run');
    expect(ctx.record.stoppedAt).toBe(`the boundary, before ${BOUNDARY}`);
    expect(ctx.record.phases.map((phase) => `${phase.name}:${phase.status}`)).toEqual([
      'preflight:ok', 'cards:ok', 'assign-ticket:skipped', 'approve-closing:skipped',
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
    ctx.record.checks = ['a', 'b', 'c', 'd', 'e'].map((check) => ({ check, passed: true, detail: '', rows: null }));
    await runPhases(ctx, []);
    expect(ctx.record.status).toBe('passed');
  });

  it('records where a failing phase stopped, keeps the record, and runs nothing after it', async (): Promise<void> => {
    const out = directory();
    const ctx = context(['--secrets', 's'], out);
    let ran = false;
    await runPhases(ctx, [
      phases[0],
      { name: 'stack', writes: [], run: async () => { throw new Error('the backend did not answer'); } },
      { name: 'app', writes: [], run: async () => { ran = true; } },
    ]);
    expect(ran).toBe(false);
    expect(ctx.record.status).toBe('failed');
    expect(ctx.record.stoppedAt).toBe('stack: the backend did not answer');
    expect(ctx.record.phases[1]).toMatchObject({ name: 'stack', status: 'failed', detail: 'the backend did not answer' });
    expect(readFileSync(join(out.path, 'summary.md'), 'utf8')).toContain('Stopped at: stack: the backend did not answer');
  });
});
