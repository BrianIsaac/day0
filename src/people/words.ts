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

/** The refusal of Take or Dismiss on a person whose proposed change is gone (W13-R3). */
export const NO_PROPOSED_CHANGE = 'Nothing is proposed for this person any more.';

/** The refusal of Take on a proposed address another of the owner's people holds (W13-R3). */
export const PROPOSED_ADDRESS_HELD =
  'Another person on your list has this address. Dismiss the change, or merge the two people first.';

/** The refusal of a change to an edge that has ended. */
export const RELATIONSHIP_ENDED = 'This relationship has already ended.';

/** The refusal of an edit that would change what kind of relationship an edge is beyond its own. */
export const RELATIONSHIP_TYPE_FIXED = 'This relationship cannot be changed into that kind.';

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
 * and no proposal is ever made; said of "the hosted office", as every mock-mode sentence is (13-FD).
 *
 * @param employee - The employee's name.
 */
export function proposedInMock(employee: string): string {
  return `In a deployment of your own, ${employee} proposes people from the one-to-one and your documentation for you to confirm. The hosted office keeps the names the one-to-one gave the charter, below.`;
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
 * The line under a proposal whose name alone matched someone already in the graph (C5), with what
 * tells the two apart when the names are the same: the known person's role and standing.
 *
 * @param existing - The name of the person it may be.
 * @param standing - Whether that person is confirmed or itself a proposal.
 * @param role - Their role, where the graph holds one.
 */
export function possiblySameLine(
  existing: string,
  standing: 'confirmed' | 'proposed',
  role?: string,
): string {
  const who = role === undefined ? existing : `${existing}, ${role}`;
  return `Possibly the same as ${who} (${standing === 'confirmed' ? 'already confirmed' : 'also proposed'}).`;
}

/**
 * What Same person and Different do, under a name-only match.
 *
 * @param existing - The name of the person it may be.
 */
export function sameOrDifferentHelp(existing: string): string {
  return `Same person adds these words to ${existing}; Different keeps them apart.`;
}

/**
 * A quote as the card shows it: a table row's cell bars and a page's code marks left out, so the
 * words read as words.
 *
 * @param quote - The kept quote.
 */
export function evidenceText(quote: string): string {
  return quote
    .replace(/`/g, '')
    .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The disclosure over a person's further evidence.
 *
 * @param count - How many more pieces there are.
 */
export function moreEvidence(count: number): string {
  return `${count} more ${count === 1 ? 'source' : 'sources'}`;
}

/**
 * The aside's words under "What {name} reads from this" (F9, the prototype's words): what the
 * People block of the planner's and both executor phases' prompts carries (`src/people/prompt-block.ts`,
 * read from the graph at every prompt, real mode only).
 */
export const READS_FROM_THIS =
  'Names and roles, at most eight lines, regenerated when the graph changes. Never identities or credentials.';

/**
 * The aside's words in the hosted office, where no graph is kept (13-K: `ensureOwner` writes
 * nothing) and the employee reads its people only as the charter it works under names them
 * (13-FD; wording draft).
 *
 * @param employee - The employee's name.
 */
export function readsInMock(employee: string): string {
  return `The hosted office keeps no graph, so ${employee} reads the people only as its charter names them.`;
}

/** The People tab's line while the graph is read. */
export const READING_PEOPLE = 'Reading your people.';

/** The Confirmed card's empty line: nobody confirmed has an edge to the employee yet. */
export function confirmedEmpty(employee: string): string {
  return `No one confirmed works with ${employee} yet. The people you confirm appear here.`;
}

/**
 * The line under a person waiting on the manager for an edge, not themselves.
 *
 * @param noun - The edge's noun ({@link RELATIONSHIP_NOUNS}).
 * @param scope - What it covers, when the source said.
 */
export function waitingLine(noun: string, scope: string | undefined): string {
  return proposedEdgeLine(noun, scope).replace(/\.$/, ' (waiting on you).');
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
  const covered = scope?.replace(/[.!?]+$/, '');
  return `${named}${covered === undefined ? '' : `: ${covered}`} · since ${since}${
    everyone ? ' · for everyone you manage' : ''
  }`;
}

/** The values of a source's proposed change, as the confirmed person's row names them. */
export interface ProposedChangeWords {
  readonly title?: string;
  readonly team?: string;
  readonly primaryEmail?: string;
}

/**
 * The line a confirmed person's row says a source's proposed change in (W13-R3, wording draft):
 * "Team directory proposes a change: title “Head of revenue operations”, address
 * priya.shah@kestrel.test. What you confirmed stays until you take it."
 *
 * @param where - Where the words came from, as the evidence says it.
 */
export function proposedChangeLine(where: string, change: ProposedChangeWords): string {
  const parts = [
    ...(change.title === undefined ? [] : [`title \u201c${change.title}\u201d`]),
    ...(change.team === undefined ? [] : [`team \u201c${change.team}\u201d`]),
    ...(change.primaryEmail === undefined ? [] : [`address ${change.primaryEmail}`]),
  ];
  return `${where} proposes a change: ${parts.join(', ')}. What you confirmed stays until you take it.`;
}

/**
 * The line a confirmed person's row says a failed lookup in (W13-R25, wording draft).
 *
 * @param name - The person.
 * @param when - When it failed, in the employee's zone.
 */
export function lookupFailedLine(name: string, when: string): string {
  return `Looking up ${name} in Slack or Linear failed on ${when}: a message or ticket from them may not show their name yet.`;
}
