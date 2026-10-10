import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { replacePageBlocks } from '../../convex/docBlocks';
import { markerCandidate } from '../../src/docs/status';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

type Harness = TestConvex<typeof schema>;

/** A runbook of two sections. */
const RUNBOOK = [
  '# Refreshing the tile',
  '',
  'Open the pipeline dashboard.',
  '',
  '## When it is stale',
  '',
  'Press refresh twice.',
].join('\n');

// A status change re-admits parked work, which schedules its next step: never run here.
beforeEach((): void => {
  vi.useFakeTimers();
});
afterEach((): void => {
  vi.useRealTimers();
});

/** An employee of the owner's, with the given sources left out at deploy. */
async function employee(
  harness: Harness,
  name: string,
  excludedDocSourceIds: Id<'docSources'>[] = [],
): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name,
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
        excludedDocSourceIds,
      }),
  );
}

/** A linked source of the owner's with a sync running. */
async function syncingSource(
  harness: Harness,
  fields: Partial<Doc<'docSources'>> = {},
): Promise<{ sourceId: Id<'docSources'>; runId: Id<'docSyncRuns'> }> {
  return await harness.run(async (ctx) => {
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'Handbook',
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

/** Store a page of the source with its blocks, as a sync leaves it. */
async function storedPage(
  harness: Harness,
  source: { sourceId: Id<'docSources'>; runId: Id<'docSyncRuns'> },
  page: Partial<Doc<'docPages'>> & { ref: string },
): Promise<Id<'docPages'>> {
  return await harness.run(async (ctx) => {
    const pageId = await ctx.db.insert('docPages', {
      sourceId: source.sourceId,
      title: 'Refreshing the tile',
      markdown: RUNBOOK,
      updatedAt: 1,
      ...page,
    });
    const stored = (await ctx.db.get(pageId))!;
    await replacePageBlocks(ctx, {
      userId: 'owner',
      sourceId: source.sourceId,
      pageRef: stored.ref,
      generation: source.runId,
      markdown: stored.markdown,
      ...(stored.status !== undefined ? { status: stored.status } : {}),
    });
    return pageId;
  });
}

/** A page's row. */
async function pageOf(harness: Harness, pageId: Id<'docPages'>): Promise<Doc<'docPages'>> {
  return await harness.run(async (ctx) => (await ctx.db.get(pageId))!);
}

/** The statuses of a page's blocks, in document order. */
async function blockStatuses(
  harness: Harness,
  sourceId: Id<'docSources'>,
  pageRef: string,
): Promise<Array<string | undefined>> {
  return await harness.run(async (ctx) =>
    (
      await ctx.db
        .query('docBlocks')
        .withIndex('by_source_page', (q) => q.eq('sourceId', sourceId).eq('pageRef', pageRef))
        .collect()
    ).map((block) => block.status),
  );
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

describe('recordRead: what a page’s source says of it, beside its hash', (): void => {
  it('archives a page whose source now says so with no edit, its blocks with it, and says what decided it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, { ref: 'runbooks/refresh.md' });
    const before = await pageOf(harness, pageId);
    const record = async (): Promise<boolean> =>
      await harness.mutation(internal.docStatus.recordRead, {
        sourceId: source.sourceId,
        syncRunId: source.runId,
        ref: 'runbooks/refresh.md',
        nativeStatus: 'archived',
      });
    expect(await record()).toBe(true);
    const after = await pageOf(harness, pageId);
    expect(after).toMatchObject({
      status: 'archived',
      statusSource: 'source-native',
      nativeStatus: 'archived',
    });
    // The text and its hash are as they were: the status rode beside them.
    expect([after.markdown, after.contentHash, after.updatedAt]).toEqual([
      before.markdown,
      before.contentHash,
      before.updatedAt,
    ]);
    expect(await blockStatuses(harness, source.sourceId, 'runbooks/refresh.md')).toEqual([
      'archived',
      'archived',
    ]);
    expect(await record()).toBe(false);
  });

  it('stores the revision the source numbers a page by, and writes no status on a page nothing decides', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, { ref: 'runbooks/refresh.md' });
    await harness.mutation(internal.docStatus.recordRead, {
      sourceId: source.sourceId,
      syncRunId: source.runId,
      ref: 'runbooks/refresh.md',
      sourceRevision: '7',
    });
    const page = await pageOf(harness, pageId);
    expect(page.sourceRevision).toBe('7');
    expect([page.status, page.statusSource, page.nativeStatus]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('returns a page to its source’s default once the source stops saying anything of it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, {
      ref: 'runbooks/refresh.md',
      status: 'archived',
      statusSource: 'source-native',
      nativeStatus: 'archived',
    });
    expect(
      await harness.mutation(internal.docStatus.recordRead, {
        sourceId: source.sourceId,
        syncRunId: source.runId,
        ref: 'runbooks/refresh.md',
      }),
    ).toBe(true);
    const page = await pageOf(harness, pageId);
    expect([page.status, page.statusSource, page.nativeStatus]).toEqual([
      'active',
      'default',
      undefined,
    ]);
    expect(await blockStatuses(harness, source.sourceId, 'runbooks/refresh.md')).toEqual([
      'active',
      'active',
    ]);
  });

  it('gives a page of a source whose pages default to drafts a draft', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness, { defaultStatus: 'draft' });
    const pageId = await storedPage(harness, source, { ref: 'notes/idea.md' });
    await harness.mutation(internal.docStatus.recordRead, {
      sourceId: source.sourceId,
      syncRunId: source.runId,
      ref: 'notes/idea.md',
    });
    expect(await pageOf(harness, pageId)).toMatchObject({
      status: 'draft',
      statusSource: 'default',
    });
  });

  it('writes nothing for a generation that is no longer the source’s running one, or a page not stored', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, { ref: 'runbooks/refresh.md' });
    const stale = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docSyncRuns', {
          sourceId: source.sourceId,
          listing: 0,
          credentialRefs: [],
          pageCount: 0,
          redactionCount: 0,
          state: 'superseded',
          createdAt: 1,
        }),
    );
    expect(
      await harness.mutation(internal.docStatus.recordRead, {
        sourceId: source.sourceId,
        syncRunId: stale,
        ref: 'runbooks/refresh.md',
        nativeStatus: 'archived',
      }),
    ).toBe(false);
    expect((await pageOf(harness, pageId)).nativeStatus).toBeUndefined();
    expect(
      await harness.mutation(internal.docStatus.recordRead, {
        sourceId: source.sourceId,
        syncRunId: source.runId,
        ref: 'gone.md',
        nativeStatus: 'archived',
      }),
    ).toBe(false);
  });

  it('keeps the manager’s own status over what the source says, and keeps what the source says for Clear', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, {
      ref: 'runbooks/refresh.md',
      status: 'draft',
      statusSource: 'manager',
      decidedBy: MANAGER_ADDRESS,
      decidedAt: 5,
    });
    expect(
      await harness.mutation(internal.docStatus.recordRead, {
        sourceId: source.sourceId,
        syncRunId: source.runId,
        ref: 'runbooks/refresh.md',
        nativeStatus: 'archived',
      }),
    ).toBe(false);
    expect(await pageOf(harness, pageId)).toMatchObject({
      status: 'draft',
      statusSource: 'manager',
      decidedBy: MANAGER_ADDRESS,
      decidedAt: 5,
      nativeStatus: 'archived',
    });
  });
});

describe('restatePage: the rules over a stored page', (): void => {
  /** Restate a page through the sync's write, with nothing new from its source. */
  const restate = async (
    harness: Harness,
    source: { sourceId: Id<'docSources'>; runId: Id<'docSyncRuns'> },
    ref: string,
  ): Promise<boolean> =>
    await harness.mutation(internal.docStatus.recordRead, {
      sourceId: source.sourceId,
      syncRunId: source.runId,
      ref,
    });

  it('reads a judged marker only while it is of the lines the page holds now', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const markdown = '# 月结流程\n\n本文件已废止,请参阅《月结流程(2026版)》。\n\n## 步骤\n\n关账。';
    const quote = markerCandidate('月结流程', markdown)!.quote;
    const pageId = await storedPage(harness, source, {
      ref: 'finance/close.md',
      title: '月结流程',
      markdown,
      marker: { status: 'superseded', quote, judgedAt: 3 },
    });
    expect(await restate(harness, source, 'finance/close.md')).toBe(true);
    expect(await pageOf(harness, pageId)).toMatchObject({
      status: 'superseded',
      statusSource: 'marker',
    });
    // The page's top is edited: the judgement was of other lines, and decides nothing.
    await harness.run(async (ctx) => {
      await ctx.db.patch(pageId, {
        markdown: markdown.replace('2026版', '2027版'),
      });
    });
    expect(await restate(harness, source, 'finance/close.md')).toBe(true);
    expect(await pageOf(harness, pageId)).toMatchObject({
      status: 'active',
      statusSource: 'default',
    });
  });

  it('supersedes a page a confirmed relation names a successor for, and names the successor', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, { ref: 'runbooks/pipeline-runbook.md' });
    await storedPage(harness, source, { ref: 'runbooks/pipeline-runbook-v2.md' });
    const relationId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: source.sourceId, ref: 'runbooks/pipeline-runbook-v2.md' },
          to: { sourceId: source.sourceId, ref: 'runbooks/pipeline-runbook.md' },
          kind: 'possible_successor',
          evidence: [{ measure: 'title-version', value: 1 }],
          status: 'proposed',
          createdAt: 4,
        }),
    );
    // Proposed is not confirmed: nothing is superseded by a measure alone.
    expect(await restate(harness, source, 'runbooks/pipeline-runbook.md')).toBe(false);
    await harness.run(async (ctx) => {
      await ctx.db.patch(relationId, { status: 'confirmed' });
    });
    expect(await restate(harness, source, 'runbooks/pipeline-runbook.md')).toBe(true);
    expect(await pageOf(harness, pageId)).toMatchObject({
      status: 'superseded',
      statusSource: 'relation',
      supersededBy: { sourceId: source.sourceId, ref: 'runbooks/pipeline-runbook-v2.md' },
    });
  });
});

describe('a change of status', (): void => {
  it('is written on the record of each employee that reads the source, and of no other', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    await storedPage(harness, source, { ref: 'runbooks/refresh.md' });
    const reader = await employee(harness, 'Priya');
    const deployedWithout = await employee(harness, 'Mateo', [source.sourceId]);
    await harness.mutation(internal.docStatus.recordRead, {
      sourceId: source.sourceId,
      syncRunId: source.runId,
      ref: 'runbooks/refresh.md',
      nativeStatus: 'archived',
    });
    expect(await eventsOf(harness, reader, 'documentation.page-status-changed')).toEqual([
      {
        sourceId: source.sourceId,
        ref: 'runbooks/refresh.md',
        title: 'Refreshing the tile',
        from: 'active',
        to: 'archived',
        decidedBy: 'source-native',
      },
    ]);
    expect(await eventsOf(harness, deployedWithout, 'documentation.page-status-changed')).toEqual(
      [],
    );
  });

  it('sends the work parked as out of scope back for a fresh evaluation, once a status', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    await storedPage(harness, source, { ref: 'runbooks/refresh.md' });
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
    const record = async (nativeStatus?: 'archived'): Promise<boolean> =>
      await harness.mutation(internal.docStatus.recordRead, {
        sourceId: source.sourceId,
        syncRunId: source.runId,
        ref: 'runbooks/refresh.md',
        ...(nativeStatus !== undefined ? { nativeStatus } : {}),
      });
    await record('archived');
    const key = `documentation-status:${source.sourceId}:runbooks/refresh.md:archived`;
    expect(await eventsOf(harness, agentId, 'work.requeued')).toEqual([
      { workItemId: parked, trigger: 'documentation', key, previousState: 'skipped' },
    ]);
    expect((await harness.run(async (ctx) => await ctx.db.get(parked)))?.state).toBe('discovered');
    // Skipped again, the page back and archived once more: the same status re-admits nothing.
    await harness.run(async (ctx) => {
      await ctx.db.patch(parked, { state: 'skipped' });
    });
    await record();
    await record('archived');
    expect(
      (await eventsOf(harness, agentId, 'work.requeued')).filter((event) => event.key === key),
    ).toHaveLength(1);
  });
});
