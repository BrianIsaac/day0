import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { getCallerOrThrow } from './ownership';
import { OWNER_KNOWN_VALUE_CAP } from '../src/redaction/known-values';
import { credentialPageRef, credentialRefRange, isValueKeyedRef } from '../src/docs/redaction';
import { assertCurrentGeneration } from '../src/docs/sync-generation';

const credentialKind = v.union(v.literal('value'), v.literal('location'), v.literal('oauth'));

const credentialSource = v.union(
  v.object({ sourceId: v.id('docSources'), ref: v.string() }),
  v.literal('entered'),
  v.literal('oauth'),
);

type CredentialKind = 'value' | 'location' | 'oauth';

type CredentialSource = { ref: string; sourceId: Id<'docSources'> } | 'entered' | 'oauth';

/**
 * Whether a credential came from a documentation page rather than a person or
 * a provider handshake.
 *
 * Only a page-derived credential is upserted by `(userId, sourceId, ref)`; a
 * typed value and an OAuth grant each stand alone, so neither is deduplicated
 * against a page that never held it.
 */
function pageSource(
  source: CredentialSource,
): { ref: string; sourceId: Id<'docSources'> } | undefined {
  return typeof source === 'string' ? undefined : source;
}

/**
 * Validate credential material without normalising its bytes.
 *
 * Args:
 *   kind: Credential acquisition kind.
 *   plaintext: Optional secret supplied by the caller.
 *
 * Returns:
 *   The exact supplied value, or an empty sentinel for an unlanded location.
 *
 * Raises:
 *   Error: If a value-bearing credential has no plaintext.
 */
function credentialPlaintext(kind: CredentialKind, plaintext?: string): string {
  if (kind === 'location' && !plaintext) return '';
  if (!plaintext) throw new Error('Credential plaintext is required.');
  return plaintext;
}

/**
 * Refuse a sync's write once its generation is superseded (step 14): a stale
 * action must not revive a row the newer generation retired. A write that
 * names no generation is not a sync's and is not fenced.
 *
 * @throws Error when the write names a generation that may no longer write.
 */
async function fenceSyncWrite(
  ctx: MutationCtx,
  sourceId: Id<'docSources'> | undefined,
  syncRunId: Id<'docSyncRuns'> | undefined,
): Promise<void> {
  if (syncRunId === undefined) return;
  if (sourceId === undefined) throw new Error('A sync writes only page-derived credentials.');
  await assertCurrentGeneration(ctx, sourceId, syncRunId);
}

/**
 * The migration that re-seals every stored value bound to its owner under the
 * current key and writes its key id (decision Q15). Its completion is the
 * switch that ends the unbound open of a row without a key id.
 */
export const CREDENTIAL_RESEAL_MIGRATION = 'credentials-reseal';

/**
 * The migration that rewrites each page-derived row's ref to the value-keyed
 * form (`credentialSourceRef`), which it must open the value to fingerprint.
 * It runs after the re-seal, so every row it opens is bound to its owner.
 */
export const CREDENTIAL_VALUE_REF_MIGRATION = 'credentials-value-refs';

/**
 * Whether a row without a key id may still open unbound: true until the
 * re-seal has run to the end, so no legacy row stops opening part-way through,
 * and false from then on, so an unbound value put on a row since is refused.
 *
 * @param ctx - A query or mutation context.
 */
export async function unboundOpenAllowed(ctx: QueryCtx): Promise<boolean> {
  const reseal = await ctx.db
    .query('migrations')
    .withIndex('by_name', (index) => index.eq('name', CREDENTIAL_RESEAL_MIGRATION))
    .unique();
  return reseal?.completedAt === undefined;
}

/**
 * How the Node side may open a stored value right now. Internal; read by
 * `credentialCryptoActions.open` before it decrypts.
 */
export const openingPolicy = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ allowUnbound: boolean }> => ({
    allowUnbound: await unboundOpenAllowed(ctx),
  }),
});

/** The reason a rotated row keeps a person's revoke, shown with the credential. */
export const REVOKE_STANDS_REASON =
  'Revoked by a person. The page now holds a different value; it stays revoked until a person lands or approves one.';

/**
 * Store encrypted credential bytes, upserting page-derived rows by source.
 * Internal; written by `store`.
 *
 * A changed source value is a rotation: the stable row takes the new value
 * and its usage restarts. Only a person sets `revokedAt`, so neither a
 * rotation nor an unchanged value clears it; a sync can never undo a
 * person's revoke, and a revoked row that rotates says so in its reason.
 */
export const persistEncrypted = internalMutation({
  args: {
    userId: v.string(),
    kind: credentialKind,
    label: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    /** The id of the key that sealed `ciphertext`, bound to `userId`. */
    keyId: v.string(),
    explicitlyAssigned: v.optional(v.boolean()),
    quoted: v.optional(v.boolean()),
    source: credentialSource,
    appId: v.optional(v.string()),
    rotated: v.boolean(),
    syncRunId: v.optional(v.id('docSyncRuns')),
  },
  handler: async (ctx, args): Promise<Id<'credentials'>> => {
    const sourced = pageSource(args.source);
    await fenceSyncWrite(ctx, sourced?.sourceId, args.syncRunId);
    if (sourced) {
      // Unlink can commit while the store action is encrypting the value.
      const source = await ctx.db.get(sourced.sourceId);
      if (!source || source.userId !== args.userId) {
        throw new Error('Credential source does not belong to its owner.');
      }
    }
    const existing =
      sourced === undefined
        ? null
        : await ctx.db
            .query('credentials')
            .withIndex('by_user_source_ref', (index) =>
              index
                .eq('userId', args.userId)
                .eq('source.sourceId', sourced.sourceId)
                .eq('source.ref', sourced.ref),
            )
            .unique();
    if (!existing) {
      return await ctx.db.insert('credentials', {
        userId: args.userId,
        kind: args.kind,
        label: args.label,
        ciphertext: args.ciphertext,
        iv: args.iv,
        keyId: args.keyId,
        explicitlyAssigned: args.explicitlyAssigned,
        quoted: args.quoted,
        source: args.source,
        appId: args.appId,
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(existing._id, {
      kind: args.kind,
      label: args.label,
      ciphertext: args.ciphertext,
      iv: args.iv,
      keyId: args.keyId,
      explicitlyAssigned: args.explicitlyAssigned,
      quoted: args.quoted,
      appId: args.appId,
      lastUsedAt: args.rotated ? undefined : existing.lastUsedAt,
      status: undefined,
      statusReason: existing.revokedAt && args.rotated ? REVOKE_STANDS_REASON : undefined,
    });
    return existing._id;
  },
});

/**
 * Update non-secret metadata without changing revocation or usage state.
 * Internal. Clears the status, so a row a sync superseded is live again once
 * its value is found again; a person's revoke stays, and so does its reason.
 */
export const updateMetadata = internalMutation({
  args: {
    credentialId: v.id('credentials'),
    kind: credentialKind,
    label: v.string(),
    appId: v.optional(v.string()),
    explicitlyAssigned: v.optional(v.boolean()),
    quoted: v.optional(v.boolean()),
    syncRunId: v.optional(v.id('docSyncRuns')),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.credentialId);
    const source = row === null ? undefined : pageSource(row.source);
    await fenceSyncWrite(ctx, source?.sourceId, args.syncRunId);
    await ctx.db.patch(args.credentialId, {
      kind: args.kind,
      label: args.label,
      appId: args.appId,
      explicitlyAssigned: args.explicitlyAssigned,
      quoted: args.quoted,
      status: undefined,
      statusReason: row?.revokedAt && !row.status ? row.statusReason : undefined,
    });
  },
});

/** Read a page-derived credential while deciding whether a sync rotated it. */
export const bySourceForStore = internalQuery({
  args: {
    userId: v.string(),
    sourceId: v.id('docSources'),
    ref: v.string(),
  },
  handler: async (ctx, args) =>
    await ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index
          .eq('userId', args.userId)
          .eq('source.sourceId', args.sourceId)
          .eq('source.ref', args.ref),
      )
      .unique(),
});

/**
 * The most of an owner's rows the exact-value list reads past to find the
 * active ones. Revoked, superseded and purged rows are read but not counted
 * against the cap, so a sync that retires values cannot lock the owner out;
 * an owner with more rows than this still fails closed.
 */
const OWNER_CREDENTIAL_SCAN_LIMIT = 4 * OWNER_KNOWN_VALUE_CAP;

/** A row the exact-value layer decrypts: live, and holding a value. */
function activeValueRow(
  row: Doc<'credentials'>,
): row is Doc<'credentials'> & { ciphertext: string; iv: string } {
  return !row.revokedAt && !row.status && row.ciphertext !== undefined && row.iv !== undefined;
}

/**
 * The owner's active, value-bearing rows for the exact-value layer. Internal;
 * read by the Node action that decrypts them.
 *
 * Only the fields the Node action needs to decrypt leave this query, and
 * only to that action: it is internal, and the plaintext never comes back
 * through a query. The cap counts active rows only; the list overflows when
 * one more active row than the cap exists, or when the scan limit is reached
 * before the owner's rows end, because a list read through a bound is only
 * complete when the bound was not reached.
 */
export const activeValuesForOwner = internalQuery({
  args: { userId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    overflow: boolean;
    allowUnbound: boolean;
    rows: Array<{
      _id: Id<'credentials'>;
      ciphertext: string;
      iv: string;
      keyId?: string;
      label: string;
      pageDerived: boolean;
      explicitlyAssigned?: boolean;
      quoted?: boolean;
    }>;
  }> => {
    const scanned = await ctx.db
      .query('credentials')
      .withIndex('by_userId', (index) => index.eq('userId', args.userId))
      .take(OWNER_CREDENTIAL_SCAN_LIMIT + 1);
    const active = scanned.slice(0, OWNER_CREDENTIAL_SCAN_LIMIT).filter(activeValueRow);
    return {
      overflow:
        scanned.length > OWNER_CREDENTIAL_SCAN_LIMIT || active.length > OWNER_KNOWN_VALUE_CAP,
      allowUnbound: await unboundOpenAllowed(ctx),
      rows: active.slice(0, OWNER_KNOWN_VALUE_CAP + 1).map((row) => ({
        _id: row._id,
        ciphertext: row.ciphertext,
        iv: row.iv,
        keyId: row.keyId,
        label: row.label,
        pageDerived: typeof row.source !== 'string',
        explicitlyAssigned: row.explicitlyAssigned,
        quoted: row.quoted,
      })),
    };
  },
});

/** Read one credential for an internal decrypt action. */
export const getInternal = internalQuery({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args) => await ctx.db.get(args.credentialId),
});

/**
 * Revoke a credential and delete its ciphertext, keeping the row.
 *
 * The reset and unlink paths delete the value outright: nothing can be
 * rotated back into a source that no longer exists. The label, source and
 * dates stay so the audit trail still says what was held and when it ended.
 *
 * Args:
 *   ctx: Convex mutation context.
 *   credential: The row to purge.
 *   now: Revocation time for a row not yet revoked.
 */
export async function purgeCredential(
  ctx: MutationCtx,
  credential: Doc<'credentials'>,
  now: number,
): Promise<void> {
  if (credential.ciphertext === undefined && credential.iv === undefined && credential.revokedAt) {
    return;
  }
  await ctx.db.patch(credential._id, {
    revokedAt: credential.revokedAt ?? now,
    ciphertext: undefined,
    iv: undefined,
  });
}

/**
 * Purge every credential one owner holds, for a reset that unlinks documentation.
 *
 * Args:
 *   ctx: Convex mutation context.
 *   userId: Owner subject being reset.
 *
 * Returns:
 *   Number of rows purged.
 */
export async function purgeOwnedCredentials(ctx: MutationCtx, userId: string): Promise<number> {
  const rows = await ctx.db
    .query('credentials')
    .withIndex('by_userId', (index) => index.eq('userId', userId))
    .take(1_001);
  if (rows.length > 1_000) throw new Error('Owner exceeds 1,000 credentials.');
  const now = Date.now();
  for (const row of rows) await purgeCredential(ctx, row, now);
  return rows.length;
}

/** Record credential use without exposing the decrypted value. */
export const touch = internalMutation({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.credentialId, { lastUsedAt: Date.now() });
  },
});

/** Revoke a credential after an already-authorised internal operation. */
export const revokeInternal = internalMutation({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<void> => {
    const credential = await ctx.db.get(args.credentialId);
    if (credential && !credential.revokedAt) {
      await ctx.db.patch(credential._id, { revokedAt: Date.now() });
    }
  },
});

/**
 * The most rows of one page a read returns. A page's rows are its live values
 * and every value a sync superseded there, which stays so it revives if it
 * returns; a page past this has had hundreds of values swapped on it, and the
 * read refuses rather than leave some of its rows out.
 */
const PAGE_ROW_LIMIT = 512;

/**
 * The page-derived rows of one page of one source, whatever shape of ref they
 * carry: value-keyed, or the page-only and position-and-label refs stored
 * before them.
 *
 * @param ctx - A query context.
 * @param page - The owner, the source and the page.
 * @throws Error when the page holds more rows than one read returns.
 */
async function pageRows(
  ctx: QueryCtx,
  page: { userId: string; sourceId: Id<'docSources'>; pageRef: string },
): Promise<Doc<'credentials'>[]> {
  const { from, to } = credentialRefRange(page.pageRef);
  const rows: Doc<'credentials'>[] = [];
  // The page-only ref and the refs extending it, each an exact index range, so
  // no other page's rows are read.
  for (const query of [
    ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index
          .eq('userId', page.userId)
          .eq('source.sourceId', page.sourceId)
          .eq('source.ref', page.pageRef),
      ),
    ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index
          .eq('userId', page.userId)
          .eq('source.sourceId', page.sourceId)
          .gte('source.ref', from)
          .lte('source.ref', to),
      ),
  ]) {
    for await (const row of query) {
      if (typeof row.source === 'string' || credentialPageRef(row.source.ref) !== page.pageRef) {
        continue;
      }
      if (rows.length === PAGE_ROW_LIMIT) {
        throw new Error(
          `A documentation page holds more than ${PAGE_ROW_LIMIT} stored credentials; it cannot be read whole.`,
        );
      }
      rows.push(row);
    }
  }
  return rows;
}

/**
 * The page-derived rows of one page of one source. Internal; read by `store`
 * before it inserts and by the sync for a page it could not read.
 */
export const pageRowsForStore = internalQuery({
  args: { userId: v.string(), sourceId: v.id('docSources'), pageRef: v.string() },
  handler: async (ctx, args): Promise<Doc<'credentials'>[]> => await pageRows(ctx, args),
});

/**
 * The live rows of one page whose label is the marker's, oldest first.
 * Internal; read by orientation to bind a `<credential: label, stored>`
 * marker to the row its sync stored, which a value-keyed ref does not name.
 * Oldest first is the page's own order when one sync stored them all, as
 * `store` runs in document order.
 */
export const pageRowsByLabel = internalQuery({
  args: {
    userId: v.string(),
    sourceId: v.id('docSources'),
    pageRef: v.string(),
    label: v.string(),
  },
  handler: async (ctx, args): Promise<Doc<'credentials'>[]> => {
    const wanted = args.label.trim().toLowerCase();
    return (await pageRows(ctx, args))
      .filter(
        (row) =>
          row.revokedAt === undefined &&
          row.status === undefined &&
          row.label.trim().toLowerCase() === wanted,
      )
      .sort((left, right) => left._creationTime - right._creationTime);
  },
});

/**
 * Move a page-derived row to the ref its page now gives its value, with the
 * metadata the sync found. Internal. Clears a sync's supersede like
 * `updateMetadata`; a person's revoke stays.
 *
 * @returns False, and nothing written, when the row is not the owner's page
 *   row on this source, has moved from the ref `store` read it at, or another
 *   row already holds the new ref.
 */
export const moveToRef = internalMutation({
  args: {
    credentialId: v.id('credentials'),
    userId: v.string(),
    fromRef: v.string(),
    source: v.object({ sourceId: v.id('docSources'), ref: v.string() }),
    kind: credentialKind,
    label: v.string(),
    appId: v.optional(v.string()),
    explicitlyAssigned: v.optional(v.boolean()),
    quoted: v.optional(v.boolean()),
    syncRunId: v.optional(v.id('docSyncRuns')),
  },
  handler: async (ctx, args): Promise<boolean> => {
    await fenceSyncWrite(ctx, args.source.sourceId, args.syncRunId);
    const row = await ctx.db.get(args.credentialId);
    if (
      !row ||
      row.userId !== args.userId ||
      typeof row.source === 'string' ||
      row.source.sourceId !== args.source.sourceId ||
      row.source.ref !== args.fromRef
    ) {
      return false;
    }
    const taken = await ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index
          .eq('userId', args.userId)
          .eq('source.sourceId', args.source.sourceId)
          .eq('source.ref', args.source.ref),
      )
      .first();
    if (taken) return false;
    await ctx.db.patch(row._id, {
      source: args.source,
      kind: args.kind,
      label: args.label,
      appId: args.appId,
      explicitlyAssigned: args.explicitlyAssigned,
      quoted: args.quoted,
      status: undefined,
      statusReason: undefined,
    });
    return true;
  },
});

/**
 * A row's value, or undefined when it holds none this deployment can read.
 *
 * @param ctx - The action context the Node decrypt runs through.
 * @param row - A stored credential row; its owner is the one its value must be bound to.
 */
async function storedValue(
  ctx: ActionCtx,
  row: Pick<Doc<'credentials'>, 'ciphertext' | 'iv' | 'userId' | 'keyId'>,
): Promise<string | undefined> {
  if (row.ciphertext === undefined || row.iv === undefined) return undefined;
  try {
    return await ctx.runAction(internal.credentialCryptoActions.open, {
      ciphertext: row.ciphertext,
      iv: row.iv,
      userId: row.userId,
      keyId: row.keyId,
    });
  } catch {
    // Sealed under a rotated DAY0_CREDENTIAL_KEY, or bound to another owner:
    // unreadable, so it holds no value this sync can match, and the page's
    // value replaces it rather than failing every sync of that page.
    return undefined;
  }
}

/**
 * Encrypt and store one credential through the stable lane-A contract.
 * Internal.
 *
 * A page-derived value is upserted by `(userId, sourceId, ref)`, its ref keyed
 * by the value's fingerprint (`credentialSourceRef`), so the same value found
 * again lands on its own row whatever its label or place on the page. A ref
 * the source has no row for is first looked for on the same page by value: a
 * row stored under a ref from before value-keyed refs, or under a fingerprint
 * taken with a key since rotated, is moved to the new ref rather than stored
 * again, so no known value mints a second row. The value is sealed bound to its
 * owner, so it opens only on that owner's row. The Node-only AES operation is
 * isolated in `credentialCryptoActions` because Convex forbids a Node module
 * from also exporting this module's public query and mutation.
 */
export const store = internalAction({
  args: {
    userId: v.string(),
    kind: credentialKind,
    label: v.string(),
    plaintext: v.optional(v.string()),
    explicitlyAssigned: v.optional(v.boolean()),
    quoted: v.optional(v.boolean()),
    source: credentialSource,
    appId: v.optional(v.string()),
    /** The sync generation that found the value; every write it makes is fenced by it. */
    syncRunId: v.optional(v.id('docSyncRuns')),
  },
  handler: async (ctx, args): Promise<Id<'credentials'>> => {
    const plaintext = credentialPlaintext(args.kind, args.plaintext);
    const sourced = pageSource(args.source);
    if (sourced) {
      const source = await ctx.runQuery(internal.docSources.getInternal, {
        sourceId: sourced.sourceId,
      });
      if (!source || source.userId !== args.userId) {
        throw new Error('Credential source does not belong to its owner.');
      }
    }
    const metadata = {
      kind: args.kind,
      label: args.label,
      appId: args.appId,
      explicitlyAssigned: args.explicitlyAssigned,
      quoted: args.quoted,
    };
    const existing = !sourced
      ? null
      : await ctx.runQuery(internal.credentials.bySourceForStore, {
          userId: args.userId,
          sourceId: sourced.sourceId,
          ref: sourced.ref,
        });
    // The same value found again: a row an earlier sync superseded because
    // its page went briefly missing is revived here.
    if (existing && (await storedValue(ctx, existing)) === plaintext) {
      await ctx.runMutation(internal.credentials.updateMetadata, {
        credentialId: existing._id,
        ...metadata,
        syncRunId: args.syncRunId,
      });
      return existing._id;
    }
    if (sourced && !existing && plaintext) {
      const pageRows = await ctx.runQuery(internal.credentials.pageRowsForStore, {
        userId: args.userId,
        sourceId: sourced.sourceId,
        pageRef: credentialPageRef(sourced.ref),
      });
      for (const row of pageRows) {
        if ((await storedValue(ctx, row)) !== plaintext) continue;
        if (typeof row.source === 'string') continue;
        const moved = await ctx.runMutation(internal.credentials.moveToRef, {
          credentialId: row._id,
          userId: args.userId,
          fromRef: row.source.ref,
          source: sourced,
          ...metadata,
          syncRunId: args.syncRunId,
        });
        if (moved) return row._id;
      }
    }
    const encrypted = await ctx.runAction(internal.credentialCryptoActions.seal, {
      plaintext,
      userId: args.userId,
    });
    return await ctx.runMutation(internal.credentials.persistEncrypted, {
      userId: args.userId,
      source: args.source,
      ...metadata,
      ...encrypted,
      rotated: existing !== null,
      syncRunId: args.syncRunId,
    });
  },
});

/**
 * Decrypt one active value for another server-side action. Internal; records
 * the use. The value opens only on its owner's row: a ciphertext bound to
 * another owner is refused.
 */
export const decrypt = internalAction({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<string> => {
    const credential = await ctx.runQuery(internal.credentials.getInternal, args);
    if (
      !credential ||
      credential.revokedAt ||
      credential.status !== undefined ||
      credential.ciphertext === undefined ||
      credential.iv === undefined
    ) {
      throw new Error('Credential is unavailable.');
    }
    const plaintext = await ctx.runAction(internal.credentialCryptoActions.open, {
      ciphertext: credential.ciphertext,
      iv: credential.iv,
      userId: credential.userId,
      keyId: credential.keyId,
    });
    if (!plaintext) throw new Error('Credential does not contain a landed value.');
    await ctx.runMutation(internal.credentials.touch, args);
    return plaintext;
  },
});

/** Revoke one owner credential without returning its encrypted fields. */
export const revoke = mutation({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<void> => {
    const identity = await getCallerOrThrow(ctx);
    const credential = await ctx.db.get(args.credentialId);
    if (!credential || credential.userId !== identity.subject) {
      throw new Error('Credential not found.');
    }
    if (!credential.revokedAt) await ctx.db.patch(credential._id, { revokedAt: Date.now() });
  },
});

/** List owner credential metadata without ciphertext or IV fields. */
export const summaryForOwner = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getCallerOrThrow(ctx);
    const credentials = await ctx.db
      .query('credentials')
      .withIndex('by_userId', (index) => index.eq('userId', identity.subject))
      .collect();
    return credentials.map((credential) => ({
      _id: credential._id,
      label: credential.label,
      kind: credential.kind,
      source: credential.source,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
      revokedAt: credential.revokedAt,
      status: credential.status,
      statusReason: credential.statusReason,
    }));
  },
});

/**
 * Count active stored credentials for local setup diagnostics: neither
 * revoked by a person nor superseded by a sync that no longer found them.
 * Internal.
 */
export const countStored = internalQuery({
  args: {},
  handler: async (ctx): Promise<number> => {
    const credentials = await ctx.db.query('credentials').take(1_001);
    if (credentials.length > 1_000) throw new Error('Credential count exceeds the setup limit.');
    return credentials.filter(
      (credential) => !credential.revokedAt && credential.status !== 'superseded',
    ).length;
  },
});

/** Quarantine only the ciphertext orientation inspected, without racing a rotation. */
export const markSuspect = internalMutation({
  args: {
    credentialId: v.id('credentials'),
    ciphertext: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.credentialId);
    if (!row || row.ciphertext !== args.ciphertext || row.revokedAt || row.status === 'superseded')
      return;
    await ctx.db.patch(row._id, { status: 'suspect', statusReason: args.reason });
  },
});

/** Rows one page of a re-seal reads: each is opened and sealed again in the Node action. */
export const RESEAL_PAGE = 50;

/** A stored row as the re-seal reads it; only the Node action it goes to sees the ciphertext. */
export interface ResealRow {
  readonly _id: Id<'credentials'>;
  readonly userId: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly keyId?: string;
}

/**
 * One page of every credential row, in table order, for the re-seal.
 * Internal; read by `credentialCryptoActions.resealPage`, which never
 * returns a value. Rows with no value (purged by a reset or an unlink) are
 * read past, not returned.
 */
export const resealBatch = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    rows: ResealRow[];
    read: number;
    cursor: string;
    isDone: boolean;
    allowUnbound: boolean;
  }> => {
    const page = await ctx.db
      .query('credentials')
      .paginate({ cursor: args.cursor, numItems: RESEAL_PAGE });
    return {
      rows: page.page.flatMap((row): ResealRow[] =>
        row.ciphertext === undefined || row.iv === undefined
          ? []
          : [
              {
                _id: row._id,
                userId: row.userId,
                ciphertext: row.ciphertext,
                iv: row.iv,
                ...(row.keyId !== undefined ? { keyId: row.keyId } : {}),
              },
            ],
      ),
      read: page.page.length,
      cursor: page.continueCursor,
      isDone: page.isDone,
      allowUnbound: await unboundOpenAllowed(ctx),
    };
  },
});

/**
 * Write the re-sealed values of one page. Internal; written by
 * `credentialCryptoActions.resealPage`.
 *
 * A row is rewritten only while it still holds the ciphertext the action
 * opened: a value a sync, a person or another re-seal wrote in between is
 * newer and already carries its key id, so it is left as it is.
 *
 * @returns How many rows were rewritten.
 */
export const applyReseal = internalMutation({
  args: {
    rows: v.array(
      v.object({
        credentialId: v.id('credentials'),
        fromCiphertext: v.string(),
        ciphertext: v.string(),
        iv: v.string(),
        keyId: v.string(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<number> => {
    let applied = 0;
    for (const resealed of args.rows) {
      const row = await ctx.db.get(resealed.credentialId);
      if (row?.ciphertext !== resealed.fromCiphertext) continue;
      await ctx.db.patch(row._id, {
        ciphertext: resealed.ciphertext,
        iv: resealed.iv,
        keyId: resealed.keyId,
      });
      applied += 1;
    }
    return applied;
  },
});

/** A page-derived row as the ref rewrite reads it; only the Node action it goes to sees the ciphertext. */
export interface ValueRefRow extends ResealRow {
  readonly sourceId: Id<'docSources'>;
  readonly ref: string;
}

/**
 * One page of every credential row, in table order, for the ref rewrite.
 * Internal; read by `credentialCryptoActions.valueRefPage`, which never
 * returns a value. Only page-derived rows holding a value on a ref from
 * before value-keyed refs are returned; the rest are read past.
 */
export const valueRefBatch = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    rows: ValueRefRow[];
    read: number;
    cursor: string;
    isDone: boolean;
    allowUnbound: boolean;
  }> => {
    const page = await ctx.db
      .query('credentials')
      .paginate({ cursor: args.cursor, numItems: RESEAL_PAGE });
    return {
      rows: page.page.filter(holdsLegacyRef).map(
        (row): ValueRefRow => ({
          _id: row._id,
          userId: row.userId,
          ciphertext: row.ciphertext,
          iv: row.iv,
          ...(row.keyId !== undefined ? { keyId: row.keyId } : {}),
          sourceId: row.source.sourceId,
          ref: row.source.ref,
        }),
      ),
      read: page.page.length,
      cursor: page.continueCursor,
      isDone: page.isDone,
      allowUnbound: await unboundOpenAllowed(ctx),
    };
  },
});

/**
 * Carry a rewritten ref into its source's newest run while that run can still
 * finish a generation. A running run unions the credential refs it holds at
 * its finish, and one that ended short hands them to the sync that takes it
 * over (`beginSync`); a ref it recorded before the rewrite would otherwise
 * leave the moved row out of the generation's set, and the finish would
 * supersede it for a page that was never re-read.
 *
 * @param ctx - A mutation context.
 * @param sourceId - The row's source.
 * @param fromRef - The ref the row carried before the rewrite.
 * @param ref - Its value-keyed ref.
 */
async function carryRefIntoOpenRun(
  ctx: MutationCtx,
  sourceId: Id<'docSources'>,
  fromRef: string,
  ref: string,
): Promise<void> {
  const latest = await ctx.db
    .query('docSyncRuns')
    .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
    .order('desc')
    .first();
  if (!latest || latest.state === 'completed' || !latest.credentialRefs.includes(fromRef)) return;
  await ctx.db.patch(latest._id, {
    credentialRefs: [
      ...new Set(latest.credentialRefs.map((carried) => (carried === fromRef ? ref : carried))),
    ],
  });
}

/**
 * Move each row of one page of the ref rewrite to its value-keyed ref.
 * Internal; written by `credentialCryptoActions.valueRefPage`.
 *
 * A row is moved only while it is still at the ref the action read it at, so
 * a row a sync moved in between (`moveToRef`) is left where the sync put it.
 * A row whose value-keyed ref another row of the page already holds (one
 * value stored twice by an earlier release) is left as it was and returned,
 * so the action logs it and the status counts it as remaining. A moved row's
 * ref is carried into its source's unfinished run (`carryRefIntoOpenRun`).
 *
 * @returns How many rows moved, and the ids of those another row blocked.
 */
export const applyValueRefs = internalMutation({
  args: {
    rows: v.array(
      v.object({ credentialId: v.id('credentials'), fromRef: v.string(), ref: v.string() }),
    ),
  },
  handler: async (ctx, args): Promise<{ changed: number; blocked: Id<'credentials'>[] }> => {
    let changed = 0;
    const blocked: Id<'credentials'>[] = [];
    for (const moved of args.rows) {
      const row = await ctx.db.get(moved.credentialId);
      if (!row || typeof row.source === 'string' || row.source.ref !== moved.fromRef) continue;
      const { sourceId } = row.source;
      const taken = await ctx.db
        .query('credentials')
        .withIndex('by_user_source_ref', (index) =>
          index
            .eq('userId', row.userId)
            .eq('source.sourceId', sourceId)
            .eq('source.ref', moved.ref),
        )
        .first();
      if (taken) {
        blocked.push(row._id);
        continue;
      }
      await ctx.db.patch(row._id, { source: { sourceId, ref: moved.ref } });
      await carryRefIntoOpenRun(ctx, sourceId, moved.fromRef, moved.ref);
      changed += 1;
    }
    return { changed, blocked };
  },
});

/** The most rows a count of the credential table reads before it answers "at least". */
const KEY_COUNT_SCAN_LIMIT = 4_000;

/** How the stored values divide between keys, as far as a bounded read saw. */
export interface CredentialKeyCounts {
  /** Rows holding a value, by the id of the key that sealed them. */
  readonly byKeyId: Readonly<Record<string, number>>;
  /** Rows holding a value with no key id: sealed before the re-seal reached them. */
  readonly unkeyed: number;
  /**
   * Page-derived rows holding a value whose ref is not keyed by it yet: the
   * rows `credentials-value-refs` has still to rewrite.
   */
  readonly legacyRefs: number;
  /** True when the table held more rows than the count read, so every figure is a floor. */
  readonly atLeast: boolean;
}

/** A page-derived row holding a value. */
type PageValueRow = Doc<'credentials'> & {
  ciphertext: string;
  iv: string;
  source: { sourceId: Id<'docSources'>; ref: string };
};

/** Whether a row holds a value on a page ref from before value-keyed refs. */
function holdsLegacyRef(row: Doc<'credentials'>): row is PageValueRow {
  return (
    row.ciphertext !== undefined &&
    row.iv !== undefined &&
    typeof row.source !== 'string' &&
    !isValueKeyedRef(row.source.ref)
  );
}

/**
 * Count the rows holding a value by the key that sealed them, and those whose
 * page ref is not yet keyed by their value.
 *
 * @param ctx - A query or mutation context.
 */
export async function credentialKeyCounts(ctx: QueryCtx): Promise<CredentialKeyCounts> {
  const rows = await ctx.db.query('credentials').take(KEY_COUNT_SCAN_LIMIT + 1);
  const byKeyId: Record<string, number> = {};
  let unkeyed = 0;
  let legacyRefs = 0;
  for (const row of rows.slice(0, KEY_COUNT_SCAN_LIMIT)) {
    if (row.ciphertext === undefined) continue;
    if (row.keyId === undefined) unkeyed += 1;
    else byKeyId[row.keyId] = (byKeyId[row.keyId] ?? 0) + 1;
    if (holdsLegacyRef(row)) legacyRefs += 1;
  }
  return { byKeyId, unkeyed, legacyRefs, atLeast: rows.length > KEY_COUNT_SCAN_LIMIT };
}

/** Rows one page of `keyCounts` reads. */
const KEY_COUNT_PAGE = 1_000;

/**
 * One page of the stored values counted by the key that sealed them.
 * Internal; the key rotation sums the pages to confirm no row is left on the
 * old key before it drops that key from the deployment.
 */
export const keyCounts = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    byKeyId: Record<string, number>;
    unkeyed: number;
    cursor: string;
    isDone: boolean;
  }> => {
    const page = await ctx.db
      .query('credentials')
      .paginate({ cursor: args.cursor, numItems: KEY_COUNT_PAGE });
    const byKeyId: Record<string, number> = {};
    let unkeyed = 0;
    for (const row of page.page) {
      if (row.ciphertext === undefined) continue;
      if (row.keyId === undefined) unkeyed += 1;
      else byKeyId[row.keyId] = (byKeyId[row.keyId] ?? 0) + 1;
    }
    return { byKeyId, unkeyed, cursor: page.continueCursor, isDone: page.isDone };
  },
});
