/**
 * The words the manager reads about working agreements (wave 13, 13-W; the wave file's section 7,
 * drafts flagged as product calls): the promotion card on the Work tab, the Agreements card on the
 * Charter tab (A18), and a refusal. Pure, so every card says each one the same way.
 */

import type { Id } from '../../convex/_generated/dataModel';
import type {
  AgreementRefusalReason,
  AgreementSourceType,
  AgreementStatus,
} from './agreement-vocabulary';

/** A working agreement as a card reads it; the `workingAgreements` row carries these fields. */
export interface AgreementView {
  readonly _id: Id<'workingAgreements'>;
  /** The one employee it binds; absent for every employee of the owner. */
  readonly agentId?: Id<'agents'>;
  readonly statement: string;
  readonly status: AgreementStatus;
  readonly sourceType: AgreementSourceType;
  /** The corrections a promotion came from. */
  readonly correctionIds?: readonly Id<'corrections'>[];
  /** When the manager kept it; set while the check runs, before it takes effect. */
  readonly approvedAt?: number;
  readonly effectiveFrom?: number;
  readonly createdAt: number;
  readonly refusal?: {
    readonly reason: AgreementRefusalReason;
    readonly clause?: string;
  };
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

/** Where a card stands: the Work tab's promotion card, or the Charter tab's Agreements card. */
export type AgreementPlace = 'work' | 'charter';

/** The promotion card's title. */
export const PROPOSALS_TITLE = 'Proposed working agreements';

/** The promotion card once its last row is decided, while the outcome is still said. */
export const PROPOSALS_DONE = 'Nothing else waits on you here.';

/** The Agreements card while its query has not answered. */
export const AGREEMENTS_LOADING = 'Reading the working agreements.';

/** The kicker of a refused row. */
export const NOT_KEPT = 'Not kept';

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
