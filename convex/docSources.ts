import { v } from 'convex/values';
import { paginationOptsValidator, type PaginationResult } from 'convex/server';
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  assertDocsComponentReachable,
  componentFor,
  isBundledNotionLocator,
} from '../src/docs/components';
import { getCallerOrThrow } from './ownership';
import { assertRealMode, SURFACE_MODE } from '../src/lib/surface-mode';
import { readCardPages, reconcileDocumentedSystems } from './surfaces';
import { credentialOwnerRefusal } from './handoverFence';
import { purgeCredential } from './credentials';
import type { IntakeScope } from '../src/surfaces/intake-scope';
import { assertCurrentGeneration } from '../src/docs/sync-generation';
import { appendEvent } from './eventLog';
import { mirroredDocSlug } from '../src/docs/types';
import { agentReadsSource } from '../src/docs/agent-sources';
import { readableDocs } from './mock';
import {
  endedShort,
  unreadPagesLine,
  unreadRecordIn,
  withUnreadPages,
  type UnreadRecord,
} from '../src/docs/sync-record';
import { runToResume } from '../src/docs/sync-resume';
import { credentialPageRef } from '../src/docs/credential-ref';
import { parseFeishuLocator, parseFeishuSecret } from '../src/docs/feishu-source';
import { actsAsAtUpgrade } from '../src/surfaces/access-identity';
import {
  FINISHING_CURSOR,
  finishingCursor,
  finishingStep,
  type FinishingPhase,
} from '../src/docs/finishing';
import type { MigrationName } from './migrations';
import schema from './schema';

const sourceKind = v.union(
  v.literal('mcp'),
  v.literal('folder'),
  v.literal('git'),
  v.literal('urls'),
  v.literal('feishu'),
);

const serverKind = v.union(
  v.literal('notion'),
  v.literal('confluence'),
  v.literal('drive'),
  v.literal('generic'),
);

/** The listed pages a batch could not read, each kept at its last stored version (P5-11). */
const unreadPages = v.optional(v.array(v.object({ ref: v.string(), reason: v.string() })));

export { FINISHING_CURSOR };

/**
 * How many finishing pages go by between the checkpoints a run's cursor
 * records: a run begun before 0.6.0 listed its pages until the
 * `sync-runs-refs` migration cleared them, so recording it after every page
 * would have rewritten that list each time; a finish resumed from a
 * checkpoint walks at most this many pages again, which delete nothing new.
 */
export const FINISHING_CHECKPOINT_EVERY = 10;

/**
 * One page of a paged read over a source's pages or mirrors: few enough rows
 * and bytes that one read stays well inside a transaction's limits whatever
 * the pages hold (a page body can be up to 768 KiB).
 */
export const PAGED_READ = { numItems: 100, maximumBytesRead: 4 * 1024 * 1024 } as const;

/**
 * Listing rows one page of the finish's walk reads. Each may lead to one
 * stored page read and deleted, of up to `MAX_STORED_PAGE_BYTES` (768 KiB),
 * so sixteen stay under a transaction's 16 MiB read limit.
 */
export const STALE_LISTING_PAGE = 16;

/**
 * How long a superseded page credential is kept before its source's finish
 * prunes it, when no surface holds it (C2 D2 (a)). A value that returns to
 * its page within this long revives its own row; past it, a page whose token
 * rotates monthly keeps about one superseded row per credential rather than
 * one per rotation, so neither the 512-row page read nor the 1,000-row source
 * cap is ever reached by history alone.
 */
export const SUPERSEDED_CREDENTIAL_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a finished run is kept for the record before the run history is pruned. */
export const RUN_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The most runs one pruning pass deletes. A run holds its counts, at most ten unread pages and
 * its credential refs, at most the 1,000 a source may hold before its finish refuses (its page
 * list went at 0.17.0, 13-K, once 0.16.0's `sync-runs-refs` had cleared it): a few hundred KiB
 * at the most, so a pass of this many stays well inside one transaction's read limit.
 */
const RUN_PRUNE_BATCH = 32;

/**
 * The migration that reads completed runs by their completion time
 * (`credentials-sync-revoke`): completed runs are kept for it until it has run.
 */
const RUNS_READ_BY_MIGRATION: MigrationName = 'credentials-sync-revoke';

/** Why a run that a newer one replaced before it finished ended. */
const SUPERSEDED_RUN_REASON = 'a newer sync of the source started before this one finished';

/**
 * The patch that says why a run ended short: the reason on one line, and the
 * run's record of its unread pages on its own field.
 */
function endedShortPatch(
  ending: string,
  run: Doc<'docSyncRuns'>,
): { reason: string; unread: UnreadRecord | undefined } {
  return { reason: endedShort(ending), unread: unreadRecordIn(run) };
}

/** Why a run that a newer one took over from its cursor ended. */
function resumedRunReason(pageCount: number): string {
  return `a newer sync of the source took over from its cursor after ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`;
}

/**
 * How many pages a source holds, from its run record rather than its pages.
 *
 * Counting the pages would read every page body (C-15). The last completed
 * run's summary counts what it kept; before a sync has completed, the newest
 * run's listing count is the pages it has named so far.
 */
async function storedPageCount(ctx: QueryCtx, source: Doc<'docSources'>): Promise<number> {
  const completed = source.lastCompletedSyncId
    ? await ctx.db.get(source.lastCompletedSyncId)
    : null;
  if (completed) return completed.summary?.pagesKept ?? listedCount(completed);
  const newest = await ctx.db
    .query('docSyncRuns')
    .withIndex('by_source', (index) => index.eq('sourceId', source._id))
    .order('desc')
    .first();
  return newest ? listedCount(newest) : 0;
}

/**
 * How many page refs a run's listing has named. A run of a release before 0.6.0 counted its refs,
 * which the `sync-runs-refs` migration carried into `pagesListed` as it cleared them (0.16.0).
 */
function listedCount(run: Doc<'docSyncRuns'>): number {
  return run.pagesListed ?? 0;
}

/** Start the next listing of a source, one that reads from page one, and return its number. */
async function nextListing(ctx: MutationCtx, source: Doc<'docSources'>): Promise<number> {
  const listing = (source.listings ?? 0) + 1;
  await ctx.db.patch(source._id, { listings: listing });
  return listing;
}

/** Why a batch or a finish of a run with no listing is refused. */
const RUN_WITHOUT_LISTING =
  'This documentation sync run has no listing: it began before 0.6.0, and the next sync reads the source from page one.';

/**
 * The listing a run reads, given it when it began. Only a run begun before 0.6.0 has none, and
 * the `sync-runs-refs` pass (0.16.0) took the cursor of every such run that had not completed, so
 * no batch or finish is fenced to one; one that reaches here anyway is refused rather than given a
 * listing its pages were never stamped under (13-K, the narrowing 12-S3 left).
 *
 * @throws Error with {@link RUN_WITHOUT_LISTING} for a run with no listing.
 */
function runListing(run: Doc<'docSyncRuns'>): number {
  if (run.listing === undefined) throw new Error(RUN_WITHOUT_LISTING);
  return run.listing;
}

/**
 * Stamp each ref a batch listed with the listing that named it, so the
 * finish keeps its page (D D2 (a)). One small row per ref, found by index:
 * no page body is read or written.
 */
async function stampListed(
  ctx: MutationCtx,
  sourceId: Id<'docSources'>,
  refs: readonly string[],
  listing: number,
): Promise<void> {
  for (const ref of new Set(refs)) {
    const row = await ctx.db
      .query('docPageListings')
      .withIndex('by_source_ref', (index) => index.eq('sourceId', sourceId).eq('ref', ref))
      .unique();
    if (row === null) await ctx.db.insert('docPageListings', { sourceId, ref, seenBy: listing });
    else if (row.seenBy !== listing) await ctx.db.patch(row._id, { seenBy: listing });
  }
}

export interface LinkInput {
  label: string;
  kind: 'mcp' | 'folder' | 'git' | 'urls' | 'feishu';
  locator: string;
  serverKind?: 'notion' | 'confluence' | 'drive' | 'generic';
}

/**
 * Validate and normalise an owner-supplied documentation location.
 *
 * Args:
 *   input: Link form values.
 *
 * Returns:
 *   Trimmed values safe to persist.
 *
 * Raises:
 *   Error: If the source kind and locator fields are inconsistent.
 */
export function validateLinkInput(input: LinkInput): LinkInput {
  const label = input.label.trim();
  const locator = input.locator.trim();
  if (!label) throw new Error('Documentation label is required.');
  if (!locator) throw new Error('Documentation locator is required.');
  // The locator is stored on the row and shown on the page, so a token in it
  // would sit in plaintext on both; no refusal repeats the locator.
  // Read on the raw text as well as the parsed URL: a `#` before the `@`
  // moves the userinfo into the fragment, where the parser does not see it.
  const refuseUserinfo = (url: URL, raw: string): void => {
    if (url.username !== '' || url.password !== '' || /^[a-z][a-z0-9+.-]*:\/\/[^/?]*@/i.test(raw)) {
      throw new Error(
        'Documentation locators must not carry a user name or password; a credential is ' +
          'linked with the source, never inside its address.',
      );
    }
  };
  if (input.kind === 'folder') {
    if (locator.startsWith('/') || locator.split(/[\\/]/).includes('..')) {
      throw new Error('Folder locator must be relative and stay inside DAY0_DOCS_ROOT.');
    }
  } else if (input.kind === 'urls') {
    const values = locator
      .split(/\r?\n/)
      .map((value: string): string => value.trim())
      .filter(Boolean);
    if (values.length === 0) throw new Error('At least one documentation URL is required.');
    for (const value of values) {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Documentation URLs must use HTTP or HTTPS.');
      }
      refuseUserinfo(url, value);
    }
  } else if (input.kind === 'feishu') {
    // The host names the region and the path the space or folder; nothing else is stored.
    parseFeishuLocator(locator);
  } else {
    const rawUrl = input.kind === 'git' ? locator.split('#')[0] : locator;
    const url = new URL(rawUrl);
    refuseUserinfo(url, locator);
    // Only Day0's own Notion component is reached over plain HTTP, on the
    // compose network; every other MCP server gets a secret, and the reader
    // connects to it over HTTPS at a checked public address alone (M16).
    const bundled =
      input.kind === 'mcp' && input.serverKind === 'notion' && isBundledNotionLocator(url.href);
    if (url.protocol !== 'https:' && !(bundled && url.protocol === 'http:')) {
      throw new Error('Remote documentation locators must use HTTPS.');
    }
  }
  if (input.kind === 'mcp') {
    if (!input.serverKind) throw new Error('MCP server kind is required.');
  } else if (input.serverKind) {
    throw new Error('Only MCP sources may name a server kind.');
  }
  return { ...input, label, locator };
}

/**
 * The source kinds that read with a secret of their own: required for MCP and Feishu, optional for
 * git and URLs.
 */
const SECRET_KINDS: ReadonlySet<LinkInput['kind']> = new Set(['mcp', 'git', 'urls', 'feishu']);

/**
 * Check the secret a source is linked with, before anything is stored (E-74).
 *
 * An MCP server needs its connection secret. A private git repository or a
 * wiki behind a login may be linked with the reader's own secret, which is
 * stored as a credential and never written into the locator. A URL list
 * read with a secret must list pages of one https site, since the secret is
 * that site's and is sent to no other. A Feishu source needs its app's ID
 * and secret, joined by a colon, which it exchanges for the tenant's token. A
 * folder is read from the mounted directory and takes none.
 *
 * @param input - The validated link values.
 * @param secret - The secret the owner entered, if any.
 * @throws Error saying which rule the secret breaks; the message never repeats the secret.
 */
export function validateReaderSecret(input: LinkInput, secret: string | undefined): void {
  if (input.kind === 'mcp' && !secret) {
    throw new Error('Connection secret is required for an MCP source.');
  }
  if (input.kind === 'feishu' && !secret) {
    throw new Error('A Feishu source needs its app ID and secret.');
  }
  if (secret === undefined) return;
  if (!SECRET_KINDS.has(input.kind)) {
    throw new Error('A folder is read from the mounted directory and takes no secret.');
  }
  if (!secret) throw new Error('A secret, when given, cannot be empty.');
  // A secret with a line break or a control character is cut apart by every
  // record that words a failure, and no longer matches its own redaction.
  if (/[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error('A secret cannot contain a line break or a control character.');
  }
  if (input.kind === 'feishu') parseFeishuSecret(secret);
  if (input.kind === 'urls') {
    const origins = new Set(
      input.locator
        .split(/\r?\n/)
        .map((value: string): string => value.trim())
        .filter(Boolean)
        .map((value: string): string => new URL(value).origin),
    );
    const [origin] = [...origins];
    if (origins.size !== 1 || !origin.startsWith('https://')) {
      throw new Error(
        'A reader secret belongs to one https site: list pages of one https site to read them with it.',
      );
    }
  }
}

/** What a source's own secret is called on its credential row. */
function secretLabel(source: Pick<LinkInput, 'label' | 'kind'>): string {
  switch (source.kind) {
    case 'mcp':
      return `${source.label} connection secret`;
    case 'feishu':
      return `${source.label} app ID and secret`;
    case 'folder':
    case 'git':
    case 'urls':
      return `${source.label} reader secret`;
  }
}

/**
 * Purge the credentials and discovered systems of one source being removed.
 *
 * Its pages, mirrors and runs are deleted in pages afterwards
 * (`deleteSourceRows`), since a whole source's rows can outgrow one transaction.
 *
 * Args:
 *   ctx: Convex mutation context.
 *   source: Documentation source being removed.
 */
async function retireSourceState(ctx: MutationCtx, source: Doc<'docSources'>): Promise<void> {
  const now = Date.now();
  const agents = await ctx.db
    .query('agents')
    .withIndex('by_userId', (index) => index.eq('userId', source.userId))
    .take(101);
  if (agents.length > 100) throw new Error('Documentation source exceeds 100 agents.');
  for (const agent of agents) {
    if (!agentReadsSource(agent, source._id)) continue;
    await reconcileDocumentedSystems(ctx, {
      agentId: agent._id,
      sourceId: source._id,
      systems: [],
      now,
    });
  }
  const discovered = await ctx.db
    .query('credentials')
    .withIndex('by_user_source_ref', (index) =>
      index.eq('userId', source.userId).eq('source.sourceId', source._id),
    )
    .take(1_001);
  if (discovered.length > 1_000) throw new Error('Source exceeds 1,000 credentials.');
  const credentialIds = new Set<Id<'credentials'>>(discovered.map((row) => row._id));
  if (source.credentialId) credentialIds.add(source.credentialId);
  for (const credentialId of credentialIds) {
    const credential = await ctx.db.get(credentialId);
    if (credential) await purgeCredential(ctx, credential, now);
  }
  const systemDiscoveries = await ctx.db
    .query('docSystemDiscoveries')
    .withIndex('by_source', (index) => index.eq('sourceId', source._id))
    .take(1_001);
  if (systemDiscoveries.length > 1_000) {
    throw new Error('Documentation source exceeds 1,000 discovered systems.');
  }
  for (const discovery of systemDiscoveries) await ctx.db.delete(discovery._id);
}

/**
 * List documentation sources owned by the signed-in caller, each with its page count.
 *
 * Public, for the signed-in owner; reads the owner's sources and each one's
 * run record, never its pages.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getCallerOrThrow(ctx);
    const sources = await ctx.db
      .query('docSources')
      .withIndex('by_user', (index) => index.eq('userId', identity.ownerKey))
      .collect();
    return await Promise.all(
      sources.map(async (source) => ({
        ...source,
        pageCount: await storedPageCount(ctx, source),
      })),
    );
  },
});

/** Return owned source labels for dashboard joins. */
export const byIds = query({
  args: { sourceIds: v.array(v.id('docSources')) },
  handler: async (ctx, args) => {
    const identity = await getCallerOrThrow(ctx);
    const sources = await Promise.all(
      args.sourceIds.map(async (sourceId) => await ctx.db.get(sourceId)),
    );
    return sources.filter(
      (source): source is Doc<'docSources'> =>
        source !== null && source.userId === identity.ownerKey,
    );
  },
});

/**
 * Link one owner-level documentation location and start its first sync.
 *
 * Public, for the signed-in owner. An MCP source's connection secret, or a
 * git or URL source's own reader secret (E-74), is stored as an encrypted
 * credential and only its id is kept on the source. Refused outside real
 * mode: a linked source makes the deployment fetch its locator on every
 * periodic sync, which the hosted mock must never do on a caller's behalf.
 */
export const link = action({
  args: {
    label: v.string(),
    kind: sourceKind,
    locator: v.string(),
    serverKind: v.optional(serverKind),
    credential: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<'docSources'>> => {
    const identity = await getCallerOrThrow(ctx);
    assertRealMode('Documentation linking');
    const input = validateLinkInput({
      label: args.label,
      kind: args.kind,
      locator: args.locator,
      serverKind: args.serverKind,
    });
    const credential = args.credential;
    validateReaderSecret(input, credential);
    // Checked before anything is written, so a component that is not running is
    // answered in the form the operator is looking at rather than as a failed
    // sync minutes later. The same check runs on every sync, which is where a
    // component that stops after the link is reported.
    await assertDocsComponentReachable(input);
    const sourceId = await ctx.runMutation(internal.docSources.createSource, {
      userId: identity.ownerKey,
      ...input,
    });
    let storedCredentialId: Id<'credentials'> | undefined;
    try {
      if (credential) {
        storedCredentialId = await ctx.runAction(internal.credentials.store, {
          userId: identity.ownerKey,
          kind: 'value',
          label: secretLabel(input),
          plaintext: credential,
          source: 'entered',
        });
        await ctx.runMutation(internal.docSources.attachCredential, {
          sourceId,
          userId: identity.ownerKey,
          credentialId: storedCredentialId,
        });
      }
      await ctx.scheduler.runAfter(0, internal.docSyncActions.syncSource, { sourceId });
      return sourceId;
    } catch (error) {
      await ctx.runMutation(internal.docSources.deleteFailedLink, {
        sourceId,
        userId: identity.ownerKey,
        credentialId: storedCredentialId,
      });
      throw error;
    }
  },
});

/**
 * Rotate an owned source's secret without placing it in scheduler arguments.
 *
 * Public, for the source's owner: an MCP connection secret, or the reader
 * secret of a git or URL source (E-74). The old credential is revoked and
 * the source syncs again from page one.
 */
export const rotateCredential = action({
  args: { sourceId: v.id('docSources'), credential: v.string() },
  handler: async (ctx, args): Promise<Id<'credentials'>> => {
    const identity = await getCallerOrThrow(ctx);
    assertRealMode('Documentation credential rotation');
    if (!args.credential) throw new Error('Connection secret is required.');
    const source = await ctx.runQuery(internal.docSources.getOwnedInternal, {
      sourceId: args.sourceId,
      userId: identity.ownerKey,
    });
    if (!source || !SECRET_KINDS.has(source.kind)) {
      throw new Error('Documentation source not found.');
    }
    validateReaderSecret(source, args.credential);
    const credentialId = await ctx.runAction(internal.credentials.store, {
      userId: identity.ownerKey,
      kind: 'value',
      label: secretLabel(source),
      plaintext: args.credential,
      source: 'entered',
    });
    await ctx.runMutation(internal.docSources.attachCredential, {
      sourceId: source._id,
      userId: identity.ownerKey,
      credentialId,
    });
    if (source.credentialId) {
      await ctx.runMutation(internal.credentials.revokeInternal, {
        credentialId: source.credentialId,
      });
    }
    // A new secret may read a different workspace, so nothing an older run read is carried over.
    await ctx.scheduler.runAfter(0, internal.docSyncActions.syncSource, {
      sourceId: source._id,
      fresh: true,
    });
    return credentialId;
  },
});

/**
 * Schedule a sync of one owned location; refused outside real mode.
 *
 * Public, for the source's owner. A sync that ended short, or one still
 * running, is carried on from its cursor (`beginSync`), so pressing it does
 * not throw away the pages already read; a new secret starts from page one.
 */
export const resync = mutation({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args): Promise<void> => {
    const identity = await getCallerOrThrow(ctx);
    assertRealMode('Documentation resync');
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.userId !== identity.ownerKey)
      throw new Error('Documentation source not found.');
    await ctx.db.patch(source._id, {
      status: 'linking',
      lastError: undefined,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.docSyncActions.syncSource, { sourceId: source._id });
  },
});

/**
 * Unlink an owned source; real mode only.
 *
 * Public, for the source's owner. Deletes the source, purges its credentials
 * and discovered systems, and schedules its pages, mirrors and runs for
 * deletion in pages (`deleteSourceRows`), since a whole source's rows can
 * outgrow one transaction. No reader reaches a page of a deleted source: the
 * readers list pages by the employee's sources.
 */
export const unlink = mutation({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args): Promise<null> => {
    const identity = await getCallerOrThrow(ctx);
    assertRealMode('Documentation unlinking');
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.userId !== identity.ownerKey)
      throw new Error('Documentation source not found.');
    await removeSource(ctx, source);
    return null;
  },
});

/** Remove one source now and its rows in scheduled pages. */
async function removeSource(ctx: MutationCtx, source: Doc<'docSources'>): Promise<void> {
  await retireSourceState(ctx, source);
  await ctx.db.delete(source._id);
  await ctx.scheduler.runAfter(0, internal.docSources.deleteSourceRows, { sourceId: source._id });
}

/**
 * The tables a removed source leaves rows in, in the order they are deleted: what an employee
 * reads directly first (its mirrors, then the blocks a search reads), the record last.
 */
const SOURCE_ROW_TABLES = [
  'mockDocs',
  'docBlocks',
  'docPages',
  'docPageListings',
  'docSyncRuns',
] as const;

/**
 * Delete one bounded page of a removed source's rows in one table, and schedule the next.
 *
 * Internal; scheduled by `unlink` and a full reset, starting at the mirrors,
 * which an employee reads directly. A table done hands on to the next, until
 * every table is empty.
 */
export const deleteSourceRows = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    table: v.optional(v.union(...SOURCE_ROW_TABLES.map((table) => v.literal(table)))),
  },
  handler: async (ctx, args): Promise<number> => {
    const table = args.table ?? SOURCE_ROW_TABLES[0];
    // A source's blocks are read by their page index, which leads with the source.
    const page =
      table === 'docBlocks'
        ? await ctx.db
            .query('docBlocks')
            .withIndex('by_source_page', (index) => index.eq('sourceId', args.sourceId))
            .paginate({ ...PAGED_READ, cursor: null })
        : await ctx.db
            .query(table)
            .withIndex('by_source', (index) => index.eq('sourceId', args.sourceId))
            .paginate({ ...PAGED_READ, cursor: null });
    for (const row of page.page) await ctx.db.delete(row._id);
    const next = page.isDone ? SOURCE_ROW_TABLES[SOURCE_ROW_TABLES.indexOf(table) + 1] : table;
    if (next !== undefined) {
      await ctx.scheduler.runAfter(0, internal.docSources.deleteSourceRows, {
        sourceId: args.sourceId,
        table: next,
      });
    }
    return page.page.length;
  },
});

/**
 * The pages one surface's card reads (its approved scope's pages and its
 * evidence), for the probe: the system's own documentation, read by ref
 * rather than as the corpus (D D3 (b)). Internal; reads, writes nothing.
 */
export const cardPagesForSurface = internalQuery({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<Doc<'docPages'>[]> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) return [];
    const agent = await ctx.db.get(surface.agentId);
    if (!agent?.userId) return [];
    return await readCardPages(ctx, agent, [surface]);
  },
});

/**
 * Count linked documentation sources by kind, for `pnpm check:setup`.
 *
 * The setup report needs to say which documentation components this
 * installation actually depends on, and only the linked sources know: a Notion
 * source needs the `docs-notion` component, while folder, git and URL sources
 * need no container at all. Counts only - no locator, label or credential
 * leaves the deployment.
 */
interface LinkedSourceKind {
  kind: string;
  serverKind?: string;
  component?: string;
  count: number;
}

export const linkedKinds = internalQuery({
  args: {},
  handler: async (ctx): Promise<LinkedSourceKind[]> => {
    const sources = await ctx.db.query('docSources').take(1_001);
    if (sources.length > 1_000)
      throw new Error('Documentation source count exceeds the setup limit.');
    const counts = new Map<string, LinkedSourceKind>();
    for (const source of sources) {
      const component = componentFor(source);
      const key = `${source.kind}:${source.serverKind ?? ''}:${component ?? ''}`;
      const row = counts.get(key) ?? {
        kind: source.kind,
        serverKind: source.serverKind,
        component,
        count: 0,
      };
      row.count += 1;
      counts.set(key, row);
    }
    return [...counts.values()].sort((left, right): number =>
      `${left.kind}${left.serverKind ?? ''}${left.component ?? ''}`.localeCompare(
        `${right.kind}${right.serverKind ?? ''}${right.component ?? ''}`,
      ),
    );
  },
});

/** Insert source metadata after a public action has validated it. */
export const createSource = internalMutation({
  args: {
    userId: v.string(),
    label: v.string(),
    kind: sourceKind,
    locator: v.string(),
    serverKind: v.optional(serverKind),
  },
  handler: async (ctx, args): Promise<Id<'docSources'>> => {
    const now = Date.now();
    return await ctx.db.insert('docSources', {
      ...args,
      status: 'linking',
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Attach only an encrypted credential id to an owned source. */
export const attachCredential = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    userId: v.string(),
    credentialId: v.id('credentials'),
  },
  handler: async (ctx, args): Promise<void> => {
    const source = await ctx.db.get(args.sourceId);
    const credential = await ctx.db.get(args.credentialId);
    if (
      !source ||
      !credential ||
      source.userId !== args.userId ||
      credential.userId !== args.userId
    ) {
      throw new Error('Documentation source not found.');
    }
    await ctx.db.patch(source._id, { credentialId: credential._id, updatedAt: Date.now() });
  },
});

/** Remove a partially linked row and revoke any credential already created for it. */
export const deleteFailedLink = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    userId: v.string(),
    credentialId: v.optional(v.id('credentials')),
  },
  handler: async (ctx, args): Promise<void> => {
    const source = await ctx.db.get(args.sourceId);
    if (source?.userId === args.userId) await ctx.db.delete(source._id);
    if (args.credentialId) {
      const credential = await ctx.db.get(args.credentialId);
      if (credential?.userId === args.userId && !credential.revokedAt) {
        await ctx.db.patch(credential._id, { revokedAt: Date.now() });
      }
    }
  },
});

/** Read one source only when it belongs to the supplied authenticated owner. */
export const getOwnedInternal = internalQuery({
  args: { sourceId: v.id('docSources'), userId: v.string() },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    return source?.userId === args.userId ? source : null;
  },
});

/** Read one source for a server-side sync action. */
export const getInternal = internalQuery({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args) => await ctx.db.get(args.sourceId),
});

/**
 * How long a sync may sit in `linking` without progress before the periodic
 * pass restarts it. A batch is bounded by the Node action limit (ten
 * minutes), and every batch stamps the source, so a source older than this
 * belongs to an action the runtime killed without reaching its catch block.
 */
export const STALE_SYNC_MS = 30 * 60 * 1000;

/**
 * List one page of the sources eligible for periodic resync; empty outside
 * real mode so the cron is inert. A source mid-sync is skipped so the cron
 * never races a continuation, unless it stopped progressing long enough ago
 * to be abandoned, in which case `beginSync` takes over the dead generation.
 * Internal; the periodic sync walks the pages.
 */
export const listSyncable = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<Doc<'docSources'>>> => {
    if (SURFACE_MODE !== 'real') return { page: [], isDone: true, continueCursor: '' };
    const result = await ctx.db.query('docSources').paginate(args.paginationOpts);
    const now = Date.now();
    return {
      ...result,
      page: result.page.filter(
        (source) => source.status !== 'linking' || now - source.updatedAt > STALE_SYNC_MS,
      ),
    };
  },
});

/**
 * List one bounded page of the pages stored for one source (`PAGED_READ`).
 *
 * Internal; the deploy mirror, the finishing sync and the re-orientation
 * walk a source through it instead of reading it whole (C-15).
 */
export const pagesForSourceInternal = internalQuery({
  args: { sourceId: v.id('docSources'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<Doc<'docPages'>>> =>
    await ctx.db
      .query('docPages')
      .withIndex('by_source', (index) => index.eq('sourceId', args.sourceId))
      .paginate({ ...args.paginationOpts, ...PAGED_READ }),
});

/** List owner agents that inherit a source. */
export const agentsForSource = internalQuery({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) return [];
    const agents = await ctx.db
      .query('agents')
      .withIndex('by_userId', (index) => index.eq('userId', source.userId))
      .collect();
    return agents.filter((agent) => agentReadsSource(agent, source._id));
  },
});

/** List inherited sources for one internal agent sync. */
export const sourcesForAgentInternal = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent?.userId) return [];
    const sources = await ctx.db
      .query('docSources')
      .withIndex('by_user', (index) => index.eq('userId', agent.userId!))
      .collect();
    return sources.filter((source) => agentReadsSource(agent, source._id));
  },
});

/**
 * Start a fenced sync generation, taking over a run that ended short from its cursor.
 *
 * Internal. The source's newest run, when it failed or is being replaced
 * before it finished, carries its cursor, its listing, its credential refs,
 * its counts and its record of unread pages into the new run, which reads on
 * from there (step 17); its own reason says the new run took over. A fresh
 * start (`fresh`, as a new connection secret needs), a run too old or a
 * resume that got nowhere reads from page one (`runToResume`) and starts the
 * source's next listing, so every page an earlier one named is pruned unless
 * this one names it again.
 *
 * @returns The new run's id; its `cursor` is where its first batch reads from.
 */
export const beginSync = internalMutation({
  args: { sourceId: v.id('docSources'), fresh: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<Id<'docSyncRuns'>> => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) throw new Error('Documentation source not found.');
    const now = Date.now();
    const [latest, previous] = await ctx.db
      .query('docSyncRuns')
      .withIndex('by_source', (index) => index.eq('sourceId', source._id))
      .order('desc')
      .take(2);
    const resumed = args.fresh === true ? undefined : runToResume(latest, previous, now);
    const active = source.activeSyncId ? await ctx.db.get(source.activeSyncId) : null;
    if (active?.state === 'running') {
      await ctx.db.patch(active._id, {
        state: 'superseded',
        completedAt: now,
        ...endedShortPatch(
          active._id === resumed?._id ? resumedRunReason(active.pageCount) : SUPERSEDED_RUN_REASON,
          active,
        ),
      });
    } else if (resumed !== undefined) {
      const ending = (resumed.reason ?? '').split('\n')[0] || 'The run ended short.';
      const tookOver = resumedRunReason(resumed.pageCount);
      await ctx.db.patch(
        resumed._id,
        endedShortPatch(
          `${ending} ${tookOver.charAt(0).toUpperCase()}${tookOver.slice(1)}.`,
          resumed,
        ),
      );
    }
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId: source._id,
      cursor: resumed?.cursor,
      listing: resumed === undefined ? await nextListing(ctx, source) : runListing(resumed),
      pagesListed: resumed === undefined ? 0 : listedCount(resumed),
      credentialRefs: resumed?.credentialRefs ?? [],
      pageCount: resumed?.pageCount ?? 0,
      redactionCount: resumed?.redactionCount ?? 0,
      unread: unreadRecordIn(resumed),
      state: 'running',
      createdAt: now,
    });
    await ctx.db.patch(source._id, {
      activeSyncId: runId,
      status: 'linking',
      lastError: undefined,
      updatedAt: now,
    });
    return runId;
  },
});

/** Why a run whose listing changed under its cursor ended. */
const LISTING_CHANGED_REASON =
  'the listing changed under its cursor, so a new sync reads the source from the first page';

/**
 * Replace a running generation whose listing changed under its cursor with a fresh one.
 *
 * Internal; the sync calls it when a reader finds its offset cursor was taken
 * from another listing (`ListingChangedError`). Reading on would miss a page
 * that moved behind the cursor and delete it at the end, so the new run reads
 * from page one and carries nothing over.
 *
 * @returns The new run's id, or null when the run is no longer the source's running one.
 */
export const restartSync = internalMutation({
  args: { sourceId: v.id('docSources'), runId: v.id('docSyncRuns') },
  handler: async (ctx, args): Promise<Id<'docSyncRuns'> | null> => {
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (!source || !run || source.activeSyncId !== run._id || run.state !== 'running') return null;
    const now = Date.now();
    await ctx.db.patch(run._id, {
      state: 'superseded',
      completedAt: now,
      ...endedShortPatch(LISTING_CHANGED_REASON, run),
    });
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId: source._id,
      listing: await nextListing(ctx, source),
      pagesListed: 0,
      credentialRefs: [],
      pageCount: 0,
      redactionCount: 0,
      state: 'running',
      createdAt: now,
    });
    await ctx.db.patch(source._id, {
      activeSyncId: runId,
      status: 'linking',
      lastError: undefined,
      updatedAt: now,
    });
    return runId;
  },
});

/**
 * Delete a source's oldest finished runs, a few at a time.
 *
 * Internal; each sync calls it once after its run begins. A run finished
 * over `RUN_HISTORY_MS` ago is deleted unless the source still points at it
 * (running, last completed, last discovered); a completed one is kept while
 * the migration that reads completed runs by their completion time has not
 * run. A pass reads at most `RUN_PRUNE_BATCH` runs.
 *
 * @returns How many runs were deleted.
 */
export const pruneRunHistory = internalMutation({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args): Promise<number> => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) return 0;
    const cutoff = Date.now() - RUN_HISTORY_MS;
    const pointedAt = new Set(
      [source.activeSyncId, source.lastCompletedSyncId, source.lastDiscoverySyncId].filter(
        (id): id is Id<'docSyncRuns'> => id !== undefined,
      ),
    );
    const migration = await ctx.db
      .query('migrations')
      .withIndex('by_name', (index) => index.eq('name', RUNS_READ_BY_MIGRATION))
      .first();
    const completedMayGo = migration?.completedAt !== undefined;
    const old = await ctx.db
      .query('docSyncRuns')
      .withIndex('by_source_completed_at', (index) =>
        index.eq('sourceId', source._id).gte('completedAt', 0).lt('completedAt', cutoff),
      )
      .take(RUN_PRUNE_BATCH);
    let deleted = 0;
    for (const run of old) {
      if (pointedAt.has(run._id) || (run.state === 'completed' && !completedMayGo)) continue;
      await ctx.db.delete(run._id);
      deleted += 1;
    }
    return deleted;
  },
});

/** Read a generation and source for one Node-action batch. */
export const syncContext = internalQuery({
  args: { sourceId: v.id('docSources'), runId: v.id('docSyncRuns') },
  handler: async (ctx, args) => {
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (
      !source ||
      !run ||
      source.activeSyncId !== run._id ||
      run.sourceId !== source._id ||
      run.state !== 'running'
    ) {
      return null;
    }
    return { source, run };
  },
});

/**
 * Record one non-final batch and advance its provider-safe cursor.
 *
 * The batch's `refs` and `credentialRefs` include the pages it could not
 * read and their stored credentials, so the finished generation keeps them:
 * each ref is stamped with the run's listing (`docPageListings`), however
 * many pages the source lists; `unread` names those pages in the run's record.
 */
export const recordSyncBatch = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    currentCursor: v.optional(v.string()),
    nextCursor: v.string(),
    refs: v.array(v.string()),
    credentialRefs: v.array(v.string()),
    pageCount: v.number(),
    redactionCount: v.number(),
    unread: unreadPages,
  },
  handler: async (ctx, args): Promise<boolean> => {
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (
      !source ||
      !run ||
      source.activeSyncId !== run._id ||
      run.state !== 'running' ||
      run.cursor !== args.currentCursor
    ) {
      return false;
    }
    await stampListed(ctx, source._id, args.refs, runListing(run));
    await ctx.db.patch(run._id, {
      cursor: args.nextCursor,
      pagesListed: listedCount(run) + args.refs.length,
      credentialRefs: [...run.credentialRefs, ...args.credentialRefs],
      pageCount: run.pageCount + args.pageCount,
      redactionCount: run.redactionCount + args.redactionCount,
      unread: withUnreadPages(unreadRecordIn(run), args.unread ?? []),
    });
    await ctx.db.patch(source._id, { updatedAt: Date.now() });
    return true;
  },
});

/**
 * The fence of a run that has read every page and is finishing: it is the
 * source's running run and its cursor is still the checkpoint the caller
 * last saw, so no newer sync and no other finish has moved it on.
 */
async function finishingRun(
  ctx: QueryCtx,
  sourceId: Id<'docSources'>,
  runId: Id<'docSyncRuns'>,
  checkpoint: string,
): Promise<{ source: Doc<'docSources'>; run: Doc<'docSyncRuns'> } | null> {
  const [source, run] = await Promise.all([ctx.db.get(sourceId), ctx.db.get(runId)]);
  if (
    !source ||
    !run ||
    source.activeSyncId !== run._id ||
    run.state !== 'running' ||
    run.cursor !== checkpoint
  ) {
    return null;
  }
  return { source, run };
}

/** What one finishing page did, and where the finish stands after it. */
export interface FinishingPage {
  readonly removed: number;
  /** Whether the phase's walk is over, and the run's cursor now starts the next phase. */
  readonly done: boolean;
  /** Where the phase's walk goes on from. */
  readonly from: string;
  /** The run's cursor after the page: the fence for the next one. */
  readonly checkpoint: string;
}

/** The arguments of one finishing page. */
const finishingPageArgs = {
  sourceId: v.id('docSources'),
  runId: v.id('docSyncRuns'),
  /** The run's cursor as the caller last saw it. */
  checkpoint: v.string(),
  /** Where in the phase's walk to read from. */
  from: v.union(v.string(), v.null()),
  /** Whether to record the page's position on the run. */
  record: v.boolean(),
};

/**
 * Close one finishing page: record where the finish stands when the phase
 * ends or the caller asks, and say where the walk goes on.
 */
async function closeFinishingPage(
  ctx: MutationCtx,
  run: Doc<'docSyncRuns'>,
  args: { readonly checkpoint: string; readonly record: boolean },
  phase: FinishingPhase,
  next: FinishingPhase,
  walked: { readonly removed: number; readonly isDone: boolean; readonly continueCursor: string },
): Promise<FinishingPage> {
  const position = finishingCursor(
    walked.isDone ? { phase: next, cursor: null } : { phase, cursor: walked.continueCursor },
  );
  const recorded = walked.isDone || args.record;
  if (recorded) await ctx.db.patch(run._id, { cursor: position });
  return {
    removed: walked.removed,
    done: walked.isDone,
    from: walked.continueCursor,
    checkpoint: recorded ? position : args.checkpoint,
  };
}

/** The phase a finishing checkpoint is in, refused when it is not the one a step runs in. */
function phaseOf(checkpoint: string, phase: FinishingPhase): void {
  if (finishingStep(checkpoint)?.phase !== phase) {
    throw new Error(`This step of a finish runs in its ${phase} phase only.`);
  }
}

/**
 * Delete one bounded page of the stored pages a finishing generation did not list.
 *
 * Internal; the finishing sync walks, with it, only the source's listing rows
 * an earlier listing stamped (D D2 (a)): a page this generation listed was
 * restamped by its batch, one it listed but could not read too (P5-11), so
 * the walk reads nothing a stable corpus keeps, whatever its size.
 *
 * @returns Where the finish stands, or null when the run is no longer at that checkpoint.
 */
export const prunePages = internalMutation({
  args: finishingPageArgs,
  handler: async (ctx, args): Promise<FinishingPage | null> => {
    phaseOf(args.checkpoint, 'pages');
    const finishing = await finishingRun(ctx, args.sourceId, args.runId, args.checkpoint);
    if (!finishing) return null;
    const listing = runListing(finishing.run);
    // A row this page deletes leaves the range behind the cursor.
    const page = await ctx.db
      .query('docPageListings')
      .withIndex('by_source', (index) => index.eq('sourceId', args.sourceId).lt('seenBy', listing))
      .paginate({ numItems: STALE_LISTING_PAGE, cursor: args.from });
    let removed = 0;
    for (const row of page.page) {
      const stored = await ctx.db
        .query('docPages')
        .withIndex('by_source_ref', (index) =>
          index.eq('sourceId', args.sourceId).eq('ref', row.ref),
        )
        .unique();
      if (stored !== null) {
        await ctx.db.delete(stored._id);
        // Its blocks go in their own bounded pages, so this page stays small whatever their count.
        await ctx.scheduler.runAfter(0, internal.docBlocks.prunePageBlocks, {
          sourceId: args.sourceId,
          pageRef: row.ref,
        });
        removed += 1;
      }
      await ctx.db.delete(row._id);
    }
    return await closeFinishingPage(ctx, finishing.run, args, 'pages', 'credentials', {
      ...page,
      removed,
    });
  },
});

/**
 * Delete one bounded page of a finishing source's superseded page credentials
 * that have aged out (C2 D2 (a)): superseded longer than
 * `SUPERSEDED_CREDENTIAL_KEEP_MS` ago, bound to no surface and never revoked
 * by a person, whose revoke the row must keep holding. Internal; the
 * finishing sync walks the source's credential rows with it, after the pages.
 *
 * @returns Where the finish stands, or null when the run is no longer at that checkpoint.
 */
export const pruneSupersededCredentials = internalMutation({
  args: finishingPageArgs,
  handler: async (ctx, args): Promise<FinishingPage | null> => {
    phaseOf(args.checkpoint, 'credentials');
    const finishing = await finishingRun(ctx, args.sourceId, args.runId, args.checkpoint);
    if (!finishing) return null;
    const cutoff = Date.now() - SUPERSEDED_CREDENTIAL_KEEP_MS;
    const page = await ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index.eq('userId', finishing.source.userId).eq('source.sourceId', args.sourceId),
      )
      .paginate({ ...PAGED_READ, cursor: args.from });
    let removed = 0;
    for (const credential of page.page) {
      // A person's revoke is kept for good: were the row gone, the same value
      // returning to its page would be stored afresh, unrevoked.
      if (
        credential.status !== 'superseded' ||
        credential.revokedAt !== undefined ||
        credential.supersededAt === undefined ||
        credential.supersededAt > cutoff
      ) {
        continue;
      }
      const bound = await ctx.db
        .query('surfaces')
        .withIndex('by_credentialId', (index) => index.eq('credentialId', credential._id))
        .first();
      if (bound !== null) continue;
      await ctx.db.delete(credential._id);
      removed += 1;
    }
    return await closeFinishingPage(ctx, finishing.run, args, 'credentials', 'mirrors', {
      ...page,
      removed,
    });
  },
});

/**
 * Delete one bounded page of the per-agent mirrors a finishing generation does not keep.
 *
 * Internal. A mirror is kept only for a listed page and only under the slug
 * `mirroredDocSlug` gives it now: one an earlier slug rule keyed (a
 * non-ASCII reference before v0.5.0) is a second copy beside the one this
 * sync wrote (review M20), and is kept while it is the only copy.
 *
 * @returns Where the finish stands, or null when the run is no longer at that checkpoint.
 */
export const pruneMirrors = internalMutation({
  args: finishingPageArgs,
  handler: async (ctx, args): Promise<FinishingPage | null> => {
    phaseOf(args.checkpoint, 'mirrors');
    const finishing = await finishingRun(ctx, args.sourceId, args.runId, args.checkpoint);
    if (!finishing) return null;
    const listing = runListing(finishing.run);
    const page = await ctx.db
      .query('mockDocs')
      .withIndex('by_source', (index) => index.eq('sourceId', args.sourceId))
      .paginate({ ...PAGED_READ, cursor: args.from });
    let removed = 0;
    for (const mirror of page.page) {
      if (mirror.sourceRef && (await listedBy(ctx, args.sourceId, mirror.sourceRef, listing))) {
        const slug = mirroredDocSlug(args.sourceId, mirror.sourceRef);
        if (mirror.slug === slug) continue;
        // An old-slug copy is the employee's only one until the page is
        // mirrored under its own slug, which a page this sync could not read is not.
        const own = await ctx.db
          .query('mockDocs')
          .withIndex('by_agent_slug', (index) =>
            index.eq('agentId', mirror.agentId).eq('slug', slug),
          )
          .first();
        if (own === null) continue;
      }
      await ctx.db.delete(mirror._id);
      removed += 1;
    }
    return await closeFinishingPage(ctx, finishing.run, args, 'mirrors', 'scopes', {
      ...page,
      removed,
    });
  },
});

/**
 * Delete one bounded page of an employee's mirrors it no longer reads, and schedule the next.
 *
 * Internal; scheduled by a handover's move (`transferAcceptance`), which hands the employee to an
 * owner the old owner's sources do not belong to. From that write the readers already hide those
 * pages (`mock.readableDocs`); this deletes them, a page of `PAGED_READ` at a time over the
 * employee's own index, the bound the finishing sync's `pruneMirrors` deletes by, keeping the
 * seeded office pages and every page the employee still reads. The run's finishing prune cannot
 * do it: it is fenced to one source's running sync and keeps every page the listing names. Each
 * page adds what it deleted to the handover's outcome (`mirroredPagesHidden`) when it names one.
 *
 * @returns How many pages this page of the walk deleted.
 */
export const pruneDepartedMirrors = internalMutation({
  args: {
    agentId: v.id('agents'),
    cursor: v.optional(v.string()),
    /** The handover whose outcome counts the pages deleted, when a handover scheduled it. */
    transferId: v.optional(v.id('managerTransfers')),
  },
  handler: async (ctx, args): Promise<number> => {
    // A retire since the move deleted the employee and its pages with it.
    const agent = await ctx.db.get(args.agentId);
    if (agent === null) return 0;
    const page = await ctx.db
      .query('mockDocs')
      .withIndex('by_agent_slug', (index) => index.eq('agentId', args.agentId))
      .paginate({ ...PAGED_READ, cursor: args.cursor ?? null });
    const readable = new Set((await readableDocs(ctx.db, agent, page.page)).map((doc) => doc._id));
    const unread = page.page.filter((doc) => !readable.has(doc._id));
    await Promise.all(unread.map(async (doc) => await ctx.db.delete(doc._id)));
    const transfer = args.transferId === undefined ? null : await ctx.db.get(args.transferId);
    if (transfer?.outcome && unread.length > 0) {
      await ctx.db.patch(transfer._id, {
        outcome: {
          ...transfer.outcome,
          mirroredPagesHidden: transfer.outcome.mirroredPagesHidden + unread.length,
        },
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.docSources.pruneDepartedMirrors, {
        agentId: args.agentId,
        cursor: page.continueCursor,
        ...(args.transferId === undefined ? {} : { transferId: args.transferId }),
      });
    }
    return unread.length;
  },
});

/** Whether a listing named a source's page: its listing row carries the listing's stamp. */
async function listedBy(
  ctx: QueryCtx,
  sourceId: Id<'docSources'>,
  ref: string,
  listing: number,
): Promise<boolean> {
  const row = await ctx.db
    .query('docPageListings')
    .withIndex('by_source_ref', (index) => index.eq('sourceId', sourceId).eq('ref', ref))
    .unique();
  return row?.seenBy === listing;
}

/** The verdicts under which an approved or proposed intake scope is re-read after a sync. */
const SCOPED_VERDICTS: ReadonlySet<Doc<'surfaces'>['verdict']> = new Set([
  'proposed',
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
]);

/** One surface's intake scope as a finishing sync reads it. */
export interface ScopedSurface {
  readonly surfaceId: Id<'surfaces'>;
  readonly intakeScope: IntakeScope<{
    value: string;
    sourceId?: Id<'docSources'>;
    ref: string;
    quote: string;
  }>;
}

/**
 * List the intake scopes of the employees reading a source, for the finishing sync to re-read.
 *
 * Internal; real mode reads it. Bounded as the employees and their surfaces are.
 */
export const scopedSurfaces = internalQuery({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args): Promise<ScopedSurface[]> => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) return [];
    const agents = await ctx.db
      .query('agents')
      .withIndex('by_userId', (index) => index.eq('userId', source.userId))
      .take(101);
    if (agents.length > 100) throw new Error('Documentation source exceeds 100 agents.');
    const scoped: ScopedSurface[] = [];
    for (const agent of agents) {
      if (!agentReadsSource(agent, source._id)) continue;
      const surfaces = await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (index) => index.eq('agentId', agent._id))
        .take(1_001);
      if (surfaces.length > 1_000) throw new Error('Agent exceeds 1,000 surfaces.');
      for (const surface of surfaces) {
        if (surface.intakeScope && SCOPED_VERDICTS.has(surface.verdict)) {
          scoped.push({ surfaceId: surface._id, intakeScope: surface.intakeScope });
        }
      }
    }
    return scoped;
  },
});

/**
 * Apply what a finishing sync found when it re-read one surface's approved intake scope.
 *
 * Internal. Values are compared by value, not by line (`restatedScope`): a
 * rename, a move or a reflowed line re-points the approved quote; a value
 * its page stopped stating returns an approved card to the manager. Nothing
 * is written when the run is no longer the finishing one, or when the
 * surface's scope changed since the sync read it (the next sync reads it again).
 *
 * @returns `repointed`, `reapproval` or `unchanged`.
 */
export const applyRestatedScope = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    surfaceId: v.id('surfaces'),
    read: schema.tables.surfaces.validator.fields.intakeScope,
    restated: schema.tables.surfaces.validator.fields.intakeScope,
    drifted: v.boolean(),
  },
  handler: async (ctx, args): Promise<'repointed' | 'reapproval' | 'unchanged'> => {
    const scopes = finishingCursor({ phase: 'scopes', cursor: null });
    if (!(await finishingRun(ctx, args.sourceId, args.runId, scopes))) return 'unchanged';
    const surface = await ctx.db.get(args.surfaceId);
    if (
      !surface?.intakeScope ||
      !SCOPED_VERDICTS.has(surface.verdict) ||
      JSON.stringify(surface.intakeScope) !== JSON.stringify(args.read)
    ) {
      return 'unchanged';
    }
    if (!args.drifted) {
      if (JSON.stringify(args.restated) === JSON.stringify(surface.intakeScope)) return 'unchanged';
      await ctx.db.patch(surface._id, { intakeScope: args.restated });
      return 'repointed';
    }
    if (surface.verdict === 'proposed' && surface.managerApprovedAt === undefined) {
      return 'unchanged';
    }
    await ctx.db.patch(surface._id, {
      verdict: 'proposed',
      reason:
        'A documented intake queue changed. Reject this card and re-run orientation before approval.',
      managerApprovedAt: undefined,
      probeGeneration: (surface.probeGeneration ?? 0) + 1,
      probeStartedAt: undefined,
      toolAllowlist: undefined,
      withheldTools: undefined,
      approvedToolAllowlist: undefined,
      toolAllowlistApprovedAt: undefined,
      toolArguments: undefined,
      lastVerifiedAt: undefined,
      providerIdentityId: undefined,
      providerWorkspaceId: undefined,
      managerDmChannelId: undefined,
      managerUserId: undefined,
      managerName: undefined,
      channelsNotJoined: undefined,
      lastPolledAt: undefined,
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.scope-reapproval-required',
      payload: { surfaceId: surface._id, sourceId: args.sourceId },
      createdAt: Date.now(),
    });
    return 'reapproval';
  },
});

/**
 * Complete a generation: supersede the credentials it no longer found and publish one synced state.
 *
 * Internal. The sync action calls it last, once the generation has read every
 * page, removed the pages and mirrors it did not list and re-read the intake
 * scopes (its cursor is the finish's `scopes` checkpoint), passing what those
 * steps removed as `pruned`; a resumed finish counts its own part only. A
 * caller that finishes a run from its last read batch passes that batch
 * instead, whose refs are stamped with the run's listing. `pagesKept` is the
 * pages the generation lists. A page the generation could not read is
 * stamped too, so it keeps its last stored version, mirror and credentials;
 * the run's unread record names it and the source's line says so until a
 * sync reads it (P5-11).
 */
export const finishSync = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    currentCursor: v.optional(v.string()),
    refs: v.array(v.string()),
    credentialRefs: v.array(v.string()),
    pageCount: v.number(),
    redactionCount: v.number(),
    unread: unreadPages,
    pruned: v.optional(
      v.object({
        pagesRemoved: v.number(),
        credentialsPruned: v.optional(v.number()),
        mirrorsRemoved: v.number(),
        surfacesToReapprove: v.number(),
      }),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ completed: boolean; pages: number; redactions: number }> => {
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (
      !source ||
      !run ||
      source.activeSyncId !== run._id ||
      run.state !== 'running' ||
      run.cursor !== args.currentCursor
    ) {
      return { completed: false, pages: 0, redactions: 0 };
    }
    await stampListed(ctx, source._id, args.refs, runListing(run));
    const pagesListed = listedCount(run) + args.refs.length;
    const currentCredentialRefs = new Set([...run.credentialRefs, ...args.credentialRefs]);
    const credentials = await ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index.eq('userId', source.userId).eq('source.sourceId', source._id),
      )
      .take(1_001);
    if (credentials.length > 1_000) throw new Error('Source exceeds 1,000 credentials.');
    // What the generation before this one stated tells a value swapped in from one the page
    // already held under the same label (N23).
    const previous = source.lastCompletedSyncId
      ? await ctx.db.get(source.lastCompletedSyncId)
      : null;
    const swap: PageSwapContext = {
      stated: currentCredentialRefs,
      statedBefore: previous === null ? undefined : new Set(previous.credentialRefs),
    };
    let credentialsSuperseded = 0;
    for (const credential of credentials) {
      if (typeof credential.source === 'string' || currentCredentialRefs.has(credential.source.ref))
        continue;
      // An earlier sync already superseded it and unbound its surfaces; doing
      // it again would rewrite nothing but the count.
      if (credential.status === 'superseded') continue;
      await supersedeCredential(ctx, credential, swap);
      credentialsSuperseded += 1;
    }
    const pageCount = run.pageCount + args.pageCount;
    const redactionCount = run.redactionCount + args.redactionCount;
    const unreadRecord = withUnreadPages(unreadRecordIn(run), args.unread ?? []);
    const pruned = {
      pagesRemoved: 0,
      credentialsPruned: 0,
      mirrorsRemoved: 0,
      surfacesToReapprove: 0,
      ...args.pruned,
    };
    const now = Date.now();
    await ctx.db.patch(run._id, {
      cursor: undefined,
      pagesListed,
      credentialRefs: [...currentCredentialRefs],
      pageCount,
      redactionCount,
      state: 'completed',
      completedAt: now,
      reason: undefined,
      unread: unreadRecord,
      summary: { pagesKept: pagesListed, ...pruned, credentialsSuperseded },
    });
    await ctx.db.patch(source._id, {
      activeSyncId: undefined,
      lastCompletedSyncId: run._id,
      status: 'synced',
      lastError: unreadPagesLine(unreadRecord),
      lastSyncAt: now,
      updatedAt: now,
    });
    return { completed: true, pages: pageCount, redactions: redactionCount };
  },
});

/** The verdicts of a card a swapped-out credential held that a re-bind sends back to its probe. */
const REBOUND_VERDICTS: ReadonlySet<Doc<'surfaces'>['verdict']> = new Set([
  'connected',
  'approved',
  'listed-dead',
  'ungranted',
]);

/** The reason `surfaces.endAccessInTransaction` leaves on a card whose access ended. */
const ACCESS_ENDED_REASON = 'expired';

/** What a re-bound card its manager approved says until its probe has checked the page's new value. */
const REBOUND_REASON =
  'The documentation now states a new value under the same label. Day0 bound it to this card and checks it before the card connects again.';

/** What a card sent back to landing a credential says. */
const UNBOUND_REASON =
  'The previously detected credential is no longer present in synced documentation. Land a valid credential before probing again.';

/** The page credentials a finishing sync states, and those the sync it follows stated. */
interface PageSwapContext {
  /** Every credential ref this generation stated. */
  readonly stated: ReadonlySet<string>;
  /** Every credential ref the source's previous completed generation stated; absent when none. */
  readonly statedBefore: ReadonlySet<string> | undefined;
}

/**
 * The live row that takes over from a page credential a sync superseded on a page swap (N23; the
 * wave 3.5 review's M15): among the page's live rows of the same label, which the label resolver
 * orientation binds a `<credential: label, stored>` marker with returns
 * (`credentials.pageRowsByLabel`), the one value this generation states that the generation before
 * it did not. A value the page already stated is another system's under the same label, never the
 * one swapped in; two new values under the label cannot be told apart, so neither is bound; with
 * no earlier generation to compare, none is. Undefined in each of those cases.
 *
 * The read is bounded as `credentials.store` bounds the page's rows, so a page this reads in full
 * is one whose credentials were stored.
 */
async function replacementFor(
  ctx: MutationCtx,
  credential: Doc<'credentials'>,
  swap: PageSwapContext,
): Promise<Doc<'credentials'> | undefined> {
  const statedBefore = swap.statedBefore;
  if (typeof credential.source === 'string' || statedBefore === undefined) return undefined;
  const rows: Doc<'credentials'>[] = await ctx.runQuery(internal.credentials.pageRowsByLabel, {
    userId: credential.userId,
    sourceId: credential.source.sourceId,
    pageRef: credentialPageRef(credential.source.ref),
    label: credential.label,
  });
  const swappedIn = rows.filter(
    (row) =>
      row._id !== credential._id &&
      row.ciphertext !== undefined &&
      typeof row.source !== 'string' &&
      swap.stated.has(row.source.ref) &&
      !statedBefore.has(row.source.ref),
  );
  return swappedIn.length === 1 ? swappedIn[0] : undefined;
}

/**
 * Supersede one page-derived credential no page of its source states any more. On a page swap
 * (the page states one new value under the same label, which this sync stored) every surface the
 * old row held whose employee belongs to the credential's owner is re-bound to the new row; any
 * other surface goes back to landing a credential.
 */
async function supersedeCredential(
  ctx: MutationCtx,
  credential: Doc<'credentials'>,
  swap: PageSwapContext,
): Promise<void> {
  const now = Date.now();
  // Superseded, not revoked: the status alone keeps the value out of every
  // decrypt and exact-value list, and the same value returning on a later
  // sync revives the row (`credentials.store`). Only a person's revoke
  // stamps `revokedAt`, so a sync never undoes one and never makes one. The
  // caller skips a row already superseded, so its first time stands and it ages.
  await ctx.db.patch(credential._id, {
    status: 'superseded',
    statusReason: 'No longer detected in synced documentation.',
    supersededAt: now,
  });
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_credentialId', (index) => index.eq('credentialId', credential._id))
    .take(1_001);
  if (surfaces.length > 1_000) throw new Error('Credential exceeds 1,000 bound surfaces.');
  const replacement =
    surfaces.length === 0 ? undefined : await replacementFor(ctx, credential, swap);
  const outcomes: SupersededSurface[] = [];
  for (const surface of surfaces) {
    // A card handed to another owner keeps its credential for the new manager's re-approval; it is
    // never bound to the old owner's new value (`credentialOwnerRefusal`, as a hand landing checks).
    const rebound =
      replacement !== undefined &&
      (await credentialOwnerRefusal(ctx.db, surface.agentId, replacement._id)) === null;
    if (rebound) await rebindSurface(ctx, surface, replacement, now);
    else await unbindSurface(ctx, surface);
    outcomes.push({ surface, rebound });
  }
  await recordSuperseded(ctx, credential, outcomes, now);
}

/**
 * Send a card a superseded page credential held back to landing a credential: unbound, its
 * request saying where one is documented, and out of `connected`, `approved` and `listed-dead`.
 */
async function unbindSurface(ctx: MutationCtx, surface: Doc<'surfaces'>): Promise<void> {
  const request = surface.request as { credential?: Record<string, unknown> } | undefined;
  const location =
    surface.credentialLocation ??
    'Ask the system administrator to land a valid credential using the linked documentation.';
  await ctx.db.patch(surface._id, {
    credentialId: undefined,
    credentialKind: undefined,
    credentialLocation: location,
    credentialLanded: false,
    request: request
      ? {
          ...request,
          credential: {
            ...request.credential,
            found: 'location',
            location,
            governanceFinding: undefined,
          },
        }
      : undefined,
    verdict: ['connected', 'approved', 'listed-dead'].includes(surface.verdict)
      ? 'ungranted'
      : surface.verdict,
    reason: UNBOUND_REASON,
    ...forgetProbedValue(surface),
  });
}

/**
 * What a probe of the old value learned, cleared, and the probe generation moved on: a probe that
 * already decrypted the retired value cannot reconnect the card.
 */
function forgetProbedValue(surface: Doc<'surfaces'>): Partial<Doc<'surfaces'>> {
  return {
    probeGeneration: (surface.probeGeneration ?? 0) + 1,
    probeStartedAt: undefined,
    toolAllowlist: undefined,
    withheldTools: undefined,
    toolArguments: undefined,
    lastVerifiedAt: undefined,
    providerIdentityId: undefined,
    providerWorkspaceId: undefined,
    managerDmChannelId: undefined,
    managerUserId: undefined,
    managerName: undefined,
    channelsNotJoined: undefined,
  };
}

/**
 * Bind a card a swapped-out page credential held to the row that took over from it, as a hand
 * landing binds a pasted one (`surfaces.attachCredential`): the card keeps its approval and its
 * approved tools and forgets what the old value's probe learned. A card its manager approved is
 * probed with the new value at once and says so; a card not approved, or whose access has ended
 * (its renewal probes it), keeps its verdict and its own reason, and nothing is probed.
 */
async function rebindSurface(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  replacement: Doc<'credentials'>,
  now: number,
): Promise<void> {
  const accessEnded =
    surface.reason === ACCESS_ENDED_REASON ||
    (surface.expiresAt !== undefined && surface.expiresAt <= now);
  const probe =
    !accessEnded &&
    surface.managerApprovedAt !== undefined &&
    REBOUND_VERDICTS.has(surface.verdict);
  await ctx.db.patch(surface._id, {
    credentialId: replacement._id,
    credentialKind: replacement.kind,
    credentialLanded: false,
    // Whom the card acts as is the new row's, named by its label; the old value's identity is
    // not carried over, as the probe learns the new one.
    actsAs: actsAsAtUpgrade(
      { ...surface, providerIdentityId: undefined },
      { kind: replacement.kind, label: replacement.label },
    ),
    ...(probe ? { verdict: 'approved' as const, reason: REBOUND_REASON } : {}),
    ...forgetProbedValue(surface),
  });
  if (probe) {
    await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
      surfaceId: surface._id,
    });
  }
}

/** A card a superseded page credential held, and whether the page swap re-bound it. */
interface SupersededSurface {
  readonly surface: Doc<'surfaces'>;
  readonly rebound: boolean;
}

/**
 * Tell every agent whose card was bound to a superseded page credential, one
 * event each through the contract, naming the page and never the value: the
 * cards sent back to landing a credential, and those re-bound to the value the
 * page states now. A credential no card was bound to reaches no agent's feed.
 */
async function recordSuperseded(
  ctx: MutationCtx,
  credential: Doc<'credentials'>,
  outcomes: readonly SupersededSurface[],
  now: number,
): Promise<void> {
  if (typeof credential.source === 'string') return;
  const byAgent = new Map<Id<'agents'>, { unbound: Id<'surfaces'>[]; rebound: Id<'surfaces'>[] }>();
  for (const { surface, rebound } of outcomes) {
    const cards = byAgent.get(surface.agentId) ?? { unbound: [], rebound: [] };
    (rebound ? cards.rebound : cards.unbound).push(surface._id);
    byAgent.set(surface.agentId, cards);
  }
  for (const [agentId, cards] of byAgent) {
    await appendEvent(ctx, {
      agentId,
      type: 'credential.superseded',
      payload: {
        credentialId: credential._id,
        label: credential.label,
        sourceId: credential.source.sourceId,
        page: credentialPageRef(credential.source.ref),
        surfaceIds: cards.unbound,
        ...(cards.rebound.length > 0 ? { reboundSurfaceIds: cards.rebound } : {}),
      },
      createdAt: now,
    });
  }
}

/**
 * End only the currently active generation short at its cursor: as failed (`error`, or
 * `credential-not-landed` for a credential the store could not give), or as `held` when the
 * deployment's pause stopped it before it read anything (W12V-2, W12-R27), the run then `held`
 * too so a later resume never counts it as one that got nowhere.
 */
export const failSync = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    status: v.union(v.literal('error'), v.literal('credential-not-landed'), v.literal('held')),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (!source || !run || source.activeSyncId !== run._id || run.state !== 'running') return false;
    const now = Date.now();
    // The cursor stays, so the next sync resumes the run from it (`beginSync`).
    await ctx.db.patch(run._id, {
      state: args.status === 'held' ? 'held' : 'error',
      completedAt: now,
      ...endedShortPatch(args.reason, run),
    });
    await ctx.db.patch(source._id, {
      activeSyncId: undefined,
      status: args.status,
      lastError: args.reason,
      updatedAt: now,
    });
    return true;
  },
});

/** Return non-secret completion counts for the local source probe. */
export const syncReport = internalQuery({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) return null;
    const latest = await ctx.db
      .query('docSyncRuns')
      .withIndex('by_source', (index) => index.eq('sourceId', source._id))
      .order('desc')
      .first();
    return {
      status: source.status,
      pageCount: await storedPageCount(ctx, source),
      redactionCount: latest?.redactionCount ?? 0,
      running: source.activeSyncId !== undefined,
      lastError: source.lastError,
    };
  },
});

/**
 * Upsert one normalised page by its stable source reference. Internal;
 * written by the sync for the generation it runs, and refused once a newer
 * generation has superseded that one, so a stale action can never write back
 * a page the newer sync removed.
 *
 * It stores the page's hash before redaction, schedules the split of every
 * page it writes into blocks (`docBlocks.splitStoredPage`), and, when a stored
 * page's body changed, the Re-check due stamp on the skills whose version read
 * it (`skillVersions.stampChangedPage`; 14-I).
 *
 * @throws Error when `syncRunId` is not the source's running generation.
 */
export const upsertPage = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    syncRunId: v.id('docSyncRuns'),
    ref: v.string(),
    title: v.string(),
    url: v.optional(v.string()),
    markdown: v.string(),
    updatedAt: v.number(),
    /** The page's hash before redaction (`pageContentHash`); absent where the deployment has no key. */
    contentHash: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<'docPages'>> => {
    await assertCurrentGeneration(ctx, args.sourceId, args.syncRunId);
    const existing = await ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (index) =>
        index.eq('sourceId', args.sourceId).eq('ref', args.ref),
      )
      .unique();
    // A changed page carries its new hash, or none, so an old hash never vouches for a new body.
    const page = {
      title: args.title,
      url: args.url,
      markdown: args.markdown,
      updatedAt: args.updatedAt,
      contentHash: args.contentHash,
    };
    // The page's blocks are split from the page as stored, in a job of their own that reads it
    // then, so a later write of the page is never undone by an earlier split (14-I).
    const splitStored = async (): Promise<void> => {
      await ctx.scheduler.runAfter(0, internal.docBlocks.splitStoredPage, {
        sourceId: args.sourceId,
        ref: args.ref,
        generation: args.syncRunId,
      });
    };
    if (existing) {
      // An unchanged page is not written again, so every subscriber to the
      // page is not woken on each fifteen-minute sync (P5-18).
      const unchanged =
        existing.title === page.title &&
        existing.url === page.url &&
        existing.markdown === page.markdown;
      if (unchanged) {
        // A page stored before its hash or under another key takes the hash, with its body
        // and time left as they were; and an unchanged page the sync stores again (its split
        // never landed, or it was redacted again) is split again.
        if (args.contentHash !== undefined) {
          if (existing.contentHash !== args.contentHash) {
            await ctx.db.patch(existing._id, { contentHash: args.contentHash });
          }
          await splitStored();
        }
        return existing._id;
      }
      await ctx.db.patch(existing._id, page);
      await splitStored();
      // A changed runbook re-checks the skills that read it (the enhancements plan, 4.1): its
      // text changed and both hashes say so; a page stored before its hash may only have been
      // redacted to other words, which is no change a skill must be checked against.
      const textChanged =
        existing.contentHash !== undefined &&
        args.contentHash !== undefined &&
        existing.contentHash !== args.contentHash;
      if (textChanged && existing.markdown !== page.markdown) {
        const source = await ctx.db.get(args.sourceId);
        if (source !== null) {
          await ctx.scheduler.runAfter(0, internal.skillVersions.stampChangedPage, {
            userId: source.userId,
            sourceId: args.sourceId,
            ref: args.ref,
            title: page.title,
            changedAt: Date.now(),
            cursor: null,
          });
        }
      }
      return existing._id;
    }
    // Every stored page carries a listing row, so a page whose batch never
    // recorded is still found, and removed, by the next finish that did not list it.
    const run = await ctx.db.get(args.syncRunId);
    if (!run) throw new Error('Documentation sync run not found.');
    await stampListed(ctx, args.sourceId, [args.ref], runListing(run));
    const pageId = await ctx.db.insert('docPages', {
      sourceId: args.sourceId,
      ref: args.ref,
      title: page.title,
      url: page.url,
      markdown: page.markdown,
      updatedAt: page.updatedAt,
      ...(args.contentHash !== undefined ? { contentHash: args.contentHash } : {}),
    });
    await splitStored();
    return pageId;
  },
});

/**
 * Delete all documentation owned by one caller during an explicit full reset.
 *
 * Each source goes now, with its credentials and discovered systems; its
 * pages, mirrors and runs are deleted in scheduled pages (`deleteSourceRows`).
 *
 * Args:
 *   ctx: Convex mutation context.
 *   userId: Owner subject being deleted.
 *
 * Returns:
 *   Number of source rows removed.
 */
export async function deleteOwnedDocumentation(ctx: MutationCtx, userId: string): Promise<number> {
  const sources = await ctx.db
    .query('docSources')
    .withIndex('by_user', (index) => index.eq('userId', userId))
    .collect();
  for (const source of sources) await removeSource(ctx, source);
  return sources.length;
}
