import { readFileSync } from 'node:fs';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { copyPageStatusToBlocks, replacePageBlocks } from '../../convex/docBlocks';
import type { PageStatus } from '../../src/docs/authority';
import type { SelectionRequest } from '../../src/docs/select';
import { renderHowTos, renderTeamDocs } from '../../src/work/documents';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

type Harness = TestConvex<typeof schema>;

// The selection is real mode's (R3). Set for every test here by 15-A: the snapshot now ignores a
// selection in any other mode (W14-R26), where it took one from whoever passed it.
beforeEach((): void => {
  useSurfaceMode('real');
});
afterEach((): void => {
  restoreSurfaceMode();
});

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

const CLOSE_STATUS_NOTE = readFileSync(
  new URL('../fixtures/company-bed/folder/finance/runbooks/close-status-note.md', import.meta.url),
  'utf8',
);

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

/** A stored page's blocks in document order. */
async function pageBlocks(harness: Harness, sourceId: Id<'docSources'>, pageRef: string) {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('docBlocks')
        .withIndex('by_source_page', (q) => q.eq('sourceId', sourceId).eq('pageRef', pageRef))
        .collect(),
  );
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
    // Re-pinned by 15-A: the check answers each gone block with what is known of why (its page,
    // and its status when that is why), where it answered the ids alone.
    await expect(
      harness.query(internal.docSelection.changedCitedBlocks, {
        blocks: [standing, deleted, { id: 'not-a-block' }],
      }),
    ).resolves.toEqual([{ id: deleted.id }, { id: 'not-a-block' }]);
    // A sync that rewrites a block in place keeps its id; the cite was of the old text.
    const page = 'Handbook/runbooks/refresh-tile.md';
    await expect(
      harness.query(internal.docSelection.changedCitedBlocks, {
        blocks: [{ id: standing.id, hash: 'the-hash-it-was-cited-under' }],
      }),
    ).resolves.toEqual([{ id: standing.id, page }]);
    await harness.run(async (ctx) => {
      const page = await ctx.db
        .query('docPages')
        .withIndex('by_source_ref', (q) => q.eq('sourceId', handbook.sourceId))
        .first();
      await ctx.db.delete(page!._id);
    });
    await expect(
      harness.query(internal.docSelection.changedCitedBlocks, { blocks: [standing] }),
    ).resolves.toEqual([{ id: standing.id, page }]);
  });

  it('answers nothing for a cited section when a section is inserted above it (W14-R2)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    const handbook = await source(harness, 'Handbook');
    const ref = 'finance/runbooks/close-status-note.md';
    await storePage(harness, {
      agentId,
      ...handbook,
      ref,
      title: 'How to write the close status note',
      markdown: CLOSE_STATUS_NOTE,
    });
    const cited = (await pageBlocks(harness, handbook.sourceId, ref))
      .filter((block) => block.headingPath.includes('Format'))
      .map((block) => ({ id: block._id, hash: block.hash }));
    expect(cited.length).toBeGreaterThan(0);
    const edited = CLOSE_STATUS_NOTE.replace(
      '## Format',
      '## Contacts\n\nThe controller answers questions about the note.\n\n## Format',
    );
    await harness.run(async (ctx) => {
      const page = await ctx.db
        .query('docPages')
        .withIndex('by_source_ref', (q) => q.eq('sourceId', handbook.sourceId).eq('ref', ref))
        .unique();
      await ctx.db.patch(page!._id, { markdown: edited });
      await replacePageBlocks(ctx, {
        userId: 'owner',
        sourceId: handbook.sourceId,
        pageRef: ref,
        generation: handbook.runId,
        markdown: edited,
      });
    });
    await expect(
      harness.query(internal.docSelection.changedCitedBlocks, { blocks: cited }),
    ).resolves.toEqual([]);
  });

  it('reads one section a cited hash, never the whole page, when a row holds another block (second pass on W14-R2)', async (): Promise<void> => {
    const harness = convexTest({
      schema,
      modules: allConvexModules(),
      transactionLimits: { documentsRead: 60 },
    });
    const agentId = await employee(harness);
    const handbook = await source(harness, 'Handbook');
    const ref = 'runbooks/long.md';
    const long = Array.from(
      { length: 200 },
      (_unused, index) => `## Step ${index}\n\nDo step ${index} of the close.`,
    ).join('\n\n');
    await storePage(harness, { agentId, ...handbook, ref, title: 'Long runbook', markdown: long });
    const [first, second] = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docBlocks')
          .withIndex('by_source_page', (q) =>
            q.eq('sourceId', handbook.sourceId).eq('pageRef', ref),
          )
          .take(2),
    );
    await harness.run(async (ctx) => await ctx.db.patch(first._id, { hash: second.hash }));
    // Re-pinned by 15-A: the gone block is answered with its page, not its id alone.
    await expect(
      harness.query(internal.docSelection.changedCitedBlocks, {
        blocks: [{ id: first._id, hash: first.hash }],
      }),
    ).resolves.toEqual([{ id: first._id, page: `Handbook/${ref}` }]);
  });

  it('reads a cite by its hash on its page, the id only a hint, so a row that now holds another block still stands (W14-R2)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    const handbook = await source(harness, 'Handbook');
    const ref = 'runbooks/refresh-tile.md';
    await storePage(harness, {
      agentId,
      ...handbook,
      ref,
      title: 'How to refresh the pipeline tile',
      markdown: TILE_RUNBOOK,
    });
    const [first, second] = await pageBlocks(harness, handbook.sourceId, ref);
    // The shape a positional re-split left: each row holds the other's block.
    const content = (block: typeof first) => ({
      headingPath: block.headingPath,
      text: block.text,
      searchText: block.searchText,
      kind: block.kind,
      hash: block.hash,
      chars: block.chars,
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(first._id, content(second));
      await ctx.db.patch(second._id, content(first));
    });
    await expect(
      harness.query(internal.docSelection.changedCitedBlocks, {
        blocks: [
          { id: first._id, hash: first.hash },
          { id: second._id, hash: second.hash },
        ],
      }),
    ).resolves.toEqual([]);
    // Re-pinned by 15-A, as above: the gone block with its page, as its three neighbours assert.
    await expect(
      harness.query(internal.docSelection.changedCitedBlocks, {
        blocks: [{ id: first._id, hash: 'a-hash-no-block-on-the-page-holds' }],
      }),
    ).resolves.toEqual([{ id: first._id, page: `Handbook/${ref}` }]);
  });
});

/** Give a stored page a status the way `docStatus` leaves it: on its row and on its blocks. */
async function mark(
  harness: Harness,
  page: { sourceId: Id<'docSources'>; ref: string },
  status: PageStatus,
  supersededBy?: { sourceId: Id<'docSources'>; ref: string },
): Promise<void> {
  await harness.run(async (ctx) => {
    const row = await ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (q) => q.eq('sourceId', page.sourceId).eq('ref', page.ref))
      .unique();
    await ctx.db.patch(row!._id, {
      status,
      statusSource: 'manager',
      ...(supersededBy !== undefined ? { supersededBy } : {}),
    });
    await copyPageStatusToBlocks(ctx, { sourceId: page.sourceId, pageRef: page.ref, status });
  });
}

describe('docSelection and a page that is not current (15-A; A20, A-1)', (): void => {
  /** A scouted how-to guide and a procedure contract, which is always included. */
  async function library(harness: Harness) {
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
      ref: 'runbooks/update-ticket.md',
      title: 'How to update a ticket',
      markdown: TICKET_RUNBOOK,
      category: 'how-to-guide',
    });
    return { agentId, handbook };
  }

  it('leaves a superseded page out of the scout, the always-included set and the whole-mirror read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, handbook } = await library(harness);
    const titles = async (selection?: SelectionRequest): Promise<string[]> =>
      (
        await harness.query(internal.mock.snapshotInternal, {
          agentId,
          ...(selection !== undefined ? { selection } : {}),
        })
      ).howToGuides.map((guide) => guide.title);
    expect(await titles(request)).toEqual([
      'How to update a ticket',
      'How to refresh the pipeline tile',
    ]);
    expect(await titles()).toHaveLength(2);
    // The scouted guide is superseded: only the contract page is carried.
    await mark(harness, { ...handbook, ref: 'runbooks/refresh-tile.md' }, 'superseded');
    expect(await titles(request)).toEqual(['How to update a ticket']);
    // The contract page is archived: the always-included set drops it too.
    await mark(harness, { ...handbook, ref: 'runbooks/update-ticket.md' }, 'archived');
    const selected = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: request,
    });
    expect(selected.howToGuides).toEqual([]);
    expect(selected.documentation?.blockIds).toEqual([]);
    // And the whole mirror, which the fallback reads, carries neither.
    expect(await titles()).toEqual([]);
    // The employee's Docs tab keeps both pages: nothing was taken out of the mirror.
    expect(
      await harness.run(async (ctx) => (await ctx.db.query('mockDocs').collect()).length),
    ).toBe(2);
  });

  it('leaves a draft out of a default selection, and carries it again once it is current (A20)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, handbook } = await library(harness);
    const tile = { ...handbook, ref: 'runbooks/refresh-tile.md' };
    const carried = async (): Promise<string[]> =>
      (
        await harness.query(internal.mock.snapshotInternal, { agentId, selection: request })
      ).howToGuides.map((guide) => guide.title);
    await mark(harness, tile, 'draft');
    expect(await carried()).toEqual(['How to update a ticket']);
    await mark(harness, tile, 'active');
    expect(await carried()).toContain('How to refresh the pipeline tile');
  });
});

describe('docSelection and the sources it searches (W14-R27, W14-R28)', (): void => {
  it('tells two sources with one label apart in their cite lines, so their cites never merge (W14-R27)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    const first = await source(harness, 'Handbook');
    const second = await source(harness, 'Handbook');
    for (const entry of [first, second]) {
      await storePage(harness, {
        agentId,
        ...entry,
        ref: 'runbooks/refresh-tile.md',
        title: 'How to refresh the pipeline tile',
        markdown: TILE_RUNBOOK,
        category: 'how-to-guide',
      });
    }
    // The second source's mirror takes its own slug, as two sources' mirrors do.
    await harness.run(async (ctx) => {
      const mirrors = await ctx.db.query('mockDocs').collect();
      await ctx.db.patch(mirrors[1]._id, { slug: `${mirrors[1].slug}-2` });
    });
    // A third page, so the item's words tell pages apart (a word on every page ranks none).
    await storePage(harness, {
      agentId,
      ...first,
      ref: 'team/holidays.md',
      title: 'Office holidays',
      markdown: HOLIDAYS,
    });
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: request,
    });
    const labels = snapshot.documentation!.citations.map((citation) => citation.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.filter((label) => label.startsWith('Handbook (1)/'))).not.toEqual([]);
    expect(labels.filter((label) => label.startsWith('Handbook (2)/'))).not.toEqual([]);
    // Each cite carries the source it is of.
    expect(new Set(snapshot.documentation!.citations.map((citation) => citation.sourceId))).toEqual(
      new Set([first.sourceId, second.sourceId]),
    );
  });

  it('asks the search for at most 512 blocks a selection however many sources, the most trusted first (W14-R28)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    // Five searches a selection (the item, its target, its shape, the role, the requester): past
    // 102 sources the old limit clamped to one block a source and asked for more than 512.
    const everyField: SelectionRequest = {
      ...request,
      target: { slug: 'looker-tile', displayName: 'Looker pipeline tile' },
      shape: { surfaceClass: 'dashboard', operation: 'refresh' },
      requester: 'Priya Raman',
    };
    const sources: Id<'docSources'>[] = [];
    for (let index = 0; index < 104; index += 1) {
      const entry = await source(harness, `Source ${index}`);
      sources.push(entry.sourceId);
      await storePage(harness, {
        agentId,
        ...entry,
        ref: `page-${index}.md`,
        title: `Page ${index}`,
        markdown:
          index === 98 || index === 99
            ? `# Tile runbook ${index}\n\nRefresh the pipeline tile coverage figure from the standup.`
            : `# Notes ${index}\n\nThe canteen opens at nine on weekday ${index}.`,
      });
    }
    // The mirror lists pages by slug, so `page-98` and `page-99` come last of the 104. The first
    // is the official source's; the second is as trusted as every other.
    await harness.run(async (ctx) => {
      await ctx.db.patch(sources[98], { authority: 'official' });
    });
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: everyField,
    });
    // 102 sources are searched, one block each a search: the official one and the first 101 of
    // the rest, so the last team source's page, as good a match, is not scouted.
    expect(snapshot.teamDocs.map((doc) => doc.title)).toEqual(['Page 98']);
  }, 60_000);
});

describe('docSelection.changedCitedBlocks and a page’s status (15-A; W14-R25, W14-R28)', (): void => {
  /** Two stored pages of one source, and the first block of each as a plan cites it. */
  async function cited(harness: Harness) {
    const agentId = await employee(harness);
    const handbook = await source(harness, 'Handbook');
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'runbooks/pipeline-runbook.md',
      title: 'Pipeline runbook',
      markdown: TILE_RUNBOOK,
    });
    await storePage(harness, {
      agentId,
      ...handbook,
      ref: 'runbooks/pipeline-runbook-v2.md',
      title: 'Pipeline runbook, version 2',
      markdown: `${TILE_RUNBOOK}\n\nThen post the figure.`,
    });
    const [v1] = await pageBlocks(harness, handbook.sourceId, 'runbooks/pipeline-runbook.md');
    return { agentId, handbook, cite: { id: v1._id as string, hash: v1.hash } };
  }

  it('answers the cite of a superseded page as gone, naming what superseded it, though its text is unchanged', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, handbook, cite } = await cited(harness);
    const check = async () =>
      await harness.query(internal.docSelection.changedCitedBlocks, { agentId, blocks: [cite] });
    expect(await check()).toEqual([]);
    await mark(harness, { ...handbook, ref: 'runbooks/pipeline-runbook.md' }, 'superseded', {
      sourceId: handbook.sourceId,
      ref: 'runbooks/pipeline-runbook-v2.md',
    });
    expect(await check()).toEqual([
      {
        id: cite.id,
        page: 'Handbook/runbooks/pipeline-runbook.md',
        status: 'superseded',
        supersededBy: 'Pipeline runbook, version 2',
      },
    ]);
    await mark(harness, { ...handbook, ref: 'runbooks/pipeline-runbook.md' }, 'archived');
    expect(await check()).toEqual([
      { id: cite.id, page: 'Handbook/runbooks/pipeline-runbook.md', status: 'archived' },
    ]);
  });

  it('answers the cite of a page the employee no longer reads as gone (W14-R25)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, handbook, cite } = await cited(harness);
    // Another owner's employee, and one of the owner's deployed without the source.
    const strangers = await harness.run(async (ctx) => ({
      other: await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Elsewhere',
        userId: 'another-owner',
        state: 'deployed',
        createdAt: 1,
      }),
      without: await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Without',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
        excludedDocSourceIds: [handbook.sourceId],
      }),
    }));
    const check = async (reader: Id<'agents'>) =>
      await harness.query(internal.docSelection.changedCitedBlocks, {
        agentId: reader,
        blocks: [cite],
      });
    expect(await check(agentId)).toEqual([]);
    const unread = [{ id: cite.id, page: 'Handbook/runbooks/pipeline-runbook.md' }];
    expect(await check(strangers.other)).toEqual(unread);
    expect(await check(strangers.without)).toEqual(unread);
  });

  it('reads each cited page once however many of its blocks a plan cites (W14-R28)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, handbook } = await cited(harness);
    const blocks = await pageBlocks(harness, handbook.sourceId, 'runbooks/pipeline-runbook.md');
    expect(blocks.length).toBeGreaterThan(1);
    await mark(harness, { ...handbook, ref: 'runbooks/pipeline-runbook.md' }, 'archived');
    const gone = await harness.query(internal.docSelection.changedCitedBlocks, {
      agentId,
      blocks: blocks.map((block) => ({ id: block._id as string, hash: block.hash })),
    });
    expect(gone.map((entry) => entry.status)).toEqual(blocks.map(() => 'archived'));
  });
});

describe('snapshotInternal and a selection outside real mode (W14-R26)', (): void => {
  it('ignores the selection in mock mode and reads the office’s own bounded set, whole', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('mockDocs', {
        agentId,
        slug: 'office-holidays',
        title: 'Office holidays',
        body: HOLIDAYS,
        category: 'team-doc',
        updatedAt: 1,
      });
    });
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: request,
    });
    expect(snapshot.documentation).toBeUndefined();
    expect(snapshot.teamDocs).toEqual([
      { slug: 'office-holidays', title: 'Office holidays', body: HOLIDAYS },
    ]);
    // And the mock office's bound holds: a caller passing a selection cannot read past it.
    await harness.run(async (ctx) => {
      for (let index = 0; index < 32; index += 1) {
        await ctx.db.insert('mockDocs', {
          agentId,
          slug: `office-${index}`,
          title: `Office ${index}`,
          body: '# Note',
          category: 'team-doc',
          updatedAt: 1,
        });
      }
    });
    await expect(
      harness.query(internal.mock.snapshotInternal, { agentId, selection: request }),
    ).rejects.toThrow('more than 32 documents');
  });
});
