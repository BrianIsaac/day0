import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from '../../convex/_generated/server';

/**
 * The credential decryption contract the executors call.
 *
 * `credentials:decrypt` is the `"use node"` internal action that decrypts one
 * `credentials` row with `DAY0_CREDENTIAL_KEY` and returns the plaintext to
 * the calling action. It is referenced by name so this module type-checks
 * against the agreed interface regardless of which lane's code is present;
 * the name resolves to the same function `internal.credentials.decrypt` names.
 */
export const decryptCredentialRef = makeFunctionReference<
  'action',
  { credentialId: string },
  string
>('credentials:decrypt');

/** Resolve one credential id to its plaintext inside a Node action. */
export type DecryptCredential = (ctx: ActionCtx, credentialId: string) => Promise<string>;

/**
 * Decrypt a stored credential for use inside the calling action.
 *
 * The value is returned to the caller only; it is never logged, persisted or
 * passed through the scheduler.
 *
 * Args:
 *   ctx: Convex action context.
 *   credentialId: Id of the `credentials` row.
 *
 * Returns:
 *   The plaintext credential.
 */
export async function decryptCredential(ctx: ActionCtx, credentialId: string): Promise<string> {
  return await ctx.runAction(decryptCredentialRef, { credentialId });
}
