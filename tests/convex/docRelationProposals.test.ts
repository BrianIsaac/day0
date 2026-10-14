import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { replacePageBlocks } from '../../convex/docBlocks';
import { forgetProposalsOf } from '../../convex/docRelationProposals';
import {
  DATED_SUCCESSOR_GAP_MS,
  RELATION_MEASURE_TRIES,
  RELATION_PAGES_PER_STEP,
  RELATION_PROPOSALS_PER_SYNC,
} from '../../src/docs/relations';
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

  it('proposes a successor over a pair answered "Not the same" or "Keep both" once a page’s front matter names the other (W15-R22)', async (): Promise<void> => {
    for (const answer of ['not-the-same', 'keep-both'] as const) {
      const harness = convexTest(schema, allConvexModules());
      const wiki = await syncingSource(harness, 'Team wiki');
      const official = await syncingSource(harness, 'Official runbooks');
      await storedPage(harness, wiki, {
        ref: 'runbooks/pipeline-runbook.md',
        title: 'Pipeline runbook',
        markdown: PIPELINE_V1,
      });
      const copy = PIPELINE_V1.replace('# Pipeline runbook', '# Tile refresh');
      await storedPage(harness, official, {
        ref: 'tile.md',
        title: 'Tile refresh',
        markdown: copy,
      });
      expect(await measure(harness, official, 'tile.md')).toBe(1);
      const [answered] = await relations(harness);
      expect(answered.kind).toBe('possible_duplicate');
      await asManager(harness).mutation(api.docRelations.decide, {
        relationId: answered._id,
        decision: answer,
      });
      // Measured again as it stands, the answer holds.
      expect(await measure(harness, official, 'tile.md')).toBe(0);
      // The author then writes that the page supersedes the runbook.
      await harness.run(async (ctx) => {
        const page = await ctx.db
          .query('docPages')
          .withIndex('by_source_ref', (q) =>
            q.eq('sourceId', official.sourceId).eq('ref', 'tile.md'),
          )
          .unique();
        const markdown = `---\nsupersedes: pipeline-runbook\n---\n${copy}`;
        await ctx.db.patch(page!._id, { markdown });
        await replacePageBlocks(ctx, {
          userId: 'owner',
          sourceId: official.sourceId,
          pageRef: 'tile.md',
          generation: official.runId,
          markdown,
        });
      });
      expect(await measure(harness, official, 'tile.md')).toBe(1);
      const rows = await relations(harness);
      expect(rows.map((row) => [row.kind, row.status])).toEqual([
        ['possible_duplicate', answer === 'keep-both' ? 'confirmed' : 'dismissed'],
        ['possible_successor', 'proposed'],
      ]);
      expect(rows[1].evidence[0]).toEqual({ measure: 'names-successor', value: 1 });
      // And once proposed, measured again it is not proposed twice.
      expect(await measure(harness, official, 'tile.md')).toBe(0);
    }
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
    expect((await asManager(harness).query(api.docRelations.listOpen, {})).cards).toEqual([]);
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
    // Re-taken by D-12 (a): the measure is a pair a transaction from the measuring's action, and
    // answers that the run no longer measures, with no pair failed or passed over.
    expect(
      await harness.action(internal.docSyncActions.measurePage, {
        sourceId: official.sourceId,
        syncRunId: wiki.runId,
        ref: 'pipeline-runbook-v2.md',
      }),
    ).toEqual({ current: false, proposed: 0, cut: false, failed: [], passedOver: [] });
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
      await harness.action(internal.docSyncActions.measurePage, {
        sourceId: first.sourceId,
        syncRunId: first.runId,
        ref: 'Alpha.md',
        room: 1,
      }),
      // Its room ended it with two candidates unmeasured, and it says so (W16-R34). Re-taken by
      // D-12 (a): a pair a transaction, the answer naming the pairs failed and passed over.
    ).toEqual({ current: true, proposed: 1, cut: true, failed: [], passedOver: [] });
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
      // Re-taken by D-12 (a): a step's answer names what it passed over, here nothing.
    ).toEqual({ measured: 17, proposed: RELATION_PROPOSALS_PER_SYNC, passedOver: [] });
    expect(await relations(harness)).toHaveLength(RELATION_PROPOSALS_PER_SYNC);
  });
});

describe('measuring a library of more pages than one step takes (W15-R5)', (): void => {
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

  it('owes no run that wrote no block, however many capped syncs follow (the pre-tag bed, 16-FD to the joins)', async (): Promise<void> => {
    // Wave 15's pre-tag bed: `relationsOwed.generations` gained a run id at every sync the cap
    // stopped, though a sync that changed no page wrote no blocks to measure.
    const harness = convexTest(schema, allConvexModules());
    const first = await syncingSource(harness, 'Runbooks');
    await storedPage(harness, first, {
      ref: 'Alpha.md',
      title: 'Alpha',
      markdown: '# Alpha\n\nA.',
    });
    await harness.run(
      async (ctx) =>
        await ctx.db.patch(first.sourceId, {
          relationsOwed: { generations: [first.runId], cursor: 'stopped-here' },
        }),
    );
    for (let sync = 0; sync < 3; sync += 1) {
      const walk = await completedWalk(harness, first.sourceId);
      expect(
        await harness.query(internal.docRelations.measuringPlan, {
          sourceId: first.sourceId,
          runId: walk.runId,
        }),
      ).toEqual({ generations: [first.runId], cursor: 'stopped-here' });
    }
  });
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

  it('keeps the proposals that name only pages its source still has', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { wiki, official } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    await harness.run(async (ctx) => await forgetProposalsOf(ctx, wiki.sourceId, ['other.md']));
    await harness.run(
      async (ctx) =>
        await forgetProposalsOf(ctx, official.sourceId, ['runbooks/pipeline-runbook.md']),
    );
    expect(await relations(harness)).toEqual([
      expect.objectContaining({ _id: relation._id, status: 'proposed' }),
    ]);
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

describe('the dated successor between copies (RM19 (a))', (): void => {
  const DAY = DATED_SUCCESSOR_GAP_MS;
  /** The tile runbook as the company folder holds it, and a copy edited three days later. */
  const RUNBOOK = [
    '# How to refresh the Looker pipeline tile',
    '',
    'Use the looker-pipeline-tile surface for the pipeline coverage figure on the tile.',
    '',
    '## Action shapes',
    '',
    'Open the documented page, fill the login form, submit the login, then save the figure.',
    '',
    '## Discipline',
    '',
    'Keep navigation on the tile; a redirect to another origin is a refusal.',
  ].join('\n');

  /** The company folder's runbook and, in a second source, its copy, each with its own edit time. */
  async function twoCopies(
    harness: Harness,
    copyKind: 'folder' | 'urls' | 'git' = 'folder',
    dated: { runbook?: boolean; copy?: boolean } = {},
  ): Promise<{ folder: Source; copies: Source }> {
    const folder = await syncingSource(harness, 'Company folder');
    const copies = await syncingSource(harness, 'Team copies');
    await harness.run(async (ctx) => await ctx.db.patch(copies.sourceId, { kind: copyKind }));
    await storedPage(harness, folder, {
      ref: 'revops/runbooks/how-to-refresh-the-tile.md',
      title: 'How to refresh the Looker pipeline tile',
      markdown: RUNBOOK,
      updatedAt: 10 * DAY,
      ...(dated.runbook !== undefined ? { datedBySource: dated.runbook } : {}),
    });
    await storedPage(harness, copies, {
      ref: 'tile-refresh.md',
      title: 'Refreshing the pipeline tile',
      markdown: RUNBOOK.replace(
        '# How to refresh the Looker pipeline tile',
        '# Refreshing the pipeline tile',
      ),
      updatedAt: 13 * DAY,
      ...(dated.copy !== undefined ? { datedBySource: dated.copy } : {}),
    });
    return { folder, copies };
  }

  it('proposes the copy its source edited three days later as the successor, the days on its evidence and its event', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { folder, copies } = await twoCopies(harness);
    const agentId = await employee(harness, 'Priya');
    expect(await measure(harness, folder, 'revops/runbooks/how-to-refresh-the-tile.md')).toBe(1);
    const [relation, ...rest] = await relations(harness);
    expect(rest).toEqual([]);
    expect(relation).toMatchObject({
      kind: 'possible_successor',
      status: 'proposed',
      from: { sourceId: copies.sourceId, ref: 'tile-refresh.md' },
      to: { sourceId: folder.sourceId, ref: 'revops/runbooks/how-to-refresh-the-tile.md' },
    });
    expect(relation.evidence.map(({ measure, value }) => ({ measure, value }))).toEqual([
      { measure: 'shared-text', value: 100 },
      { measure: 'edit-dates', value: 3 },
    ]);
    const [proposed] = await eventsOf(harness, agentId, 'documentation.relation-proposed');
    expect(proposed).toMatchObject({
      kind: 'possible_successor',
      evidence: [
        { measure: 'shared-text', value: 100 },
        { measure: 'edit-dates', value: 3 },
      ],
    });
  });

  it('keeps a copy read from a list of URLs a duplicate: its time is when it was read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { folder } = await twoCopies(harness, 'urls');
    expect(await measure(harness, folder, 'revops/runbooks/how-to-refresh-the-tile.md')).toBe(1);
    expect(await relations(harness)).toMatchObject([{ kind: 'possible_duplicate' }]);
  });

  it('keeps a copy in a git checkout a duplicate: its time is when the checkout wrote the file (the second pass)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { folder } = await twoCopies(harness, 'git');
    expect(await measure(harness, folder, 'revops/runbooks/how-to-refresh-the-tile.md')).toBe(1);
    expect(await relations(harness)).toMatchObject([{ kind: 'possible_duplicate' }]);
  });

  it('proposes no successor for a pair one of whose pages is dated by the time it was read, though its kind gives edit times (D-8 (a))', async (): Promise<void> => {
    // 16-FD's bed's team copy, read by a reader that fell back to the time it read the page.
    const harness = convexTest(schema, allConvexModules());
    const { folder } = await twoCopies(harness, 'folder', { runbook: true, copy: false });
    expect(await measure(harness, folder, 'revops/runbooks/how-to-refresh-the-tile.md')).toBe(1);
    const [relation] = await relations(harness);
    expect(relation).toMatchObject({ kind: 'possible_duplicate', status: 'proposed' });
    expect(relation.evidence.map(({ measure }) => measure)).toEqual(['shared-text']);
  });

  it('proposes the successor between two pages their sources dated, whatever their kinds (D-8 (a))', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { folder } = await twoCopies(harness, 'urls', { runbook: true, copy: true });
    expect(await measure(harness, folder, 'revops/runbooks/how-to-refresh-the-tile.md')).toBe(1);
    const [relation] = await relations(harness);
    expect(relation).toMatchObject({ kind: 'possible_successor', status: 'proposed' });
    expect(relation.evidence.map(({ measure, value }) => ({ measure, value }))).toEqual([
      { measure: 'shared-text', value: 100 },
      { measure: 'edit-dates', value: 3 },
    ]);
  });

  it('gives an unanswered dated successor way to the duplicate once a page turns out dated by its read, and leaves one the manager answered', async (): Promise<void> => {
    for (const answered of [undefined, 'confirmed', 'dismissed'] as const) {
      const harness = convexTest(schema, allConvexModules());
      const { folder, copies } = await twoCopies(harness, 'folder', { copy: false });
      // What 0.20.0's measure proposed for the pair by its sources' kinds: a dated successor.
      const earlier = await harness.run(
        async (ctx) =>
          await ctx.db.insert('docRelations', {
            userId: 'owner',
            from: { sourceId: copies.sourceId, ref: 'tile-refresh.md' },
            to: { sourceId: folder.sourceId, ref: 'revops/runbooks/how-to-refresh-the-tile.md' },
            kind: 'possible_successor',
            evidence: [
              { measure: 'shared-text', value: 100 },
              { measure: 'edit-dates', value: 3 },
            ],
            status: answered ?? 'proposed',
            createdAt: 1,
            ...(answered !== undefined ? { decidedAt: 2 } : {}),
          }),
      );
      const measuredNow = await measure(
        harness,
        folder,
        'revops/runbooks/how-to-refresh-the-tile.md',
      );
      const rows = await relations(harness);
      if (answered === undefined) {
        expect(measuredNow).toBe(1);
        expect(rows).toMatchObject([{ kind: 'possible_duplicate', status: 'proposed' }]);
        expect(rows[0]._id).not.toBe(earlier);
      } else {
        expect(measuredNow).toBe(0);
        expect(rows).toMatchObject([
          { _id: earlier, kind: 'possible_successor', status: answered },
        ]);
      }
    }
  });

  it('removes a stale dated successor at the next measure once a fill changes a page’s dating, kept or stored again (W17-R16)', async (): Promise<void> => {
    // The review's W17-R16: the K-2 fill wrote the field and nothing else, and a kept page is
    // never measured again, so a 0.20.0 dated successor whose page is now dated by its read stood
    // with its card saying "last read" beside "edited 3 days after".
    for (const fill of ['kept by its hash', 'stored unchanged'] as const) {
      const harness = convexTest(schema, allConvexModules());
      const { folder, copies } = await twoCopies(harness);
      expect(await measure(harness, folder, 'revops/runbooks/how-to-refresh-the-tile.md')).toBe(1);
      expect(await relations(harness)).toMatchObject([
        { kind: 'possible_successor', status: 'proposed' },
      ]);
      // The next sync of the copies meets the copy unchanged, and its reader says its time is
      // when it read it.
      if (fill === 'kept by its hash') {
        await harness.mutation(internal.docStatus.recordRead, {
          sourceId: copies.sourceId,
          syncRunId: copies.runId,
          ref: 'tile-refresh.md',
          datedBySource: false,
        });
      } else {
        const page = (await harness.run(
          async (ctx) =>
            await ctx.db
              .query('docPages')
              .withIndex('by_source_ref', (q) =>
                q.eq('sourceId', copies.sourceId).eq('ref', 'tile-refresh.md'),
              )
              .unique(),
        ))!;
        await harness.mutation(internal.docSources.upsertPage, {
          sourceId: copies.sourceId,
          syncRunId: copies.runId,
          ref: page.ref,
          title: page.title,
          markdown: page.markdown,
          updatedAt: page.updatedAt,
          datedBySource: false,
        });
      }
      // Two syncs that changed nothing put both pages out of every look-back: only a mark on the
      // source owes them a measure.
      for (const source of [folder, copies]) {
        await completedWalk(harness, source.sourceId);
        await completedWalk(harness, source.sourceId);
      }
      await harness.action(
        internal.docSyncActions.proposeRelations,
        await completedWalk(harness, copies.sourceId),
      );
      await harness.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await relations(harness), fill).toMatchObject([
        { kind: 'possible_duplicate', status: 'proposed' },
      ]);
      expect(
        (await harness.run(async (ctx) => await ctx.db.get(copies.sourceId)))?.relationsRemeasure,
      ).toBeUndefined();
    }
  });

  it('finds the proposal a fill’s dating rests on behind any number of older relations, and starts a remeasure under way again from the start (the second pass)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { folder, copies } = await twoCopies(harness);
    // Forty answered relations of the copy, older than the unanswered dated successor.
    await harness.run(async (ctx) => {
      for (let index = 0; index < 40; index += 1) {
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: copies.sourceId, ref: 'tile-refresh.md' },
          to: { sourceId: folder.sourceId, ref: `older-${index}.md` },
          kind: 'possible_duplicate',
          evidence: [{ measure: 'shared-text', value: 70 }],
          status: 'dismissed',
          createdAt: index,
          decidedAt: index,
        });
      }
    });
    expect(await measure(harness, folder, 'revops/runbooks/how-to-refresh-the-tile.md')).toBe(1);
    // A remeasure already under way, part of the way through the copies.
    await harness.run(
      async (ctx) =>
        await ctx.db.patch(copies.sourceId, { relationsRemeasure: { cursor: 'part-way' } }),
    );
    await harness.mutation(internal.docStatus.recordRead, {
      sourceId: copies.sourceId,
      syncRunId: copies.runId,
      ref: 'tile-refresh.md',
      datedBySource: false,
    });
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(copies.sourceId)))?.relationsRemeasure,
    ).toEqual({ cursor: null });
  });

  it('marks no source for a fill that leaves a page’s dating as its kind gave it, or where no card rests on it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { folder, copies } = await twoCopies(harness);
    const remeasureOf = async (sourceId: Id<'docSources'>) =>
      (await harness.run(async (ctx) => await ctx.db.get(sourceId)))?.relationsRemeasure;
    // A folder's file is dated by its source: the fill says what the kind said.
    await harness.mutation(internal.docStatus.recordRead, {
      sourceId: folder.sourceId,
      syncRunId: folder.runId,
      ref: 'revops/runbooks/how-to-refresh-the-tile.md',
      datedBySource: true,
    });
    // No relation of the copy yet: nothing a measure would take back.
    await harness.mutation(internal.docStatus.recordRead, {
      sourceId: copies.sourceId,
      syncRunId: copies.runId,
      ref: 'tile-refresh.md',
      datedBySource: false,
    });
    expect([await remeasureOf(folder.sourceId), await remeasureOf(copies.sourceId)]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('gives an unanswered duplicate of the pair way to the successor, and leaves one the manager answered', async (): Promise<void> => {
    for (const answered of [undefined, 'confirmed', 'dismissed'] as const) {
      const harness = convexTest(schema, allConvexModules());
      const { folder, copies } = await twoCopies(harness);
      // What v0.19.0's measure proposed for the pair: a duplicate, the later copy first.
      const earlier = await harness.run(
        async (ctx) =>
          await ctx.db.insert('docRelations', {
            userId: 'owner',
            from: { sourceId: copies.sourceId, ref: 'tile-refresh.md' },
            to: { sourceId: folder.sourceId, ref: 'revops/runbooks/how-to-refresh-the-tile.md' },
            kind: 'possible_duplicate',
            evidence: [{ measure: 'shared-text', value: 100 }],
            status: answered ?? 'proposed',
            createdAt: 1,
            ...(answered !== undefined ? { decidedAt: 2 } : {}),
          }),
      );
      const measuredNow = await measure(
        harness,
        folder,
        'revops/runbooks/how-to-refresh-the-tile.md',
      );
      const rows = await relations(harness);
      if (answered === undefined) {
        expect(measuredNow).toBe(1);
        expect(rows).toMatchObject([{ kind: 'possible_successor', status: 'proposed' }]);
        expect(rows[0]._id).not.toBe(earlier);
      } else {
        // The manager's answer stands: "Keep both" and "Not the same" are not asked again.
        expect(measuredNow).toBe(0);
        expect(rows).toMatchObject([
          { _id: earlier, kind: 'possible_duplicate', status: answered },
        ]);
      }
    }
  });
});

describe('the existing library measured once by the dated successor (RM19 (a), the remeasure pass)', (): void => {
  const DAY = DATED_SUCCESSOR_GAP_MS;

  /** A completed run of a source that wrote no page: a later sync that changed nothing. */
  async function quietWalk(harness: Harness, sourceId: Id<'docSources'>): Promise<Source> {
    return await harness.run(async (ctx) => {
      const runs = await ctx.db
        .query('docSyncRuns')
        .withIndex('by_source', (q) => q.eq('sourceId', sourceId))
        .collect();
      for (const run of runs) {
        if (run.state === 'running') await ctx.db.patch(run._id, { state: 'completed' });
      }
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
      await ctx.db.patch(sourceId, { lastCompletedSyncId: runId, activeSyncId: undefined });
      return { sourceId, runId };
    });
  }

  async function measureWalk(harness: Harness, walk: Source): Promise<void> {
    await harness.action(internal.docSyncActions.proposeRelations, walk);
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
  }

  const owed = async (harness: Harness, sourceId: Id<'docSources'>) =>
    (await harness.run(async (ctx) => await ctx.db.get(sourceId)))?.relationsRemeasure;

  it('measures every stored page past the look-back from the pass’s mark, past one step’s pages, and clears the mark at the end', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const library = await syncingSource(harness, 'Library');
    // More pages than one step measures; the two copies are stored last, edited six days apart.
    for (let index = 0; index < RELATION_PAGES_PER_STEP + 5; index += 1) {
      await storedPage(harness, library, {
        ref: `p${index}.md`,
        title: `Unrelated topic number ${index} qx${index}`,
        markdown: `# Unrelated topic number ${index} qx${index}\n\nContent unique to page ${index} word${index}.`,
        updatedAt: 1 + index,
      });
    }
    const runbook = '# Zebra quartz runbook\n\nPress Refresh once and read back the zebra figure.';
    await storedPage(harness, library, {
      ref: 'zebra.md',
      title: 'Zebra quartz runbook',
      markdown: runbook,
      updatedAt: 2 * DAY,
    });
    await storedPage(harness, library, {
      ref: 'zebra-copy.md',
      title: 'Zebra quartz notes',
      markdown: runbook.replace('# Zebra quartz runbook', '# Zebra quartz notes'),
      updatedAt: 8 * DAY,
    });
    // As v0.19.0 left it: the pair proposed as a duplicate, then two syncs that changed nothing,
    // so the pages are out of the measuring's look-back.
    await harness.run(async (ctx) => {
      await ctx.db.insert('docRelations', {
        userId: 'owner',
        from: { sourceId: library.sourceId, ref: 'zebra-copy.md' },
        to: { sourceId: library.sourceId, ref: 'zebra.md' },
        kind: 'possible_duplicate',
        evidence: [{ measure: 'shared-text', value: 100 }],
        status: 'proposed',
        createdAt: 1,
      });
    });
    await quietWalk(harness, library.sourceId);
    const second = await quietWalk(harness, library.sourceId);
    // Without the pass's mark, the quiet sync measures nothing and the duplicate stays.
    await measureWalk(harness, second);
    expect(await relations(harness)).toMatchObject([{ kind: 'possible_duplicate' }]);
    // The pass marks the source owed from its start; the next sync measures the whole library.
    await harness.run(
      async (ctx) => await ctx.db.patch(library.sourceId, { relationsRemeasure: { cursor: null } }),
    );
    await measureWalk(harness, await quietWalk(harness, library.sourceId));
    expect(await relations(harness)).toMatchObject([
      {
        kind: 'possible_successor',
        status: 'proposed',
        from: { ref: 'zebra-copy.md' },
        to: { ref: 'zebra.md' },
        evidence: [
          { measure: 'shared-text', value: 100 },
          { measure: 'edit-dates', value: 6 },
        ],
      },
    ]);
    expect(await owed(harness, library.sourceId)).toBeUndefined();
    // Measured once: the next quiet sync measures nothing again.
    await measureWalk(harness, await quietWalk(harness, library.sourceId));
    expect(await relations(harness)).toHaveLength(1);
  }, 120_000);

  it('keeps its place under the cap on new proposals, and goes on from there at the next sync', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const library = await syncingSource(harness, 'Library');
    // Sixty pairs of copies, each copy edited two days after its first: more than the cap.
    const PAIRS = RELATION_PROPOSALS_PER_SYNC + 10;
    for (let index = 0; index < PAIRS; index += 1) {
      // No word is shared between pairs, so each page's search finds its own copy.
      const word = `zq${index}x`;
      const markdown = `# ${word}\n\n${word}a ${word}b ${word}c, in full.`;
      await storedPage(harness, library, {
        ref: `${word}.md`,
        title: word,
        markdown,
        updatedAt: index,
      });
      await storedPage(harness, library, {
        ref: `${word}-copy.md`,
        title: `${word} ${word}d`,
        markdown: markdown.replace(`# ${word}`, `# ${word} ${word}d`),
        updatedAt: index + 2 * DAY,
      });
    }
    await quietWalk(harness, library.sourceId);
    await quietWalk(harness, library.sourceId);
    await harness.run(
      async (ctx) => await ctx.db.patch(library.sourceId, { relationsRemeasure: { cursor: null } }),
    );
    await measureWalk(harness, await quietWalk(harness, library.sourceId));
    expect(await relations(harness)).toHaveLength(RELATION_PROPOSALS_PER_SYNC);
    expect(await owed(harness, library.sourceId)).toBeDefined();
    await measureWalk(harness, await quietWalk(harness, library.sourceId));
    expect(await relations(harness)).toHaveLength(PAIRS);
    expect(await owed(harness, library.sourceId)).toBeUndefined();
  }, 120_000);
});

describe('the candidates of a page in its own source (found on the 16-FD bed)', (): void => {
  it('finds a copy in the same source though the page’s own blocks answer its search first', async (): Promise<void> => {
    // The bed's company folder: a team copy of the tile runbook, edited three days later, drew no
    // proposal. Its own blocks took the four places its source's search answers, so the runbook
    // it copies was never measured against it.
    const harness = convexTest(schema, allConvexModules());
    const folder = await syncingSource(harness, 'Company folder');
    const sections = ['Sign in', 'Refresh', 'Read back', 'Post', 'Discipline'].flatMap(
      (heading) => [
        '',
        `## ${heading}`,
        '',
        `${heading} for the Looker pipeline tile refresh, as the runbook says.`,
      ],
    );
    const runbook = ['# How to refresh the Looker pipeline tile', ...sections].join('\n');
    const DAY = DATED_SUCCESSOR_GAP_MS;
    // The copy is stored first, so its own blocks lead every search that matches it.
    await storedPage(harness, folder, {
      ref: 'revops/runbooks/tile-refresh-team-copy.md',
      title: 'How to refresh the Looker pipeline tile, team copy',
      markdown: runbook.replace(
        '# How to refresh the Looker pipeline tile',
        '# How to refresh the Looker pipeline tile, team copy',
      ),
      updatedAt: 8 * DAY,
    });
    await storedPage(harness, folder, {
      ref: 'revops/runbooks/how-to-refresh-the-tile.md',
      title: 'How to refresh the Looker pipeline tile',
      markdown: runbook,
      updatedAt: 5 * DAY,
    });
    expect(await measure(harness, folder, 'revops/runbooks/tile-refresh-team-copy.md')).toBe(1);
    expect(await relations(harness)).toMatchObject([
      {
        kind: 'possible_successor',
        from: { ref: 'revops/runbooks/tile-refresh-team-copy.md' },
        to: { ref: 'revops/runbooks/how-to-refresh-the-tile.md' },
      },
    ]);
  });
});

describe('a duplicate beside the conflict of its pair (the joins’ W3d)', (): void => {
  /** The joins' review-window pair: two folders' pages that give 2 and 5 working days. */
  async function reviewWindows(harness: Harness): Promise<{ policies: Source; revops: Source }> {
    const policies = await syncingSource(harness, 'Policies folder');
    const revops = await syncingSource(harness, 'Revops folder');
    const body = (days: number): string =>
      [
        '# Close review window',
        '',
        'How soon a Q3 close ticket in Linear is reviewed once its work is posted.',
        '',
        '## Review window',
        '',
        `A Q3 close ticket is reviewed within ${days} working days of its audit comment.`,
        '',
        '## Who reviews',
        '',
        'The revenue operations manager checks every close ticket.',
      ].join('\n');
    await storedPage(harness, policies, {
      ref: 'close-review-window.md',
      title: 'Close review window',
      markdown: body(5),
    });
    await storedPage(harness, revops, {
      ref: 'runbooks/close-review-window.md',
      title: 'Close review window',
      markdown: body(2),
      updatedAt: 2,
    });
    return { policies, revops };
  }

  /** The duplicate 0.20.0's measure proposed for the pair, its differing line passed over. */
  async function duplicateOf(
    harness: Harness,
    pair: { policies: Source; revops: Source },
    status: 'proposed' | 'confirmed',
  ): Promise<Id<'docRelations'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: pair.revops.sourceId, ref: 'runbooks/close-review-window.md' },
          to: { sourceId: pair.policies.sourceId, ref: 'close-review-window.md' },
          kind: 'possible_duplicate',
          evidence: [{ measure: 'shared-text', value: 63 }],
          status,
          createdAt: 1,
          ...(status === 'confirmed' ? { decidedAt: 2 } : {}),
        }),
    );
  }

  it('proposes the pair as a conflict, and the duplicate nobody answered goes with it: one card a pair', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const pair = await reviewWindows(harness);
    await duplicateOf(harness, pair, 'proposed');
    expect(await measure(harness, pair.revops, 'runbooks/close-review-window.md')).toBe(1);
    expect(await relations(harness)).toMatchObject([
      { kind: 'possible_conflict', status: 'proposed' },
    ]);
    // Measured again from the other page, the conflict is held and nothing more is written.
    expect(await measure(harness, pair.policies, 'close-review-window.md')).toBe(0);
    expect(await relations(harness)).toHaveLength(1);
  });

  it('proposes the pair as a conflict, and a dated successor nobody answered goes with it: a proposed dated successor and a new conflict of one pair do not both stand (W17-R17)', async (): Promise<void> => {
    // The review's W17-R17: the conflict branch deleted proposed duplicates only, so the pair's
    // dated successor, proposed before its pages came to disagree, stood beside its conflict.
    const harness = convexTest(schema, allConvexModules());
    const pair = await reviewWindows(harness);
    const dated = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: pair.revops.sourceId, ref: 'runbooks/close-review-window.md' },
          to: { sourceId: pair.policies.sourceId, ref: 'close-review-window.md' },
          kind: 'possible_successor',
          evidence: [
            { measure: 'shared-text', value: 63 },
            { measure: 'edit-dates', value: 3 },
          ],
          status: 'proposed',
          createdAt: 1,
        }),
    );
    expect(await measure(harness, pair.revops, 'runbooks/close-review-window.md')).toBe(1);
    const rows = await relations(harness);
    expect(rows).toMatchObject([{ kind: 'possible_conflict', status: 'proposed' }]);
    expect(rows.map((row) => row._id)).not.toContain(dated);
  });

  it('leaves a duplicate the manager answered beside the conflict: "Keep both" is their answer', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const pair = await reviewWindows(harness);
    const kept = await duplicateOf(harness, pair, 'confirmed');
    expect(await measure(harness, pair.revops, 'runbooks/close-review-window.md')).toBe(1);
    expect(await relations(harness)).toMatchObject([
      { _id: kept, kind: 'possible_duplicate', status: 'confirmed' },
      { kind: 'possible_conflict', status: 'proposed' },
    ]);
  });

  it('leaves the unanswered duplicate where the pair’s conflict was set aside, since no conflict card is drawn for it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const pair = await reviewWindows(harness);
    expect(await measure(harness, pair.revops, 'runbooks/close-review-window.md')).toBe(1);
    const [conflict] = await relations(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: conflict._id,
      decision: 'both-hold',
    });
    const duplicate = await duplicateOf(harness, pair, 'proposed');
    expect(await measure(harness, pair.revops, 'runbooks/close-review-window.md')).toBe(0);
    expect((await relations(harness)).map((row) => [row._id, row.status])).toEqual([
      [conflict._id, 'dismissed'],
      [duplicate, 'proposed'],
    ]);
  });
});

describe('a page whose measure throws (W16-R34)', (): void => {
  const DAY = DATED_SUCCESSOR_GAP_MS;
  const RUNBOOK = '# Zebra quartz runbook\n\nPress Refresh once and read back the zebra figure.';

  /** A library of one runbook and its copy, edited six days later: one pair the measures relate. */
  async function runbookAndCopy(harness: Harness): Promise<Source> {
    const library = await syncingSource(harness, 'Library');
    await storedPage(harness, library, {
      ref: 'zebra.md',
      title: 'Zebra quartz runbook',
      markdown: RUNBOOK,
      updatedAt: 2 * DAY,
    });
    await storedPage(harness, library, {
      ref: 'zebra-copy.md',
      title: 'Zebra quartz notes',
      markdown: RUNBOOK.replace('# Zebra quartz runbook', '# Zebra quartz notes'),
      updatedAt: 8 * DAY,
    });
    return library;
  }

  /**
   * Make every measure that reads the runbook throw, as a measure over a read limit or out of
   * retries does (the review's W16-R34; convex-test enforces no limit): a second row under its
   * ref, which the read of a page by its ref refuses.
   *
   * @returns The row to delete for the measure to pass again.
   */
  async function breakRunbook(harness: Harness, library: Source): Promise<Id<'docPages'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('docPages', {
          sourceId: library.sourceId,
          ref: 'zebra.md',
          title: 'Zebra quartz runbook',
          markdown: RUNBOOK,
          updatedAt: 2 * DAY,
        }),
    );
  }

  const mend = async (harness: Harness, row: Id<'docPages'>): Promise<void> =>
    await harness.run(async (ctx) => await ctx.db.delete(row));

  const remeasureOf = async (harness: Harness, sourceId: Id<'docSources'>) =>
    (await harness.run(async (ctx) => await ctx.db.get(sourceId)))?.relationsRemeasure;

  /** The measuring steps of one kind the scheduler holds or ran, by their arguments. */
  const stepsOf = async (harness: Harness, name: string): Promise<Array<Record<string, unknown>>> =>
    await harness.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect())
        .filter((job) => job.name.endsWith(name))
        .map((job) => job.args[0] as Record<string, unknown>),
    );

  it('tries a page of the sync’s own again at the next step, and proposes its relation once the measure passes', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const library = await runbookAndCopy(harness);
    const broken = await breakRunbook(harness, library);
    await harness.action(internal.docSyncActions.proposeRelations, library);
    expect(await relations(harness)).toEqual([]);
    await mend(harness, broken);
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await relations(harness)).toMatchObject([
      { kind: 'possible_successor', from: { ref: 'zebra-copy.md' }, to: { ref: 'zebra.md' } },
    ]);
  });

  it('keeps the remeasure’s place at the read a measure threw in, and moves on once the page is measured', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const library = await runbookAndCopy(harness);
    // Two syncs that changed nothing: the pages are out of the look-back, owed by the mark alone.
    await completedWalk(harness, library.sourceId);
    await completedWalk(harness, library.sourceId);
    await harness.run(
      async (ctx) => await ctx.db.patch(library.sourceId, { relationsRemeasure: { cursor: null } }),
    );
    const broken = await breakRunbook(harness, library);
    await harness.action(
      internal.docSyncActions.proposeRelations,
      await completedWalk(harness, library.sourceId),
    );
    // The read's pages were not all measured: the mark stands where the read began.
    expect(await remeasureOf(harness, library.sourceId)).toEqual({ cursor: null });
    expect(await relations(harness)).toEqual([]);
    await mend(harness, broken);
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await relations(harness)).toMatchObject([
      { kind: 'possible_successor', from: { ref: 'zebra-copy.md' }, to: { ref: 'zebra.md' } },
    ]);
    expect(await remeasureOf(harness, library.sourceId)).toBeUndefined();
  });

  it('passes a page over after three tries, measures the rest and clears the mark', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const library = await runbookAndCopy(harness);
    // A second pair, stored after the first, that shares no word of a title with it: no search
    // for its candidates answers the broken page, so nothing is in its measure's way.
    const other = '# Okapi ledger\n\nPost the okapi ledger line and file it.';
    await storedPage(harness, library, {
      ref: 'okapi.md',
      title: 'Okapi ledger',
      markdown: other,
      updatedAt: 2 * DAY,
    });
    await storedPage(harness, library, {
      ref: 'okapi-copy.md',
      title: 'Okapi ledger duplicate',
      markdown: other.replace('# Okapi ledger', '# Okapi ledger duplicate'),
      updatedAt: 5 * DAY,
    });
    await completedWalk(harness, library.sourceId);
    await completedWalk(harness, library.sourceId);
    await harness.run(
      async (ctx) => await ctx.db.patch(library.sourceId, { relationsRemeasure: { cursor: null } }),
    );
    await breakRunbook(harness, library);
    await harness.action(
      internal.docSyncActions.proposeRelations,
      await completedWalk(harness, library.sourceId),
    );
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await relations(harness)).toMatchObject([
      { kind: 'possible_successor', from: { ref: 'okapi-copy.md' }, to: { ref: 'okapi.md' } },
    ]);
    expect(await remeasureOf(harness, library.sourceId)).toBeUndefined();
    // Tried at the first step and at two more, each carrying the pages still to try and how
    // often each was, in the source's page order: the copy, whose measure reads the runbook, and
    // the runbook. Re-taken by D-12 (a): of the copy only its pair with the runbook is tried
    // again, each pair being measured in its own transaction.
    const runbook = { sourceId: library.sourceId, ref: 'zebra.md' };
    expect((await stepsOf(harness, 'remeasureRelations')).map((step) => step.retry)).toEqual([
      [
        { ref: 'zebra-copy.md', tries: 1, pairs: [runbook] },
        { ref: 'zebra.md', tries: 1 },
      ],
      [
        { ref: 'zebra-copy.md', tries: 2, pairs: [runbook] },
        { ref: 'zebra.md', tries: 2 },
      ],
    ]);
  });
});

describe('a page whose measure throws, at the edges (the second pass)', (): void => {
  const DAY = DATED_SUCCESSOR_GAP_MS;
  const RUNBOOK = '# Zebra quartz runbook\n\nPress Refresh once and read back the zebra figure.';

  async function runbookAndCopy(harness: Harness): Promise<Source> {
    const library = await syncingSource(harness, 'Library');
    await storedPage(harness, library, {
      ref: 'zebra.md',
      title: 'Zebra quartz runbook',
      markdown: RUNBOOK,
      updatedAt: 2 * DAY,
    });
    await storedPage(harness, library, {
      ref: 'zebra-copy.md',
      title: 'Zebra quartz notes',
      markdown: RUNBOOK.replace('# Zebra quartz runbook', '# Zebra quartz notes'),
      updatedAt: 8 * DAY,
    });
    return library;
  }

  /** A second row under the runbook's ref: every read of the page by its ref then throws. */
  const breakRunbook = async (harness: Harness, library: Source): Promise<void> => {
    await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId: library.sourceId,
        ref: 'zebra.md',
        title: 'Zebra quartz runbook',
        markdown: RUNBOOK,
        updatedAt: 2 * DAY,
      });
    });
  };

  const retriesOf = async (harness: Harness, name: string): Promise<unknown[]> =>
    await harness.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect())
        .filter((job) => job.name.endsWith(name))
        .map((job) => (job.args[0] as { retry?: unknown }).retry),
    );

  it('passes a page of the sync’s own over after three tries, as the remeasure does', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const library = await runbookAndCopy(harness);
    await breakRunbook(harness, library);
    await harness.action(internal.docSyncActions.proposeRelations, library);
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await relations(harness)).toEqual([]);
    // In the order the run wrote them: the runbook, then the copy, whose measure reads it.
    // Re-taken by D-12 (a): of the copy only its pair with the runbook is tried again.
    const runbook = { sourceId: library.sourceId, ref: 'zebra.md' };
    expect(await retriesOf(harness, 'proposeRelations')).toEqual([
      [
        { ref: 'zebra.md', tries: 1 },
        { ref: 'zebra-copy.md', tries: 1, pairs: [runbook] },
      ],
      [
        { ref: 'zebra.md', tries: 2 },
        { ref: 'zebra-copy.md', tries: 2, pairs: [runbook] },
      ],
    ]);
    // Nothing is owed for it: the next sync's own look-back is what measures it again.
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(library.sourceId)))?.relationsOwed,
    ).toBeUndefined();
  });

  it('goes on when a page still to try has left the read by the next step', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const library = await runbookAndCopy(harness);
    await completedWalk(harness, library.sourceId);
    await completedWalk(harness, library.sourceId);
    await harness.run(
      async (ctx) => await ctx.db.patch(library.sourceId, { relationsRemeasure: { cursor: null } }),
    );
    await breakRunbook(harness, library);
    await harness.action(
      internal.docSyncActions.proposeRelations,
      await completedWalk(harness, library.sourceId),
    );
    // The runbook leaves its source before the retry: its rows and its blocks.
    await harness.run(async (ctx) => {
      for (const table of ['docPages', 'docBlocks'] as const) {
        for (const row of await ctx.db.query(table).collect()) {
          const ref = 'pageRef' in row ? row.pageRef : row.ref;
          if (ref === 'zebra.md') await ctx.db.delete(row._id);
        }
      }
    });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    // The copy is measured, with nothing left to relate it to; the measuring reaches its end.
    expect(await relations(harness)).toEqual([]);
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(library.sourceId)))?.relationsRemeasure,
    ).toBeUndefined();
    expect(await retriesOf(harness, 'remeasureRelations')).toHaveLength(1);
  });
});

// D-12 (a) (17-FD's F3, the review's carried row): a measure read its page and every candidate in
// one transaction, so a page whose read breaks threw every measure that read it as a candidate,
// its neighbours' with it, and the log named the page measured, not the candidate whose read
// broke it. Each pair is now measured in a transaction of its own, from the measuring's action.
describe('one pair a transaction (D-12 (a))', (): void => {
  const DAY = DATED_SUCCESSOR_GAP_MS;
  const RUNBOOK = '# Zebra quartz runbook\n\nPress Refresh once and read back the zebra figure.';

  /** 17-FD's F3 input: the runbook and its copy, and a second copy beside them. */
  async function runbookAndCopies(harness: Harness): Promise<Source> {
    const library = await syncingSource(harness, 'Library');
    for (const [ref, title, day] of [
      ['zebra.md', 'Zebra quartz runbook', 2],
      ['zebra-notes.md', 'Zebra quartz notes', 5],
      ['zebra-copy.md', 'Zebra quartz copy', 8],
    ] as const) {
      await storedPage(harness, library, {
        ref,
        title,
        markdown: RUNBOOK.replace('# Zebra quartz runbook', `# ${title}`),
        updatedAt: day * DAY,
      });
    }
    return library;
  }

  /**
   * A second row under the runbook's ref: every read of the page by its ref throws, as a read
   * over a transaction's limit does (17-FD's F3 input; the harness enforces the limits too).
   */
  const breakRunbook = async (harness: Harness, library: Source): Promise<void> => {
    await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId: library.sourceId,
        ref: 'zebra.md',
        title: 'Zebra quartz runbook',
        markdown: RUNBOOK,
        updatedAt: 2 * DAY,
      });
    });
  };

  /** A step's answer. */
  interface StepAnswer {
    readonly measured: number;
    readonly proposed: number;
    readonly passedOver?: ReadonlyArray<{ ref: string; candidate?: { ref: string } }>;
  }

  /** The measuring steps of one name the scheduler holds, run or not, by id. */
  const scheduled = async (
    harness: Harness,
    name: string,
  ): Promise<Array<{ id: string; args: unknown }>> =>
    await harness.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect())
        .filter((row) => row.name.endsWith(name))
        .map((row) => ({ id: row._id as string, args: row.args[0] })),
    );

  /**
   * Run a measuring step by step, each step it schedules run here in turn with the arguments it
   * was scheduled with (the clock is faked, so none runs by itself), so every step's answer is
   * read.
   */
  async function stepsByHand(
    harness: Harness,
    name: 'proposeRelations' | 'remeasureRelations',
    first: () => Promise<StepAnswer>,
  ): Promise<StepAnswer[]> {
    const answers = [await first()];
    const run = new Set<string>();
    for (;;) {
      const next = (await scheduled(harness, name)).find((job) => !run.has(job.id));
      if (next === undefined) return answers;
      run.add(next.id);
      answers.push(
        (await harness.action(internal.docSyncActions[name], next.args as never)) as StepAnswer,
      );
    }
  }

  it('a page over the read limit costs only its own pairs, and the measuring’s answer names the pair it passed over', async (): Promise<void> => {
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const library = await runbookAndCopies(harness);
    await breakRunbook(harness, library);
    const answers = await stepsByHand(
      harness,
      'proposeRelations',
      async () => await harness.action(internal.docSyncActions.proposeRelations, library),
    );
    // The two copies' pair is proposed at the first step, though both copies read the runbook.
    expect(await relations(harness)).toMatchObject([
      {
        kind: 'possible_successor',
        from: { ref: 'zebra-copy.md' },
        to: { ref: 'zebra-notes.md' },
      },
    ]);
    // Tried three times, then passed over: the runbook's own measure, and each copy's pair with it.
    expect(answers).toHaveLength(3);
    expect(answers.at(-1)?.passedOver).toEqual(
      expect.arrayContaining([
        { ref: 'zebra.md' },
        { ref: 'zebra-notes.md', candidate: { sourceId: library.sourceId, ref: 'zebra.md' } },
        { ref: 'zebra-copy.md', candidate: { sourceId: library.sourceId, ref: 'zebra.md' } },
      ]),
    );
    expect(answers.at(-1)?.passedOver).toHaveLength(3);
  });

  it('a retry step that also hands on at the step’s share measures each page once (17-FD’s second pass, item 3)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const library = await syncingSource(harness, 'Library');
    // The runbook and its copy first, so the read that holds them is the first; then one block a
    // page, so no page's blocks straddle two reads, filling three reads of blocks (400 a read):
    // the last retry passes the two over, measures the second read whole and hands on there.
    for (const [ref, title] of [
      ['zebra.md', 'Zebra quartz runbook'],
      ['zebra-copy.md', 'Zebra quartz copy'],
    ] as const) {
      await storedPage(harness, library, {
        ref,
        title,
        markdown: RUNBOOK.replace('# Zebra quartz runbook', `# ${title}`),
      });
    }
    await breakRunbook(harness, library);
    const PAGES = 900;
    for (let index = 0; index < PAGES; index += 1) {
      await storedPage(harness, library, {
        ref: `p${String(index).padStart(3, '0')}.md`,
        title: `zq${index}x`,
        markdown: `zq${index}x alone.`,
      });
    }
    const answers = await stepsByHand(
      harness,
      'proposeRelations',
      async () => await harness.action(internal.docSyncActions.proposeRelations, library),
    );
    // The first step, the two retries (the second hands on past its share) and the step after it.
    expect(answers.map((answer) => answer.measured)).toEqual([400, 2, 402, 102]);
    // Every page once, and the runbook and its copy at each of their three tries.
    expect(answers.reduce((sum, answer) => sum + answer.measured, 0)).toBe(
      PAGES + 2 * RELATION_MEASURE_TRIES,
    );
  }, 240_000);

  it('a retry for a run a newer sync overtook measures nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const library = await runbookAndCopies(harness);
    await breakRunbook(harness, library);
    await harness.action(internal.docSyncActions.proposeRelations, library);
    const [retry, ...more] = await scheduled(harness, 'proposeRelations');
    expect(retry).toBeDefined();
    expect(more).toEqual([]);
    const before = (await relations(harness)).length;
    // A newer sync takes the source over, and the runbook is mended before the retry runs.
    await harness.run(async (ctx) => {
      const newer = await ctx.db.insert('docSyncRuns', {
        sourceId: library.sourceId,
        listing: 2,
        credentialRefs: [],
        pageCount: 0,
        redactionCount: 0,
        state: 'running',
        createdAt: 3,
      });
      await ctx.db.patch(library.sourceId, { activeSyncId: newer, lastCompletedSyncId: undefined });
      const rows = await ctx.db
        .query('docPages')
        .withIndex('by_source_ref', (q) => q.eq('sourceId', library.sourceId).eq('ref', 'zebra.md'))
        .collect();
      await ctx.db.delete(rows[1]._id);
    });
    const answer = await harness.action(
      internal.docSyncActions.proposeRelations,
      retry.args as never,
    );
    // The sync's proposals so far, as the retry carried them: none more.
    expect(answer).toEqual({
      measured: 0,
      proposed: (retry.args as { proposed: number }).proposed,
      passedOver: [],
    });
    expect(await relations(harness)).toHaveLength(before);
    // And it schedules nothing more.
    expect(await scheduled(harness, 'proposeRelations')).toHaveLength(1);
  });
});

describe('a page a front matter names that its source lists and Day0 never stored (the second pass)', (): void => {
  it('takes none of a page’s three candidates: the copy beside it is still measured', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const DAY = DATED_SUCCESSOR_GAP_MS;
    const library = await syncingSource(harness, 'Library');
    const body = 'Press Refresh once and read back the zebra figure.';
    await storedPage(harness, library, {
      ref: 'zebra.md',
      title: 'Zebra quartz runbook',
      markdown: `---\nsupersedes: ghost\n---\n# Zebra quartz runbook\n\n${body}`,
      updatedAt: 8 * DAY,
    });
    await storedPage(harness, library, {
      ref: 'zebra-copy.md',
      title: 'Zebra quartz notes',
      markdown: `# Zebra quartz notes\n\n${body}`,
      updatedAt: 2 * DAY,
    });
    // Three sources list a `ghost.md` too large to store: a listing row each, and no page.
    for (const label of ['One', 'Two', 'Three']) {
      const other = await syncingSource(harness, label);
      await harness.run(
        async (ctx) =>
          await ctx.db.insert('docPageListings', {
            sourceId: other.sourceId,
            ref: 'ghost.md',
            seenBy: 1,
          }),
      );
    }
    expect(await measure(harness, library, 'zebra.md')).toBe(1);
    expect(await relations(harness)).toMatchObject([
      { kind: 'possible_successor', from: { ref: 'zebra.md' }, to: { ref: 'zebra-copy.md' } },
    ]);
  });
});

describe('a page whose candidates the cap cut (W16-R34)', (): void => {
  it('is measured again at the next sync, though it was the last page of the remeasure’s last read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    // Seventeen runbooks of three later versions each hold fifty-one relations: the cap of fifty
    // cuts the seventeenth's third candidate, and that page is the last of the only read.
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
    // Two syncs that changed nothing put the runbooks out of the look-back: the pass's mark alone
    // owes them, and the remeasure measures a page once.
    await completedWalk(harness, first.sourceId);
    await completedWalk(harness, first.sourceId);
    await harness.run(
      async (ctx) => await ctx.db.patch(first.sourceId, { relationsRemeasure: { cursor: null } }),
    );
    const measureNextWalk = async (): Promise<void> => {
      await harness.action(
        internal.docSyncActions.proposeRelations,
        await completedWalk(harness, first.sourceId),
      );
      await harness.finishAllScheduledFunctions(vi.runAllTimers);
    };
    await measureNextWalk();
    expect(await relations(harness)).toHaveLength(RELATION_PROPOSALS_PER_SYNC);
    await measureNextWalk();
    expect(await relations(harness)).toHaveLength(RELATION_PROPOSALS_PER_SYNC + 1);
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(first.sourceId)))?.relationsRemeasure,
    ).toBeUndefined();
  }, 120_000);
});

// D-12 (b) (17-FD's F3 with F9, carried by the joins to the review): a measure reads its page and
// each candidate's row and blocks in one transaction, so four pages each under the store's bound
// passed its read limit together and the whole measure failed, every pair with it. A candidate
// whose row, read already, says its read would take the measure past its budget is passed over
// before its blocks are read, and the function log names it; each candidate in a transaction of
// its own is wave 18's (D-12 (a)).
describe('a candidate whose read would pass the measure’s budget (D-12 (b))', (): void => {
  it('is measured a pair a transaction since D-12 (a): four pages that passed the limit together each fit with the page', async (): Promise<void> => {
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    // Under the store's 768 KiB, in the script whose search text carries every bigram.
    const paragraph = (n: number): string => `第${n}段：${'季度关账记录保存备查。'.repeat(40)}\n\n`;
    let body = '';
    for (let n = 0; Buffer.byteLength(body) < 740 * 1024; n += 1) body += paragraph(n);
    expect(Buffer.byteLength(body)).toBeLessThan(768 * 1024);
    const sources: Source[] = [];
    for (let index = 0; index < 4; index += 1) {
      const source = await syncingSource(harness, `Library ${index}`);
      await storedPage(harness, source, {
        ref: 'readme.md',
        title: 'Readme',
        markdown: `# Readme\n\n${body}`,
      });
      sources.push(source);
    }
    await storedPage(harness, sources[0], {
      ref: 'zebra.md',
      title: 'Zebra quartz',
      markdown: `---\nsupersedes: readme\n---\n# Zebra quartz\n\n${body}`,
      updatedAt: 2,
    });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const proposed = await measure(harness, sources[0], 'zebra.md');
      const passed = logged.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter(
          (line) =>
            line.msg ===
            'documentation: a candidate page too large to measure here was passed over',
        );
      // Re-taken by D-12 (a): each pair is measured in a transaction of its own, under the
      // budget, so the four pages that passed the limit together are three pairs that each fit.
      expect(passed).toEqual([]);
      expect(proposed).toBe(3);
    } finally {
      logged.mockRestore();
    }
  }, 240_000);
});

describe('the pages a page’s front matter names, under Convex’s limits (W15-R20; reader 2’s R2-K)', (): void => {
  it('measures a page that names a readme held, at 700 KB, by each of 32 sources', async (): Promise<void> => {
    // The wave 15 review's R2-K: a whole page row was read from every source to test that a named
    // page exists, so 32 sources each holding a 700 KB `readme.md` threw the measure over the
    // transaction's read limit and the page was never measured.
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const paragraph = `${'Kestrel close notes, kept for the record of the quarter. '.repeat(18)}\n\n`;
    const readme = `# Readme\n\n${paragraph.repeat(Math.ceil((700 * 1024) / paragraph.length))}`;
    expect(Buffer.byteLength(readme)).toBeGreaterThan(700 * 1024);
    const sources: Source[] = [];
    for (let index = 0; index < 32; index += 1) {
      const source = await syncingSource(harness, `Library ${index}`);
      await storedPage(harness, source, { ref: 'readme.md', title: 'Readme', markdown: readme });
      await harness.run(
        async (ctx) =>
          await ctx.db.insert('docPageListings', {
            sourceId: source.sourceId,
            ref: 'readme.md',
            seenBy: 1,
          }),
      );
      sources.push(source);
    }
    await storedPage(harness, sources[0], {
      ref: 'zebra.md',
      title: 'Zebra quartz',
      markdown: '---\nsupersedes: readme\n---\n# Zebra quartz\n\nThe zebra quartz procedure.',
      updatedAt: 2,
    });
    // Measured, against the three candidates a page takes: each proposed as the page it replaces.
    expect(await measure(harness, sources[0], 'zebra.md')).toBe(3);
    expect(await relations(harness)).toMatchObject(
      [0, 1, 2].map(() => ({
        kind: 'possible_successor',
        from: { sourceId: sources[0].sourceId, ref: 'zebra.md' },
        to: { ref: 'readme.md' },
      })),
    );
  }, 240_000);
});
