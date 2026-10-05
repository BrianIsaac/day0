/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { routeSpanModelFetch, SPAN_MODEL_TEST_URL } from '../fixtures/redaction-double';
import { temporaryDirectories } from '../setup/temporary-directories';
import { allConvexModules } from './all-modules';
import { graphRows } from './fakes/people-graph';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/*
 * The people extraction scheduled beside discovery after a completed documentation generation
 * (wave 13, 13-P; the wave file's section 5.2). Its own file: the extraction is real mode's, and
 * the mode is set before the modules load.
 */

const temporary = temporaryDirectories();

// The redaction component the sync reaches, answered in-process, never over a socket: the tests
// fake setTimeout (12-N).
const redactorFetch = routeSpanModelFetch(globalThis.fetch);

const { schemaChecked } = await vi.hoisted(async () => await import('./fakes/mastra'));

/** The handbook row the extraction proposes a person from. */
const ROW =
  '| NetLedger | The general ledger. | Finance systems owner: Dana Okafor (dana.okafor@kestrel.test) approves NetLedger access |';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: schemaChecked(({ agent }) =>
    agent.name === 'day0-people-extraction'
      ? {
          people: [
            {
              name: 'Dana Okafor',
              pageRef: 'onboarding.md',
              quote: ROW,
              email: 'dana.okafor@kestrel.test',
              title: 'Finance systems owner',
              team: null,
              approves: ['NetLedger access'],
              escalationFor: [],
            },
          ],
        }
      : { systems: [] },
  ),
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

/** The jobs the scheduler still holds, by name, with their arguments. */
async function pending(
  harness: TestConvex<typeof schema>,
): Promise<Array<{ name: string; args: unknown }>> {
  return (
    await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
  )
    .filter((job) => job.state.kind === 'pending')
    .map((job) => ({ name: job.name, args: job.args }));
}

describe('the people extraction beside discovery', (): void => {
  it('is scheduled with discovery after a completed generation, and proposes the people the pages name', async (): Promise<void> => {
    const root = temporary('day0-sync-people-');
    await mkdir(join(root, 'kestrel'));
    await writeFile(
      join(root, 'kestrel', 'onboarding.md'),
      `# Kestrel Supply onboarding\n\n| System | What it is for | Access owner |\n|---|---|---|\n${ROW}\n`,
      'utf8',
    );
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Kestrel handbook',
      kind: 'folder',
      locator: 'kestrel',
    });
    await expect(
      harness.action(internal.docSyncActions.syncSource, { sourceId }),
    ).resolves.toMatchObject({ ok: true, complete: true });
    const jobs = await pending(harness);
    const discovery = jobs.find(
      (job) => job.name === 'documentationDiscoveryActions:discoverSource',
    );
    const extraction = jobs.find((job) => job.name === 'peopleExtractionActions:extractSource');
    expect(extraction?.args).toEqual(discovery?.args);

    await harness.finishAllScheduledFunctions(drainScheduled);
    const { people } = await graphRows(harness);
    expect(people).toMatchObject([
      {
        displayName: 'Dana Okafor',
        status: 'unverified',
        source: 'documentation',
        evidence: [{ quote: ROW, ref: 'onboarding.md' }],
      },
    ]);
  });
});
