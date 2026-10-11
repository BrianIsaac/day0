import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { replacePageBlocks } from '../../convex/docBlocks';
import { forgetProposalsOf } from '../../convex/docRelationProposals';
import { RELATION_PROPOSALS_PER_SYNC } from '../../src/docs/relations';
import { allConvexModules } from './all-modules';
import {
  FINANCE,
  PIPELINE_V1,
  PIPELINE_V2,
  asManager,
  employee,
  eventsOf,
  measure,
  pageOf,
  relations,
  storedPage,
  syncingSource,
  twoThatDisagree,
  twoVersions,
  type Harness,
  type Source,
} from './fakes/doc-relations';

// A decision that supersedes a page re-admits parked work, which schedules its next step.
beforeEach((): void => {
  vi.useFakeTimers();
});
afterEach((): void => {
  vi.useRealTimers();
});

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

describe('measuring a library of more pages than one step takes (W15-R5)', (): void => {
  /** A completed walk of a source: the run a finished sync measures. */
  async function completedWalk(harness: Harness, sourceId: Id<'docSources'>): Promise<Source> {
    return await harness.run(async (ctx) => {
      const runs = await ctx.db
        .query('docSyncRuns')
        .withIndex('by_source', (q) => q.eq('sourceId', sourceId))
        .collect();
      const runId = await ctx.db.insert('docSyncRuns', {
        sourceId,
        listing: runs.length + 1,
        credentialRefs: [],
        pageCount: 0,
        redactionCount: 0,
        state: 'completed',
        createdAt: runs.length + 2,
        completedAt: runs.length + 2,
      });
      for (const run of runs) {
        if (run.state === 'running') await ctx.db.patch(run._id, { state: 'completed' });
      }
      await ctx.db.patch(sourceId, { lastCompletedSyncId: runId, activeSyncId: undefined });
      return { sourceId, runId };
    });
  }

  /** Measure a completed walk's pages as its finish schedules it, every step of it. */
  async function measureWalk(harness: Harness, walk: Source): Promise<void> {
    await harness.action(internal.docSyncActions.proposeRelations, walk);
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
  }

  it('measures the pages past the first hundred: a later version stored 120th is proposed', async (): Promise<void> => {
    // Reader 2's vt/c.test.ts R2-H: 130 stored pages, only the 121st and 122nd related. Each
    // page holds four sections, so the walk's blocks are more than one read of them.
    const harness = convexTest(schema, allConvexModules());
    const library = await syncingSource(harness, 'Library');
    for (let index = 0; index < 130; index += 1) {
      const related = index === 120 || index === 121;
      const title = related
        ? index === 120
          ? 'Zebra quartz runbook'
          : 'Zebra quartz runbook v2'
        : `Unrelated topic number ${index} qx${index}`;
      await storedPage(harness, library, {
        ref: related ? `zebra-${index}.md` : `p${index}.md`,
        title,
        markdown: [
          ...(index === 121 ? ['---', 'supersedes: zebra-120', '---'] : []),
          `# ${title}`,
          '',
          `Content unique to page ${index} word${index} alpha${index}.`,
          ...['One', 'Two', 'Three'].flatMap((section) => [
            '',
            `## ${section} of ${index}`,
            '',
            `Section ${section.toLowerCase()} of page ${index}: beta${index} gamma${index}.`,
          ]),
        ].join('\n'),
        updatedAt: 1 + index,
      });
    }
    await harness.run(
      async (ctx) =>
        await ctx.db.patch(library.sourceId, {
          lastCompletedSyncId: library.runId,
          activeSyncId: undefined,
        }),
    );
    await measureWalk(harness, library);
    expect(await relations(harness)).toMatchObject([
      {
        kind: 'possible_successor',
        status: 'proposed',
        from: { ref: 'zebra-121.md' },
        to: { ref: 'zebra-120.md' },
      },
    ]);
    // Nothing is owed once every page was measured, and a walk that changes nothing adds nothing.
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(library.sourceId)))?.relationsOwed,
    ).toBeUndefined();
    await measureWalk(harness, await completedWalk(harness, library.sourceId));
    expect(await relations(harness)).toHaveLength(1);
  }, 120_000);

  it('goes on at the next sync from where the cap on new proposals stopped it, and owes nothing once it reaches the end', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    // Seventeen runbooks of three later versions each hold fifty-one relations; two more pages
    // stored after them hold a fifty-second.
    const first = await syncingSource(harness, 'Runbooks');
    const later = [
      await syncingSource(harness, 'Second editions'),
      await syncingSource(harness, 'Third editions'),
      await syncingSource(harness, 'Fourth editions'),
    ];
    const words =
      'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November Oscar Papa Quebec';
    for (const word of words.split(' ')) {
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
    await storedPage(harness, first, {
      ref: 'Zulu.md',
      title: 'Zulu',
      markdown: '# Zulu\n\nZulu procedure, in full.',
    });
    await storedPage(harness, later[0], {
      ref: 'Zulu-v2.md',
      title: 'Zulu v2',
      markdown: '# Zulu\n\nZulu procedure, in full.',
      updatedAt: 2,
    });
    const owed = async () =>
      (await harness.run(async (ctx) => await ctx.db.get(first.sourceId)))?.relationsOwed;
    await harness.run(
      async (ctx) =>
        await ctx.db.patch(first.sourceId, {
          lastCompletedSyncId: first.runId,
          activeSyncId: undefined,
        }),
    );
    await measureWalk(harness, first);
    expect(await relations(harness)).toHaveLength(RELATION_PROPOSALS_PER_SYNC);
    // The cap ended the measuring inside the walk's pages: what is left is kept on the source.
    expect(await owed()).toEqual({ generations: [first.runId], cursor: null });
    // The next sync changes no page, so its own walk wrote nothing: it measures what is owed.
    await measureWalk(harness, await completedWalk(harness, first.sourceId));
    expect(await relations(harness)).toHaveLength(RELATION_PROPOSALS_PER_SYNC + 2);
    expect(await owed()).toBeUndefined();
    // And two syncs on, the first walk's pages are out of the look-back and still nothing is lost.
    await measureWalk(harness, await completedWalk(harness, first.sourceId));
    expect(await relations(harness)).toHaveLength(RELATION_PROPOSALS_PER_SYNC + 2);
  }, 120_000);
});

describe('forgetProposalsOf: the proposals a page its source dropped leaves behind', (): void => {
  it('deletes the proposals that name the removed page, which no card could draw', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { wiki, official } = await twoVersions(harness);
    expect(await measure(harness, official, 'pipeline-runbook-v2.md')).toBe(1);
    await harness.run(
      async (ctx) => await forgetProposalsOf(ctx, wiki.sourceId, ['runbooks/pipeline-runbook.md']),
    );
    expect(await relations(harness)).toEqual([]);
  });

  it('keeps a relation the manager answered, which is their answer', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { wiki, official } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'keep-both',
    });
    await harness.run(
      async (ctx) => await forgetProposalsOf(ctx, wiki.sourceId, ['runbooks/pipeline-runbook.md']),
    );
    expect(await relations(harness)).toEqual([
      expect.objectContaining({
        _id: relation._id,
        kind: 'possible_duplicate',
        status: 'confirmed',
      }),
    ]);
  });
});
