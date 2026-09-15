/**
 * The owner's stored credential values as an exact-removal list.
 *
 * Exact-value removal is the layer a model miss must never get past, and it
 * is only as wide as the list it is given. A transport knows the one value it
 * just sent; an owner's other credentials (the tile password stored from a
 * runbook, a token entered for a surface that is not part of this run) are
 * just as much Day0's own material and must not reach a ledger row, a stored
 * page, a prompt or an export through an unrelated outcome. This module names
 * the source of that list and the rules around it:
 *
 *   - decrypted by one internal Node action, in-process, through the same AES
 *     primitive `credentials.decrypt` uses; never a public function;
 *   - bounded: above the cap the action fails closed with a named reason
 *     rather than persist text it could not protect;
 *   - resolved once per action invocation, before any transport, so a run
 *     with many outcomes decrypts once and a failure is never discovered
 *     after a write has landed;
 *   - held in memory only: never persisted, scheduled or logged.
 */
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from '../../convex/_generated/server';
import { redactValue } from '../surfaces/secrets';

/** The most credentials one owner may hold before the source refuses to answer. */
export const OWNER_KNOWN_VALUE_CAP = 1_000;

/** The reason the source fails closed with, named so a caller can test for it. */
export const OWNER_KNOWN_VALUES_CAP_REASON =
  'known credential values unavailable: the owner holds more stored credentials than the exact-value layer can carry';

/**
 * The Node action that decrypts the owner's active values, referenced by
 * name the way `credentials:decrypt` is, so this module type-checks without
 * importing the generated API.
 */
export const ownerValuesRef = makeFunctionReference<'action', { userId: string }, string[]>(
  'credentialCryptoActions:ownerValues',
);

/** Resolve one owner's active credential values inside a Node action. */
export type FetchOwnerValues = (ctx: ActionCtx, userId: string) => Promise<readonly string[]>;

/**
 * The owner's stored credential values, decrypted for exact removal.
 *
 * Args:
 *   ctx: Convex action context.
 *   userId: The owner whose credentials are listed.
 *
 * Returns:
 *   Every active, decryptable value the owner holds; empty for an owner with
 *   none. The caller keeps the list for the rest of its invocation and hands
 *   it to every boundary it persists through.
 *
 * Raises:
 *   Error: With `OWNER_KNOWN_VALUES_CAP_REASON` when the owner holds more
 *     rows than the cap; the caller must not persist without the list.
 */
export async function ownerKnownValues(ctx: ActionCtx, userId: string): Promise<readonly string[]> {
  const values: unknown = await ctx.runAction(ownerValuesRef, { userId });
  if (!Array.isArray(values) || values.some((value: unknown): boolean => typeof value !== 'string')) {
    throw new Error('known credential values unavailable: the source answered with something other than a list');
  }
  return values as string[];
}

/**
 * Remove every known value from every string inside a value about to be
 * persisted or returned: a ledger output, an event payload, an export.
 *
 * Args:
 *   value: Any JSON-shaped value.
 *   known: The exact values to remove.
 *
 * Returns:
 *   The same shape with every occurrence of every known value, literal,
 *   JSON-escaped or URL-encoded, replaced by the redaction marker.
 */
export function scrubKnownValues<T>(value: T, known: readonly string[]): T {
  if (known.length === 0) return value;
  // Longest first, so a value that contains another is removed whole.
  const ordered = [...known].sort((left, right): number => right.length - left.length);
  const walk = (entry: unknown): unknown => {
    if (typeof entry === 'string') {
      let text = entry;
      for (const secret of ordered) text = redactValue(text, secret);
      return text;
    }
    if (Array.isArray(entry)) return entry.map(walk);
    if (entry !== null && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([key, child]): [string, unknown] => [key, walk(child)]),
      );
    }
    return entry;
  };
  return walk(value) as T;
}
