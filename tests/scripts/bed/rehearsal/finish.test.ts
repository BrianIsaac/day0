import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UndoLedger } from '../../../../scripts/lib/cleanup';
import { LinearClient } from '../../../../scripts/lib/linear';
import { CeilingPassed, finish, sleepUntilCeiling } from '../../../../scripts/bed/rehearsal/finish';
import { parseRehearsalArguments } from '../../../../scripts/bed/rehearsal/options';
import { RunDirectory } from '../../../../scripts/bed/rehearsal/output';
import type { RunResult } from '../../../../scripts/bed/rehearsal/process';
import { runPhases, type RehearsalContext } from '../../../../scripts/bed/rehearsal/run';

const created: string[] = [];

afterEach((): void => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A run whose bed is up in a real temporary clone, torn down by the given `docker` answer. */
function context(down: RunResult): { ctx: RehearsalContext; clone: string; lines: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'rehearsal-finish-'));
  created.push(root);
  const clone = join(root, 'clone');
  mkdirSync(clone);
  const out = new RunDirectory(join(root, 'run'));
  out.prepare();
  const lines: string[] = [];
  const ctx: RehearsalContext = {
    options: parseRehearsalArguments(['--secrets', '/s']),
    secrets: { linearApiKey: 'lin_api_test' },
    primary: root,
    source: root,
    record: {
      startedAt: '2026-09-27T10:00:00Z',
      commit: '',
      ref: 'HEAD',
      project: 'day0-rehearsal-abc123',
      clone,
      ports: { backend: 0, site: 0, dashboard: 0, app: 0 },
      dryRun: false,
      status: 'passed',
      phases: [],
      checks: [],
      writes: [],
      cleanup: [],
      notes: [],
    },
    out,
    log: (line: string): void => {
      lines.push(line);
    },
    runner: (): RunResult => down,
    startServer: () => ({ pid: 1, output: () => '', stop: async () => undefined }),
    fetchImpl: fetch,
    now: () => 0,
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
    sourceEnv: {},
    state: {
      shots: 0,
      bed: {
        clone,
        project: 'day0-rehearsal-abc123',
        ports: { backend: 1, site: 2, dashboard: 3, app: 4 },
        env: {},
      },
    },
  };
  return { ctx, clone, lines };
}

describe('the end of a rehearsal', (): void => {
  it('exits non-zero and keeps the clone when the bed could not be taken down', async (): Promise<void> => {
    const { ctx, clone } = context({ status: 1, stdout: '', stderr: 'daemon gone' });
    await expect(finish(ctx, 0)).resolves.toBe(1);
    expect(existsSync(clone)).toBe(true);
    expect(ctx.record.notes.join('\n')).toContain(
      'docker compose -p day0-rehearsal-abc123 down -v',
    );
  });

  it("removes the clone and keeps the phases' exit code when the teardown worked", async (): Promise<void> => {
    const { ctx, clone } = context({ status: 0, stdout: '', stderr: '' });
    await expect(finish(ctx, 0)).resolves.toBe(0);
    expect(existsSync(clone)).toBe(false);
  });

  it('stops the running phase at its next wait once the ceiling passes, so the clean-up runs after it and not beside it', async (): Promise<void> => {
    const { ctx } = context({ status: 0, stdout: '', stderr: '' });
    let clock = 0;
    const slept: number[] = [];
    const sleep = sleepUntilCeiling(
      async (ms: number): Promise<void> => {
        slept.push(ms);
        clock += ms;
      },
      () => clock,
      5_000,
      40,
    );
    const writes: number[] = [];
    await runPhases({ ...ctx, sleep }, [
      {
        name: 'approve-plan',
        writes: [],
        run: async (): Promise<void> => {
          for (;;) {
            writes.push(clock);
            await sleep(3_000);
          }
        },
      },
    ]);
    expect(slept).toEqual([3_000, 2_000]);
    expect(writes).toEqual([0, 3_000, 5_000]);
    expect(ctx.record.status).toBe('failed');
    expect(ctx.record.stoppedAt).toBe('approve-plan: the 40-minute ceiling passed');
    await expect(sleep(1)).rejects.toBeInstanceOf(CeilingPassed);
  });
});
