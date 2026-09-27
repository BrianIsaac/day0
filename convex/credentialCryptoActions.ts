'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  CREDENTIAL_KEY_CHANGED_MESSAGE,
  decrypt as decryptCredential,
  openOwnedCredential,
  sealForOwner,
  type CredentialKeyring,
  type SealedCredential,
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
