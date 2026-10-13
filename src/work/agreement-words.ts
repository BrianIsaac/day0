/**
 * The words the manager reads about working agreements (wave 13, 13-W; the wave file's section 7,
 * drafts flagged as product calls): the promotion card on the Work tab, the Agreements card on the
 * Charter tab (A18), and a refusal. Pure, so every card says each one the same way.
 */

import type { Id } from '../../convex/_generated/dataModel';
import {
  CHECK_STALE_MS,
  EMPLOYEES_CHECKED,
  type AgreementRefusalReason,
  type AgreementRowRefusalReason,
  type AgreementScope,
  type AgreementSourceType,
  type AgreementStatus,
} from './agreement-vocabulary';

/**
 * The one refusal of a charter's two judgements of an agreement for every employee (RM32 (a)): why
 * that judgement refused it, and the Will not do clause it quoted.
 */
export interface RefusedOnce {
  readonly reason: AgreementRefusalReason;
  readonly clause?: string;
}

/** A working agreement as a card reads it; the `workingAgreements` row carries these fields. */
export interface AgreementView {
  readonly _id: Id<'workingAgreements'>;
  /** The one employee it binds; absent for every employee of the owner. */
  readonly agentId?: Id<'agents'>;
  readonly statement: string;
  /** Which work it applies to; a keep for one employee compares it with the words (W15-R37). */
  readonly scope: AgreementScope;
  /** The surface slug of a `surface` scope, the operation of an `operation` one. */
  readonly scopeRef?: string;
  /** The person of a `person` scope. */
  readonly personId?: Id<'people'>;
  readonly status: AgreementStatus;
  readonly sourceType: AgreementSourceType;
  /** The corrections a promotion came from. */
  readonly correctionIds?: readonly Id<'corrections'>[];
  /** When the manager kept it; set while the check runs, before it takes effect. */
  readonly approvedAt?: number;
  readonly effectiveFrom?: number;
  readonly createdAt: number;
  readonly refusal?: {
    readonly reason: AgreementRowRefusalReason;
    readonly clause?: string;
    /**
     * On a hold (`unchecked-for-employee`): the owner has no more employees than the check reads,
     * so the agreement can be checked against this employee's charter now (W14-R15's lift).
     */
    readonly checkable?: boolean;
    /**
     * On a hold two judgements disagreed on (RM32 (a)): the refusal of the one judgement of the
     * employee's charter that refused the agreement, where the other allowed it. Absent on a hold
     * nothing has checked.
     */
    readonly refusedOnce?: RefusedOnce;
  };
  /**
   * An agreement for every employee whose check against this employee's amended charter could not
   * be had (RM28 (b)): when it was last checked, and whether it can be checked now (the owner has
   * no more employees than the check reads). It stays in effect meanwhile.
   */
  readonly checkOwed?: { readonly since: number; readonly checkable: boolean };
}

/** The Agreements card's title. */
export const AGREEMENTS_TITLE = 'Working agreements';

/** The Agreements card's meta line. */
export const AGREEMENTS_META = 'revise, never override the charter';

/** The Agreements card with nothing in it. */
export const AGREEMENTS_EMPTY =
  'No working agreements yet. They come from corrections you give twice, or from a note you keep when you approve a plan.';

/** The plan approval's tick. */
export const KEEP_NOTE_LABEL = 'Keep this note for later work of this kind';

/**
 * What the tick does, under it.
 *
 * @param name - The employee's name.
 */
export function keepNoteHint(name: string): string {
  return `Your answer above becomes a working agreement for ${name} once Day0 checks it against the charter; it is then on the Charter tab, where you can edit or retire it.`;
}

/**
 * The plan approval's second tick (15-FX, the person scope; wording draft): the note kept for
 * later asks from the item's requester, offered where the requester is a person the manager
 * confirmed.
 *
 * @param requester - The requester's name.
 */
export function keepNoteForRequesterLabel(requester: string): string {
  return `Keep this note for later asks from ${requester}`;
}

/**
 * What the second tick does, under it (wording draft).
 *
 * @param name - The employee's name.
 * @param requester - The requester's name.
 */
export function keepNoteForRequesterHint(name: string, requester: string): string {
  return `Your answer above becomes a working agreement for ${name} on asks from ${requester} once Day0 checks it against the charter; it is then on the Charter tab, where you can edit or retire it.`;
}

/**
 * What the plan approval says in the hosted office, where no working agreement is kept, in place
 * of the "Keep this note" tick (13-FD's R10; wording draft).
 */
export const KEEP_NOTE_IN_MOCK =
  'Your answer is for this run. In a deployment of your own, “Keep this note for later work of this kind” keeps it as a working agreement.';

/** Where a card stands: the Work tab's promotion card, or the Charter tab's Agreements card. */
export type AgreementPlace = 'work' | 'charter';

/** The promotion card's title. */
export const PROPOSALS_TITLE = 'Proposed working agreements';

/** The promotion card once its last row is decided, while the outcome is still said. */
export const PROPOSALS_DONE = 'Nothing else waits on you here.';

/**
 * The Agreements card in the hosted office, where no working agreement is kept (13-W: real mode
 * only): what a deployment of the manager's own keeps here, so a visitor learns they exist
 * (13-FD; wording draft).
 */
export const AGREEMENTS_IN_MOCK =
  'The hosted office keeps no working agreements. In a deployment of your own, a note you keep when you approve a plan becomes one here once Day0 checks it against the charter, and a correction you give twice is proposed on the Work tab for you to keep.';

/** The Agreements card while its query has not answered. */
export const AGREEMENTS_LOADING = 'Reading the working agreements.';

/** The kicker of a refused row that never took effect. */
export const NOT_KEPT = 'Not kept';

/**
 * The kicker of a refused row, by what happened to it (14-FX's M2; wording draft): "Held" for an
 * agreement for every employee held for this one, which is in effect for the others; "Ended" for
 * one that was in effect until a later charter's check refused it; "Not kept" for one that never
 * took effect.
 *
 * @param row - The refused agreement.
 */
export function refusedKicker(row: Pick<AgreementView, 'effectiveFrom' | 'refusal'>): string {
  if (row.refusal?.reason === 'unchecked-for-employee') return 'Held';
  return row.effectiveFrom === undefined ? NOT_KEPT : 'Ended';
}

/**
 * Why an agreement kept for every employee was not kept (W13-R28, moved from
 * `convex/workingAgreements.ts` for the card's row; wording draft): the owner has more employees
 * than its check reads, so it would bind an employee whose charter nobody checked it against. The
 * row is drawn on every employee's card, so it names none of them (found on the bed: "Keep it for
 * Ines alone" on a card whose proposal was Priya's).
 */
export const EVERY_EMPLOYEE_TOO_MANY = `Not in effect for every employee: Day0 checks an agreement for every employee only while you have ${EMPLOYEES_CHECKED} employees or fewer, and you had more when you kept it. You can keep it for a single employee instead.`;

/**
 * The label of the control behind {@link EVERY_EMPLOYEE_TOO_MANY}'s last sentence (W14-R15; wording
 * draft): the refused agreement kept for the card's employee alone.
 *
 * @param name - The employee whose card it is.
 */
export function keepForOneLabel(name: string): string {
  return `Keep for ${name}`;
}

/**
 * The live region once {@link keepForOneLabel} is pressed (wording draft).
 *
 * @param name - The employee whose card it is.
 */
export function keptForOneLine(name: string): string {
  return `Kept for ${name} once Day0 checks it against ${name}'s charter.`;
}

/**
 * Why an agreement for every employee does not bind one employee (W14-R15; wording draft): nothing
 * checked it against the employee's charter, which was approved while the owner had more employees
 * than the check reads, or at a time the check could not be had. It stays in effect for the
 * others, which the row says. While the owner is past the bound the row says the bound; once the
 * check can be had it says when Day0 checks it (the stalled-step sweep checks a hold within half an
 * hour, a stored plan sooner: W15-R37), and the row offers {@link CHECK_HOLD_NOW}.
 *
 * @param name - The employee's name.
 * @param checkable - Whether the owner has no more employees than the check reads.
 */
export function uncheckedForEmployee(name: string, checkable: boolean): string {
  return checkable
    ? `Not in effect for ${name} yet: Day0 has not checked it against ${name}'s charter. It checks within half an hour, or now with Check now. It stays in effect for your other employees.`
    : `Not in effect for ${name}: Day0 has not checked it against ${name}'s charter, and it checks an agreement for every employee only while you have ${EMPLOYEES_CHECKED} employees or fewer. It stays in effect for your other employees.`;
}

/** What the one refusing judgement of two found, as the clause after "One found that". */
function foundByOne(refusedOnce: RefusedOnce, name: string): string {
  switch (refusedOnce.reason) {
    case 'contradicts-will-not-do':
      return refusedOnce.clause
        ? `it contradicts “${refusedOnce.clause}”`
        : `it contradicts what ${name} will not do`;
    case 'widens-scope':
      return `it widens the work the charter gives ${name}`;
    case 'grants-permission':
      return 'it would grant a permission';
    case 'names-credential':
      return 'it names a credential';
    default: {
      const unknown: never = refusedOnce.reason;
      throw new Error(`unhandled refusal reason ${String(unknown)}`);
    }
  }
}

/**
 * Why an agreement for every employee is held for one employee whose charter Day0 judged it against
 * twice, one judgement refusing it and the other allowing it (RM32 (a); wording draft, RM24): that
 * the two disagreed, what the one found, that it stays in effect for the others, and what Check now
 * does. Such a hold is not checked again by itself, so the line promises no check within the half
 * hour: one judgement's variance held it, and a third and fourth unasked would settle it by chance.
 *
 * @param name - The employee's name.
 * @param refusedOnce - The one judgement's refusal.
 * @param checkable - Whether the owner has no more employees than the check reads.
 */
export function disputedForEmployee(
  name: string,
  refusedOnce: RefusedOnce,
  checkable: boolean,
): string {
  const next = checkable
    ? 'Check now checks it twice again: it ends for every employee only if both checks refuse it.'
    : HOLD_PAST_THE_CHECK;
  return `Not in effect for ${name}: Day0 checked it against ${name}'s charter twice and the two checks disagreed. One found that ${foundByOne(refusedOnce, name)}; the other allowed it. It stays in effect for your other employees. ${next}`;
}

/** The control on a hold that can be checked now (W14-R15's lift; wording draft). */
export const CHECK_HOLD_NOW = 'Check now';

/**
 * The live region once {@link CHECK_HOLD_NOW} is pressed (wording draft).
 *
 * @param name - The employee's name.
 */
export function checkingHoldLine(name: string): string {
  return `Day0 is checking it against ${name}'s charter.`;
}

/**
 * What Check now, or Try again, answers (W15-R37): the check runs now, or it is held until the
 * pause of the employee's work, or of the deployment's, ends.
 */
export interface RecheckOutcome {
  readonly ok: true;
  readonly when: 'now' | 'after-pause';
}

/**
 * The live region once {@link CHECK_HOLD_NOW} or Try again is pressed while the work is paused
 * (W15-R37; wording draft): the check is held, not under way, and its retries span about a quarter
 * of an hour, so after a long pause the manager presses again (the second pass).
 *
 * @param name - The employee's name.
 */
export function checkHeldForPauseLine(name: string): string {
  return `The work is paused, so the check waits: Day0 tries it against ${name}'s charter after the pause, and if the pause runs long, press Check now again then.`;
}

/**
 * The live region once Check now or Try again is answered: the line for a check under way, or, when
 * a pause holds it, {@link checkHeldForPauseLine}.
 *
 * @param outcome - What the backend answered.
 * @param underWay - The line for a check that runs now.
 * @param name - The employee's name.
 */
export function recheckLine(outcome: RecheckOutcome, underWay: string, name: string): string {
  return outcome.when === 'after-pause' ? checkHeldForPauseLine(name) : underWay;
}

/**
 * The line on an agreement for every employee whose check against the employee's amended charter
 * is owed (RM28 (b); wording draft, "Not checked since {date}; Check now"): since when, that it
 * stays in effect, and, past the employees the check reads, why nothing can check it; within the
 * bound the row offers {@link CHECK_HOLD_NOW}.
 *
 * @param name - The employee's name.
 * @param since - When it was last checked, as the page writes a time.
 * @param checkable - Whether the owner has no more employees than the check reads.
 */
export function checkOwedLine(name: string, since: string, checkable: boolean): string {
  return checkable
    ? `Not checked since ${since} against ${name}'s amended charter. It stays in effect meanwhile.`
    : `Not checked since ${since} against ${name}'s amended charter: Day0 checks an agreement for every employee only while you have ${EMPLOYEES_CHECKED} employees or fewer. It stays in effect meanwhile.`;
}

/** The refusal of a hold's check while the owner has more employees than the check reads. */
export const HOLD_PAST_THE_CHECK = `Day0 checks an agreement for every employee only while you have ${EMPLOYEES_CHECKED} employees or fewer.`;

/** A refused row whose refusal carries no reason (none is written so; the field is optional). */
export const REFUSED_WITHOUT_REASON = 'This would go beyond the charter. It was not kept.';

/** The live region once a stale check is tried again (W13-R30, wording draft). */
export const CHECKING_AGAIN = 'Day0 is checking it again.';

/** The live region once a kept agreement waiting on its check is withdrawn. */
export const WITHDRAWN = 'Withdrawn: it will not take effect.';

/** Whether the manager kept it on a card and its check against the charter has not answered yet. */
export function awaitingCheck(row: Pick<AgreementView, 'status' | 'approvedAt'>): boolean {
  return row.status === 'proposed' && row.approvedAt !== undefined;
}

/** Whether it is a proposal waiting on the manager: proposed and not yet kept. */
export function awaitingManager(row: Pick<AgreementView, 'status' | 'approvedAt'>): boolean {
  return row.status === 'proposed' && row.approvedAt === undefined;
}

/**
 * Words quoted as the end of a sentence: closed with a full stop after the quote, unless the
 * quoted words already end one.
 *
 * @param words - The words quoted.
 */
export function quotedSentence(words: string): string {
  return /[.!?]$/.test(words.trim()) ? `“${words}”` : `“${words}”.`;
}

/**
 * The promotion card's question for one proposal: the manager's own repeated words, or a
 * correction the planner applied to a second item.
 *
 * @param row - The proposal.
 * @param name - The employee's name.
 */
export function proposalQuestion(
  row: Pick<AgreementView, 'statement' | 'correctionIds'>,
  name: string,
): string {
  const lead =
    (row.correctionIds?.length ?? 0) >= 2
      ? 'You have said this twice'
      : `${name} applied this correction on a second item`;
  return `${lead}: ${quotedSentence(row.statement)} Keep it as a working agreement?`;
}

/**
 * The line of an agreement kept on a card whose check against the charter has not answered.
 *
 * @param statement - The agreement's words.
 * @param place - The card it is drawn on: the Work tab's says where it goes once it passes.
 */
export function checkingLine(statement: string, place: AgreementPlace): string {
  const then =
    place === 'work'
      ? 'once it passes it is on the Charter tab'
      : 'it takes effect once the check passes';
  return `Kept. Day0 is checking “${statement}” against the charter; ${then}.`;
}

/**
 * Whether a kept agreement's check has waited past its tries (W13-R30): its card then says the
 * check could not be had and offers Try again beside Withdraw.
 *
 * @param row - The agreement.
 * @param now - The page's clock.
 */
export function checkStale(
  row: Pick<AgreementView, 'status' | 'approvedAt'>,
  now: number,
): boolean {
  return awaitingCheck(row) && now - (row.approvedAt ?? now) > CHECK_STALE_MS;
}

/**
 * The line of a kept agreement whose check could not be had (W13-R30, wording draft).
 *
 * @param statement - The agreement's words.
 */
export function checkUnavailableLine(statement: string): string {
  return `Kept, but Day0 could not check “${statement}” against the charter yet, so it is not in effect. Try again, or withdraw it.`;
}

/**
 * Why a statement was refused, in a sentence: the clause it contradicts, quoted word for word, or
 * what it would have done; and, where the charter could settle it, the way to: on the Work tab the
 * question the card's Amend the charter answers, on the Charter tab the amendment above.
 *
 * @param refusal - The refusal.
 * @param name - The employee's name.
 * @param place - The card it is drawn on.
 */
export function refusalSentence(
  refusal: NonNullable<AgreementView['refusal']>,
  name: string,
  place: AgreementPlace,
): string {
  const amend =
    place === 'work' ? 'Amend the charter instead?' : 'To allow it, amend the charter above.';
  switch (refusal.reason) {
    case 'contradicts-will-not-do':
      return refusal.clause
        ? `This would go beyond the charter: it contradicts ${quotedSentence(refusal.clause)} ${amend}`
        : `This would go beyond the charter: it contradicts what ${name} will not do. ${amend}`;
    case 'widens-scope':
      return `This would go beyond the charter: it widens the work the charter gives ${name}. ${amend}`;
    case 'grants-permission':
      return 'This would grant a permission, which only a connection you approve can give. It was not kept.';
    case 'names-credential':
      return 'This names a credential, which a working agreement never keeps. It was not kept.';
    case 'every-employee-too-many':
      return EVERY_EMPLOYEE_TOO_MANY;
    case 'unchecked-for-employee':
      return refusal.refusedOnce
        ? disputedForEmployee(name, refusal.refusedOnce, refusal.checkable === true)
        : uncheckedForEmployee(name, refusal.checkable === true);
    default: {
      const unknown: never = refusal.reason;
      throw new Error(`unhandled refusal reason ${String(unknown)}`);
    }
  }
}

/**
 * Whether a refusal offers to amend the charter: only one the charter could settle.
 *
 * @param refusal - The refusal.
 */
export function refusalOffersAmendment(refusal: NonNullable<AgreementView['refusal']>): boolean {
  return refusal.reason === 'contradicts-will-not-do' || refusal.reason === 'widens-scope';
}

/**
 * Whom an agreement binds, as a card's meta line says it.
 *
 * @param row - The agreement.
 * @param name - The employee whose card it is.
 */
export function bindingWords(row: Pick<AgreementView, 'agentId'>, name: string): string {
  return row.agentId === undefined ? 'for every employee' : `for ${name}`;
}

/**
 * Where an agreement came from, as a card's meta line says it.
 *
 * @param source - The agreement's source.
 */
export function sourceWords(source: AgreementSourceType): string {
  switch (source) {
    case 'correction-promotion':
      return 'from your corrections';
    case 'plan-approval':
      return 'from a note you kept at a plan approval';
    case 'manager-card':
      return 'kept on this card';
    case 'reorientation':
      return 'from a reorientation';
    case 'manager-chat':
      return 'from the one-to-one';
    default: {
      const unknown: never = source;
      throw new Error(`unhandled agreement source ${String(unknown)}`);
    }
  }
}
