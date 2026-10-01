import { sha256OfText } from '../lib/sha256';

/**
 * The identity of a skill body, for the ledger to say which body a run used.
 *
 * Synchronous on purpose: it is computed inside the execution claim's
 * transaction, and an await on Web Crypto there hands control to the event
 * loop mid-mutation, which `convex-test` then interleaves with scheduled work.
 *
 * @param body - The skill's SKILL.md text.
 * @returns `sha256:` and the hex digest of the UTF-8 body.
 */
export function skillBodyHash(body: string): string {
  return `sha256:${sha256OfText(body)}`;
}
