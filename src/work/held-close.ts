/**
 * A close Day0 held is decided on its card (wave 12, 12-H; ruling R-12D-1, a product call built as
 * 12-D recommends). When a run answers that the work is done over its own contrary words, the
 * tripwire holds its close for the manager with the sentence on the card. The paths that approve
 * a whole held set at once (a Slack approval by the typed code, a button or the batch code, and the
 * Needs you batch) never show that sentence, so they decide every other held write and leave such
 * a close waiting on its card; Approve all on the card stays an explicit choice made beside it.
 */

import { type ActionVerdict, HELD_CLOSE_AGAINST_WORDS } from '../surfaces/policy';
import type { AppliedAction } from '../surfaces/types';

/** The key on a held set's output naming the closes an approval left for their card. */
export const LEFT_FOR_CARD_KEY = 'leftForCard';

/** What an approval of a whole held set decides: the writes it sends, and the closes it leaves. */
export interface WholeSetApproval {
  /** The held writes still waiting that the approval sends. */
  readonly approve: readonly number[];
  /** The closes the tripwire held, left waiting on their card. */
  readonly leftForCard: readonly number[];
}

/**
 * Whether a verdict is a close the tripwire held for the manager (12-D).
 *
 * @param verdict - One row's verdict, as the hold decided it.
 */
export function isCloseHeldAgainstWords(verdict: ActionVerdict | undefined): boolean {
  return verdict?.disposition === 'held' && verdict.reason === HELD_CLOSE_AGAINST_WORDS;
}

/**
 * The held rows still waiting for the manager: held at the hold and not yet settled by an apply. A
 * row an earlier approval of this set sent (or withheld) carries its ledger entry and is decided;
 * a row the auto phase or an earlier approval parked carries the `awaitingApproval` placeholder.
 *
 * @param verdicts - The set's verdicts, one per action.
 * @param applied - The set's ledger as the row carries it, aligned with its actions.
 */
export function awaitingIndexes(
  verdicts: readonly ActionVerdict[],
  applied: ReadonlyArray<AppliedAction | undefined>,
): number[] {
  return verdicts.flatMap((verdict, index) => {
    if (verdict.disposition !== 'held') return [];
    const entry = applied[index];
    return entry === undefined || entry.awaitingApproval === true ? [index] : [];
  });
}

/**
 * What an approval of the whole set from Slack or the Needs you batch decides: every held write
 * still waiting, except a close the tripwire held, which is left for its card.
 *
 * @param verdicts - The set's verdicts, one per action.
 * @param applied - The set's ledger as the row carries it, aligned with its actions.
 */
export function wholeSetApproval(
  verdicts: readonly ActionVerdict[],
  applied: ReadonlyArray<AppliedAction | undefined>,
): WholeSetApproval {
  const awaiting = awaitingIndexes(verdicts, applied);
  return {
    approve: awaiting.filter((index) => !isCloseHeldAgainstWords(verdicts[index])),
    leftForCard: awaiting.filter((index) => isCloseHeldAgainstWords(verdicts[index])),
  };
}

/**
 * The closes an approval left for their card, as a held set's output records them until its apply
 * claims them; empty when there are none or the field is not a list of indexes.
 *
 * @param output - A held set's output as the row stores it.
 */
export function leftForCardOf(output: unknown): number[] {
  if (typeof output !== 'object' || output === null) return [];
  const indexes = (output as Record<string, unknown>)[LEFT_FOR_CARD_KEY];
  if (!Array.isArray(indexes)) return [];
  return indexes.filter(
    (index): index is number => typeof index === 'number' && Number.isInteger(index) && index >= 0,
  );
}

/**
 * A held set's output without the closes an approval left for their card: what the apply carries
 * on, once its claim has read them.
 *
 * @param output - A held set's output as the row stores it.
 */
export function withoutLeftForCard(output: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(output).filter(([key]) => key !== LEFT_FOR_CARD_KEY));
}

/** The most of the run's sentence a Slack request quotes, so it stays inside one section block. */
export const QUOTED_SENTENCE_MAX_CHARS = 400;

/**
 * The run's sentence as a quotation in running text: its full stop moved outside the quotation
 * marks, a question or exclamation mark kept inside them with no full stop added, and a sentence
 * longer than `max` cut at a word with an ellipsis inside the marks.
 *
 * @param clause - The sentence the tripwire read.
 * @param max - The most characters of it quoted.
 */
export function quotedSentence(clause: string, max = QUOTED_SENTENCE_MAX_CHARS): string {
  const sentence = clause.trim().replace(/\s+/g, ' ');
  if (sentence.length > max) {
    const cut = sentence.slice(0, max);
    const atWord = cut.lastIndexOf(' ') > max / 2 ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
    return `“${atWord.replace(/[\s.,;:]+$/, '')}…”`;
  }
  return /[?!…]$/.test(sentence) ? `“${sentence}”` : `“${sentence.replace(/\.+$/, '')}”.`;
}
