import type { RelationshipType } from './vocabulary';

/*
 * The people graph's words (wave 13, 13-P; the wave file's section 7, product copy, flagged): the
 * refusals the card's mutations answer with and the lines the People tab draws. One place, so the
 * server's refusal and the page's sentence never drift apart.
 */

/** The refusal of Confirm, Dismiss or a merge on a person with nothing waiting on the manager. */
export const NOTHING_WAITING = 'Nothing about this person is waiting on you.';

/** The refusal of Confirm or Dismiss on a proposal offered as possibly someone already known. */
export const SAY_WHETHER_SAME_FIRST =
  'Say whether this is the same person as the one already in your people first.';

/** The refusal of Same person or Different on a proposal no name matched. */
export const NOT_OFFERED_AS_SAME = 'This person is not offered as the same as anyone.';

/** The refusal of Same person when the person it was offered as is no longer in the graph. */
export const SAME_PERSON_GONE = 'The person this was offered as is no longer in your people.';

/** The refusal of A different person on an identity that is not the proposal's own match. */
export const NOT_THE_MATCH = 'This identity is not the match proposed for this person.';

/** The refusal of a change to an edge that has ended. */
export const RELATIONSHIP_ENDED = 'This relationship has already ended.';

/** The refusal of a new edge to a person the manager has not confirmed. */
export const CONFIRM_BEFORE_RELATING = 'Confirm this person before you add a relationship to them.';

/** The refusal of an edge's scope longer than {@link RELATIONSHIP_SCOPE_LIMIT}. */
export const SCOPE_TOO_LONG = 'Keep what the relationship covers to 200 characters.';

/** The longest scope an edge the manager writes may carry, in characters. */
export const RELATIONSHIP_SCOPE_LIMIT = 200;

/** The refusal of a change to the owner's own row, which is the manager and never a proposal. */
export const OWNER_IS_THE_MANAGER = 'You are the manager: your own row is not a proposal.';

/** An edge type in the manager's words, as the People tab and the record say it. */
export const RELATIONSHIP_WORDS: Readonly<Record<RelationshipType, string>> = {
  'escalation-contact': 'escalation contact',
  collaborator: 'works with',
  'adjacent-role': 'neighbouring role',
  'dotted-line': 'dotted line',
  'approval-authority': 'approves',
};

/** An edge type as a noun for the person it points at, as the record says it. */
export const RELATIONSHIP_NOUNS: Readonly<Record<RelationshipType, string>> = {
  'escalation-contact': 'escalation contact',
  collaborator: 'collaborator',
  'adjacent-role': 'neighbouring role',
  'dotted-line': 'dotted-line contact',
  'approval-authority': 'approver',
};

/**
 * An edge type's noun from a stored row, read defensively: a row that carries no type, or one
 * this release does not know, reads as a plain relationship.
 *
 * @param type - What the row holds.
 */
export function relationshipNoun(type: unknown): string {
  return typeof type === 'string' && Object.hasOwn(RELATIONSHIP_NOUNS, type)
    ? RELATIONSHIP_NOUNS[type as RelationshipType]
    : 'relationship';
}

/** The edge types the manager can add from one employee's People tab: an employee's own edges. */
export const EMPLOYEE_RELATIONSHIP_TYPES = [
  'collaborator',
  'adjacent-role',
  'escalation-contact',
  'dotted-line',
] as const satisfies readonly RelationshipType[];

/**
 * The Proposed card's lead line.
 *
 * @param employee - The employee's name.
 */
export function proposedLead(employee: string): string {
  return `${employee} found these people. Confirm the ones that are right.`;
}

/**
 * The Proposed card's empty line in real mode.
 *
 * @param employee - The employee's name.
 */
export function proposedEmpty(employee: string): string {
  return `No one to confirm. ${employee} proposes people after its charter is approved and when your documentation changes.`;
}

/**
 * The Proposed card in mock mode, where the graph is not kept (13-K: `ensureOwner` writes nothing)
 * and no proposal is ever made.
 *
 * @param employee - The employee's name.
 */
export function proposedInMock(employee: string): string {
  return `${employee} proposes people from the one-to-one and your documentation in a deployment of your own. This demo keeps the names the one-to-one gave the charter, below.`;
}

/**
 * What follows a person's name on the card: their role, where a source said it ("{person},
 * {role}").
 *
 * @param role - Their title or team, when a source gave one.
 */
export function roleSuffix(role: string | undefined): string {
  return role === undefined || role.trim() === '' ? '' : `, ${role.trim()}`;
}

/**
 * One piece of evidence as the card says it.
 *
 * @param quote - The words.
 * @param where - Where they were said.
 * @param when - When, as the page writes a time.
 */
export function evidenceLine(quote: string, where: string, when: string): string {
  return `Evidence: “${quote}” (${where}, ${when}).`;
}

/**
 * The line under a proposal a lookup matched to a Slack user.
 *
 * @param handle - The Slack user's name.
 */
export function matchesSlackLine(handle: string): string {
  return `Matches Slack user @${handle}.`;
}

/**
 * Confirm's label on a matched proposal.
 *
 * @param handle - The Slack user's name.
 */
export function confirmAsLabel(handle: string): string {
  return `Confirm as @${handle}`;
}

/**
 * The line under a proposal whose name alone matched someone already in the graph (C5).
 *
 * @param existing - The name of the person it may be.
 */
export function possiblySameLine(existing: string): string {
  return `Possibly the same as ${existing}.`;
}

/**
 * The aside's words under "What {name} reads from this" (F9, the prototype's words): what the
 * People block of the planner's and executor's prompts carries (the joins unit's, after 13-P and
 * 13-W land).
 */
export const READS_FROM_THIS =
  'Names and roles, at most eight lines, regenerated when the graph changes. Never identities or credentials.';

/** The People tab's line while the graph is read. */
export const READING_PEOPLE = 'Reading your people.';

/** The Confirmed card's empty line: nobody confirmed has an edge to the employee yet. */
export function confirmedEmpty(employee: string): string {
  return `No one confirmed works with ${employee} yet. The people you confirm above appear here.`;
}

/**
 * The line under a person waiting on the manager for an edge, not themselves.
 *
 * @param noun - The edge's noun ({@link RELATIONSHIP_NOUNS}).
 * @param scope - What it covers, when the source said.
 */
export function waitingLine(noun: string, scope: string | undefined): string {
  return `Waiting on you: ${noun}${scope === undefined ? '' : `, ${scope}`}.`;
}

/**
 * What a proposed person would be to the employee, under the proposal ("Collaborator: Linear
 * access and workflow.").
 *
 * @param noun - The edge's noun ({@link RELATIONSHIP_NOUNS}).
 * @param scope - What it covers, when the source said.
 */
export function proposedEdgeLine(noun: string, scope: string | undefined): string {
  const named = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;
  return scope === undefined ? `${named}.` : `${named}: ${scope.replace(/[.!?]+$/, '')}.`;
}

/**
 * When the manager confirmed a person, as the Confirmed card says it.
 *
 * @param when - The time, as the page writes one.
 */
export function confirmedByYouLine(when: string): string {
  return `Confirmed by you ${when}.`;
}

/** An identity of a person as the tab names it: the system and how it shows them. */
export function identityLabel(identity: {
  readonly provider: 'email' | 'oidc' | 'slack' | 'linear';
  readonly externalId: string;
  readonly displayName?: string;
}): string {
  switch (identity.provider) {
    case 'slack':
      return `Slack @${identity.displayName ?? identity.externalId}`;
    case 'linear':
      return `Linear ${identity.displayName ?? identity.externalId}`;
    case 'email':
      return identity.externalId;
    case 'oidc':
      return 'sign-in account';
    default: {
      const unknown: never = identity.provider;
      throw new Error(`unhandled identity provider ${String(unknown)}`);
    }
  }
}

/**
 * One edge as the Confirmed card lists it.
 *
 * @param noun - The edge's noun.
 * @param scope - What it covers.
 * @param since - When it took effect, as the page writes a time.
 * @param everyone - Whether it holds for everyone the manager manages, not this employee alone.
 */
export function edgeLine(
  noun: string,
  scope: string | undefined,
  since: string,
  everyone: boolean,
): string {
  const named = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;
  return `${named}${scope === undefined ? '' : `: ${scope}`} · since ${since}${
    everyone ? ' · for everyone you manage' : ''
  }`;
}
