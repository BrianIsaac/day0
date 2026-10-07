import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { replacePageBlocks } from '../../convex/docBlocks';
import type { SelectionRequest } from '../../src/docs/select';
import { renderHowTos, renderTeamDocs } from '../../src/work/documents';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

type Harness = TestConvex<typeof schema>;

const TICKET_RUNBOOK = [
  '# How to update a ticket',
  '',
  '## Closing the loop',
  '',
  'When work originated in the ticket-queue, use ticket.update on the originating ticket.',
  'Set status: done for full completion and in-progress for partial completion.',
  'Add a one-line comment summarising the work.',
].join('\n');

const TILE_RUNBOOK = [
  '# How to refresh the pipeline tile',
  '',
  '## Sign in',
  '',
  'Open the Looker pipeline tile and sign in with the stored account.',
  '',
  '## Refresh',
  '',
  'Press Refresh, then read back the coverage figure and the audit line.',
].join('\n');

const HOLIDAYS = ['# Office holidays', '', 'The office closes on the first Monday of August.'].join(
  '\n',
);

const CHINESE = ['# 季度流程', '', '每个季度结束时请刷新管道看板然后在频道里发布结果'].join('\n');

const request: SelectionRequest = {
  site: 'plan',
  title: 'Refresh the pipeline tile',
  summary: 'The coverage figure on the Looker pipeline tile is stale.',
  roleFunction: 'Revenue operations coordination',
  writtenBrowserSurfaces: [],
};

/** An owner's employee, with the given sources excluded at deploy. */
async function employee(
  harness: Harness,
  excludedDocSourceIds: Id<'docSources'>[] = [],
): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Selector test',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
        excludedDocSourceIds,
      }),
  );
}

/** A linked source of the owner's and its completed run. */
async function source(
  harness: Harness,
  label: string,
): Promise<{ sourceId: Id<'docSources'>; runId: Id<'docSyncRuns'> }> {
  return await harness.run(async (ctx) => {
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label,
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId,
      listing: 1,
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
      state: 'completed',
      createdAt: 2,
    });
    return { sourceId, runId };
  });
}

/** A page as a sync stores it: the page, its blocks and the employee's mirror. */
async function storePage(
  harness: Harness,
  page: {
    agentId: Id<'agents'>;
    sourceId: Id<'docSources'>;
    runId: Id<'docSyncRuns'>;
    ref: string;
    title: string;
    markdown: string;
    category?: 'how-to-guide' | 'team-doc';
  },
): Promise<void> {
  await harness.run(async (ctx) => {
    await ctx.db.insert('docPages', {
      sourceId: page.sourceId,
      ref: page.ref,
      title: page.title,
      markdown: page.markdown,
      updatedAt: 3,
    });
    await replacePageBlocks(ctx, {
      userId: 'owner',
      sourceId: page.sourceId,
      pageRef: page.ref,
      generation: page.runId,
      markdown: page.markdown,
    });
    await ctx.db.insert('mockDocs', {
      agentId: page.agentId,
      slug: `source-${page.ref.replace(/[^a-z0-9]+/gi, '-')}`,
      title: page.title,
      body: page.markdown,
      category: page.category ?? 'team-doc',
      sourceId: page.sourceId,
      sourceRef: page.ref,
      updatedAt: 3,
    });
  });
}

describe('docSelection', (): void => {
  it('selects the blocks that answer the item, cited, from the employee’s readable pages', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    const handbook = await source(harness, 'Handbook');
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'runbooks/refresh-tile.md',
      title: 'How to refresh the pipeline tile',
      markdown: TILE_RUNBOOK,
      category: 'how-to-guide',
    });
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'team/holidays.md',
      title: 'Office holidays',
      markdown: HOLIDAYS,
    });
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: request,
    });
    expect(snapshot.teamDocs).toEqual([]);
    expect(snapshot.howToGuides).toHaveLength(1);
    expect(snapshot.howToGuides[0].body).toContain(
      '[cite: Handbook/runbooks/refresh-tile.md#How to refresh the pipeline tile > Refresh]',
    );
    expect(snapshot.documentation).toMatchObject({ site: 'plan' });
    expect(snapshot.documentation?.blockIds.length).toBeGreaterThan(0);
    expect(snapshot.documentation?.chars).toBe(renderHowTos(snapshot.howToGuides).length);
  });

  it('always includes every procedure contract, however little the item says of it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    const handbook = await source(harness, 'Handbook');
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'runbooks/update-ticket.md',
      title: 'How to update a ticket',
      markdown: TICKET_RUNBOOK,
      category: 'how-to-guide',
    });
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'team/holidays.md',
      title: 'Office holidays',
      markdown: HOLIDAYS,
    });
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: { ...request, title: 'Office holidays', summary: 'When does it close?' },
    });
    expect(snapshot.howToGuides.map((guide) => guide.title)).toEqual(['How to update a ticket']);
    expect(snapshot.howToGuides[0].body).toContain('ticket.update on the originating ticket');
    const stored = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docBlocks')
          .withIndex('by_source_page', (q) =>
            q.eq('sourceId', handbook.sourceId).eq('pageRef', 'runbooks/update-ticket.md'),
          )
          .collect(),
    );
    expect(snapshot.documentation?.blockIds).toEqual(
      expect.arrayContaining(stored.map((block) => block._id)),
    );
  });

  it('finds a Chinese block in unspaced text through its bigrams', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    const handbook = await source(harness, 'Handbook');
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'team/zh.md',
      title: '季度流程',
      markdown: CHINESE,
    });
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'team/holidays.md',
      title: 'Office holidays',
      markdown: HOLIDAYS,
    });
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: { ...request, title: '管道看板', summary: '', roleFunction: '' },
    });
    expect(snapshot.teamDocs.map((doc) => doc.title)).toEqual(['季度流程']);
    expect(snapshot.teamDocs[0].body).toContain('刷新管道看板');
  });

  it('searches every source the employee reads, one search a source, and no other source', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const first = await source(harness, 'Handbook');
    const second = await source(harness, 'Wiki');
    const excluded = await source(harness, 'Finance');
    const agentId = await employee(harness, [excluded.sourceId]);
    // A page that shares no word with the item, so the tile's words still tell pages apart.
    await storePage(harness, {
      agentId,
      ...first,
      ref: 'team/holidays.md',
      title: 'Office holidays',
      markdown: HOLIDAYS,
    });
    for (const [entry, ref] of [
      [first, 'tile-a.md'],
      [second, 'tile-b.md'],
    ] as const) {
      await storePage(harness, {
        agentId,
        ...entry,
        ref,
        title: `Pipeline tile ${ref}`,
        markdown: `# Pipeline tile\n\nThe pipeline tile coverage figure, ${ref}.`,
      });
    }
    // A page of an excluded source: blocks stored under the same owner, mirrored by no employee
    // that reads it, so it is never searched.
    await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId: excluded.sourceId,
        ref: 'tile-c.md',
        title: 'Pipeline tile c',
        markdown: '# Pipeline tile\n\nThe pipeline tile coverage figure, c.',
        updatedAt: 3,
      });
      await replacePageBlocks(ctx, {
        userId: 'owner',
        sourceId: excluded.sourceId,
        pageRef: 'tile-c.md',
        generation: excluded.runId,
        markdown: '# Pipeline tile\n\nThe pipeline tile coverage figure, c.',
      });
    });
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: request,
    });
    expect(snapshot.teamDocs.map((doc) => doc.title).sort()).toEqual([
      'Pipeline tile tile-a.md',
      'Pipeline tile tile-b.md',
    ]);
  });

  it('cites each block it found with the hash it was read under', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    const handbook = await source(harness, 'Handbook');
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'team/tile.md',
      title: 'Tile notes',
      markdown: '# Tile notes\n\nThe pipeline tile coverage figure is refreshed weekly.',
    });
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'team/holidays.md',
      title: 'Office holidays',
      markdown: HOLIDAYS,
    });
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: request,
    });
    const rows = await harness.run(async (ctx) => await ctx.db.query('docBlocks').collect());
    const hashOf = new Map(rows.map((row) => [row._id as string, row.hash]));
    const cited = snapshot.documentation!.citations.flatMap((citation) => citation.blocks);
    expect(cited.length).toBeGreaterThan(0);
    for (const block of cited) expect(block.hash).toBe(hashOf.get(block.id));
  });

  it('never searches another owner’s source, however well it matches', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    const handbook = await source(harness, 'Handbook');
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'team/holidays.md',
      title: 'Office holidays',
      markdown: HOLIDAYS,
    });
    // Another owner's blocks, stored under their own key, for their own employee.
    await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'someone-else',
        label: 'Their handbook',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const generation = await ctx.db.insert('docSyncRuns', {
        sourceId,
        listing: 1,
        credentialRefs: [],
        pageCount: 1,
        redactionCount: 0,
        state: 'completed',
        createdAt: 2,
      });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'tile.md',
        title: 'Their tile',
        markdown: TILE_RUNBOOK,
        updatedAt: 3,
      });
      await replacePageBlocks(ctx, {
        userId: 'someone-else',
        sourceId,
        pageRef: 'tile.md',
        generation,
        markdown: TILE_RUNBOOK,
      });
    });
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: request,
    });
    expect([...snapshot.howToGuides, ...snapshot.teamDocs]).toEqual([]);
    expect(snapshot.documentation?.blockIds).toEqual([]);
  });

  it('searches more than 32 sources in runs, so a page of the thirty-third is found', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    for (let index = 0; index < 33; index += 1) {
      const entry = await source(harness, `Source ${index}`);
      await storePage(harness, {
        agentId,
        ...entry,
        ref: `page-${index}.md`,
        title: `Page ${index}`,
        markdown:
          index === 32
            ? '# Tile runbook\n\nRefresh the pipeline tile coverage figure from the standup.'
            : `# Notes ${index}\n\nThe canteen opens at nine on weekday ${index}.`,
      });
    }
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: request,
    });
    expect(snapshot.teamDocs.map((doc) => doc.title)).toEqual(['Page 32']);
  });

  it('drops a block whose page a finished sync removed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    const handbook = await source(harness, 'Handbook');
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'team/tile.md',
      title: 'Tile notes',
      markdown: '# Tile notes\n\nThe pipeline tile is refreshed weekly.',
    });
    await harness.run(async (ctx) => {
      const page = await ctx.db
        .query('docPages')
        .withIndex('by_source_ref', (q) =>
          q.eq('sourceId', handbook.sourceId).eq('ref', 'team/tile.md'),
        )
        .unique();
      await ctx.db.delete(page!._id);
    });
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: request,
    });
    expect(snapshot.teamDocs).toEqual([]);
    expect(snapshot.documentation?.blockIds).toEqual([]);
  });

  it('reads the whole mirror when no selection is passed, blocks or none', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    const handbook = await source(harness, 'Handbook');
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'team/holidays.md',
      title: 'Office holidays',
      markdown: HOLIDAYS,
    });
    const snapshot = await harness.query(internal.mock.snapshotInternal, { agentId });
    expect(snapshot.teamDocs).toEqual([
      { slug: 'source-team-holidays-md', title: 'Office holidays', body: HOLIDAYS },
    ]);
    expect(snapshot.documentation).toBeUndefined();
    expect(renderTeamDocs(snapshot.teamDocs)).toContain(HOLIDAYS);
  });
});

describe('docSelection.changedCitedBlocks', (): void => {
  it('answers a cited block whose row is gone, whose text was rewritten or whose page is gone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    const handbook = await source(harness, 'Handbook');
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'runbooks/refresh-tile.md',
      title: 'How to refresh the pipeline tile',
      markdown: TILE_RUNBOOK,
    });
    const blocks = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docBlocks')
          .withIndex('by_source_page', (q) => q.eq('sourceId', handbook.sourceId))
          .collect(),
    );
    const [standing, deleted] = blocks.map((block) => ({ id: block._id, hash: block.hash }));
    await harness.run(async (ctx) => await ctx.db.delete(deleted.id));
    await expect(
      harness.query(internal.docSelection.changedCitedBlocks, {
        blocks: [standing, deleted, { id: 'not-a-block' }],
      }),
    ).resolves.toEqual([deleted.id, 'not-a-block']);
    // A sync that rewrites a block in place keeps its id; the cite was of the old text.
    await expect(
      harness.query(internal.docSelection.changedCitedBlocks, {
        blocks: [{ id: standing.id, hash: 'the-hash-it-was-cited-under' }],
      }),
    ).resolves.toEqual([standing.id]);
    await harness.run(async (ctx) => {
      const page = await ctx.db
        .query('docPages')
        .withIndex('by_source_ref', (q) => q.eq('sourceId', handbook.sourceId))
        .first();
      await ctx.db.delete(page!._id);
    });
    await expect(
      harness.query(internal.docSelection.changedCitedBlocks, { blocks: [standing] }),
    ).resolves.toEqual([standing.id]);
  });
});
