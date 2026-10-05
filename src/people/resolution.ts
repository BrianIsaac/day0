import { personNameKey, type RelationshipStatus } from './vocabulary';

/*
 * How the people graph's readers answer (wave 13, 13-P; the wave file's section 5.2): whom a set of
 * matches names, whether an edge held on a date, and whether an edge's scope covers the one asked
 * about. Pure, so the queries in `convex/people.ts` and their tests share one reading.
 */

/**
 * Whom a lookup resolved to: one person, several people it could be (never a guess, Q11), or
 * nobody the graph knows (RM6). The shape `workItems.requesterPerson` stores.
 */
export type PersonResolution<PersonId extends string = string> =
  | { readonly kind: 'person'; readonly personId: PersonId }
  | { readonly kind: 'ambiguous'; readonly candidates: number }
  | { readonly kind: 'unknown' };

/**
 * The answer a set of matches gives: the person when every match names the same one, ambiguous
 * with the number of people when they name several, unknown when there is none.
 *
 * @param personIds - The person each match names, repeats included.
 */
export function resolveMatches<PersonId extends string>(
  personIds: readonly PersonId[],
): PersonResolution<PersonId> {
  const distinct = [...new Set(personIds)];
  if (distinct.length === 0) return { kind: 'unknown' };
  if (distinct.length === 1) return { kind: 'person', personId: distinct[0]! };
  return { kind: 'ambiguous', candidates: distinct.length };
}

/** The parts of an edge that say when it held. */
export interface EdgeSpan {
  readonly status: RelationshipStatus;
  readonly effectiveFrom: number;
  readonly effectiveUntil?: number;
  readonly confirmedAt?: number;
}

/**
 * Whether an edge held at a moment: the manager confirmed it, it had taken effect, and it had not
 * ended. A proposal never held, nor did an edge retired before it was in force (13-K's
 * `retireEdgesOf` gives that one no end); a disputed edge is one the manager said is wrong, so it
 * answers for no date.
 *
 * @param edge - The edge.
 * @param at - The moment, in epoch milliseconds.
 */
export function edgeHeldAt(edge: EdgeSpan, at: number): boolean {
  if (edge.confirmedAt === undefined || edge.status === 'disputed') return false;
  if (edge.status === 'proposed') return false;
  if (edge.effectiveFrom > at) return false;
  if (edge.effectiveUntil === undefined) return edge.status === 'active';
  return at < edge.effectiveUntil;
}

/**
 * Whether an edge is in force now: active and held at the moment.
 *
 * @param edge - The edge.
 * @param now - The moment, in epoch milliseconds.
 */
export function edgeInForce(edge: EdgeSpan, now: number): boolean {
  return edge.status === 'active' && edgeHeldAt(edge, now);
}

/** The words of a scope as the graph compares them. */
function scopeWords(scope: string): ReadonlySet<string> {
  const key = personNameKey(scope);
  return new Set(key === '' ? [] : key.split(' '));
}

/**
 * Whether an edge's scope covers the scope asked about: every word asked about is among the
 * edge's own, in any order or case; an edge with no scope covers every scope. A question with no
 * word in it is covered by nothing.
 *
 * @param edgeScope - The edge's scope in its source's words, or undefined for none.
 * @param wanted - The scope asked about.
 */
export function scopeCovers(edgeScope: string | undefined, wanted: string): boolean {
  const asked = scopeWords(wanted);
  if (asked.size === 0) return false;
  if (edgeScope === undefined) return true;
  const held = scopeWords(edgeScope);
  return [...asked].every((word) => held.has(word));
}
