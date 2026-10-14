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
  /** A charter change that would change nothing: the charter already holds it (W16-R24). */
  unchanged: 'The charter already says this. Dismiss the card.',
  /** A charter change with no approved charter to amend (W16-R24). */
  noCharter:
    'The charter is not approved yet, so this card cannot amend it: approve the charter, or dismiss the card.',
  /** An owed check's card whose agreements have all been checked since (RM34 (a)). */
  checked: 'These agreements have been checked since this card opened: dismiss it.',
  /**
   * A page's status the page already holds from its source (W17-R2, D-1 (a)): approving it would
   * change nothing but pin the page to the manager, so a later word of its source were ignored.
   */
  held: 'The page already has this status from its source, so approving would change nothing: dismiss the card.',
  /**
   * An Approve with no proposal sent as shown (O-2 (a)): a page built before 0.22.0, left open
   * across the upgrade.
   */
  reload: 'This page is from an earlier version of Day0. Reload it, then approve.',
  date: 'Pick a date after today and within a year.',
  summary: 'Say what changed in up to 300 characters.',
} as const;

/** How the outcome of a sibling card that could not be closed opens. */
const NOT_CLOSED = 'not closed: decided on ';

/**
 * Whose card decided the edge a standing card could not be closed for, or undefined for any other
 * outcome (W17-R7).
 */
export function notClosedOf(summary: string | undefined): string | undefined {
  const match = /^not closed: decided on (.+?)’s card$/u.exec(summary ?? '');
  return match === null ? undefined : match[1];
}

/**
 * What a standing card says when another employee's Approve decided its edge and it could not be
 * closed (section 7; W17-R7): "Decided on {other}'s card, but this card could not be closed:
 * dismiss it."
 */
export function notClosedWords(name: string): string {
  return `Decided on ${name}’s card, but this card could not be closed: dismiss it.`;
}

/** How the outcome of a card closed because it is no longer needed opens. */
const NO_LONGER_NEEDED = 'no longer needed: ';

/**
 * Whether a card's outcome says it closed because it is no longer needed, as a page's return
 * closes its status card (W17-R2), so the card says it closed and not that it was dismissed.
 */
export function closedAsNoLongerNeeded(summary: string | undefined): boolean {
  return summary?.startsWith(NO_LONGER_NEEDED) === true;
}

/** What Approve did, as the end of the record's sentence and the card's outcome line. */
export const approvedResultWords = {
  none: 'nothing needed to change',
  dismissed: 'nothing changed',
  /** A card still undecided when its employee was handed over (W16-R1, D-5 (a)). */
  handedOver: 'closed at the handover, as it was the previous manager’s to decide',
  /**
   * Another employee's card about an edge for everyone, closed when one card's Approve decided the
   * edge (the pre-tag's row 6): read back by {@link decidedElsewhereOf}.
   */
  decidedElsewhere: (name: string, result: string): string =>
    `decided on ${name}’s card: ${result}`,
  /**
   * A sibling card the close of an edge for everyone could not close (W17-R7): it stays standing
   * with this as its outcome, read back by {@link notClosedOf}.
   */
  notClosed: (name: string): string => `${NOT_CLOSED}${name}’s card`,
  /**
   * A page's status card closed by the page's return (W17-R2, D-1 (a)): read back by {@link
   * closedAsNoLongerNeeded}.
   */
  pageBack: (title: string): string => `${NO_LONGER_NEEDED}“${title}” is current again`,
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

/**
 * What a card the previous manager opened by hand says once a handover closed it (D-5's remainder,
 * (a); section 7): their typed words are cleared with the talk's, and the card says who opened it.
 */
export function closedByHandSummary(previousManager: string): string {
  return `A card ${previousManager} opened was closed at the handover`;
}

/**
 * What a card the previous manager opened by hand and decided says once a handover moved it
 * (W17-R4): their typed words are cleared as an undecided card's are, and the card says who
 * opened it and that it was decided before the handover; its outcome line says what was decided.
 */
export function decidedByHandSummary(previousManager: string): string {
  return `A card ${previousManager} opened and decided before the handover`;
}

/** The most cards a manager opens by hand for one employee in a day (W16-R35). */
export const BY_HAND_CARDS_A_DAY = 3;

/**
 * Why a fourth by-hand card of a day was refused (section 7): each one asks the model for a
 * proposal, and on the hosted office a visitor could open, dismiss and open again without end.
 */
export function byHandLimitWords(name: string): string {
  return `You have opened three cards for ${name} today. Decide one, or come back tomorrow.`;
}

/**
 * Why a by-hand card was refused once the day's three changes were spent on cards already decided
 * (D-6 (a); flagged with RM24: section 7 drafts the join's line, not this refusal).
 */
export function byHandChangesWords(name: string): string {
  return `You have changed ${name}’s cards three times today. Come back tomorrow.`;
}

/**
 * What the by-hand form says of a fourth change of a day joined to the standing card without a new
 * judgement (D-6 (a); section 7).
 */
export function joinedWithoutProposalWords(name: string): string {
  return `Added to the card. ${name} will not work out a new proposal for it until tomorrow: you have changed this card three times today.`;
}

/** What an owed check's card says changed (RM34 (a); section 9.1's words). */
export const CHECK_OWED_SUMMARY = 'Its agreements could not be checked against the amended charter';

/**
 * Whose card decided a card closed as decided elsewhere, and what that decision did: the parts of
 * `approvedResultWords.decidedElsewhere`, or undefined for any other outcome.
 */
export function decidedElsewhereOf(
  summary: string | undefined,
): { readonly name: string; readonly result: string } | undefined {
  const match = /^decided on (.+?)’s card: (.+)$/u.exec(summary ?? '');
  return match === null ? undefined : { name: match[1], result: match[2] };
}

/**
 * A card closed as decided elsewhere, as its line says it (section 7): "Decided on {other}'s card
 * on {date}: {outcome}. Nothing more to do here."
 */
export function decidedElsewhereWords(
  decided: { readonly name: string; readonly result: string },
  day: string,
): string {
  return `Decided on ${decided.name}’s card on ${day}: ${decided.result}. Nothing more to do here.`;
}

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

/**
 * A documentation page as a conflict's question names it: its title, its source's label and its
 * ref within the source. The ref is absent on a cite stored before v0.21.0.
 */
export interface NamedPageWords {
  readonly title: string;
  readonly source: string;
  readonly ref?: string;
}

/** The letter each of a conflict's two pages goes by, as the typed answer names it. */
export type PageLetter = 'A' | 'B';

/** A ref's folder: the ref up to its last "/", or empty for a page at its source's top. */
function folderOf(ref: string): string {
  const cut = ref.lastIndexOf('/');
  return cut > 0 ? ref.slice(0, cut) : '';
}

/**
 * Where in their one source each of two pages of one title sits, or undefined for both where the
 * title or the source already tells them apart (W17-R1, D-11 (a)): each page's folder, or, where
 * the folders do not tell them apart (one at the source's top, or both in one folder), each
 * page's whole ref. Undefined too where a page carries no ref.
 */
export function pagePlaces(
  pages: readonly [NamedPageWords, NamedPageWords],
): readonly [string | undefined, string | undefined] {
  const [a, b] = pages;
  if (a.title !== b.title || a.source !== b.source) return [undefined, undefined];
  if (a.ref === undefined || b.ref === undefined || a.ref === b.ref) return [undefined, undefined];
  const folders = [folderOf(a.ref), folderOf(b.ref)] as const;
  return folders[0] !== folders[1] && folders[0] !== '' && folders[1] !== ''
    ? folders
    : [a.ref, b.ref];
}

/**
 * One of a conflict's two pages as every place that names it says it (W16-R12): its letter, its
 * title and its source, "A, {title} ({source})". Two pages of one title in two sources are told
 * apart by the source, two of one title in one source by the place {@link pagePlaces} gives,
 * "A, {title} ({source}, {folder})" (W17-R1), and two sources of one label by the letter the
 * question gave them.
 */
export function pageWords(letter: PageLetter, page: NamedPageWords, place?: string): string {
  return `${letter}, ${page.title} (${page.source}${place === undefined ? '' : `, ${place}`})`;
}

/** A conflict's two pages as every place that names the pair says them, each by its letter. */
export function pairWords(
  pages: readonly [NamedPageWords, NamedPageWords],
): readonly [string, string] {
  const places = pagePlaces(pages);
  return [pageWords('A', pages[0], places[0]), pageWords('B', pages[1], places[1])];
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
 * where the plan declares none to tell apart (W16-R10). Beside an item that is done or whose plan
 * was turned down nothing is held, and the question says that (`nothing`; the joins' W3k: a
 * finished card went on saying the employee held its writes until the answer and a Retry).
 */
export function conflictQuestionText(
  name: string,
  heading: string,
  pages: readonly [NamedPageWords, NamedPageWords],
  holds?: readonly string[] | 'every' | 'nothing',
): string {
  // What the hold withholds is every write to a surface a held step writes (W16-R10), so the
  // question names those surfaces, or says every write where the plan cannot tell them apart.
  const held =
    holds === 'nothing'
      ? `Nothing of this item waits on the answer: other plans of ${name}’s that rest on these pages do.`
      : holds === 'every'
        ? `${name} holds every write of the plan until you answer and Retry.`
        : holds !== undefined && holds.length > 0
          ? `${name} runs the other steps now and holds its writes to ${SURFACE_LIST.format(holds)} until you answer and Retry.`
          : `${name} runs the other steps now and holds the ones that may rely on this until you answer and Retry.`;
  return `Two pages disagree under ${conflictFacts(heading, pages)} Which is right? ${held}`;
}

/** What a conflict is, as every sentence about it says it: the heading and the two lettered pages. */
function conflictFacts(heading: string, pages: readonly [NamedPageWords, NamedPageWords]): string {
  const [a, b] = pairWords(pages);
  return `“${heading}”: ${a}, and ${b}.`;
}

/**
 * The question as the thread of a plan's request asks it once the request is already out (17-C;
 * section 7): "Since I asked you about this plan, you confirmed that two pages disagree under
 * “{heading}”: A, ..., and B, .... Which is right? {name} holds {what is held} until you answer."
 * The request itself is never edited; this is posted under it, once.
 */
export function conflictNoticeText(
  name: string,
  heading: string,
  pages: readonly [NamedPageWords, NamedPageWords],
  holds?: readonly string[] | 'every',
): string {
  const held =
    holds === 'every'
      ? 'every write of the plan'
      : holds !== undefined && holds.length > 0
        ? `its writes to ${SURFACE_LIST.format(holds)}`
        : 'the steps that may rely on this';
  return `Since I asked you about this plan, you confirmed that two pages disagree under ${conflictFacts(heading, pages)} Which is right? ${name} holds ${held} until you answer.`;
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
  const [a, b] = pairWords(pages);
  return `${choice === 'from' ? a : b} is right`;
}

/**
 * How a Slack request asks for the answer: the decision's code and a letter, and between them the
 * question's number where the message asks more than one (17-C; section 7, flagged: "each by its
 * number" is added to the draft, so the one line reads as the way to answer every question above).
 */
export function conflictReplyLine(id: string, number?: number): string {
  if (number === undefined) {
    return `Answer with “answer ${id} A”, “answer ${id} B” or “answer ${id} both”.`;
  }
  const code = `${id} ${number}`;
  return `Answer each by its number: “answer ${code} A”, “answer ${code} B” or “answer ${code} both”.`;
}

/**
 * How a question posted on its own in a request's thread asks for the answer (17-C; flagged: the
 * draft of section 7 gives the request's line only): the thread's message asks one question, so
 * where the plan has several standing it says which of them this is, in the words to type.
 */
export function conflictNoticeReplyLine(id: string, number?: number): string {
  if (number === undefined) return conflictReplyLine(id);
  const code = `${id} ${number}`;
  return `This is question ${number} of the plan: answer with “answer ${code} A”, “answer ${code} B” or “answer ${code} both”.`;
}

/**
 * What is said of a question closed without an answer because its conflict stopped standing
 * (17-C; section 7): on the plan's card, and in answer to a reply that names it.
 */
export const CONFLICT_QUESTION_CLOSED =
  'These two pages no longer disagree, so this question is closed.';

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
  /**
   * The open work the change reached that the card does not hold, because a card holds at most
   * ten items (W16-R22). Absent or 0 where the card holds everything it reached.
   */
  readonly notHeld?: number;
}

/**
 * What a card holds, as its line says it: "2 plans held, 1 run held before closing", and where the
 * change reached more open work than a card holds, "10 plans held, and 90 more not held: a card
 * holds at most ten" (W16-R22; section 7).
 */
export function heldWords(held: HeldCounts): string {
  const parts = [
    held.plans > 0 ? (held.plans === 1 ? '1 plan held' : `${held.plans} plans held`) : undefined,
    held.runs > 0
      ? held.runs === 1
        ? '1 run held before closing'
        : `${held.runs} runs held before closing`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0) return 'nothing held';
  const more = held.notHeld ?? 0;
  return more > 0
    ? `${parts.join(', ')}, and ${more} more not held: a card holds at most ten`
    : parts.join(', ');
}

/**
 * What Defer says once it lands (section 7): its date, and for a card that holds plans or runs,
 * that they stay held until then (W16-R24: a deferred high-risk card keeps its hold while it is
 * out of the inbox, and Defer said only the date).
 *
 * @param revisit - The day the card opens again, as the card writes a day.
 * @param held - What the card holds when it is deferred.
 */
export function deferredWords(revisit: string, held: HeldCounts): string {
  const things = [
    held.plans > 0 ? (held.plans === 1 ? '1 plan' : `${held.plans} plans`) : undefined,
    held.runs > 0 ? (held.runs === 1 ? '1 run' : `${held.runs} runs`) : undefined,
  ].filter((part): part is string => part !== undefined);
  if (things.length === 0) return `Deferred until ${revisit}.`;
  const stay = held.plans + held.runs === 1 ? 'stays' : 'stay';
  return `Deferred until ${revisit}. Its ${things.join(' and ')} ${stay} held until then.`;
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

/** What the sweep stores on a card whose proposal stayed pending with nothing said (W16-R23). */
export const PROPOSAL_DID_NOT_FINISH = 'did not finish';

/**
 * Why a judgement could not propose, by kind (W17-R8): the model did not answer in time, its
 * answer could not be read, its provider refused the request, or something else failed. The card
 * stores the kind and says its fixed sentence; the provider's own words go to the function log
 * only, since a provider may say anything in them.
 */
export const PROPOSAL_FAILURE_KINDS = ['timeout', 'unreadable', 'refused', 'failed'] as const;

/** One of {@link PROPOSAL_FAILURE_KINDS}. */
export type ProposalFailureKind = (typeof PROPOSAL_FAILURE_KINDS)[number];

/**
 * Why a fan-out's card could not be opened, as the record says it (`reorientation.card-not-opened`;
 * W17-R8): a fixed sentence, the error's own words going to the function log only.
 */
export const CARD_NOT_OPENED_REASON = 'an error stopped it, and the function log has the details';

/** Each kind's fixed sentence, after "{name} could not work out a proposal: " (section 7). */
const FAILURE_SAID: Readonly<Partial<Record<string, string>>> = {
  timeout: 'the model did not answer in time',
  unreadable: 'the model’s answer could not be read',
  refused: 'the model’s provider refused the request',
} satisfies Partial<Record<ProposalFailureKind, string>>;

/**
 * What a card says when the judgement could not propose (section 7): the card stays, and the ways
 * on are named, Discuss first. "{name} could not work out a proposal: {the kind's sentence}.
 * Nothing changes unless you act: talk it through with {name}, dismiss the card, or amend the
 * charter yourself." A judgement that never finished says so; any other stored reason, a
 * provider's words stored before 0.22.0 among them, is said as "for this change" (W17-R8).
 *
 * @param failure - The stored kind, when there is one.
 */
export function failedProposalWords(name: string, failure?: string): string {
  return `${failureOpening(name, failure)} Nothing changes unless you act: talk it through with ${name}, dismiss the card, or amend the charter yourself.`;
}

/** That the judgement could not propose, and why, as a card's first sentence about it. */
function failureOpening(name: string, failure: string | undefined): string {
  const reason = failure?.trim().replace(/[.!?]+$/u, '');
  if (reason === PROPOSAL_DID_NOT_FINISH) return `${name} did not finish working out a proposal.`;
  const said = reason === undefined ? undefined : FAILURE_SAID[reason];
  return said === undefined
    ? `${name} could not work out a proposal for this change.`
    : `${name} could not work out a proposal: ${said}.`;
}

/**
 * What a decided card says of a proposal that never came: that none was made, or that the
 * judgement could not make one, with nothing about what the manager could still do. A dismissed
 * card went on telling its reader to dismiss it, and a card another employee's Approve closed
 * that the employee was still working one out (the bed day0-w17o, 13 October 2026).
 *
 * @param proposal - The card's proposal, still pending: when it failed and why, if it did.
 */
export function unproposedWords(
  name: string,
  proposal: { readonly failedAt?: number; readonly failure?: string },
): string {
  return proposal.failedAt !== undefined
    ? failureOpening(name, proposal.failure)
    : `${name} had proposed nothing when the card was decided.`;
}

/** Why Approve was refused for a card whose proposal changed since the page drew it (W16-R24). */
export const PROPOSAL_CHANGED =
  'The proposal changed while this card was open. Read it again, then approve.';

/**
 * A proposal as one string, the same for the same proposal whatever order its fields are stored
 * in: what the page sends back with Approve, so a talk's finish in another tab cannot put another
 * proposal under the press (W16-R24).
 */
export function proposalFingerprint(proposed: unknown): string {
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : typeof value === 'object' && value !== null
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([key, entry]) => [key, ordered(entry)]),
          )
        : value;
  return JSON.stringify(ordered(proposed));
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
