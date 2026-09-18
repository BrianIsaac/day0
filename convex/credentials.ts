import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { getCallerOrThrow } from './ownership';
import { OWNER_KNOWN_VALUE_CAP } from '../src/redaction/known-values';

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

/** Update non-secret metadata without changing revocation or usage state. */
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
 * The owner's active, value-bearing rows for the exact-value layer.
 *
 * Only the fields the Node action needs to decrypt leave this query, and
 * only to that action: it is internal, and the plaintext never comes back
 * through a query. One row past the cap is read so the action can tell a
 * full list from an overflowing one; the count is of every row the owner
 * holds, revoked or not, because a list read through a bound is only
 * complete when the bound was not reached.
 */
export const activeValuesForOwner = internalQuery({
  args: { userId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ overflow: boolean; rows: Array<{ _id: Id<'credentials'>; ciphertext: string; iv: string; label: string; pageDerived: boolean; explicitlyAssigned?: boolean }> }> => {
    const rows = await ctx.db
      .query('credentials')
      .withIndex('by_userId', (index) => index.eq('userId', args.userId))
      .take(OWNER_KNOWN_VALUE_CAP + 1);
    return {
      overflow: rows.length > OWNER_KNOWN_VALUE_CAP,
      rows: rows.flatMap((row) =>
        !row.revokedAt && !row.status && row.ciphertext !== undefined && row.iv !== undefined
          ? [{ _id: row._id, ciphertext: row.ciphertext, iv: row.iv, label: row.label, pageDerived: typeof row.source !== 'string', explicitlyAssigned: row.explicitlyAssigned }]
          : [],
      ),
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
 * Encrypt and store one credential through the stable lane-A contract.
 *
 * The Node-only AES operation is isolated in `credentialCryptoActions`
 * because Convex forbids a Node module from also exporting this module's
 * public query and mutation.
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
    const existing = !sourced
      ? null
      : await ctx.runQuery(internal.credentials.bySourceForStore, {
          userId: args.userId,
          sourceId: sourced.sourceId,
          ref: sourced.ref,
        });
    if (existing && existing.ciphertext !== undefined && existing.iv !== undefined) {
      let current: string | undefined;
      try {
        current = await ctx.runAction(internal.credentialCryptoActions.open, {
          ciphertext: existing.ciphertext,
          iv: existing.iv,
        });
      } catch {
        // Sealed under a rotated DAY0_CREDENTIAL_KEY: unreadable, so the page's
        // value replaces it rather than failing every sync of that page.
        current = undefined;
      }
      if (current === plaintext) {
        await ctx.runMutation(internal.credentials.updateMetadata, {
          credentialId: existing._id,
          kind: args.kind,
          label: args.label,
          appId: args.appId,
          explicitlyAssigned: args.explicitlyAssigned,
        });
        return existing._id;
      }
    }
    const encrypted = await ctx.runAction(internal.credentialCryptoActions.seal, { plaintext });
    return await ctx.runMutation(internal.credentials.persistEncrypted, {
      userId: args.userId,
      kind: args.kind,
      label: args.label,
      source: args.source,
      appId: args.appId,
      explicitlyAssigned: args.explicitlyAssigned,
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

/** Count active stored credentials for local setup diagnostics. */
export const countStored = internalQuery({
  args: {},
  handler: async (ctx): Promise<number> => {
    const credentials = await ctx.db.query('credentials').take(1_001);
    if (credentials.length > 1_000) throw new Error('Credential count exceeds the setup limit.');
    return credentials.filter((credential) => !credential.revokedAt).length;
  },
});

/** Quarantine only the ciphertext orientation inspected, without racing a rotation. */
export const markSuspect = internalMutation({
  args: { credentialId: v.id('credentials'), ciphertext: v.optional(v.string()), reason: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.credentialId);
    if (!row || row.ciphertext !== args.ciphertext || row.revokedAt || row.status === 'superseded') return;
    await ctx.db.patch(row._id, { status: 'suspect', statusReason: args.reason });
  },
});
