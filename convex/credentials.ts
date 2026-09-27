import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { getCallerOrThrow } from './ownership';
import { OWNER_KNOWN_VALUE_CAP } from '../src/redaction/known-values';
import { credentialPageRef, credentialRefRange } from '../src/docs/redaction';

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
 * Store encrypted credential bytes, upserting page-derived rows by source.
 *
 * A changed source value is a rotation and reactivates its stable row. An
 * unchanged value never clears revocation, so periodic sync cannot undo an
 * explicit owner decision.
 */
export const persistEncrypted = internalMutation({
  args: {
    userId: v.string(),
    kind: credentialKind,
    label: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    explicitlyAssigned: v.optional(v.boolean()),
    source: credentialSource,
    appId: v.optional(v.string()),
    reactivate: v.boolean(),
  },
  handler: async (ctx, args): Promise<Id<'credentials'>> => {
    const sourced = pageSource(args.source);
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
        explicitlyAssigned: args.explicitlyAssigned,
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
      explicitlyAssigned: args.explicitlyAssigned,
      appId: args.appId,
      lastUsedAt: args.reactivate ? undefined : existing.lastUsedAt,
      revokedAt: args.reactivate ? undefined : existing.revokedAt,
      status: undefined,
      statusReason: undefined,
    });
    return existing._id;
  },
});

/**
 * Update non-secret metadata without changing revocation or usage state.
 * Internal. Clears the status, so a row a sync superseded is live again once
 * its value is found again; a person's revoke stays.
 */
export const updateMetadata = internalMutation({
  args: {
    credentialId: v.id('credentials'),
    kind: credentialKind,
    label: v.string(),
    appId: v.optional(v.string()),
    explicitlyAssigned: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.credentialId, {
      kind: args.kind,
      label: args.label,
      appId: args.appId,
      explicitlyAssigned: args.explicitlyAssigned,
      status: undefined,
      statusReason: undefined,
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
    rows: Array<{
      _id: Id<'credentials'>;
      ciphertext: string;
      iv: string;
      label: string;
      pageDerived: boolean;
      explicitlyAssigned?: boolean;
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
      rows: active.slice(0, OWNER_KNOWN_VALUE_CAP + 1).map((row) => ({
        _id: row._id,
        ciphertext: row.ciphertext,
        iv: row.iv,
        label: row.label,
        pageDerived: typeof row.source !== 'string',
        explicitlyAssigned: row.explicitlyAssigned,
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

/** The most rows one page can hold that `store` reads to find a value it already has. */
const PAGE_ROW_LIMIT = 64;

/**
 * The page-derived rows of one page of one source, whatever the page's count
 * of values made their refs. Internal; read by `store` before it inserts.
 */
export const pageRowsForStore = internalQuery({
  args: { userId: v.string(), sourceId: v.id('docSources'), pageRef: v.string() },
  handler: async (ctx, args): Promise<Doc<'credentials'>[]> => {
    const { from, to } = credentialRefRange(args.pageRef);
    const rows = await ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index
          .eq('userId', args.userId)
          .eq('source.sourceId', args.sourceId)
          .gte('source.ref', from)
          .lte('source.ref', to),
      )
      .take(PAGE_ROW_LIMIT);
    return rows.filter(
      (row) => typeof row.source !== 'string' && credentialPageRef(row.source.ref) === args.pageRef,
    );
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
  },
  handler: async (ctx, args): Promise<boolean> => {
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
 * @param row - A stored credential row.
 */
async function storedValue(
  ctx: ActionCtx,
  row: Pick<Doc<'credentials'>, 'ciphertext' | 'iv'>,
): Promise<string | undefined> {
  if (row.ciphertext === undefined || row.iv === undefined) return undefined;
  try {
    return await ctx.runAction(internal.credentialCryptoActions.open, {
      ciphertext: row.ciphertext,
      iv: row.iv,
    });
  } catch {
    // Sealed under a rotated DAY0_CREDENTIAL_KEY: unreadable, so it holds no
    // value this sync can match, and the page's value replaces it rather than
    // failing every sync of that page.
    return undefined;
  }
}

/**
 * Encrypt and store one credential through the stable lane-A contract.
 * Internal.
 *
 * A page-derived value is upserted by `(userId, sourceId, ref)`. A ref the
 * source has no row for is first looked for on the same page: a value the
 * page already holds under the ref its old count of values gave it is moved
 * to the new ref, not stored again, so a page gaining or losing a value never
 * mints a row for a value already known. The Node-only AES operation is
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
    source: credentialSource,
    appId: v.optional(v.string()),
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
        });
        if (moved) return row._id;
      }
    }
    const encrypted = await ctx.runAction(internal.credentialCryptoActions.seal, { plaintext });
    return await ctx.runMutation(internal.credentials.persistEncrypted, {
      userId: args.userId,
      source: args.source,
      ...metadata,
      ...encrypted,
      reactivate: existing !== null,
    });
  },
});

/** Decrypt one active value for another server-side action. */
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
