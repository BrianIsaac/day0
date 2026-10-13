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
  /** A card still undecided when its employee was handed over (W16-R1, D-5 (a)). */
  handedOver: 'closed at the handover, as it was the previous manager’s to decide',
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

/** A card's summary without the full stop or other closing mark it may end with. */
function withoutStop(summary: string): string {
  return summary.trim().replace(/[.!?]+$/u, '');
}

/** A card's summary as a sentence of its own: one closing mark, never two. */
export function sentenceOf(summary: string): string {
  return /[.!?]$/u.test(summary.trim()) ? summary.trim() : `${summary.trim()}.`;
}

/**
 * Why a run's closing phase did not author (O-3; section 7, flagged: the draft spliced the card's
 * summary into "the reorientation card about {summary}", which read wrongly for most summaries):
 * "{name} stopped before its closing steps: a reorientation card is still open ({summary}).
 * Decide it, then Retry."
 */
export function closingHeldReason(name: string, summary: string): string {
  return `${name} stopped before its closing steps: a reorientation card is still open (${withoutStop(summary)}). Decide it, then Retry.`;
}

/**
 * What a plan's card on the Work tab says while a high-risk reorientation card holds it (W-9; the
 * joins' draft, a product word flagged with RM24): the hold stops Day0's own approval only, so
 * the plan is still the manager's to approve, and the line says what Day0 will not do meanwhile.
 */
export function heldByCardWords(summary: string): string {
  return `Day0 approves nothing here on its own until you decide the reorientation card: ${withoutStop(summary)}.`;
}

/** A documentation page as a conflict's question names it: its title and its source's label. */
export interface NamedPageWords {
  readonly title: string;
  readonly source: string;
}

/** The letter each of a conflict's two pages goes by, as the typed answer names it. */
export type PageLetter = 'A' | 'B';

/**
 * One of a conflict's two pages as every place that names it says it (W16-R12): its letter, its
 * title and its source, "A, {title} ({source})". Two pages of one title in two sources are told
 * apart by the source, and two sources of one label by the letter the question gave them.
 */
export function pageWords(letter: PageLetter, page: NamedPageWords): string {
  return `${letter}, ${page.title} (${page.source})`;
}

/** The three answers a conflict's question takes, as the request and the card offer them. */
export const CONFLICT_CHOICES = ['from', 'to', 'both'] as const;

/** One answer to a conflict's question: the first page is right, the second, or both hold. */
export type ConflictChoice = (typeof CONFLICT_CHOICES)[number];

/** Surfaces named in a sentence: "Linear and Slack". */
const SURFACE_LIST = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' });

/**
 * The question a standing conflict under a drafted plan asks, in the plan's own request (RM20 (a);
 * section 7, flagged: the pages are lettered as the typed answer names them, a plan citing nothing
 * holds every step, and the held steps run on Retry after the answer): "Two pages disagree under
 * “{heading}”: A, {A} ({source}), and B, {B} ({source}). Which is right? {name} runs the other
 * steps now and holds the ones that may rely on this until you answer and Retry." Where the
 * hold's surfaces are known it names them, "holds its writes to {surfaces}", or says every write
 * where the plan declares none to tell apart (W16-R10).
 */
export function conflictQuestionText(
  name: string,
  heading: string,
  pages: readonly [NamedPageWords, NamedPageWords],
  holds?: readonly string[] | 'every',
): string {
  const [a, b] = pages;
  // What the hold withholds is every write to a surface a held step writes (W16-R10), so the
  // question names those surfaces, or says every write where the plan cannot tell them apart.
  const held =
    holds === 'every'
      ? `${name} holds every write of the plan until you answer and Retry.`
      : holds !== undefined && holds.length > 0
        ? `${name} runs the other steps now and holds its writes to ${SURFACE_LIST.format(holds)} until you answer and Retry.`
        : `${name} runs the other steps now and holds the ones that may rely on this until you answer and Retry.`;
  return `Two pages disagree under “${heading}”: ${pageWords('A', a)}, and ${pageWords('B', b)}. Which is right? ${held}`;
}

/**
 * An answer's words, as the card's buttons, the stored answer and the record say it: "A, {title}
 * ({source}) is right", so two pages of one title make two controls of two names (W16-R12).
 */
export function conflictChoiceWords(
  choice: ConflictChoice,
  pages: readonly [NamedPageWords, NamedPageWords],
): string {
  if (choice === 'both') return 'Both hold';
  return choice === 'from'
    ? `${pageWords('A', pages[0])} is right`
    : `${pageWords('B', pages[1])} is right`;
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
  /** The day Defer would revisit on; absent on a card already deferred, which offers no Defer. */
  readonly revisit?: string;
  readonly charterVersion?: string;
  /** The card holds plans or runs, which a deferred card keeps holding (A21). */
  readonly holds?: boolean;
}): string {
  const keeps =
    args.charterVersion !== undefined
      ? `Dismiss closes the card and ${args.name} keeps working under version ${args.charterVersion}.`
      : 'Dismiss closes the card and nothing changes.';
  const defers =
    args.revisit === undefined
      ? undefined
      : args.holds === true
        ? `Defer revisits on ${args.revisit} and keeps what the card holds held until then.`
        : `Defer revisits on ${args.revisit} and changes nothing.`;
  return [args.approves, defers, keeps].filter((part) => part !== undefined).join(' ');
}
