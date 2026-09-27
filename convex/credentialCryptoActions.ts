'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import {
  CREDENTIAL_KEY_CHANGED_MESSAGE,
  credentialOwnerBinding,
  decrypt as decryptCredential,
  encrypt as encryptCredential,
  openOwnedCredential,
} from '../src/lib/credential-crypto';
import { log } from '../src/lib/logger';
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
 * Encrypt plaintext inside the Convex Node runtime. Internal; writes nothing.
 *
 * Given the owner, the value is bound to them with associated data
 * (`credentialOwnerBinding`), so it opens only on that owner's row. Without
 * one it is sealed unbound, as every value was before binding existed.
 */
export const seal = internalAction({
  args: { plaintext: v.string(), userId: v.optional(v.string()) },
  handler: async (_ctx, args): Promise<{ ciphertext: string; iv: string }> =>
    encryptCredential(
      args.plaintext,
      requireCredentialKey(),
      args.userId === undefined ? undefined : credentialOwnerBinding(args.userId),
    ),
});

/**
 * Decrypt ciphertext inside the Convex Node runtime. Internal; writes nothing.
 *
 * Given the owner, a value bound to that owner opens and so does an unbound
 * value sealed before binding existed; a value bound to anyone else does not.
 */
export const open = internalAction({
  args: { ciphertext: v.string(), iv: v.string(), userId: v.optional(v.string()) },
  handler: async (_ctx, args): Promise<string> => {
    const sealed = { ciphertext: args.ciphertext, iv: args.iv };
    return args.userId === undefined
      ? decryptCredential(sealed, requireCredentialKey())
      : openOwnedCredential(sealed, requireCredentialKey(), args.userId);
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
      rows,
    }: {
      overflow: boolean;
      rows: Array<{
        ciphertext: string;
        iv: string;
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
    const key = requireCredentialKey();
    const values = new Set<string>();
    let skipped = 0;
    for (const row of rows) {
      let plaintext: string;
      try {
        plaintext = openOwnedCredential(
          { ciphertext: row.ciphertext, iv: row.iv },
          key,
          args.userId,
        );
      } catch {
        skipped += 1;
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
    if (skipped > 0) {
      log.warn(
        'credentialCryptoActions.ownerValues: stored credentials left out of exact removal',
        {
          skipped,
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
  label: string;
  explicitlyAssigned?: boolean;
  quoted?: boolean;
}): string | undefined {
  if (row.ciphertext === undefined || row.iv === undefined)
    return 'credential material unavailable';
  try {
    const sealed = { ciphertext: row.ciphertext, iv: row.iv };
    const value =
      row.userId === undefined
        ? decryptCredential(sealed, requireCredentialKey())
        : openOwnedCredential(sealed, requireCredentialKey(), row.userId);
    return guardReason(value, {
      assigned: row.explicitlyAssigned === true || assignedByLabel(row.label),
      quoted: row.quoted === true,
    });
  } catch {
    return 'credential material unreadable';
  }
}
