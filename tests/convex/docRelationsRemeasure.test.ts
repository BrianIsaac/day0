import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { storedPage, syncingSource, type Harness, type Source } from './fakes/doc-relations';

/*
 * The remeasure's reads and its mark (wave 16, 16-FD; RM19 (a)). The measuring that walks them is
 * driven through `docSyncActions.proposeRelations` in `docRelationProposals.test.ts`.
 */

/** A source with three stored pages, two blocks each. */
async function library(harness: Harness): Promise<Source> {
  const source = await syncingSource(harness, 'Library');
  for (const ref of ['a.md', 'b.md', 'c.md']) {
    await storedPage(harness, source, {
      ref,
      title: ref,
      markdown: `# ${ref}\n\nFirst part of ${ref}.\n\n## More\n\nSecond part of ${ref}.`,
    });
  }
  return source;
}

const mark = async (harness: Harness, sourceId: Id<'docSources'>, cursor: string | null) =>
  await harness.run(
    async (ctx) => await ctx.db.patch(sourceId, { relationsRemeasure: { cursor } }),
  );

const remeasureOf = async (harness: Harness, sourceId: Id<'docSources'>) =>
  (await harness.run(async (ctx) => await ctx.db.get(sourceId)))?.relationsRemeasure;

describe('pagesOwed', (): void => {
  it('owes nothing to a source the pass did not mark', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await library(harness);
    expect(await harness.query(internal.docRelationsRemeasure.pagesOwed, source)).toBeNull();
  });

  it('reads the source’s pages from the mark’s start, each a read holds once, and says where the read ends', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await library(harness);
    await mark(harness, source.sourceId, null);
    expect(await harness.query(internal.docRelationsRemeasure.pagesOwed, source)).toEqual({
      cursor: null,
      refs: ['a.md', 'b.md', 'c.md'],
      next: null,
    });
  });

  it('owes nothing to a run that is no longer the source’s running or last completed one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await library(harness);
    await mark(harness, source.sourceId, null);
    await harness.run(
      async (ctx) => await ctx.db.patch(source.sourceId, { activeSyncId: undefined }),
    );
    expect(await harness.query(internal.docRelationsRemeasure.pagesOwed, source)).toBeNull();
  });
});

describe('settleRemeasure', (): void => {
  it('keeps the place reached, and clears the mark at the end', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await library(harness);
    await mark(harness, source.sourceId, null);
    await harness.mutation(internal.docRelationsRemeasure.settleRemeasure, {
      ...source,
      owed: { cursor: 'reached' },
    });
    expect(await remeasureOf(harness, source.sourceId)).toEqual({ cursor: 'reached' });
    await harness.mutation(internal.docRelationsRemeasure.settleRemeasure, {
      ...source,
      owed: null,
    });
    expect(await remeasureOf(harness, source.sourceId)).toBeUndefined();
  });

  it('marks nothing on a source not owed the remeasure, or for a run overtaken by a newer sync', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await library(harness);
    await harness.mutation(internal.docRelationsRemeasure.settleRemeasure, {
      ...source,
      owed: { cursor: 'reached' },
    });
    expect(await remeasureOf(harness, source.sourceId)).toBeUndefined();
    await mark(harness, source.sourceId, 'kept');
    await harness.run(
      async (ctx) => await ctx.db.patch(source.sourceId, { activeSyncId: undefined }),
    );
    await harness.mutation(internal.docRelationsRemeasure.settleRemeasure, {
      ...source,
      owed: null,
    });
    expect(await remeasureOf(harness, source.sourceId)).toEqual({ cursor: 'kept' });
  });
});
