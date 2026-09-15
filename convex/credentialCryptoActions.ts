'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import {
  decrypt as decryptCredential,
  encrypt as encryptCredential,
} from '../src/lib/credential-crypto';
import { OWNER_KNOWN_VALUE_CAP, OWNER_KNOWN_VALUES_CAP_REASON } from '../src/redaction/known-values';

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

/** Encrypt plaintext inside the Convex Node runtime. */
export const seal = internalAction({
  args: { plaintext: v.string() },
  handler: async (_ctx, args): Promise<{ ciphertext: string; iv: string }> =>
    encryptCredential(args.plaintext, requireCredentialKey()),
});

/** Decrypt ciphertext inside the Convex Node runtime. */
export const open = internalAction({
  args: { ciphertext: v.string(), iv: v.string() },
  handler: async (_ctx, args): Promise<string> =>
    decryptCredential({ ciphertext: args.ciphertext, iv: args.iv }, requireCredentialKey()),
});

/**
 * Every active credential value one owner holds, for exact removal.
 *
 * Decrypts in-process through the same primitive `credentials.decrypt` uses,
 * without recording use: listing a value so it can be removed from text is
 * not using it. A row sealed under a rotated key is skipped, since no
 * plaintext of it exists to leak. Above the cap the action logs the count
 * and fails closed; the values themselves are never logged.
 */
export const ownerValues = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const { overflow, rows }: { overflow: boolean; rows: Array<{ ciphertext: string; iv: string }> } =
      await ctx.runQuery(internal.credentials.activeValuesForOwner, { userId: args.userId });
    if (overflow) {
      console.error(
        `credentialCryptoActions.ownerValues: more than ${OWNER_KNOWN_VALUE_CAP} active credentials for one owner; refusing`,
      );
      throw new Error(OWNER_KNOWN_VALUES_CAP_REASON);
    }
    if (rows.length === 0) return [];
    const key = requireCredentialKey();
    const values = new Set<string>();
    for (const row of rows) {
      let plaintext: string;
      try {
        plaintext = decryptCredential({ ciphertext: row.ciphertext, iv: row.iv }, key);
      } catch {
        continue;
      }
      if (plaintext) values.add(plaintext);
    }
    return [...values];
  },
});
