'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import {
  decrypt as decryptCredential,
  encrypt as encryptCredential,
} from '../src/lib/credential-crypto';

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
