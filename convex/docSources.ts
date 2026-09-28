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
import { assertOwnsAgent, getCallerOrThrow } from './ownership';
import { assertRealMode, SURFACE_MODE } from '../src/lib/surface-mode';
import { reconcileDocumentedSystems } from './surfaces';
import { purgeCredential } from './credentials';
import type { IntakeScope } from '../src/surfaces/intake-scope';
import { assertCurrentGeneration } from '../src/docs/sync-generation';
import { appendEvent } from './eventLog';
import { mirroredDocSlug } from '../src/docs/types';
import {
  endedShort,
  unreadPagesLine,
  unreadRecordIn,
  withUnreadPages,
} from '../src/docs/sync-record';
import { runToResume } from '../src/docs/sync-resume';
import { cardPageRefs } from '../src/docs/card-pages';
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
 * records: a run lists its pages, so recording it after every page would
 * rewrite that list each time; a finish resumed from a checkpoint walks at
 * most this many pages again, which delete nothing new.
 */
export const FINISHING_CHECKPOINT_EVERY = 10;

/**
 * One page of a paged read over a source's pages or mirrors: few enough rows
 * and bytes that one read stays well inside a transaction's limits whatever
 * the pages hold (a page body can be up to 768 KiB).
 */
export const PAGED_READ = { numItems: 100, maximumBytesRead: 4 * 1024 * 1024 } as const;

/** Convex's bound on an array's length, and so on the pages one generation can record. */
export const MAX_GENERATION_PAGES = 8_192;

/** How long a finished run is kept for the record before the run history is pruned. */
export const RUN_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;

/** The most runs one pruning pass deletes; a run can be large, since it lists its pages. */
const RUN_PRUNE_BATCH = 8;

/**
 * The migration that reads completed runs by their completion time
 * (`credentials-sync-revoke`): completed runs are kept for it until it has run.
 */
const RUNS_READ_BY_MIGRATION: MigrationName = 'credentials-sync-revoke';

/** The most pages the surface cards are sent, and the most bytes they are read up to. */
const CARD_PAGE_LIMIT = 100;
const CARD_PAGE_BYTES = 8 * 1024 * 1024;

/** The most surfaces of one employee the cards' page list is drawn from. */
const CARD_SURFACE_LIMIT = 1_000;

/** Why a run that a newer one replaced before it finished ended. */
const SUPERSEDED_RUN_REASON = 'a newer sync of the source started before this one finished';

/** Why a run that a newer one took over from its cursor ended. */
function resumedRunReason(pageCount: number): string {
  return `a newer sync of the source took over from its cursor after ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`;
}

/**
 * How many pages a source holds, from its run record rather than its pages.
 *
 * Counting the pages would read every page body (C-15). The last completed
 * run's summary counts what it kept; before a sync has completed, the newest
 * run's recorded refs are the pages it has stored so far.
 */
async function storedPageCount(ctx: QueryCtx, source: Doc<'docSources'>): Promise<number> {
  const completed = source.lastCompletedSyncId
    ? await ctx.db.get(source.lastCompletedSyncId)
    : null;
  if (completed) return completed.summary?.pagesKept ?? completed.refs.length;
  const newest = await ctx.db
    .query('docSyncRuns')
    .withIndex('by_source', (index) => index.eq('sourceId', source._id))
    .order('desc')
    .first();
  return newest?.refs.length ?? 0;
}

export interface LinkInput {
  label: string;
  kind: 'mcp' | 'folder' | 'git' | 'urls';
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

/** The source kinds that read with a secret of their own: required for MCP, optional for the others. */
const SECRET_KINDS: ReadonlySet<LinkInput['kind']> = new Set(['mcp', 'git', 'urls']);

/**
 * Check the secret a source is linked with, before anything is stored (E-74).
 *
 * An MCP server needs its connection secret. A private git repository or a
 * wiki behind a login may be linked with the reader's own secret, which is
 * stored as a credential and never written into the locator. A URL list
 * read with a secret must list pages of one https site, since the secret is
 * that site's and is sent to no other. A folder is read from the mounted
 * directory and takes none.
 *
 * @param input - The validated link values.
 * @param secret - The secret the owner entered, if any.
 * @throws Error saying which rule the secret breaks; the message never repeats the secret.
 */
export function validateReaderSecret(input: LinkInput, secret: string | undefined): void {
  if (input.kind === 'mcp' && !secret) {
    throw new Error('Connection secret is required for an MCP source.');
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
  return `${source.label} ${source.kind === 'mcp' ? 'connection secret' : 'reader secret'}`;
}

/**
 * Check whether an agent inherits a source.
 *
 * An agent reads every source its owner links, before or after the deploy,
 * except the ones it excluded at deploy.
 *
 * Args:
 *   agent: Persisted agent row.
 *   sourceId: Owner-level source id.
 *
 * Returns:
 *   True when the source should be mirrored for the agent.
 */
export function agentReadsSource(agent: Doc<'agents'>, sourceId: Id<'docSources'>): boolean {
  return !agent.excludedDocSourceIds?.includes(sourceId);
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
      .withIndex('by_user', (index) => index.eq('userId', identity.subject))
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
        source !== null && source.userId === identity.subject,
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
    assertRealMode('Documentation linking');
    const identity = await getCallerOrThrow(ctx);
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
      userId: identity.subject,
      ...input,
    });
    let storedCredentialId: Id<'credentials'> | undefined;
    try {
      if (credential) {
        storedCredentialId = await ctx.runAction(internal.credentials.store, {
          userId: identity.subject,
          kind: 'value',
          label: secretLabel(input),
          plaintext: credential,
          source: 'entered',
        });
        await ctx.runMutation(internal.docSources.attachCredential, {
          sourceId,
          userId: identity.subject,
          credentialId: storedCredentialId,
        });
      }
      await ctx.scheduler.runAfter(0, internal.docSyncActions.syncSource, { sourceId });
      return sourceId;
    } catch (error) {
      await ctx.runMutation(internal.docSources.deleteFailedLink, {
        sourceId,
        userId: identity.subject,
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
    assertRealMode('Documentation credential rotation');
    const identity = await getCallerOrThrow(ctx);
    if (!args.credential) throw new Error('Connection secret is required.');
    const source = await ctx.runQuery(internal.docSources.getOwnedInternal, {
      sourceId: args.sourceId,
      userId: identity.subject,
    });
    if (!source || !SECRET_KINDS.has(source.kind)) {
      throw new Error('Documentation source not found.');
    }
    validateReaderSecret(source, args.credential);
    const credentialId = await ctx.runAction(internal.credentials.store, {
      userId: identity.subject,
      kind: 'value',
      label: secretLabel(source),
      plaintext: args.credential,
      source: 'entered',
    });
    await ctx.runMutation(internal.docSources.attachCredential, {
      sourceId: source._id,
      userId: identity.subject,
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
    assertRealMode('Documentation resync');
    const identity = await getCallerOrThrow(ctx);
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.userId !== identity.subject)
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
    assertRealMode('Documentation unlinking');
    const identity = await getCallerOrThrow(ctx);
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.userId !== identity.subject)
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

/** The tables a removed source leaves rows in, in the order they are deleted. */
const SOURCE_ROW_TABLES = ['mockDocs', 'docPages', 'docSyncRuns'] as const;

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
    const page = await ctx.db
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
 * Return the documentation pages one owned agent's surface cards read.
 *
 * Public, owner-guarded. The cards need the page each approved intake value
 * quotes and the pages that evidence each system, never the corpus
 * (`cardPageRefs`); each is read by its reference, up to a hundred pages and
 * eight mebibytes, and returned in the order the employee's sources and
 * their pages were created, as the cards read the documented order.
 */
export const pagesForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const sources = (
      await ctx.db
        .query('docSources')
        .withIndex('by_user', (index) => index.eq('userId', agent.userId!))
        .collect()
    ).filter((source) => agentReadsSource(agent, source._id));
    const byId = new Map(sources.map((source, index) => [String(source._id), { source, index }]));
    const surfaces = await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (index) => index.eq('agentId', agent._id))
      .take(CARD_SURFACE_LIMIT);
    const refs = cardPageRefs(surfaces, new Set(byId.keys()), CARD_PAGE_LIMIT);
    const encoder = new TextEncoder();
    const pages: Array<Doc<'docPages'> & { sourceLabel: string; sourceKind: string }> = [];
    let bytes = 0;
    for (const { sourceId, ref } of refs) {
      if (bytes >= CARD_PAGE_BYTES) break;
      const owner = byId.get(sourceId);
      if (!owner) continue;
      const page = await ctx.db
        .query('docPages')
        .withIndex('by_source_ref', (index) =>
          index.eq('sourceId', owner.source._id).eq('ref', ref),
        )
        .unique();
      if (!page) continue;
      bytes += encoder.encode(page.markdown).length;
      pages.push({ ...page, sourceLabel: owner.source.label, sourceKind: owner.source.kind });
    }
    return pages.sort(
      (left, right): number =>
        (byId.get(String(left.sourceId))?.index ?? 0) -
          (byId.get(String(right.sourceId))?.index ?? 0) ||
        left._creationTime - right._creationTime,
    );
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
 * before it finished, carries its cursor, its refs and credential refs, its
 * counts and its record of unread pages into the new run, which reads on
 * from there (step 17); its own reason says the new run took over. A fresh
 * start (`fresh`, as a new connection secret needs), a run too old or a
 * resume that got nowhere reads from page one (`runToResume`).
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
        reason: endedShort(
          active._id === resumed?._id ? resumedRunReason(active.pageCount) : SUPERSEDED_RUN_REASON,
          active.reason,
        ),
      });
    } else if (resumed !== undefined) {
      const ending = (resumed.reason ?? '').split('\n')[0] || 'The run ended short.';
      const tookOver = resumedRunReason(resumed.pageCount);
      await ctx.db.patch(resumed._id, {
        reason: endedShort(
          `${ending} ${tookOver.charAt(0).toUpperCase()}${tookOver.slice(1)}.`,
          resumed.reason,
        ),
      });
    }
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId: source._id,
      cursor: resumed?.cursor,
      refs: resumed?.refs ?? [],
      credentialRefs: resumed?.credentialRefs ?? [],
      pageCount: resumed?.pageCount ?? 0,
      redactionCount: resumed?.redactionCount ?? 0,
      reason: unreadRecordIn(resumed?.reason),
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
      reason: endedShort(LISTING_CHANGED_REASON, run.reason),
    });
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId: source._id,
      refs: [],
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
 * run. A run lists its pages, so a pass reads at most `RUN_PRUNE_BATCH`.
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
 * A generation's page refs with a batch's added, within what one run can record.
 *
 * @throws Error naming the bound when the source lists more pages than one run records.
 */
function generationRefs(recorded: readonly string[], batch: readonly string[]): string[] {
  const refs = [...recorded, ...batch];
  if (refs.length > MAX_GENERATION_PAGES) {
    throw new Error(
      `This source lists more than ${MAX_GENERATION_PAGES.toLocaleString('en-GB')} pages, the most one sync can record; split it into smaller sources.`,
    );
  }
  return refs;
}

/**
 * Record one non-final batch and advance its provider-safe cursor.
 *
 * The batch's `refs` and `credentialRefs` include the pages it could not
 * read and their stored credentials, so the finished generation keeps them;
 * `unread` names those pages in the run's record.
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
    const refs = generationRefs(run.refs, args.refs);
    await ctx.db.patch(run._id, {
      cursor: args.nextCursor,
      refs,
      credentialRefs: [...run.credentialRefs, ...args.credentialRefs],
      pageCount: run.pageCount + args.pageCount,
      redactionCount: run.redactionCount + args.redactionCount,
      reason: withUnreadPages(run.reason, args.unread ?? []),
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
 * Internal; the finishing sync walks the source's pages with it. A page the
 * generation listed but could not read is in its refs and is kept (P5-11).
 *
 * @returns Where the finish stands, or null when the run is no longer at that checkpoint.
 */
export const prunePages = internalMutation({
  args: finishingPageArgs,
  handler: async (ctx, args): Promise<FinishingPage | null> => {
    phaseOf(args.checkpoint, 'pages');
    const finishing = await finishingRun(ctx, args.sourceId, args.runId, args.checkpoint);
    if (!finishing) return null;
    const current = new Set(finishing.run.refs);
    const page = await ctx.db
      .query('docPages')
      .withIndex('by_source', (index) => index.eq('sourceId', args.sourceId))
      .paginate({ ...PAGED_READ, cursor: args.from });
    let removed = 0;
    for (const row of page.page) {
      if (current.has(row.ref)) continue;
      await ctx.db.delete(row._id);
      removed += 1;
    }
    return await closeFinishingPage(ctx, finishing.run, args, 'pages', 'mirrors', {
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
    const current = new Set(finishing.run.refs);
    const page = await ctx.db
      .query('mockDocs')
      .withIndex('by_source', (index) => index.eq('sourceId', args.sourceId))
      .paginate({ ...PAGED_READ, cursor: args.from });
    let removed = 0;
    for (const mirror of page.page) {
      if (mirror.sourceRef && current.has(mirror.sourceRef)) {
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
      toolAllowlist: undefined,
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
 * instead. `pagesKept` is the pages the generation lists. A page the generation could not read is in its
 * refs, so it keeps its last stored version, mirror and credentials; the
 * run's reason names it and the source's line says so until a sync reads it
 * (P5-11).
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
    const refs = generationRefs(run.refs, args.refs);
    const currentCredentialRefs = new Set([...run.credentialRefs, ...args.credentialRefs]);
    const credentials = await ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index.eq('userId', source.userId).eq('source.sourceId', source._id),
      )
      .take(1_001);
    if (credentials.length > 1_000) throw new Error('Source exceeds 1,000 credentials.');
    let credentialsSuperseded = 0;
    for (const credential of credentials) {
      if (typeof credential.source === 'string' || currentCredentialRefs.has(credential.source.ref))
        continue;
      await supersedeCredential(ctx, credential);
      credentialsSuperseded += 1;
    }
    const pageCount = run.pageCount + args.pageCount;
    const redactionCount = run.redactionCount + args.redactionCount;
    const unreadRecord = withUnreadPages(run.reason, args.unread ?? []);
    const pruned = args.pruned ?? { pagesRemoved: 0, mirrorsRemoved: 0, surfacesToReapprove: 0 };
    const now = Date.now();
    await ctx.db.patch(run._id, {
      cursor: undefined,
      refs,
      credentialRefs: [...currentCredentialRefs],
      pageCount,
      redactionCount,
      state: 'completed',
      completedAt: now,
      reason: unreadRecord,
      summary: { pagesKept: refs.length, ...pruned, credentialsSuperseded },
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

/**
 * Supersede one page-derived credential no page of its source states any more,
 * and send every surface bound to it back to landing a credential.
 */
async function supersedeCredential(
  ctx: MutationCtx,
  credential: Doc<'credentials'>,
): Promise<void> {
  // Superseded, not revoked: the status alone keeps the value out of every
  // decrypt and exact-value list, and the same value returning on a later
  // sync revives the row (`credentials.store`). Only a person's revoke
  // stamps `revokedAt`, so a sync never undoes one and never makes one.
  await ctx.db.patch(credential._id, {
    status: 'superseded',
    statusReason: 'No longer detected in synced documentation.',
  });
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_credentialId', (index) => index.eq('credentialId', credential._id))
    .take(1_001);
  if (surfaces.length > 1_000) throw new Error('Credential exceeds 1,000 bound surfaces.');
  for (const surface of surfaces) {
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
      reason:
        'The previously detected credential is no longer present in synced documentation. Land a valid credential before probing again.',
      // A probe that already decrypted the retired value cannot reconnect this surface.
      probeGeneration: (surface.probeGeneration ?? 0) + 1,
      toolAllowlist: undefined,
      toolArguments: undefined,
      lastVerifiedAt: undefined,
      providerIdentityId: undefined,
      providerWorkspaceId: undefined,
      managerDmChannelId: undefined,
      managerUserId: undefined,
      managerName: undefined,
      channelsNotJoined: undefined,
    });
  }
}

/** Mark only the currently active generation as failed. */
export const failSync = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    status: v.union(v.literal('error'), v.literal('credential-not-landed')),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (!source || !run || source.activeSyncId !== run._id || run.state !== 'running') return false;
    const now = Date.now();
    // The cursor stays, so the next sync resumes the run from it (`beginSync`).
    await ctx.db.patch(run._id, {
      state: 'error',
      completedAt: now,
      reason: endedShort(args.reason, run.reason),
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
  },
  handler: async (ctx, args): Promise<Id<'docPages'>> => {
    await assertCurrentGeneration(ctx, args.sourceId, args.syncRunId);
    const existing = await ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (index) =>
        index.eq('sourceId', args.sourceId).eq('ref', args.ref),
      )
      .unique();
    const page = {
      title: args.title,
      url: args.url,
      markdown: args.markdown,
      updatedAt: args.updatedAt,
    };
    if (existing) {
      // An unchanged page is not written again, so every subscriber to the
      // page is not woken on each fifteen-minute sync (P5-18).
      const unchanged =
        existing.title === page.title &&
        existing.url === page.url &&
        existing.markdown === page.markdown;
      if (!unchanged) await ctx.db.patch(existing._id, page);
      return existing._id;
    }
    return await ctx.db.insert('docPages', { sourceId: args.sourceId, ref: args.ref, ...page });
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
