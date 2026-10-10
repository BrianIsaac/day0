import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { replacePageBlocks } from '../../convex/docBlocks';
import { DECISION_NOT_OFFERED, standingConflictOf } from '../../convex/docRelations';
import { SUCCESSOR_NOT_CURRENT } from '../../convex/docStatus';
import type { SourceAuthority } from '../../src/docs/authority';
import { RELATION_PROPOSALS_PER_SYNC } from '../../src/docs/relations';
import type { SelectionRequest } from '../../src/docs/select';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

type Harness = TestConvex<typeof schema>;

/** A linked source with a sync running. */
interface Source {
  readonly sourceId: Id<'docSources'>;
  readonly runId: Id<'docSyncRuns'>;
}

const PIPELINE_V1 = [
  '# Pipeline runbook',
  '',
  'How the pipeline tile is refreshed.',
  '',
  '## Refresh',
  '',
  'Press Refresh once and read back the coverage figure.',
  '',
  '## Thresholds',
  '',
  'Escalate any variance above 5,000 USD to the finance lead.',
].join('\n');

const PIPELINE_V2 = [
  '---',
  'supersedes: pipeline-runbook',
  '---',
  '# Pipeline runbook',
  '',
  'How the pipeline tile is refreshed.',
  '',
  '## Refresh',
  '',
  'Press Refresh twice and read back the coverage figure and the audit line.',
].join('\n');

const FINANCE = [
  '# Finance escalation',
  '',
  '## Thresholds',
  '',
  'Escalate any variance above 10,000 USD to the finance lead.',
].join('\n');

// A decision that supersedes a page re-admits parked work, which schedules its next step.
beforeEach((): void => {
  vi.useFakeTimers();
});
afterEach((): void => {
  vi.useRealTimers();
});

/** An employee of an owner's. */
async function employee(harness: Harness, name: string, userId = 'owner'): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name,
        userId,
        state: 'deployed',
        createdAt: 1,
      }),
  );
}

/** A linked source of an owner's with a sync running. */
async function syncingSource(
  harness: Harness,
  label: string,
  fields: { userId?: string; authority?: SourceAuthority } = {},
): Promise<Source> {
  return await harness.run(async (ctx) => {
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label,
      kind: 'folder',
      locator: '.',
      status: 'linking',
      createdAt: 1,
      updatedAt: 1,
      ...fields,
    });
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId,
      listing: 1,
      credentialRefs: [],
      pageCount: 0,
      redactionCount: 0,
      state: 'running',
      createdAt: 2,
    });
    await ctx.db.patch(sourceId, { activeSyncId: runId });
    return { sourceId, runId };
  });
}

/** Store a page of the source with its blocks, as the source's running sync leaves it. */
async function storedPage(
  harness: Harness,
  source: Source,
  page: { ref: string; title: string; markdown: string; updatedAt?: number },
): Promise<Id<'docPages'>> {
  return await harness.run(async (ctx) => {
    const owner = (await ctx.db.get(source.sourceId))!.userId;
    const pageId = await ctx.db.insert('docPages', {
      sourceId: source.sourceId,
      updatedAt: 1,
      ...page,
    });
    await replacePageBlocks(ctx, {
      userId: owner,
      sourceId: source.sourceId,
      pageRef: page.ref,
      generation: source.runId,
      markdown: page.markdown,
    });
    return pageId;
  });
}

/** Measure a page of a source, as its finishing sync does. */
async function measure(harness: Harness, source: Source, ref: string): Promise<number> {
  return await harness.mutation(internal.docRelations.measurePage, {
    sourceId: source.sourceId,
    syncRunId: source.runId,
    ref,
  });
}

/** Every relation, oldest first. */
async function relations(harness: Harness): Promise<Doc<'docRelations'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('docRelations').collect());
}

/** A page's row. */
async function pageOf(harness: Harness, pageId: Id<'docPages'>): Promise<Doc<'docPages'>> {
  return await harness.run(async (ctx) => (await ctx.db.get(pageId))!);
}

/** An employee's events of one type, oldest first, by payload. */
async function eventsOf(
  harness: Harness,
  agentId: Id<'agents'>,
  type: string,
): Promise<Array<Record<string, unknown>>> {
  return await harness.run(async (ctx) =>
    (
      await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .collect()
    )
      .filter((event) => event.type === type)
      .map((event) => event.payload as Record<string, unknown>),
  );
}

/** The wiki's runbook and, in a second source, the version that says it supersedes it. */
async function twoVersions(harness: Harness): Promise<{
  wiki: Source;
  official: Source;
  v1: Id<'docPages'>;
  v2: Id<'docPages'>;
}> {
  const wiki = await syncingSource(harness, 'Team wiki');
  const official = await syncingSource(harness, 'Official runbooks', { authority: 'official' });
  const v1 = await storedPage(harness, wiki, {
    ref: 'runbooks/pipeline-runbook.md',
    title: 'Pipeline runbook',
    markdown: PIPELINE_V1,
  });
  const v2 = await storedPage(harness, official, {
    ref: 'pipeline-runbook-v2.md',
    title: 'Pipeline runbook',
    markdown: PIPELINE_V2,
    updatedAt: 2,
  });
  return { wiki, official, v1, v2 };
}

/** Two equally trusted pages that give different figures under one heading. */
async function twoThatDisagree(
  harness: Harness,
  authority: { handbook?: SourceAuthority; finance?: SourceAuthority } = {},
): Promise<{ handbook: Source; finance: Source; a: Id<'docPages'>; b: Id<'docPages'> }> {
  const handbook = await syncingSource(harness, 'Handbook', { authority: authority.handbook });
  const finance = await syncingSource(harness, 'Finance wiki', { authority: authority.finance });
  const a = await storedPage(harness, handbook, {
    ref: 'runbooks/pipeline-runbook.md',
    title: 'Pipeline runbook',
    markdown: PIPELINE_V1,
  });
  const b = await storedPage(harness, finance, {
    ref: 'escalation.md',
    title: 'Finance escalation',
    markdown: FINANCE,
    updatedAt: 2,
  });
  return { handbook, finance, a, b };
}

const asManager = (harness: Harness) => harness.withIdentity(managerIdentity());

/** A relation as a conflict that stands, or null. */
async function standingOf(harness: Harness, relationId: Id<'docRelations'>) {
  return await harness.run(
    async (ctx) => (await standingConflictOf(ctx, await ctx.db.get(relationId))) ?? null,
  );
}

describe('measurePage: the relations a finishing sync proposes', (): void => {
  it('proposes a later version in another source as the successor, on each reader’s record, and changes no page', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { wiki, official, v1, v2 } = await twoVersions(harness);
    const agentId = await employee(harness, 'Priya');
    expect(await measure(harness, official, 'pipeline-runbook-v2.md')).toBe(1);
    const [relation, ...rest] = await relations(harness);
    expect(rest).toEqual([]);
    expect(relation).toMatchObject({
      userId: 'owner',
      kind: 'possible_successor',
      status: 'proposed',
      from: { sourceId: official.sourceId, ref: 'pipeline-runbook-v2.md' },
      to: { sourceId: wiki.sourceId, ref: 'runbooks/pipeline-runbook.md' },
    });
    expect(relation.evidence[0]).toEqual({ measure: 'names-successor', value: 1 });
    // Never merged, never decided by code: both pages read as they did.
    for (const id of [v1, v2]) {
      expect([
        (await pageOf(harness, id)).status,
        (await pageOf(harness, id)).supersededBy,
      ]).toEqual([undefined, undefined]);
    }
    expect(await eventsOf(harness, agentId, 'documentation.relation-proposed')).toEqual([
      {
        relationId: relation._id,
        kind: 'possible_successor',
        from: {
          sourceId: official.sourceId,
          ref: 'pipeline-runbook-v2.md',
          title: 'Pipeline runbook',
          source: 'Official runbooks',
        },
        to: {
          sourceId: wiki.sourceId,
          ref: 'runbooks/pipeline-runbook.md',
          title: 'Pipeline runbook',
          source: 'Team wiki',
        },
        evidence: relation.evidence.map(({ measure, value }) => ({ measure, value })),
      },
    ]);
  });

  it('proposes a pair once: measured again, or from the other page, it writes nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { wiki, official } = await twoVersions(harness);
    expect(await measure(harness, official, 'pipeline-runbook-v2.md')).toBe(1);
    expect(await measure(harness, official, 'pipeline-runbook-v2.md')).toBe(0);
    expect(await measure(harness, wiki, 'runbooks/pipeline-runbook.md')).toBe(0);
    expect(await relations(harness)).toHaveLength(1);
  });

  it('proposes two pages that disagree on a figure as a conflict, and one the manager set aside again only once its blocks change', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { handbook, finance } = await twoThatDisagree(harness);
    expect(await measure(harness, finance, 'escalation.md')).toBe(1);
    const [conflict] = await relations(harness);
    expect(conflict).toMatchObject({ kind: 'possible_conflict', status: 'proposed' });
    expect(conflict.evidence[0]).toMatchObject({ measure: 'heading-figures', value: 1 });
    expect(conflict.evidence[0].blockRefs).toHaveLength(2);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: conflict._id,
      decision: 'both-hold',
    });
    expect(await measure(harness, handbook, 'runbooks/pipeline-runbook.md')).toBe(0);
    // The finance page is edited to another figure: other blocks disagree now.
    await harness.run(async (ctx) => {
      const edited = FINANCE.replace('10,000', '20,000');
      const page = await ctx.db
        .query('docPages')
        .withIndex('by_source_ref', (q) =>
          q.eq('sourceId', finance.sourceId).eq('ref', 'escalation.md'),
        )
        .unique();
      await ctx.db.patch(page!._id, { markdown: edited });
      await replacePageBlocks(ctx, {
        userId: 'owner',
        sourceId: finance.sourceId,
        pageRef: 'escalation.md',
        generation: finance.runId,
        markdown: edited,
      });
    });
    expect(await measure(harness, finance, 'escalation.md')).toBe(1);
    expect((await relations(harness)).map((row) => row.status)).toEqual(['dismissed', 'proposed']);
  });

  it('proposes a conflict again once the one it holds no longer disagrees, and removes the proposal nobody could answer', async (): Promise<void> => {
    // The second pass's minor 4: a conflict whose blocks no longer disagree is drawn on no card,
    // so it cannot be answered, and it still counted as held: a later conflict between the same
    // two pages was never proposed.
    const harness = convexTest(schema, allConvexModules());
    const { finance } = await twoThatDisagree(harness);
    /** Store the finance page again with another figure, as a sync that read an edit does. */
    const editFinance = async (figure: string): Promise<void> =>
      await harness.run(async (ctx) => {
        const edited = FINANCE.replace('10,000', figure);
        const page = await ctx.db
          .query('docPages')
          .withIndex('by_source_ref', (q) =>
            q.eq('sourceId', finance.sourceId).eq('ref', 'escalation.md'),
          )
          .unique();
        await ctx.db.patch(page!._id, { markdown: edited });
        await replacePageBlocks(ctx, {
          userId: 'owner',
          sourceId: finance.sourceId,
          pageRef: 'escalation.md',
          generation: finance.runId,
          markdown: edited,
        });
      });
    expect(await measure(harness, finance, 'escalation.md')).toBe(1);
    const [first] = await relations(harness);
    // Unanswered, and the page is edited to another figure: the row names blocks that are gone.
    await editFinance('20,000');
    expect(await asManager(harness).query(api.docRelations.listOpen, {})).toEqual([]);
    expect(await measure(harness, finance, 'escalation.md')).toBe(1);
    const afterEdit = await relations(harness);
    expect(afterEdit.map((row) => [row.kind, row.status])).toEqual([
      ['possible_conflict', 'proposed'],
    ]);
    expect(afterEdit[0]._id).not.toBe(first._id);
    // A conflict the manager confirmed is their answer and is kept; it blocks nothing once stale.
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: afterEdit[0]._id,
      decision: 'disagree',
    });
    await editFinance('30,000');
    expect(await measure(harness, finance, 'escalation.md')).toBe(1);
    expect((await relations(harness)).map((row) => row.status)).toEqual(['confirmed', 'proposed']);
  });

  it('measures against the owner’s own active pages only, and proposes nothing for a page that is not current', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const theirs = await syncingSource(harness, 'Their wiki', { userId: 'another-owner' });
    await storedPage(harness, theirs, {
      ref: 'runbooks/pipeline-runbook.md',
      title: 'Pipeline runbook',
      markdown: PIPELINE_V1,
    });
    const mine = await syncingSource(harness, 'Official runbooks');
    const v2 = await storedPage(harness, mine, {
      ref: 'pipeline-runbook-v2.md',
      title: 'Pipeline runbook',
      markdown: PIPELINE_V2,
    });
    expect(await measure(harness, mine, 'pipeline-runbook-v2.md')).toBe(0);
    // The owner's own copy is superseded already: nothing is proposed against it.
    const wiki = await syncingSource(harness, 'Team wiki');
    const v1 = await storedPage(harness, wiki, {
      ref: 'runbooks/pipeline-runbook.md',
      title: 'Pipeline runbook',
      markdown: PIPELINE_V1,
    });
    await asManager(harness).mutation(api.docStatus.setPageStatus, {
      pageId: v1,
      status: 'superseded',
      supersededBy: v2,
    });
    expect(await measure(harness, mine, 'pipeline-runbook-v2.md')).toBe(0);
    expect(await measure(harness, wiki, 'runbooks/pipeline-runbook.md')).toBe(0);
    expect(await relations(harness)).toEqual([]);
  });

  it('writes nothing for a generation that is neither the source’s running one nor its last completed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { wiki, official } = await twoVersions(harness);
    expect(
      await harness.mutation(internal.docRelations.measurePage, {
        sourceId: official.sourceId,
        syncRunId: wiki.runId,
        ref: 'pipeline-runbook-v2.md',
      }),
    ).toBe(0);
    expect(await relations(harness)).toEqual([]);
  });
});

describe('the pages a finishing sync measures', (): void => {
  it('are the pages the runs since the last complete walk wrote, found by the blocks they wrote', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    // Three walks of one source, oldest first: two completed, and the one running now.
    const { sourceId, before, completed, running } = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Team wiki',
        kind: 'folder',
        locator: '.',
        status: 'linking',
        createdAt: 1,
        updatedAt: 1,
      });
      const walk = async (state: 'completed' | 'running', createdAt: number) =>
        await ctx.db.insert('docSyncRuns', {
          sourceId,
          listing: createdAt,
          credentialRefs: [],
          pageCount: 1,
          redactionCount: 0,
          state,
          createdAt,
          ...(state === 'completed' ? { completedAt: createdAt } : {}),
        });
      const before = await walk('completed', 1);
      const completed = await walk('completed', 2);
      const running = await walk('running', 3);
      await ctx.db.patch(sourceId, { lastCompletedSyncId: completed, activeSyncId: running });
      return { sourceId, before, completed, running };
    });
    await storedPage(
      harness,
      { sourceId, runId: before },
      { ref: 'old.md', title: 'Old', markdown: '# Old\n\nUnchanged for a year.' },
    );
    await storedPage(
      harness,
      { sourceId, runId: completed },
      { ref: 'last-walk.md', title: 'Last walk', markdown: '# Last walk\n\nStored last time.' },
    );
    await storedPage(
      harness,
      { sourceId, runId: running },
      { ref: 'runbooks/pipeline-runbook.md', title: 'Pipeline runbook', markdown: PIPELINE_V1 },
    );
    // This walk and the last complete one: a page the walk before stored is not measured again.
    expect(
      await harness.query(internal.docRelations.generationsToMeasure, {
        sourceId,
        runId: running,
      }),
    ).toEqual([running, completed]);
    // Once it has completed too, it still looks back one complete walk and no further.
    expect(
      await harness.query(internal.docRelations.generationsToMeasure, {
        sourceId,
        runId: completed,
      }),
    ).toEqual([completed, before]);
    const written = async (generation: Id<'docSyncRuns'>) =>
      await harness.query(internal.docRelations.pagesWrittenBy, {
        sourceId,
        generation,
        cursor: null,
      });
    expect(await written(running)).toEqual({ refs: ['runbooks/pipeline-runbook.md'], next: null });
    expect(await written(completed)).toEqual({ refs: ['last-walk.md'], next: null });
  });
});

describe('the cap on new proposals a sync (the second pass, minor 8)', (): void => {
  const WORDS = [
    'Alpha',
    'Bravo',
    'Charlie',
    'Delta',
    'Echo',
    'Foxtrot',
    'Golf',
    'Hotel',
    'India',
    'Juliet',
    'Kilo',
    'Lima',
    'Mike',
    'November',
    'Oscar',
    'Papa',
    'Quebec',
  ];

  /**
   * Seventeen runbooks in one source, each with three later versions, one in each of three other
   * sources: measuring a runbook proposes three relations, so seventeen propose fifty-one.
   */
  async function versionedLibrary(harness: Harness): Promise<Source> {
    const first = await syncingSource(harness, 'Runbooks');
    const later = [
      await syncingSource(harness, 'Second editions'),
      await syncingSource(harness, 'Third editions'),
      await syncingSource(harness, 'Fourth editions'),
    ];
    for (const word of WORDS) {
      const markdown = `# ${word}\n\n${word} procedure, in full.`;
      await storedPage(harness, first, { ref: `${word}.md`, title: word, markdown });
      for (const [index, source] of later.entries()) {
        await storedPage(harness, source, {
          ref: `${word}-v${index + 2}.md`,
          title: `${word} v${index + 2}`,
          markdown,
          updatedAt: index + 2,
        });
      }
    }
    return first;
  }

  it('stops a page’s measure at the room it is given', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const first = await versionedLibrary(harness);
    expect(
      await harness.mutation(internal.docRelations.measurePage, {
        sourceId: first.sourceId,
        syncRunId: first.runId,
        ref: 'Alpha.md',
        room: 1,
      }),
    ).toBe(1);
    expect(await relations(harness)).toHaveLength(1);
    // With no room given a page proposes every relation its three candidates hold.
    expect(await measure(harness, first, 'Bravo.md')).toBe(3);
  });

  it('proposes exactly the cap for a sync whose pages hold more, where the last page measured went over it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const first = await versionedLibrary(harness);
    expect(
      await harness.action(internal.docSyncActions.proposeRelations, {
        sourceId: first.sourceId,
        runId: first.runId,
      }),
    ).toEqual({ measured: 17, proposed: RELATION_PROPOSALS_PER_SYNC });
    expect(await relations(harness)).toHaveLength(RELATION_PROPOSALS_PER_SYNC);
  });
});

describe('decide: the manager’s answer on a relation’s card', (): void => {
  it('supersedes the older page when the successor is confirmed, and sends parked work back', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { wiki, official, v1, v2 } = await twoVersions(harness);
    const agentId = await employee(harness, 'Priya');
    const parked = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-10',
          title: 'Refresh the pipeline tile',
          contentSummary: 'The tile is stale.',
          contentRefs: [],
          observedAt: 1,
          createdAt: 1,
          state: 'skipped',
          verdict: {
            decision: 'skip',
            reason: 'out-of-scope: no charter or current documented-system overlap',
          },
          skipReason: 'out-of-scope: no charter or current documented-system overlap',
        }),
    );
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'));
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'supersedes',
    });
    expect((await relations(harness))[0]).toMatchObject({
      kind: 'possible_successor',
      status: 'confirmed',
      decidedBy: MANAGER_ADDRESS,
      decidedAt: Date.parse('2026-10-10T09:00:00.000Z'),
    });
    expect(await pageOf(harness, v1)).toMatchObject({
      status: 'superseded',
      statusSource: 'relation',
      supersededBy: { sourceId: official.sourceId, ref: 'pipeline-runbook-v2.md' },
    });
    expect((await pageOf(harness, v2)).status).toBeUndefined();
    expect(await eventsOf(harness, agentId, 'work.requeued')).toEqual([
      {
        workItemId: parked,
        trigger: 'documentation',
        key: `documentation-status:${wiki.sourceId}:runbooks/pipeline-runbook.md:superseded`,
        previousState: 'skipped',
      },
    ]);
    expect(await eventsOf(harness, agentId, 'documentation.relation-decided')).toMatchObject([
      { relationId: relation._id, kind: 'possible_successor', decision: 'supersedes' },
    ]);
  });

  it('answers what became of the older page, which a source’s own word or the manager’s keeps as it was', async (): Promise<void> => {
    // The second pass's minor 13: the card said "now supersedes" whatever the rules made of it,
    // and a page its source calls current, or the manager decided by hand, is not superseded by
    // a relation.
    const harness = convexTest(schema, allConvexModules());
    const { official, v1 } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    const supersede = async () =>
      await asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'supersedes',
      });
    const undo = async () =>
      await asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'undo',
      });
    expect(await supersede()).toEqual({ older: 'superseded', by: 'relation' });
    expect(await undo()).toBeNull();
    // The older page's front matter says it is current: the source's word stands over a relation.
    await harness.run(async (ctx) => {
      await ctx.db.patch(v1, {
        nativeStatus: 'active',
        status: 'active',
        statusSource: 'source-native',
      });
    });
    expect(await supersede()).toEqual({ older: 'active', by: 'source-native' });
    expect((await pageOf(harness, v1)).status).toBe('active');
  });

  it('changes no page for "Keep both" or "Not the same", and offers the card no second answer', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { official, v1, v2 } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'keep-both',
    });
    // Both kept is no successor: the older page stays current.
    expect((await relations(harness))[0]).toMatchObject({
      kind: 'possible_duplicate',
      status: 'confirmed',
    });
    expect([(await pageOf(harness, v1)).status, (await pageOf(harness, v2)).status]).toEqual([
      undefined,
      undefined,
    ]);
    await expect(
      asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'supersedes',
      }),
    ).rejects.toThrow(DECISION_NOT_OFFERED);
  });

  it('lets a confirmed conflict stand between two active pages of equal trust, until "Both hold"', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { handbook, finance } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [relation] = await relations(harness);
    const standing = async () => await standingOf(harness, relation._id);
    // Proposed only: nothing stands, nothing is held or tagged.
    expect(await standing()).toBeNull();
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'disagree',
    });
    expect(await standing()).toMatchObject({
      relationId: relation._id,
      from: { sourceId: finance.sourceId, title: 'Finance escalation', source: 'Finance wiki' },
      to: { sourceId: handbook.sourceId, title: 'Pipeline runbook', source: 'Handbook' },
      heading: 'Thresholds',
      figures: { from: '10,000', to: '5,000' },
    });
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'both-hold',
    });
    expect(await standing()).toBeNull();
    expect((await relations(harness))[0].status).toBe('dismissed');
  });

  it('marks the other page superseded in the manager’s name when one is right, which ends the conflict', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { handbook, finance, a, b } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [relation] = await relations(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'disagree',
    });
    // The handbook's page is the relation's `to`.
    expect(relation.to.sourceId).toBe(handbook.sourceId);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'to-is-right',
    });
    expect(await pageOf(harness, b)).toMatchObject({
      status: 'superseded',
      statusSource: 'manager',
      decidedBy: MANAGER_ADDRESS,
      supersededBy: { sourceId: handbook.sourceId, ref: 'runbooks/pipeline-runbook.md' },
    });
    expect((await pageOf(harness, a)).status).toBeUndefined();
    expect(await standingOf(harness, relation._id)).toBeNull();
  });

  it('refuses a stale second answer on a conflict already settled, so the two pages never supersede each other (W15-R6)', async (): Promise<void> => {
    // Reader 2's vt/a.test.ts R2-A: two tabs show the proposed card; one answers "{A} is right",
    // the other, stale, "{B} is right". The second was taken, and neither page was current.
    const harness = convexTest(schema, allConvexModules());
    const { handbook, finance, a, b } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [relation] = await relations(harness);
    expect(relation.from.sourceId).toBe(finance.sourceId);
    const answer = async (decision: 'from-is-right' | 'to-is-right' | 'both-hold') =>
      await asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision,
      });
    await answer('from-is-right');
    expect(await pageOf(harness, a)).toMatchObject({
      status: 'superseded',
      supersededBy: { sourceId: finance.sourceId, ref: 'escalation.md' },
    });
    for (const stale of ['to-is-right', 'from-is-right', 'both-hold'] as const) {
      await expect(answer(stale), stale).rejects.toThrow(DECISION_NOT_OFFERED);
    }
    // The page the first answer named right is still current, and the other still gives way to it.
    expect((await pageOf(harness, b)).status).toBeUndefined();
    expect((await pageOf(harness, a)).status).toBe('superseded');
    expect((await relations(harness))[0]).toMatchObject({ status: 'confirmed' });
    // "This is current" on the superseded page's row is the way back: the conflict stands again
    // and takes its answers.
    await asManager(harness).mutation(api.docStatus.setPageStatus, { pageId: a, status: 'active' });
    expect(await standingOf(harness, relation._id)).not.toBeNull();
    await answer('to-is-right');
    expect((await pageOf(harness, b)).status).toBe('superseded');
    expect((await pageOf(harness, a)).status).toBe('active');
    expect(handbook.sourceId).toBe(relation.to.sourceId);
  });

  it('refuses an answer that would make a page that is not current stand in for another (W15-R6)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { finance, a, b } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [conflict] = await relations(harness);
    // The card was drawn while both pages were current; the finance page is then archived by hand.
    await asManager(harness).mutation(api.docStatus.setPageStatus, {
      pageId: b,
      status: 'archived',
    });
    await expect(
      asManager(harness).mutation(api.docRelations.decide, {
        relationId: conflict._id,
        decision: 'from-is-right',
      }),
    ).rejects.toThrow(SUCCESSOR_NOT_CURRENT);
    expect((await pageOf(harness, a)).status).toBeUndefined();
    expect((await relations(harness))[0]).toMatchObject({ status: 'proposed' });

    const versions = convexTest(schema, allConvexModules());
    const { official, v1, v2 } = await twoVersions(versions);
    await measure(versions, official, 'pipeline-runbook-v2.md');
    const [successor] = await relations(versions);
    await asManager(versions).mutation(api.docStatus.setPageStatus, {
      pageId: v2,
      status: 'draft',
    });
    await expect(
      asManager(versions).mutation(api.docRelations.decide, {
        relationId: successor._id,
        decision: 'supersedes',
      }),
    ).rejects.toThrow(SUCCESSOR_NOT_CURRENT);
    expect((await pageOf(versions, v1)).status).toBeUndefined();
    expect((await relations(versions))[0]).toMatchObject({ status: 'proposed' });
  });

  it('lets no conflict stand between pages of unequal trust, and offers no "They disagree" that would hold nothing', async (): Promise<void> => {
    // The second pass's minor 3: "They disagree" on such a pair was recorded, tagged no cite,
    // held no plan and took the card away, while the card said a step would be held.
    const harness = convexTest(schema, allConvexModules());
    const { finance, handbook } = await twoThatDisagree(harness, { finance: 'official' });
    await measure(harness, finance, 'escalation.md');
    const [relation] = await relations(harness);
    const [card] = await asManager(harness).query(api.docRelations.listOpen, {});
    expect(card.offered).toEqual(['from-is-right', 'to-is-right', 'both-hold']);
    expect([card.from.authority, card.to.authority]).toEqual(['official', 'team']);
    await expect(
      asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'disagree',
      }),
    ).rejects.toThrow(DECISION_NOT_OFFERED);
    expect((await relations(harness))[0].status).toBe('proposed');
    // A conflict confirmed between equals stops standing once the manager trusts one page more.
    await asManager(harness).mutation(api.docStatus.setSourceAuthority, {
      sourceId: finance.sourceId,
      authority: 'team',
    });
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'disagree',
    });
    expect(await standingOf(harness, relation._id)).not.toBeNull();
    await asManager(harness).mutation(api.docStatus.setSourceAuthority, {
      sourceId: handbook.sourceId,
      authority: 'official',
    });
    expect(await standingOf(harness, relation._id)).toBeNull();
  });

  it('takes a confirmed successor back: the older page is current again and the card asks again', async (): Promise<void> => {
    // The second pass's major 1: a wrong "supersedes" could not be undone.
    const harness = convexTest(schema, allConvexModules());
    const { official, v1 } = await twoVersions(harness);
    const agentId = await employee(harness, 'Priya');
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    const decide = async (decision: 'supersedes' | 'undo'): Promise<unknown> =>
      await asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision,
      });
    // A card not yet answered has nothing to take back.
    await expect(decide('undo')).rejects.toThrow(DECISION_NOT_OFFERED);
    await decide('supersedes');
    expect((await pageOf(harness, v1)).status).toBe('superseded');
    await decide('undo');
    const [undone] = await relations(harness);
    expect([undone.kind, undone.status, undone.decidedBy, undone.decidedAt]).toEqual([
      'possible_successor',
      'proposed',
      undefined,
      undefined,
    ]);
    const older = await pageOf(harness, v1);
    expect([older.status, older.statusSource, older.supersededBy]).toEqual([
      'active',
      'default',
      undefined,
    ]);
    expect(
      (await eventsOf(harness, agentId, 'documentation.relation-decided')).map(
        (event) => event.decision,
      ),
    ).toEqual(['supersedes', 'undo']);
    expect(await asManager(harness).query(api.docRelations.listOpen, {})).toMatchObject([
      {
        _id: relation._id,
        status: 'proposed',
        offered: ['supersedes', 'keep-both', 'not-the-same'],
      },
    ]);
  });

  it('takes "Keep both", "Not the same" and "Both hold" back to the card, and offers no undo on a conflict that stands', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { official } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [versions] = await relations(harness);
    const decide = async (
      relationId: Id<'docRelations'>,
      decision: 'keep-both' | 'not-the-same' | 'disagree' | 'both-hold' | 'undo',
    ): Promise<unknown> =>
      await asManager(harness).mutation(api.docRelations.decide, { relationId, decision });
    for (const decision of ['keep-both', 'not-the-same'] as const) {
      await decide(versions._id, decision);
      await decide(versions._id, 'undo');
      expect((await relations(harness))[0].status).toBe('proposed');
    }
    const { finance } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const conflict = (await relations(harness)).find((row) => row.kind === 'possible_conflict')!;
    await decide(conflict._id, 'disagree');
    // A confirmed conflict stands with its own three answers; "Both hold" is how it is let go.
    await expect(decide(conflict._id, 'undo')).rejects.toThrow(DECISION_NOT_OFFERED);
    await decide(conflict._id, 'both-hold');
    await decide(conflict._id, 'undo');
    const again = (await relations(harness)).find((row) => row._id === conflict._id)!;
    expect([again.kind, again.status]).toEqual(['possible_conflict', 'proposed']);
    expect(await standingOf(harness, conflict._id)).toBeNull();
  });

  it('is the owner’s alone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { official } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    await expect(
      harness.withIdentity(managerIdentity('stranger')).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'supersedes',
      }),
    ).rejects.toThrow('forbidden');
    await expect(
      harness.mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'supersedes',
      }),
    ).rejects.toThrow();
    expect((await relations(harness))[0].status).toBe('proposed');
  });
});

describe('listOpen: the cards the manager has still to answer', (): void => {
  it('draws each proposed relation with its pages, its measures and the answers it offers, and a confirmed conflict while it stands', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { official } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const finance = await syncingSource(harness, 'Finance wiki');
    await storedPage(harness, finance, {
      ref: 'escalation.md',
      title: 'Finance escalation',
      markdown: FINANCE,
      updatedAt: 3,
    });
    await measure(harness, finance, 'escalation.md');
    const cards = await asManager(harness).query(api.docRelations.listOpen, {});
    expect(cards.map((card) => [card.kind, card.status, card.offered])).toEqual([
      ['possible_conflict', 'proposed', ['disagree', 'from-is-right', 'to-is-right', 'both-hold']],
      ['possible_successor', 'proposed', ['supersedes', 'keep-both', 'not-the-same']],
    ]);
    expect(cards[0]).toMatchObject({
      from: { title: 'Finance escalation', source: 'Finance wiki', updatedAt: 3 },
      disagreement: { heading: 'Thresholds', figures: { from: '10,000', to: '5,000' } },
    });
    expect(cards[1]).toMatchObject({
      from: { title: 'Pipeline runbook', source: 'Official runbooks' },
      to: { title: 'Pipeline runbook', source: 'Team wiki' },
      evidence: [{ measure: 'names-successor', value: 1 }, expect.anything()],
    });
    // Confirmed, the conflict's card stays, offering how to settle it.
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: cards[0]._id,
      decision: 'disagree',
    });
    const after = await asManager(harness).query(api.docRelations.listOpen, {});
    expect(after.map((card) => [card.kind, card.status, card.offered])).toEqual([
      ['possible_successor', 'proposed', ['supersedes', 'keep-both', 'not-the-same']],
      ['possible_conflict', 'confirmed', ['from-is-right', 'to-is-right', 'both-hold']],
    ]);
    // Another manager sees none of them.
    expect(
      await harness.withIdentity(managerIdentity('stranger')).query(api.docRelations.listOpen, {}),
    ).toEqual([]);
  });

  it('draws a live card behind any number of proposals whose pages are no longer current', async (): Promise<void> => {
    // The second pass's minor 4: the read took the newest 20 proposals and drew the live ones
    // among them, so 20 dead rows above a live card hid it.
    const harness = convexTest(schema, allConvexModules());
    const { official } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const dead = await syncingSource(harness, 'Old wiki');
    for (let pair = 0; pair < 25; pair += 1) {
      await storedPage(harness, dead, {
        ref: `old-${pair}.md`,
        title: `Old ${pair}`,
        markdown: `# Old ${pair}\n\nRetired.`,
      });
      await harness.run(async (ctx) => {
        const page = await ctx.db
          .query('docPages')
          .withIndex('by_source_ref', (q) =>
            q.eq('sourceId', dead.sourceId).eq('ref', `old-${pair}.md`),
          )
          .unique();
        await ctx.db.patch(page!._id, { status: 'archived', statusSource: 'manager' });
        await replacePageBlocks(ctx, {
          userId: 'owner',
          sourceId: dead.sourceId,
          pageRef: `old-${pair}.md`,
          generation: dead.runId,
          markdown: page!.markdown,
          status: 'archived',
        });
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: official.sourceId, ref: 'pipeline-runbook-v2.md' },
          to: { sourceId: dead.sourceId, ref: `old-${pair}.md` },
          kind: 'possible_duplicate',
          evidence: [{ measure: 'shared-text', value: 70 }],
          status: 'proposed',
          createdAt: 10 + pair,
        });
      });
    }
    const cards = await asManager(harness).query(api.docRelations.listOpen, {});
    expect(cards.map((card) => [card.kind, card.to.title])).toEqual([
      ['possible_successor', 'Pipeline runbook'],
    ]);
  });

  it('draws cards only while their pages fit one read, and the rest once those are answered', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness, 'Team wiki');
    // Four pairs of pages near the largest a page may be: all eight bodies pass one query's read.
    const body = `# Long\n\n${'x'.repeat(700 * 1024)}`;
    for (let pair = 0; pair < 4; pair += 1) {
      await harness.run(async (ctx) => {
        for (const side of ['a', 'b']) {
          await ctx.db.insert('docPages', {
            sourceId: source.sourceId,
            ref: `long-${pair}-${side}.md`,
            title: `Long ${pair} ${side}`,
            markdown: body,
            updatedAt: 1,
          });
        }
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: source.sourceId, ref: `long-${pair}-b.md` },
          to: { sourceId: source.sourceId, ref: `long-${pair}-a.md` },
          kind: 'possible_duplicate',
          evidence: [{ measure: 'shared-text', value: 100 }],
          status: 'proposed',
          createdAt: pair,
        });
      });
    }
    const drawn = await asManager(harness).query(api.docRelations.listOpen, {});
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(4);
    expect(drawn[0].from.title).toBe('Long 3 b');
    // Answered, a drawn card makes room for the next.
    for (const card of drawn) {
      await asManager(harness).mutation(api.docRelations.decide, {
        relationId: card._id,
        decision: 'not-the-same',
      });
    }
    const next = await asManager(harness).query(api.docRelations.listOpen, {});
    expect(next[0].from.title).not.toBe('Long 3 b');
    expect(next.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('a confirmed conflict in a selection and at a plan’s decision (the sixth hold reason; A-3)', (): void => {
  const request: SelectionRequest = {
    site: 'plan',
    title: 'Escalate the variance',
    summary: 'A variance above the threshold needs the finance lead.',
    roleFunction: 'Revenue operations coordination',
    writtenBrowserSurfaces: [],
  };

  afterEach((): void => {
    restoreSurfaceMode();
  });

  /** Two pages that disagree, mirrored for an employee with autonomous actions on, and the relation. */
  async function disagreement(harness: Harness) {
    const pages = await twoThatDisagree(harness);
    const agentId = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
        autonomousActions: true,
      });
      for (const page of await ctx.db.query('docPages').collect()) {
        await ctx.db.insert('mockDocs', {
          agentId,
          slug: `source-${page.ref.replace(/[^a-z0-9]+/gi, '-')}`,
          title: page.title,
          body: page.markdown,
          category: 'team-doc',
          sourceId: page.sourceId,
          sourceRef: page.ref,
          updatedAt: 3,
        });
      }
      // A third page, so the item's words tell pages apart.
      await ctx.db.insert('mockDocs', {
        agentId,
        slug: 'office-holidays',
        title: 'Office holidays',
        body: '# Office holidays\n\nClosed in August.',
        category: 'team-doc',
        updatedAt: 3,
      });
      return agentId;
    });
    await measure(harness, pages.finance, 'escalation.md');
    const relation = (await relations(harness)).find((row) => row.kind === 'possible_conflict')!;
    return { ...pages, agentId, relationId: relation._id };
  }

  /** The cite lines a plan-site selection prints for the employee. */
  async function selection(harness: Harness, agentId: Id<'agents'>) {
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: request,
    });
    return {
      lines: snapshot.teamDocs.flatMap((doc) =>
        doc.body.split('\n').filter((line) => line.startsWith('[cite: ')),
      ),
      citations: snapshot.documentation?.citations ?? [],
    };
  }

  it('tags both pages’ cites [conflict] once the manager confirms it, and no cite before or after it is settled', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId } = await disagreement(harness);
    // Proposed only: a measure tags nothing.
    expect((await selection(harness, agentId)).lines.join('\n')).not.toContain('[conflict]');
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    const tagged = await selection(harness, agentId);
    expect(tagged.lines).toEqual(
      expect.arrayContaining([
        '[cite: Handbook/runbooks/pipeline-runbook.md#Pipeline runbook > Thresholds] [conflict]',
        '[cite: Finance wiki/escalation.md#Finance escalation > Thresholds] [conflict]',
      ]),
    );
    // Only the passages that disagree are tagged, and each carries what it disagrees with.
    expect(tagged.lines.filter((line) => line.endsWith('[conflict]'))).toHaveLength(2);
    const conflicts = tagged.citations.flatMap((citation) =>
      citation.conflict ? [citation.conflict] : [],
    );
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toEqual({
      relationId,
      heading: 'Thresholds',
      pages: [
        { title: 'Finance escalation', source: 'Finance wiki' },
        { title: 'Pipeline runbook', source: 'Handbook' },
      ],
    });
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'both-hold',
    });
    expect((await selection(harness, agentId)).lines.join('\n')).not.toContain('[conflict]');
  });

  it('sees a confirmed conflict among any number of other confirmed relations, older or newer', async (): Promise<void> => {
    // The second pass's major 2: the selection read the owner's oldest 64 confirmed relations of
    // every kind, and every kept version and settled conflict stays confirmed for good, so past
    // 64 a newly confirmed conflict tagged no cite and held no plan; and its card, read newest
    // first, went the same way once 64 later answers stood above it.
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const kept = await syncingSource(harness, 'Kept versions');
    /** 65 relations the manager confirmed that are no conflict: two versions, both kept. */
    const keptVersions = async (from: number): Promise<void> =>
      await harness.run(async (ctx) => {
        for (let pair = from; pair < from + 65; pair += 1) {
          await ctx.db.insert('docRelations', {
            userId: 'owner',
            from: { sourceId: kept.sourceId, ref: `kept-${pair}-v2.md` },
            to: { sourceId: kept.sourceId, ref: `kept-${pair}.md` },
            kind: 'possible_duplicate',
            evidence: [{ measure: 'shared-text', value: 80 }],
            status: 'confirmed',
            decidedAt: 5,
            createdAt: 5,
          });
        }
      });
    await keptVersions(0);
    const { agentId, relationId } = await disagreement(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    await keptVersions(65);
    const { lines } = await selection(harness, agentId);
    expect(lines.filter((line) => line.endsWith('[conflict]')).sort()).toEqual([
      '[cite: Finance wiki/escalation.md#Finance escalation > Thresholds] [conflict]',
      '[cite: Handbook/runbooks/pipeline-runbook.md#Pipeline runbook > Thresholds] [conflict]',
    ]);
    expect(await asManager(harness).query(api.docRelations.listOpen, {})).toMatchObject([
      { _id: relationId, kind: 'possible_conflict', status: 'confirmed' },
    ]);
  });

  it('holds a plan that cites the disputed passage for the manager, naming the two pages and the heading, and lets it go once both hold', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId } = await disagreement(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    const { citations } = await selection(harness, agentId);
    const disputed = citations.find((citation) => citation.conflict !== undefined)!;
    const workItemId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-12',
          title: 'Escalate the variance',
          contentSummary: 'A variance above the threshold needs the finance lead.',
          contentRefs: [],
          observedAt: 1,
          createdAt: 1,
          state: 'plan-pending',
          plan: {
            summary: 'Escalate the variance to the finance lead.',
            steps: ['Message the finance lead when the variance passes the threshold'],
            expectedOutputType: 'slack-reply',
            riskNotes: '',
            reversibility: 'A message.',
            estimatedMinutes: 5,
            cites: [{ step: 1, ...disputed }],
          },
        }),
    );
    expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
      approved: false,
    });
    expect(await eventsOf(harness, agentId, 'work.plan-held')).toEqual([
      {
        workItemId,
        reason: 'documentation-conflict',
        relationId,
        heading: 'Thresholds',
        pages: [
          { title: 'Finance escalation', source: 'Finance wiki' },
          { title: 'Pipeline runbook', source: 'Handbook' },
        ],
      },
    ]);
    expect((await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.state).toBe(
      'plan-pending',
    );
    // "Both hold": nothing disputes the passage any more, and the sweep's next look approves it.
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'both-hold',
    });
    expect(
      await harness.mutation(internal.work.decidePlan, { workItemId, recovery: true }),
    ).toEqual({ approved: true });
  });

  it('holds nothing for a plan that cites other passages of the same pages', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId } = await disagreement(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    const workItemId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-13',
          title: 'Refresh the tile',
          contentSummary: 'The tile is stale.',
          contentRefs: [],
          observedAt: 1,
          createdAt: 1,
          state: 'plan-pending',
          plan: {
            summary: 'Refresh the tile.',
            steps: ['Press Refresh'],
            expectedOutputType: 'ticket-update',
            riskNotes: '',
            reversibility: 'Nothing is written.',
            estimatedMinutes: 5,
            cites: [
              {
                step: 1,
                label: 'Handbook/runbooks/pipeline-runbook.md#Pipeline runbook > Refresh',
                blocks: [],
              },
            ],
          },
        }),
    );
    expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
      approved: true,
    });
  });
});
