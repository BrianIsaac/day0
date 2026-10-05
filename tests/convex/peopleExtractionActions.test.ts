/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { PeopleExtractionResult } from '../../src/people/extraction';
import { allConvexModules } from './all-modules';
import { graphRows, seedPerson } from './fakes/people-graph';

/*
 * The documentation's people extraction (wave 13, 13-P): after a completed generation the people
 * its pages name are proposed, each with the page's quote, and a generation whose pages the last
 * extraction read is skipped with no model call. The model is the seam (`agentJson`), and every
 * scripted reply is held to the call's real schema.
 */

const model = vi.hoisted(() => ({
  calls: 0,
  error: undefined as Error | undefined,
  people: [] as PeopleExtractionResult['people'],
}));
const { schemaChecked } = await vi.hoisted(async () => await import('./fakes/mastra'));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string) => ({ name }),
  agentJson: schemaChecked(async () => {
    model.calls += 1;
    if (model.error !== undefined) throw model.error;
    return { people: model.people };
  }),
}));

beforeEach((): void => {
  model.calls = 0;
  model.error = undefined;
  model.people = [];
});

/** The onboarding page the bed's handbook carries, as a test reads it. */
const ONBOARDING = [
  '| System | What it is for | Access owner |',
  '|---|---|---|',
  '| NetLedger | The general ledger. | Finance systems owner: Dana Okafor (dana.okafor@kestrel.test) approves NetLedger access |',
].join('\n');

/** Dana's row as the model reads it. */
const DANA: PeopleExtractionResult['people'][number] = {
  name: 'Dana Okafor',
  pageRef: 'onboarding.md',
  quote:
    '| NetLedger | The general ledger. | Finance systems owner: Dana Okafor (dana.okafor@kestrel.test) approves NetLedger access |',
  email: 'dana.okafor@kestrel.test',
  title: 'Finance systems owner',
  team: null,
  approves: ['NetLedger access'],
  escalationFor: [],
};

/** A completed generation of one owner's source holding the onboarding page. */
async function seedGeneration(
  harness: TestConvex<typeof schema>,
): Promise<{ sourceId: Id<'docSources'>; runId: Id<'docSyncRuns'> }> {
  return await harness.run(async (ctx) => {
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'Kestrel handbook',
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId,
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
      state: 'completed',
      createdAt: 1,
      completedAt: 1,
    });
    await ctx.db.patch(sourceId, { lastCompletedSyncId: runId });
    await ctx.db.insert('docPages', {
      sourceId,
      ref: 'onboarding.md',
      title: 'Kestrel Supply onboarding',
      markdown: ONBOARDING,
      updatedAt: 1,
    });
    return { sourceId, runId };
  });
}

/** A second completed generation of the same source, its pages untouched. */
async function completeAgain(
  harness: TestConvex<typeof schema>,
  sourceId: Id<'docSources'>,
): Promise<Id<'docSyncRuns'>> {
  return await harness.run(async (ctx) => {
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId,
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
      state: 'completed',
      createdAt: 2,
      completedAt: 2,
    });
    await ctx.db.patch(sourceId, { lastCompletedSyncId: runId });
    return runId;
  });
}

describe('peopleExtractionActions.extractSource', (): void => {
  it('proposes only people a page quotes, with the quote, unverified, and the approval its quote states', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await seedGeneration(harness);
    model.people = [
      DANA,
      { ...DANA, name: 'Invented Person', quote: 'Invented Person approves everything.' },
    ];
    await expect(
      harness.action(internal.peopleExtractionActions.extractSource, { sourceId, runId }),
    ).resolves.toMatchObject({ applied: true, people: 1 });
    const { people, edges } = await graphRows(harness);
    expect(people).toMatchObject([
      {
        displayName: 'Dana Okafor',
        primaryEmail: 'dana.okafor@kestrel.test',
        title: 'Finance systems owner',
        status: 'unverified',
        source: 'documentation',
        evidence: [
          {
            quote: DANA.quote,
            where: 'Kestrel Supply onboarding',
            sourceId,
            ref: 'onboarding.md',
          },
        ],
      },
    ]);
    expect(edges).toMatchObject([
      { type: 'approval-authority', scope: 'NetLedger access', status: 'proposed' },
    ]);
    expect(edges[0]?.fromAgentId).toBeUndefined();
    const source = await harness.run(async (ctx) => await ctx.db.get(sourceId));
    expect(source).toMatchObject({ peopleExtractionSyncId: runId });
    expect(source?.peopleExtractionFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is skipped for an unchanged fingerprint, with no model call and the run stamped', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await seedGeneration(harness);
    model.people = [DANA];
    await harness.action(internal.peopleExtractionActions.extractSource, { sourceId, runId });
    expect(model.calls).toBe(1);
    const second = await completeAgain(harness, sourceId);
    await expect(
      harness.action(internal.peopleExtractionActions.extractSource, { sourceId, runId: second }),
    ).resolves.toMatchObject({ unchanged: true });
    expect(model.calls).toBe(1);
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(sourceId)))?.peopleExtractionSyncId,
    ).toBe(second);
  });

  it('merges a page person into a confirmed person by address, as evidence', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const known = await seedPerson(harness, 'D. Okafor', {
      primaryEmail: 'dana.okafor@kestrel.test',
    });
    const { sourceId, runId } = await seedGeneration(harness);
    model.people = [DANA];
    await harness.action(internal.peopleExtractionActions.extractSource, { sourceId, runId });
    const { people } = await graphRows(harness);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      _id: known,
      status: 'active',
      evidence: [{ quote: DANA.quote }],
    });
  });

  it('records a model failure on the source with nothing it echoed, and proposes nobody', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await seedGeneration(harness);
    const bearer = 'opaque-provider-secret-12345';
    model.error = new Error(`Provider rejected Authorization: Bearer ${bearer}`);
    await expect(
      harness.action(internal.peopleExtractionActions.extractSource, { sourceId, runId }),
    ).resolves.toMatchObject({ applied: false });
    const source = await harness.run(async (ctx) => await ctx.db.get(sourceId));
    expect(source?.lastPeopleExtractionError).toContain('<redacted>');
    expect(source?.lastPeopleExtractionError).not.toContain(bearer);
    expect(source?.peopleExtractionSyncId).toBeUndefined();
    expect((await graphRows(harness)).people).toEqual([]);
  });

  it('reads nothing for a run that is no longer the newest generation', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await seedGeneration(harness);
    await completeAgain(harness, sourceId);
    model.people = [DANA];
    await expect(
      harness.action(internal.peopleExtractionActions.extractSource, { sourceId, runId }),
    ).resolves.toEqual({ applied: false, people: 0 });
    expect(model.calls).toBe(0);
  });

  it('schedules the lookup of every proposed person whose quote gave an address', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await seedGeneration(harness);
    model.people = [DANA];
    await harness.action(internal.peopleExtractionActions.extractSource, { sourceId, runId });
    const dana = (await graphRows(harness)).people[0]?._id;
    const jobs = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(
      jobs
        .filter((job) => job.name === 'peopleLookupActions:lookUpAddresses')
        .map((job) => job.args),
    ).toEqual([[{ personIds: [dana] }]]);
  });
});
