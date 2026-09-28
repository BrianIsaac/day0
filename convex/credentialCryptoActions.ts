'use node';

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  CREDENTIAL_KEY_CHANGED_MESSAGE,
  credentialKeyId,
  credentialValueFingerprint,
  decrypt as decryptCredential,
  openOwnedCredential,
  sealForOwner,
  type CredentialKeyring,
  type SealedCredential,
} from '../src/lib/credential-crypto';
import { log } from '../src/lib/logger';
import { credentialPageRef, credentialSourceRef } from '../src/docs/redaction';
import { assignedByLabel, guardReason } from '../src/redaction/guard';
import {
  OWNER_KNOWN_VALUE_CAP,
  OWNER_KNOWN_VALUES_CAP_REASON,
} from '../src/redaction/known-values';

/**
 * Read the deployment encryption key without exposing it.
 *
 * Returns:
 *   Configured base64 AES-256 key.
 *
 * Raises:
 *   Error: If the deployment has no credential key.
 */
export function requireCredentialKey(): string {
  const key = process.env.DAY0_CREDENTIAL_KEY;
  if (!key) throw new Error('DAY0_CREDENTIAL_KEY is not configured.');
  return key;
}

/**
 * The deployment's keys: `DAY0_CREDENTIAL_KEY`, and while a rotation is under
 * way `DAY0_CREDENTIAL_KEY_PREVIOUS`, the key it replaced, which
 * `scripts/rotate-credential-key.ts` sets before the new key and removes once
 * no row needs it.
 *
 * @throws Error when the deployment has no credential key.
 */
export function credentialKeyring(): CredentialKeyring {
  const previous = process.env.DAY0_CREDENTIAL_KEY_PREVIOUS;
  return {
    current: requireCredentialKey(),
    ...(previous ? { previous } : {}),
  };
}

/**
 * Seal plaintext for its owner under the current key. Internal; writes
 * nothing. The value is bound to the owner with associated data
 * (`credentialOwnerBinding`), so it opens only on that owner's row, and the
 * result names the key that sealed it.
 */
export const seal = internalAction({
  args: { plaintext: v.string(), userId: v.string() },
  handler: async (_ctx, args): Promise<SealedCredential> =>
    sealForOwner(args.plaintext, credentialKeyring(), args.userId),
});

/**
 * A value's fingerprint for its owner under the current key, which keys a
 * page-derived credential's source ref (`credentialSourceRef`). Internal;
 * writes nothing. The documentation sync asks for it per credential it
 * found, since the key is read only here.
 *
 * @throws Error when the deployment has no credential key.
 */
export const fingerprint = internalAction({
  args: { plaintext: v.string(), userId: v.string() },
  handler: async (_ctx, args): Promise<string> =>
    credentialValueFingerprint(args.plaintext, requireCredentialKey(), args.userId),
});

/**
 * Open a stored row's value as its owner. Internal; writes nothing.
 *
 * A row with a key id opens only under that key and bound to its owner; a row
 * without one, sealed before key ids existed, opens unbound only until the
 * re-seal has finished (`credentials.openingPolicy`).
 */
export const open = internalAction({
  args: {
    ciphertext: v.string(),
    iv: v.string(),
    userId: v.string(),
    keyId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string> => {
    const policy: { allowUnbound: boolean } = await ctx.runQuery(
      internal.credentials.openingPolicy,
      {},
    );
    return openOwnedCredential(args, credentialKeyring(), policy);
  },
});

/**
 * Every active credential value one owner holds, for exact removal.
 *
 * Decrypts in-process through the same primitive `credentials.decrypt` uses,
 * without recording use: listing a value so it can be removed from text is
 * not using it. A row the key cannot open (sealed under a rotated key, or
 * bound to another owner) holds no plaintext a transport could have sent, so
 * it is left out, and the count left out is logged so the narrower removal
 * is visible; a deployment with no key at all gets an empty list. Above the
 * cap the action logs the count and fails closed. Values are never logged.
 */
export const ownerValues = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const {
      overflow,
      allowUnbound,
      rows,
    }: {
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
    } = await ctx.runQuery(internal.credentials.activeValuesForOwner, { userId: args.userId });
    if (overflow) {
      log.error(
        'credentialCryptoActions.ownerValues: too many active credentials for one owner; refusing',
        {
          cap: OWNER_KNOWN_VALUE_CAP,
        },
      );
      throw new Error(OWNER_KNOWN_VALUES_CAP_REASON);
    }
    if (rows.length === 0 || !process.env.DAY0_CREDENTIAL_KEY) return [];
    const keyring = credentialKeyring();
    const values = new Set<string>();
    const skipped: Id<'credentials'>[] = [];
    for (const row of rows) {
      let plaintext: string;
      try {
        plaintext = openOwnedCredential({ ...row, userId: args.userId }, keyring, {
          allowUnbound,
        });
      } catch {
        skipped.push(row._id);
        continue;
      }
      // A false page detection must not perpetuate itself through exact-value redaction.
      if (
        plaintext &&
        !(
          row.pageDerived &&
          guardReason(plaintext, {
            assigned: row.explicitlyAssigned === true || assignedByLabel(row.label),
            quoted: row.quoted === true,
          })
        )
      ) {
        values.add(plaintext);
      }
    }
    if (skipped.length > 0) {
      log.warn(
        'credentialCryptoActions.ownerValues: stored credentials left out of exact removal',
        {
          skipped: skipped.length,
          credentialIds: skipped,
          reason: CREDENTIAL_KEY_CHANGED_MESSAGE,
        },
      );
    }
    return [...values];
  },
});

/**
 * Inspect a stored value in-process; only a fixed guard reason leaves this
 * boundary. A password-class label records that the page assigned the value
 * explicitly, so a name-shaped password is not refused as a scope.
 */
export function storedCredentialGuardReason(row: {
  ciphertext?: string;
  iv?: string;
  userId?: string;
  keyId?: string;
  label: string;
  explicitlyAssigned?: boolean;
  quoted?: boolean;
}): string | undefined {
  if (row.ciphertext === undefined || row.iv === undefined)
    return 'credential material unavailable';
  const sealed = { ciphertext: row.ciphertext, iv: row.iv };
  let value: string;
  try {
    // Only a guard reason leaves this function, so a legacy row is read the
    // way it was stored; the decrypt that uses a value holds the re-seal's
    // switch (`open`). A caller that does not say whose row it is gets the
    // unbound read a row had before owners were bound.
    value =
      row.userId === undefined
        ? decryptCredential(sealed, requireCredentialKey())
        : openOwnedCredential(
            { ...sealed, userId: row.userId, keyId: row.keyId },
            credentialKeyring(),
            {
              allowUnbound: true,
            },
          );
  } catch {
    return CREDENTIAL_KEY_CHANGED_MESSAGE;
  }
  return guardReason(value, {
    assigned: row.explicitlyAssigned === true || assignedByLabel(row.label),
    quoted: row.quoted === true,
  });
}

/** What one page of a re-seal did. */
export interface ResealPage {
  /** Rows the page read, whether or not they hold a value. */
  readonly read: number;
  /** Rows sealed again under the current key. */
  readonly changed: number;
  /** Rows the keyring could not open, left as they were and logged by id. */
  readonly skipped: number;
  readonly cursor: string;
  readonly isDone: boolean;
  /** The id of the key every re-sealed row now names; absent when the page held no value. */
  readonly keyId?: string;
}

/**
 * Re-seal one page of credential rows under the current key, bound to each
 * row's owner, and write the key id.
 *
 * A row already naming the current key is left alone, so a page run twice
 * writes nothing the second time. A row the keyring cannot open (a key no
 * longer held, or an unbound value once the re-seal has finished) is not
 * sealed again: it is logged by id with the one "the credential key changed"
 * message and stays as it was. Plaintext never leaves this action. A page
 * holding no value needs no key, so a deployment that stores none (the mock
 * rung) finishes the re-seal without one.
 *
 * @param ctx - The Node action context.
 * @param cursor - Where the previous page stopped; null for the first page.
 * @throws Error when the page holds a value and the deployment has no key.
 */
async function resealOnePage(ctx: ActionCtx, cursor: string | null): Promise<ResealPage> {
  const batch = await ctx.runQuery(internal.credentials.resealBatch, { cursor });
  const progress = { read: batch.read, cursor: batch.cursor, isDone: batch.isDone };
  if (batch.rows.length === 0) return { ...progress, changed: 0, skipped: 0 };
  const keyring = credentialKeyring();
  const keyId = credentialKeyId(keyring.current);
  const resealed: Array<{
    credentialId: Id<'credentials'>;
    fromCiphertext: string;
    ciphertext: string;
    iv: string;
    keyId: string;
  }> = [];
  const skipped: Id<'credentials'>[] = [];
  for (const row of batch.rows) {
    if (row.keyId === keyId) continue;
    let plaintext: string;
    try {
      plaintext = openOwnedCredential(row, keyring, { allowUnbound: batch.allowUnbound });
    } catch {
      skipped.push(row._id);
      continue;
    }
    resealed.push({
      credentialId: row._id,
      fromCiphertext: row.ciphertext,
      ...sealForOwner(plaintext, keyring, row.userId),
    });
  }
  const changed =
    resealed.length === 0
      ? 0
      : await ctx.runMutation(internal.credentials.applyReseal, { rows: resealed });
  if (skipped.length > 0) {
    log.warn('credentialCryptoActions.reseal: stored credentials left as they were', {
      skipped: skipped.length,
      credentialIds: skipped,
      reason: CREDENTIAL_KEY_CHANGED_MESSAGE,
    });
  }
  return { ...progress, changed, skipped: skipped.length, keyId };
}

/**
 * One page of the re-seal. Internal; the `credentials-reseal` migration runs
 * it page by page on the migration runner, which keeps the cursor.
 */
export const resealPage = internalAction({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<ResealPage> => await resealOnePage(ctx, args.cursor),
});

/** What one page of the ref rewrite did. */
export interface ValueRefPage {
  /** Rows the page read, whether or not they needed rewriting. */
  readonly read: number;
  /** Rows moved to their value-keyed ref. */
  readonly changed: number;
  /** Rows left as they were: the key could not open them, or another row holds their ref. */
  readonly skipped: number;
  readonly cursor: string;
  readonly isDone: boolean;
}

/**
 * Rewrite one page of page-derived rows to the value-keyed ref
 * (`credentialSourceRef`), keeping each row's page part.
 *
 * Each value is opened as its owner and fingerprinted under the current key;
 * the row keeps its id, label, status and every surface bound to it. A row
 * the keyring cannot open, or whose value-keyed ref another row of its page
 * already holds, is left as it was and logged by id; the status counts it as
 * remaining. Plaintext never leaves this action. A page holding no such row
 * needs no key, so a deployment that stores no value finishes without one.
 *
 * @param ctx - The Node action context.
 * @param cursor - Where the previous page stopped; null for the first page.
 * @throws Error when the page holds a value and the deployment has no key.
 */
async function valueRefsOnePage(ctx: ActionCtx, cursor: string | null): Promise<ValueRefPage> {
  const batch = await ctx.runQuery(internal.credentials.valueRefBatch, { cursor });
  const progress = { read: batch.read, cursor: batch.cursor, isDone: batch.isDone };
  if (batch.rows.length === 0) return { ...progress, changed: 0, skipped: 0 };
  const keyring = credentialKeyring();
  const moves: Array<{ credentialId: Id<'credentials'>; fromRef: string; ref: string }> = [];
  const unreadable: Id<'credentials'>[] = [];
  for (const row of batch.rows) {
    let plaintext: string;
    try {
      plaintext = openOwnedCredential(row, keyring, { allowUnbound: batch.allowUnbound });
    } catch {
      unreadable.push(row._id);
      continue;
    }
    moves.push({
      credentialId: row._id,
      fromRef: row.ref,
      ref: credentialSourceRef(
        credentialPageRef(row.ref),
        credentialValueFingerprint(plaintext, keyring.current, row.userId),
      ),
    });
  }
  const { changed, blocked } =
    moves.length === 0
      ? { changed: 0, blocked: [] }
      : await ctx.runMutation(internal.credentials.applyValueRefs, { rows: moves });
  if (unreadable.length > 0) {
    log.warn('credentialCryptoActions.valueRefs: stored credentials left on their old ref', {
      skipped: unreadable.length,
      credentialIds: unreadable,
      reason: CREDENTIAL_KEY_CHANGED_MESSAGE,
    });
  }
  if (blocked.length > 0) {
    log.warn('credentialCryptoActions.valueRefs: stored credentials left on their old ref', {
      skipped: blocked.length,
      credentialIds: blocked,
      reason: 'another row of the page already holds the same value',
    });
  }
  return { ...progress, changed, skipped: unreadable.length + blocked.length };
}

/**
 * One page of the ref rewrite. Internal; the `credentials-value-refs`
 * migration runs it page by page on the migration runner, which keeps the
 * cursor.
 */
export const valueRefPage = internalAction({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<ValueRefPage> => await valueRefsOnePage(ctx, args.cursor),
});

/** How long one `resealAll` call re-seals before it hands back its cursor. */
const RESEAL_BUDGET_MS = 4 * 60 * 1_000;

/**
 * Re-seal every row from a cursor until the table ends or the time budget
 * runs out, and say how far it got. Internal; the key rotation calls it
 * through `npx convex run` until `isDone`, passing back the cursor.
 */
export const resealAll = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    read: number;
    changed: number;
    skipped: number;
    cursor: string | null;
    isDone: boolean;
  }> => {
    const startedAt = Date.now();
    let cursor = args.cursor ?? null;
    let read = 0;
    let changed = 0;
    let skipped = 0;
    for (;;) {
      const page = await resealOnePage(ctx, cursor);
      read += page.read;
      changed += page.changed;
      skipped += page.skipped;
      cursor = page.cursor;
      if (page.isDone || Date.now() - startedAt > RESEAL_BUDGET_MS) {
        return { read, changed, skipped, cursor, isDone: page.isDone };
      }
    }
  },
});

/**
 * The ids of the keys this backend reads now. Internal; the key rotation
 * compares them with the keys it set, because a self-hosted backend reads a
 * changed environment only after a restart.
 */
export const keyIds = internalAction({
  args: {},
  handler: async (): Promise<{ current: string; previous?: string }> => {
    const keyring = credentialKeyring();
    return {
      current: credentialKeyId(keyring.current),
      ...(keyring.previous !== undefined ? { previous: credentialKeyId(keyring.previous) } : {}),
    };
  },
});
