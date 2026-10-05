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
  return `${employee} proposes people from the one-to-one and your documentation in a deployment of your own. This demo keeps the names the one-to-one gave the charter, above.`;
}

/**
 * One proposal's line: the person and, where a source said it, their role.
 *
 * @param person - The person's name.
 * @param role - Their title or team, when a source gave one.
 */
export function proposalLine(person: string, role: string | undefined): string {
  return role === undefined || role.trim() === '' ? person : `${person}, ${role}`;
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
