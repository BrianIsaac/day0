import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { replacePageBlocks } from '../../convex/docBlocks';
import { DECISION_NOT_OFFERED, standingConflictOf } from '../../convex/docRelations';
import type { SourceAuthority } from '../../src/docs/authority';
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

  it('lets no conflict stand between pages of unequal trust: official over team settles it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { finance } = await twoThatDisagree(harness, { finance: 'official' });
    await measure(harness, finance, 'escalation.md');
    const [relation] = await relations(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'disagree',
    });
    expect(await standingOf(harness, relation._id)).toBeNull();
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
    const [relation] = await relations(harness);
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
