/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { routeSpanModelFetch, SPAN_MODEL_TEST_URL } from '../fixtures/redaction-double';
import { temporaryDirectories } from '../setup/temporary-directories';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/*
 * The documentation sync's own chain under the deployment's pause (wave 12, 12-J item 8; the wave
 * file's 4.3). Its own file: the cron lists sources only in real mode (`listSyncable`), and the
 * mode is set before the modules load, which would leave the sync file's spies on another class.
 */

const temporary = temporaryDirectories();

// The redaction component the sync reaches through DAY0_REDACTOR_URL, answered in-process by the
// global fetch each test starts with, never over a socket: every test here fakes setTimeout, and
// from undici 6.28 (Node 22.23) a request on a pooled socket waits for a zero-delay timer a faked
// clock never fires (about 6 s until the double dropped the socket, 12-N, 5 October 2026).
const redactorFetch = routeSpanModelFetch(globalThis.fetch);

const { schemaChecked } = await vi.hoisted(async () => await import('./fakes/mastra'));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: schemaChecked(() => ({ systems: [] })),
}));

beforeEach((): void => {
  useSurfaceMode('real');
  vi.useFakeTimers();
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('DAY0_REDACTOR_URL', SPAN_MODEL_TEST_URL);
  vi.stubGlobal('fetch', redactorFetch);
});

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  restoreSurfaceMode();
});

/** Run the continuations due now, without firing the redaction calls' own timeouts. */
function drainScheduled(): void {
  vi.advanceTimersByTime(0);
}

/** Sixty plain pages in a folder source, so a sync takes three batches. */
async function sixtyPages(): Promise<string> {
  const root = temporary('day0-sync-pause-');
  await mkdir(join(root, 'many'));
  for (let index = 1; index <= 60; index += 1) {
    const name = `page-${String(index).padStart(2, '0')}.md`;
    await writeFile(join(root, 'many', name), `# Page ${index}\n\nBody ${index}\n`, 'utf8');
  }
  return root;
}

/** The continuations the scheduler still holds. */
async function pending(harness: TestConvex<typeof schema>): Promise<string[]> {
  return (
    await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
  )
    .filter((job) => job.state.kind === 'pending')
    .map((job) => job.name);
}

/** The source's runs' states, oldest first. */
async function runStates(
  harness: TestConvex<typeof schema>,
  sourceId: Id<'docSources'>,
): Promise<string[]> {
  return (
    await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docSyncRuns')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .collect(),
    )
  ).map((run) => run.state);
}

describe("the documentation sync under the deployment's pause", (): void => {
  it("holds a sync's next batch while scheduled work is paused, and the cron's first run after goes on from its cursor", async (): Promise<void> => {
    // The reader class the modules load once the mode is set.
    const { FolderReader } = await import('../../src/docs/readers/folder');
    const { SYNC_HELD_REASON } = await import('../../convex/docSyncActions');
    vi.stubEnv('DAY0_DOCS_ROOT', await sixtyPages());
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Many',
      kind: 'folder',
      locator: 'many',
    });
    const reads = vi.spyOn(FolderReader.prototype, 'listPageBatch');
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    expect(reads).toHaveBeenCalledTimes(1);

    // An upgrade pauses the jobs with the continuation queued: it reads nothing, and the source
    // says why rather than reading as linking for the length of the pause.
    vi.stubEnv('DAY0_CRONS_PAUSED', 'upgrade to 0.16.0');
    await harness.finishAllScheduledFunctions(drainScheduled);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(await pending(harness)).toEqual([]);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'held', running: false, pageCount: 25 });
    const held = await harness.run(async (ctx) => await ctx.db.get(sourceId));
    expect(held?.lastError).toBe(SYNC_HELD_REASON);
    expect(await runStates(harness, sourceId)).toEqual(['held']);

    // The jobs run again, and the cron's next run lists the source and takes the run over at 25.
    vi.stubEnv('DAY0_CRONS_PAUSED', '');
    reads.mockClear();
    await harness.action(internal.docSyncActions.syncAll, {});
    await harness.finishAllScheduledFunctions(drainScheduled);
    expect(reads.mock.calls.map((call) => call[2]?.split('@')[0])).toEqual(['25', '50']);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'synced', running: false, pageCount: 60 });
  }, 30_000);

  it("carries a Re-sync the pause held as well on from the first hold's cursor, not from page one (W12-R27)", async (): Promise<void> => {
    const { FolderReader } = await import('../../src/docs/readers/folder');
    vi.stubEnv('DAY0_DOCS_ROOT', await sixtyPages());
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Many',
      kind: 'folder',
      locator: 'many',
    });
    const reads = vi.spyOn(FolderReader.prototype, 'listPageBatch');
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    vi.stubEnv('DAY0_CRONS_PAUSED', 'upgrade to 0.17.0');
    await harness.finishAllScheduledFunctions(drainScheduled);

    // A person's Re-sync during the same pause takes the held run over and is held at once.
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    await harness.finishAllScheduledFunctions(drainScheduled);
    expect(await runStates(harness, sourceId)).toEqual(['held', 'held']);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'held', running: false, pageCount: 25 });

    vi.stubEnv('DAY0_CRONS_PAUSED', '');
    reads.mockClear();
    await harness.action(internal.docSyncActions.syncAll, {});
    await harness.finishAllScheduledFunctions(drainScheduled);
    expect(reads.mock.calls.map((call) => call[2]?.split('@')[0])).toEqual(['25', '50']);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'synced', running: false, pageCount: 60 });
  }, 30_000);
});
