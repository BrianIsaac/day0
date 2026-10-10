import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { replacePageBlocks } from '../../convex/docBlocks';
import { markerCandidate } from '../../src/docs/status';
import { finishingCursor } from '../../src/docs/finishing';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { sourceAuthorityOf } from '../../src/docs/authority';

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

/** A registered skill of the employee's whose verified version read the given pages. */
async function skillThatRead(
  harness: Harness,
  agentId: Id<'agents'>,
  readRefs: Array<{ sourceId: Id<'docSources'>; ref: string; title: string }>,
): Promise<Id<'skills'>> {
  return await harness.run(async (ctx) => {
    const versionId = await ctx.db.insert('skillVersions', {
      userId: 'owner',
      name: 'refresh-the-tile',
      description: 'Refresh the tile',
      surfaceClass: 'dashboard',
      operation: 'refresh',
      version: 1,
      body: '# Body',
      bodyHash: 'b'.repeat(64),
      requiredScopes: [],
      harnessTools: [],
      authorName: 'Priya',
      readRefs,
      verifiedAt: 1,
      createdAt: 1,
    });
    return await ctx.db.insert('skills', {
      agentId,
      name: 'refresh-the-tile',
      description: 'Refresh the tile',
      body: '# Body',
      sourceType: 'agent-authored',
      state: 'registered',
      versionId,
      ownerKey: 'owner',
      createdAt: 1,
    });
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

describe('restatePages: the status phase of a finishing sync', (): void => {
  const CHINESE = '# 月结流程\n\n本文件已废止,请参阅《月结流程(2026版)》。\n\n## 步骤\n\n关账。';
  const STATUS = finishingCursor({ phase: 'status', cursor: null });

  /** Put the source's running sync at a point of its finish. */
  async function standAt(
    harness: Harness,
    source: { runId: Id<'docSyncRuns'> },
    cursor: string,
  ): Promise<void> {
    await harness.run(async (ctx) => {
      await ctx.db.patch(source.runId, { cursor });
    });
  }

  it('restates every page the generation keeps and hands back the pages whose marker lines no judgement stands for', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    await storedPage(harness, source, { ref: 'a-plain.md' });
    await storedPage(harness, source, { ref: 'b-close.md', title: '月结流程', markdown: CHINESE });
    const judged = markerCandidate('Close checklist (DEPRECATED)', RUNBOOK)!;
    const standing = await storedPage(harness, source, {
      ref: 'c-judged.md',
      title: 'Close checklist (DEPRECATED)',
      marker: { status: 'superseded', quote: judged.quote, judgedAt: 3 },
    });
    const stale = await storedPage(harness, source, {
      ref: 'd-stale.md',
      title: 'Onboarding',
      status: 'draft',
      statusSource: 'marker',
      marker: { status: 'draft', quote: 'DRAFT, not yet approved', judgedAt: 3 },
    });
    await standAt(harness, source, STATUS);
    const page = await harness.mutation(internal.docStatus.restatePages, {
      sourceId: source.sourceId,
      runId: source.runId,
      checkpoint: STATUS,
      from: null,
      record: false,
    });
    expect(page).toMatchObject({
      changed: 2,
      done: true,
      checkpoint: finishingCursor({ phase: 'scopes', cursor: null }),
    });
    // Only the Chinese page awaits a judgement: its lines hit the pre-filter and none is stored.
    expect(page?.toJudge).toEqual([
      { ref: 'b-close.md', ...markerCandidate('月结流程', CHINESE)! },
    ]);
    // A standing judgement decides; one of lines the page no longer holds is removed with its status.
    expect(await pageOf(harness, standing)).toMatchObject({
      status: 'superseded',
      statusSource: 'marker',
    });
    const cleared = await pageOf(harness, stale);
    expect([cleared.status, cleared.statusSource, cleared.marker]).toEqual([
      'active',
      'default',
      undefined,
    ]);
    // The run's cursor now starts the scopes phase, where the finish goes on.
    expect((await harness.run(async (ctx) => await ctx.db.get(source.runId)))?.cursor).toBe(
      finishingCursor({ phase: 'scopes', cursor: null }),
    );
  });

  it('runs in its own phase only, and stops for a run a newer sync moved on', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    await storedPage(harness, source, { ref: 'a-plain.md' });
    const mirrors = finishingCursor({ phase: 'mirrors', cursor: null });
    await standAt(harness, source, mirrors);
    const walk = async (checkpoint: string) =>
      await harness.mutation(internal.docStatus.restatePages, {
        sourceId: source.sourceId,
        runId: source.runId,
        checkpoint,
        from: null,
        record: false,
      });
    await expect(walk(mirrors)).rejects.toThrow('runs in its status phase only');
    // The run stands elsewhere than the caller last saw: another finish, or a newer sync.
    expect(await walk(STATUS)).toBeNull();
    await standAt(harness, source, STATUS);
    await harness.run(async (ctx) => {
      await ctx.db.patch(source.runId, { state: 'superseded' });
    });
    expect(await walk(STATUS)).toBeNull();
  });
});

describe('recordMarker: a judgement of a page’s marker lines', (): void => {
  const CHINESE = '# 月结流程\n\n本文件已废止,请参阅《月结流程(2026版)》。';

  it('stores the judgement with the lines it is of, and supersedes the page with its blocks', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, {
      ref: 'finance/close.md',
      title: '月结流程',
      markdown: CHINESE,
    });
    const { quote } = markerCandidate('月结流程', CHINESE)!;
    expect(
      await harness.mutation(internal.docStatus.recordMarker, {
        sourceId: source.sourceId,
        syncRunId: source.runId,
        ref: 'finance/close.md',
        quote,
        status: 'superseded',
      }),
    ).toBe(true);
    expect(await pageOf(harness, pageId)).toMatchObject({
      status: 'superseded',
      statusSource: 'marker',
      marker: { status: 'superseded', quote, judgedAt: expect.any(Number) },
    });
    expect(await blockStatuses(harness, source.sourceId, 'finance/close.md')).toEqual([
      'superseded',
    ]);
  });

  it('keeps a judgement of active as the cache it is, and leaves the page current', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const markdown = '# How to archive a ticket\n\nAn archived ticket leaves the board.';
    const pageId = await storedPage(harness, source, {
      ref: 'howto/archive.md',
      title: 'How to archive a ticket',
      markdown,
    });
    const { quote } = markerCandidate('How to archive a ticket', markdown)!;
    await harness.mutation(internal.docStatus.recordMarker, {
      sourceId: source.sourceId,
      syncRunId: source.runId,
      ref: 'howto/archive.md',
      quote,
      status: 'active',
    });
    const page = await pageOf(harness, pageId);
    expect(page.marker).toMatchObject({ status: 'active', quote });
    expect([page.status, page.statusSource]).toEqual([undefined, undefined]);
  });

  it('takes nothing for lines the page no longer holds, or a generation that is not the running one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, {
      ref: 'finance/close.md',
      title: '月结流程',
      markdown: CHINESE,
    });
    const record = async (quote: string, syncRunId: Id<'docSyncRuns'>): Promise<boolean> =>
      await harness.mutation(internal.docStatus.recordMarker, {
        sourceId: source.sourceId,
        syncRunId,
        ref: 'finance/close.md',
        quote,
        status: 'superseded',
      });
    expect(await record('本文件已废止,请参阅《月结流程(2025版)》。', source.runId)).toBe(false);
    const other = await syncingSource(harness);
    expect(await record(markerCandidate('月结流程', CHINESE)!.quote, other.runId)).toBe(false);
    expect((await pageOf(harness, pageId)).marker).toBeUndefined();
  });
});

describe('the manager’s own status for a page', (): void => {
  /** The owner signed in with a verified address. */
  const asManager = (harness: Harness) => harness.withIdentity(managerIdentity());

  it('marks a page a draft, archived, or superseded by another page, with who decided and when', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, { ref: 'runbooks/pipeline-runbook.md' });
    const successor = await storedPage(harness, source, { ref: 'runbooks/pipeline-runbook-v2.md' });
    const agentId = await employee(harness, 'Priya');
    vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'));
    await asManager(harness).mutation(api.docStatus.setPageStatus, { pageId, status: 'draft' });
    expect(await pageOf(harness, pageId)).toMatchObject({
      status: 'draft',
      statusSource: 'manager',
      decidedBy: MANAGER_ADDRESS,
      decidedAt: Date.parse('2026-10-10T09:00:00.000Z'),
    });
    expect(await blockStatuses(harness, source.sourceId, 'runbooks/pipeline-runbook.md')).toEqual([
      'draft',
      'draft',
    ]);
    await asManager(harness).mutation(api.docStatus.setPageStatus, { pageId, status: 'archived' });
    expect((await pageOf(harness, pageId)).status).toBe('archived');
    await asManager(harness).mutation(api.docStatus.setPageStatus, {
      pageId,
      status: 'superseded',
      supersededBy: successor,
    });
    expect(await pageOf(harness, pageId)).toMatchObject({
      status: 'superseded',
      statusSource: 'manager',
      supersededBy: { sourceId: source.sourceId, ref: 'runbooks/pipeline-runbook-v2.md' },
    });
    expect(
      (await eventsOf(harness, agentId, 'documentation.page-status-changed')).map((event) => [
        event.from,
        event.to,
        event.decidedBy,
      ]),
    ).toEqual([
      ['active', 'draft', 'manager'],
      ['draft', 'archived', 'manager'],
      ['archived', 'superseded', 'manager'],
    ]);
  });

  it('refuses a superseded page with no successor, itself as its successor, or a successor that is not the manager’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, { ref: 'runbooks/pipeline-runbook.md' });
    const other = await syncingSource(harness, { userId: 'another-owner' });
    const theirs = await storedPage(harness, other, { ref: 'theirs.md' });
    const set = async (supersededBy?: Id<'docPages'>) =>
      await asManager(harness).mutation(api.docStatus.setPageStatus, {
        pageId,
        status: 'superseded',
        ...(supersededBy !== undefined ? { supersededBy } : {}),
      });
    await expect(set()).rejects.toThrow('Name the page that supersedes it.');
    await expect(set(pageId)).rejects.toThrow('A page cannot supersede itself.');
    await expect(set(theirs)).rejects.toThrow('forbidden');
    expect((await pageOf(harness, pageId)).status).toBeUndefined();
  });

  it('clears back to what the page and its source say: the source’s own word, or the default', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, { ref: 'runbooks/refresh.md' });
    const native = await storedPage(harness, source, {
      ref: 'archive/old.md',
      status: 'archived',
      statusSource: 'source-native',
      nativeStatus: 'archived',
    });
    for (const id of [pageId, native]) {
      await asManager(harness).mutation(api.docStatus.setPageStatus, {
        pageId: id,
        status: 'draft',
      });
      await asManager(harness).mutation(api.docStatus.clearPageStatus, { pageId: id });
    }
    const cleared = await pageOf(harness, pageId);
    expect([cleared.status, cleared.statusSource, cleared.decidedBy, cleared.decidedAt]).toEqual([
      'active',
      'default',
      undefined,
      undefined,
    ]);
    expect(await blockStatuses(harness, source.sourceId, 'runbooks/refresh.md')).toEqual([
      'active',
      'active',
    ]);
    expect(await pageOf(harness, native)).toMatchObject({
      status: 'archived',
      statusSource: 'source-native',
    });
    // Clear on a page the manager never decided changes nothing.
    await asManager(harness).mutation(api.docStatus.clearPageStatus, { pageId: native });
    expect((await pageOf(harness, native)).statusSource).toBe('source-native');
  });

  it('says a page is current over a confirmed relation, a judged marker and its source’s own word, until Clear', async (): Promise<void> => {
    // The second pass's major 1: each of these three was a state the manager could not leave.
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const successor = { sourceId: source.sourceId, ref: 'runbooks/pipeline-runbook-v2.md' };
    await storedPage(harness, source, { ref: successor.ref });
    const byRelation = await storedPage(harness, source, {
      ref: 'runbooks/pipeline-runbook.md',
      status: 'superseded',
      statusSource: 'relation',
      supersededBy: successor,
    });
    await harness.run(async (ctx) => {
      await ctx.db.insert('docRelations', {
        userId: 'owner',
        from: successor,
        to: { sourceId: source.sourceId, ref: 'runbooks/pipeline-runbook.md' },
        kind: 'possible_successor',
        evidence: [{ measure: 'title-version', value: 1 }],
        status: 'confirmed',
        createdAt: 4,
      });
    });
    const chinese = '# 月结流程\n\n本文件已废止,请参阅《月结流程(2026版)》。';
    const byMarker = await storedPage(harness, source, {
      ref: 'finance/close.md',
      title: '月结流程',
      markdown: chinese,
      status: 'superseded',
      statusSource: 'marker',
      marker: {
        status: 'superseded',
        quote: markerCandidate('月结流程', chinese)!.quote,
        judgedAt: 3,
      },
    });
    const bySource = await storedPage(harness, source, {
      ref: 'archive/old.md',
      status: 'archived',
      statusSource: 'source-native',
      nativeStatus: 'archived',
    });
    const agentId = await employee(harness, 'Priya');
    vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'));
    for (const pageId of [byRelation, byMarker, bySource]) {
      await asManager(harness).mutation(api.docStatus.setPageStatus, { pageId, status: 'active' });
      const row = await pageOf(harness, pageId);
      expect([
        row.status,
        row.statusSource,
        row.decidedBy,
        row.decidedAt,
        row.supersededBy,
      ]).toEqual([
        'active',
        'manager',
        MANAGER_ADDRESS,
        Date.parse('2026-10-10T09:00:00.000Z'),
        undefined,
      ]);
      expect(new Set(await blockStatuses(harness, source.sourceId, row.ref))).toEqual(
        new Set(['active']),
      );
    }
    expect(
      (await eventsOf(harness, agentId, 'documentation.page-status-changed')).map((event) => [
        event.ref,
        event.from,
        event.to,
        event.decidedBy,
      ]),
    ).toEqual([
      ['runbooks/pipeline-runbook.md', 'superseded', 'active', 'manager'],
      ['finance/close.md', 'superseded', 'active', 'manager'],
      ['archive/old.md', 'archived', 'active', 'manager'],
    ]);
    // Clear takes the manager's word off again: each page is back to what decided it before.
    for (const pageId of [byRelation, byMarker, bySource]) {
      await asManager(harness).mutation(api.docStatus.clearPageStatus, { pageId });
    }
    expect(await pageOf(harness, byRelation)).toMatchObject({
      status: 'superseded',
      statusSource: 'relation',
      supersededBy: successor,
    });
    expect(await pageOf(harness, byMarker)).toMatchObject({
      status: 'superseded',
      statusSource: 'marker',
    });
    expect(await pageOf(harness, bySource)).toMatchObject({
      status: 'archived',
      statusSource: 'source-native',
    });
  });

  it('is the owner’s alone: another signed-in manager is refused, and an anonymous caller before any read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, { ref: 'runbooks/refresh.md' });
    const stranger = harness.withIdentity(managerIdentity('stranger'));
    await expect(
      stranger.mutation(api.docStatus.setPageStatus, { pageId, status: 'archived' }),
    ).rejects.toThrow('forbidden');
    await expect(stranger.mutation(api.docStatus.clearPageStatus, { pageId })).rejects.toThrow(
      'forbidden',
    );
    await expect(
      stranger.mutation(api.docStatus.setSourceAuthority, {
        sourceId: source.sourceId,
        authority: 'official',
      }),
    ).rejects.toThrow('forbidden');
    await expect(
      harness.mutation(api.docStatus.setPageStatus, { pageId, status: 'archived' }),
    ).rejects.toThrow();
    expect((await pageOf(harness, pageId)).status).toBeUndefined();
  });
});

describe('the trust the manager gives a source', (): void => {
  it('is stored on the source, and reads as team until it is set', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const read = async () =>
      sourceAuthorityOf((await harness.run(async (ctx) => await ctx.db.get(source.sourceId)))!);
    expect(await read()).toBe('team');
    await harness.withIdentity(managerIdentity()).mutation(api.docStatus.setSourceAuthority, {
      sourceId: source.sourceId,
      authority: 'official',
    });
    expect(await read()).toBe('official');
  });
});

describe('the skills that read a page whose status changed', (): void => {
  /** The skill's Re-check due reason, once the scheduled library scan has run. */
  async function reasonOf(harness: Harness, skillId: Id<'skills'>): Promise<string | undefined> {
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    return (await harness.run(async (ctx) => await ctx.db.get(skillId)))?.recheckReason;
  }

  it('are due a re-check when the page is superseded, in the card’s words, and keep running meanwhile', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    const pageId = await storedPage(harness, source, { ref: 'runbooks/pipeline-runbook.md' });
    const successor = await storedPage(harness, source, { ref: 'runbooks/pipeline-runbook-v2.md' });
    const agentId = await employee(harness, 'Priya');
    const skillId = await skillThatRead(harness, agentId, [
      {
        sourceId: source.sourceId,
        ref: 'runbooks/pipeline-runbook.md',
        title: 'Refreshing the tile',
      },
    ]);
    vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'));
    await harness.withIdentity(managerIdentity()).mutation(api.docStatus.setPageStatus, {
      pageId,
      status: 'superseded',
      supersededBy: successor,
    });
    expect(await reasonOf(harness, skillId)).toBe(
      'its runbook "Refreshing the tile" was superseded on 10 October 2026',
    );
    expect((await harness.run(async (ctx) => await ctx.db.get(skillId)))?.state).toBe('registered');
  });

  it('are due one when its source archives it with no edit, and none when a page comes back', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness);
    await storedPage(harness, source, { ref: 'runbooks/refresh.md' });
    const back = await storedPage(harness, source, {
      ref: 'runbooks/back.md',
      status: 'archived',
      statusSource: 'source-native',
      nativeStatus: 'archived',
    });
    const agentId = await employee(harness, 'Priya');
    const archived = await skillThatRead(harness, agentId, [
      { sourceId: source.sourceId, ref: 'runbooks/refresh.md', title: 'Refreshing the tile' },
    ]);
    const returning = await skillThatRead(harness, agentId, [
      { sourceId: source.sourceId, ref: 'runbooks/back.md', title: 'Refreshing the tile' },
    ]);
    vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'));
    for (const [ref, nativeStatus] of [
      ['runbooks/refresh.md', 'archived'],
      ['runbooks/back.md', undefined],
    ] as const) {
      await harness.mutation(internal.docStatus.recordRead, {
        sourceId: source.sourceId,
        syncRunId: source.runId,
        ref,
        ...(nativeStatus !== undefined ? { nativeStatus } : {}),
      });
    }
    expect(await reasonOf(harness, archived)).toBe(
      'its runbook "Refreshing the tile" was archived on 10 October 2026',
    );
    expect((await pageOf(harness, back)).status).toBe('active');
    expect(await reasonOf(harness, returning)).toBeUndefined();
  });
});
