/*
 * The words of the people graph (wave 13; the wave file's section 5.1): the people an owner's
 * employees work with, each person's identities in the systems they use, and the edges between an
 * employee or a person and a person. `convex/schema.ts` declares its validators from these lists,
 * so the schema and the code that writes and reads the graph (13-P) say each state one way.
 */

/**
 * A person's standing in the owner's graph: `unverified` while it is a proposal nobody has
 * confirmed (A1, A14: a proposal is never a confirmed fact), `active` once the manager confirmed
 * it, `inactive` for one who left, and `dismissed` for a proposal the manager turned down, kept so
 * the same words are not proposed again.
 */
export const PERSON_STATUSES = ['active', 'inactive', 'unverified', 'dismissed'] as const;

/** One of {@link PERSON_STATUSES}. */
export type PersonStatus = (typeof PERSON_STATUSES)[number];

/**
 * Where a person, an identity or an edge came from: the owner's own sign-in, the manager's hand,
 * the approved charter, the one-to-one, the documentation, a provider's lookup (Slack's
 * `users.lookupByEmail`), a proposal made in chat, or a directory.
 */
export const PEOPLE_SOURCES = [
  'owner',
  'manager',
  'charter',
  'one-to-one',
  'documentation',
  'provider-lookup',
  'chat-proposal',
  'directory',
] as const;

/** One of {@link PEOPLE_SOURCES}. */
export type PeopleSource = (typeof PEOPLE_SOURCES)[number];

/**
 * The systems a person's identity is in: an address, a sign-in issuer's subject, a Slack user or
 * a Linear user. The graph's identities are people's; whom a card acts as (`surfaces.actsAs`) is
 * the employee's, and nothing is shared between the two (the access plan, section 6).
 */
export const IDENTITY_PROVIDERS = ['email', 'oidc', 'slack', 'linear'] as const;

/** One of {@link IDENTITY_PROVIDERS}. */
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

/**
 * What an edge says. There is no `direct-manager`: the manager is the owner (the one-role
 * rulings). `approval-authority` informs routing and reorientation only, and never decides an
 * employee's writes (A17, Q10).
 */
export const RELATIONSHIP_TYPES = [
  'escalation-contact',
  'collaborator',
  'adjacent-role',
  'dotted-line',
  'approval-authority',
] as const;

/** One of {@link RELATIONSHIP_TYPES}. */
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/**
 * An edge's standing: `proposed` until the manager confirms it, `active`, `superseded` by the
 * edit that replaced it, `disputed` when the manager said it is wrong without replacing it, and
 * `retired` when it ended (an employee's retire or handover ends its edges).
 */
export const RELATIONSHIP_STATUSES = [
  'proposed',
  'active',
  'superseded',
  'disputed',
  'retired',
] as const;

/** One of {@link RELATIONSHIP_STATUSES}. */
export type RelationshipStatus = (typeof RELATIONSHIP_STATUSES)[number];

/**
 * A person's name as the graph compares it: compatibility forms folded (a full-width letter is
 * its letter), accents dropped, every run of anything but a letter or a digit one space, lower
 * case, trimmed. Two names with one key are a name-only match, which is offered as "possibly the
 * same as" and never merged by itself (C5); a name with no letter or digit keys as empty and
 * matches nobody.
 *
 * @param name - The name as a source wrote it.
 * @returns The key `people.nameKey` and `personIdentities.displayNameKey` are indexed by.
 */
export function personNameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
