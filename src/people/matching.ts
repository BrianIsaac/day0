import { normaliseManagerAddress } from '../agent/manager-address';
import { personNameKey, type IdentityProvider, type PersonStatus } from './vocabulary';

/*
 * Whom a proposed person is in the owner's graph (wave 13, 13-P; the wave file's section 5.2, C5,
 * Q11): a held identity or address merges a proposal into its person as evidence; a name alone is
 * only ever "possibly the same as", merged by the manager and never here. Pure: the mutations in
 * `convex/people.ts` read the candidates and act on the answer.
 */

/** An identity a source gave for a proposed person: a Slack or Linear user a lookup found. */
export interface ProposedIdentity {
  readonly provider: IdentityProvider;
  readonly externalId: string;
  /** The vendor's workspace the id is unique in. */
  readonly workspaceId?: string;
}

/** A person a source proposes: a name, an address where the source gave one, and its words. */
export interface PersonProposal {
  readonly name: string;
  readonly email?: string;
  readonly identities: readonly ProposedIdentity[];
  /** The quotes the proposal is grounded on. */
  readonly quotes: readonly string[];
}

/** A person the owner's graph holds, as matching reads it. */
export interface HeldPerson<PersonId extends string> {
  readonly id: PersonId;
  readonly nameKey: string;
  readonly primaryEmail?: string;
  readonly status: PersonStatus;
  /** The quotes of the person's evidence. */
  readonly quotes: readonly string[];
}

/** An identity the owner's graph holds. */
export interface HeldIdentity<PersonId extends string> {
  readonly personId: PersonId;
  readonly provider: IdentityProvider;
  readonly externalId: string;
  readonly workspaceId?: string;
}

/**
 * What a proposal is to the graph: the person it is by identity or address (merged as evidence),
 * the person it already is on the same words (nothing new), a person the manager dismissed on
 * those grounds (proposed nobody), a person it is possibly the same as by name alone (offered, C5),
 * or nobody yet (a new proposal).
 */
export type ProposalMatch<PersonId extends string> =
  | { readonly kind: 'same'; readonly personId: PersonId; readonly by: 'identity' | 'address' }
  | { readonly kind: 'repeat'; readonly personId: PersonId }
  | { readonly kind: 'dismissed'; readonly personId: PersonId }
  | { readonly kind: 'possibly'; readonly personId: PersonId }
  | { readonly kind: 'new' };

/** The person a match found, as a merge or as a dismissal kept. */
function matched<PersonId extends string>(
  found: HeldPerson<PersonId>,
  by: 'identity' | 'address',
): ProposalMatch<PersonId> {
  return found.status === 'dismissed'
    ? { kind: 'dismissed', personId: found.id }
    : { kind: 'same', personId: found.id, by };
}

/** The person holding one of the proposal's identities, in the same workspace. */
function byIdentity<PersonId extends string>(
  proposal: PersonProposal,
  people: ReadonlyMap<PersonId, HeldPerson<PersonId>>,
  identities: readonly HeldIdentity<PersonId>[],
): HeldPerson<PersonId> | undefined {
  for (const wanted of proposal.identities) {
    const held = identities.find(
      (identity) =>
        identity.provider === wanted.provider &&
        identity.externalId === wanted.externalId &&
        identity.workspaceId === wanted.workspaceId,
    );
    const found = held === undefined ? undefined : people.get(held.personId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The person with the proposal's address, as their own or as an address identity. */
function byAddress<PersonId extends string>(
  proposal: PersonProposal,
  people: ReadonlyMap<PersonId, HeldPerson<PersonId>>,
  identities: readonly HeldIdentity<PersonId>[],
): HeldPerson<PersonId> | undefined {
  const address = normaliseManagerAddress(proposal.email);
  if (address === undefined) return undefined;
  const own = [...people.values()].find(
    (person) => normaliseManagerAddress(person.primaryEmail) === address,
  );
  if (own !== undefined) return own;
  const held = identities.find(
    (identity) =>
      identity.provider === 'email' && normaliseManagerAddress(identity.externalId) === address,
  );
  return held === undefined ? undefined : people.get(held.personId);
}

/**
 * Whom a proposal is in the owner's graph. An identity is compared first, then the address, and
 * either merges the proposal into its person (a dismissed person stays dismissed). By name alone,
 * a person already carrying one of the proposal's quotes is a repeat, a dismissed one carrying it
 * stays dismissed, and otherwise the proposal is possibly the same as the person, a confirmed one
 * before a proposal; nothing is merged by name.
 *
 * @param proposal - The proposed person.
 * @param people - The owner's people the proposal could be: every person under its name key and
 *   address, and every person its identities name.
 * @param identities - The owner's identities under the proposal's providers and ids, and its
 *   address.
 */
export function matchProposal<PersonId extends string>(
  proposal: PersonProposal,
  people: readonly HeldPerson<PersonId>[],
  identities: readonly HeldIdentity<PersonId>[],
): ProposalMatch<PersonId> {
  const byId = new Map(people.map((person) => [person.id, person]));
  const identified = byIdentity(proposal, byId, identities);
  if (identified !== undefined) return matched(identified, 'identity');
  const addressed = byAddress(proposal, byId, identities);
  if (addressed !== undefined) return matched(addressed, 'address');
  const key = personNameKey(proposal.name);
  if (key === '') return { kind: 'new' };
  const named = people.filter((person) => person.nameKey === key);
  const sameWords = named.find((person) =>
    person.quotes.some((quote) => proposal.quotes.includes(quote)),
  );
  if (sameWords !== undefined) {
    return sameWords.status === 'dismissed'
      ? { kind: 'dismissed', personId: sameWords.id }
      : { kind: 'repeat', personId: sameWords.id };
  }
  const standing = named.filter((person) => person.status !== 'dismissed');
  const offered =
    standing.find((person) => person.status === 'active') ??
    standing.find((person) => person.status === 'unverified');
  return offered === undefined ? { kind: 'new' } : { kind: 'possibly', personId: offered.id };
}
