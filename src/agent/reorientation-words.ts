/**
 * A reorientation card's words (wave 16, 16-O; the wave file's section 7, RM24: built as drafted):
 * what a decision did, why one was refused, and what a held plan and a held closing phase say.
 * Pure: the backend writes them on the card and the record, the page draws them.
 */

import type {
  AgreementProposalAction,
  PageStatusProposal,
  RelationshipProposalAction,
  ScopeProposalAction,
  SkillProposalAction,
} from './reorientation-vocabulary';

/** How long Defer sets a card aside unless the manager picks another date (A21: a week). */
export const DEFER_DAYS = 7;

/** Why a decision on a card was refused, in the card's words. */
export const CARD_ACTION_REFUSALS = {
  gone: 'That card is no longer stored.',
  decided: 'That card has already been decided.',
  pending: 'Nothing is proposed on this card yet: wait for the proposal, or dismiss it.',
  targetGone: 'What this card proposes to change is no longer there: dismiss it.',
  moved: 'What this card proposes to change has moved on since: dismiss it.',
  successor: 'The page this card names as the successor is not current: dismiss it.',
  date: 'Pick a date after today and within a year.',
  summary: 'Say what changed in up to 300 characters.',
} as const;

/** What Approve did, as the end of the record's sentence and the card's outcome line. */
export const approvedResultWords = {
  none: 'nothing needed to change',
  dismissed: 'nothing changed',
  charter: (version: string): string => `the charter was amended to version ${version}`,
  agreement: {
    keep: 'the working agreement was kept as it is',
    edit: 'the working agreement was changed, once its check passes',
    recheck: 'the working agreement is being checked again',
    retire: 'the working agreement was retired',
    dismiss: 'the proposed working agreement was set aside',
  } satisfies Readonly<Record<AgreementProposalAction, string>>,
  relationship: {
    edit: 'the relationship was changed',
    retire: 'the relationship was retired',
  } satisfies Readonly<Record<RelationshipProposalAction, string>>,
  page: (status: PageStatusProposal, title: string): string =>
    status === 'clear'
      ? `“${title}” follows its source’s own status again`
      : `“${title}” was marked ${status === 'active' ? 'current' : status}`,
  scope: (action: ScopeProposalAction, scope: string): string =>
    action === 'revoke' ? `access “${scope}” was revoked` : `access “${scope}” was granted`,
  skill: (action: SkillProposalAction, name: string): string =>
    action === 'recheck'
      ? `the skill “${name}” is being checked again`
      : action === 'retire'
        ? `the skill “${name}” was retired`
        : `the skill “${name}” was withdrawn from every employee`,
} as const;

/** The opening of a closing phase held by a card, so a Retry can tell it from another stop. */
const CLOSING_HELD_OPENING = 'stopped before its closing steps: the reorientation card about ';

/**
 * Why a run's closing phase did not author (O-3; section 7): "{name} stopped before its closing
 * steps: the reorientation card about {summary} is still open. Decide it, then Retry."
 */
export function closingHeldReason(name: string, summary: string): string {
  return `${name} ${CLOSING_HELD_OPENING}${summary} is still open. Decide it, then Retry.`;
}

/** Whether a run's failure is a closing phase a reorientation card held. */
export function isClosingHeld(failure: string): boolean {
  return failure.includes(CLOSING_HELD_OPENING);
}

/** What a plan a card holds says (section 7). */
export function heldPlanWords(summary: string): string {
  return `Held until you decide the reorientation card: ${summary}.`;
}

/** A documentation page as a conflict's question names it: its title and its source's label. */
export interface NamedPageWords {
  readonly title: string;
  readonly source: string;
}

/** The three answers a conflict's question takes, as the request and the card offer them. */
export const CONFLICT_CHOICES = ['from', 'to', 'both'] as const;

/** One answer to a conflict's question: the first page is right, the second, or both hold. */
export type ConflictChoice = (typeof CONFLICT_CHOICES)[number];

/**
 * The question a standing conflict under a drafted plan asks, in the plan's own request (RM20 (a);
 * section 7): "Two pages disagree under “{heading}”: {A} ({source}) and {B} ({source}). Which is
 * right? {name} runs the other steps now and holds the ones that rely on this until you answer."
 */
export function conflictQuestionText(
  name: string,
  heading: string,
  pages: readonly [NamedPageWords, NamedPageWords],
): string {
  const [a, b] = pages;
  return `Two pages disagree under “${heading}”: ${a.title} (${a.source}) and ${b.title} (${b.source}). Which is right? ${name} runs the other steps now and holds the ones that rely on this until you answer.`;
}

/** An answer's words, as the card's buttons and the record say it. */
export function conflictChoiceWords(
  choice: ConflictChoice,
  pages: readonly [NamedPageWords, NamedPageWords],
): string {
  if (choice === 'both') return 'Both hold';
  return `${(choice === 'from' ? pages[0] : pages[1]).title} is right`;
}

/** How a Slack request asks for the answer: the decision's code and a letter. */
export function conflictReplyLine(id: string): string {
  return `Answer with “answer ${id} A”, “answer ${id} B” or “answer ${id} both”.`;
}

/** A card's title (the prototype's): "Something {name}'s charter assumed has changed". */
export function cardTitle(name: string): string {
  return `Something ${name}'s charter assumed has changed`;
}

/** The day a card opens again, as its date: "3 October", in the employee's zone. */
export function revisitDay(ms: number, zone: string | undefined): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    ...(zone !== undefined ? { timeZone: zone } : {}),
  }).format(ms);
}

/**
 * What a standing card holds, as the hold stops it (the second pass's M3): plans wait at their
 * approval, and runs already going on stop before their closing steps. Nothing else is held.
 */
export interface HeldCounts {
  readonly plans: number;
  readonly runs: number;
}

/** What a card holds, as its line says it: "2 plans held, 1 run held before closing". */
export function heldWords(held: HeldCounts): string {
  const parts = [
    held.plans > 0 ? (held.plans === 1 ? '1 plan held' : `${held.plans} plans held`) : undefined,
    held.runs > 0
      ? held.runs === 1
        ? '1 run held before closing'
        : `${held.runs} runs held before closing`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'nothing held' : parts.join(', ');
}

/**
 * The card's waiting line while the judgement works (section 7): "{name} is working out what to
 * propose. Nothing is held while it does." A high-risk card holds its plans and runs meanwhile,
 * and says what of them waits (flagged: the draft's second sentence would be untrue there).
 */
export function pendingWords(name: string, held: HeldCounts): string {
  const opening = `${name} is working out what to propose.`;
  const plans = held.plans === 1 ? 'plan it holds waits' : `${held.plans} plans it holds wait`;
  const runs =
    held.runs === 1
      ? 'run it holds stops before its closing steps'
      : `${held.runs} runs it holds stop before their closing steps`;
  if (held.plans > 0 && held.runs > 0) {
    return `${opening} The ${plans}, and the ${runs}, until you decide the card.`;
  }
  if (held.plans > 0) return `${opening} The ${plans} until you decide the card.`;
  if (held.runs > 0) return `${opening} The ${runs} until you decide the card.`;
  return `${opening} Nothing is held while it does.`;
}

/** What a card says when the judgement could not propose: the card stays, and Dismiss is the way on. */
export function failedProposalWords(name: string): string {
  return `${name} could not work out a proposal for this change. Nothing changes unless you act: dismiss the card, or amend the charter yourself.`;
}

/**
 * The card's foot (the prototype's): what each decision does. "Approve writes charter version
 * 0.2. Defer revisits on 3 October and changes nothing. Dismiss closes the card and Mira keeps
 * working under version 0.1."
 */
export function decisionWords(args: {
  readonly name: string;
  readonly approves: string;
  readonly revisit: string;
  readonly charterVersion?: string;
}): string {
  const keeps =
    args.charterVersion !== undefined
      ? `Dismiss closes the card and ${args.name} keeps working under version ${args.charterVersion}.`
      : 'Dismiss closes the card and nothing changes.';
  return `${args.approves} Defer revisits on ${args.revisit} and changes nothing. ${keeps}`;
}
