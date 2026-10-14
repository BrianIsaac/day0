import type { TestConvex } from 'convex-test';
import { internal } from '../../../convex/_generated/api';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';
import { replacePageBlocks } from '../../../convex/docBlocks';
import type { SourceAuthority } from '../../../src/docs/authority';
import { MANAGER_ADDRESS, managerIdentity } from './manager-identity';

/*
 * The documentation a relation's test seeds (wave 15, 15-A; shared since wave 16's 16-s split
 * `convex/docRelations.ts` and its tests by concern): an owner's employees, linked sources with a
 * sync running, pages stored with their blocks as that sync leaves them, and the measure a
 * finishing sync runs over one page.
 */

/** The convex-test harness over the schema. */
export type Harness = TestConvex<typeof schema>;

/** A linked source with a sync running. */
export interface Source {
  readonly sourceId: Id<'docSources'>;
  readonly runId: Id<'docSyncRuns'>;
}

/** The wiki's pipeline runbook: a refresh step and a 5,000 USD threshold. */
export const PIPELINE_V1 = [
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

/** Its later version, whose front matter says it supersedes the first. */
export const PIPELINE_V2 = [
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

/** The finance escalation page, which gives 10,000 USD under the same heading. */
export const FINANCE = [
  '# Finance escalation',
  '',
  '## Thresholds',
  '',
  'Escalate any variance above 10,000 USD to the finance lead.',
].join('\n');

/** An employee of an owner's. */
export async function employee(
  harness: Harness,
  name: string,
  userId = 'owner',
): Promise<Id<'agents'>> {
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
export async function syncingSource(
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
export async function storedPage(
  harness: Harness,
  source: Source,
  page: {
    ref: string;
    title: string;
    markdown: string;
    updatedAt?: number;
    datedBySource?: boolean;
  },
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

/**
 * Measure a page of a source, as its finishing sync does with room for every candidate.
 *
 * @returns How many relations the measure proposed.
 */
export async function measure(harness: Harness, source: Source, ref: string): Promise<number> {
  // A pair a transaction since D-12 (a): the measuring's action, as a step measures one page.
  const { proposed } = await harness.action(internal.docSyncActions.measurePage, {
    sourceId: source.sourceId,
    syncRunId: source.runId,
    ref,
  });
  return proposed;
}

/** Every relation, oldest first. */
export async function relations(harness: Harness): Promise<Doc<'docRelations'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('docRelations').collect());
}

/** A page's row. */
export async function pageOf(harness: Harness, pageId: Id<'docPages'>): Promise<Doc<'docPages'>> {
  return await harness.run(async (ctx) => (await ctx.db.get(pageId))!);
}

/** An employee's events of one type, oldest first, by payload. */
export async function eventsOf(
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
export async function twoVersions(harness: Harness): Promise<{
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
export async function twoThatDisagree(
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

/** The harness as the manager's verified identity. */
export const asManager = (harness: Harness) => harness.withIdentity(managerIdentity());
