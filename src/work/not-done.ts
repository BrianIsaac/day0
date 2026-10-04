/**
 * What a run's own words say it did not do (the 4 October live demo, wave 12, 12-W).
 *
 * On the hosted demo two of three first ticket runs closed their ticket as done while their own
 * comment and DM said the work could not be done ("I can't find the three October deals"; "no
 * vendor-charge data"). The mock action contract decided full or partial closure from the ask
 * and the plan alone and sent the run back to `done`; a real closing phase was held to the
 * transition its plan promised. Both now read the run's own words first: a run whose draft or
 * messages say the work was not done does not close the ticket, and its card says so.
 *
 * The reading is lexical, as the evidence check's is: a sentence or clause says the work was not
 * done when it says the writer could not do a step of it, that the work is pending, unfinished or
 * not yet found, that nothing was done, or that the data it needs is not there. A finished run's
 * careful words ("no discrepancies found", "pending manager confirmation before committee" on a
 * row left blank, "I did not change any deal amount") are not read so.
 */

import { messageTexts } from './evidence-claims';
import type { MockAction } from './types';

/** A step the writer says it could not take: the verbs of finding, reaching and finishing work. */
const STEP_VERB = String.raw`(?:find|locate|identify|access|open|read|reach|reconcile|complete|finish|verify|confirm|match|obtain|get|do|work\s+out)`;

/** The writer's own inability: "I can't find", "we couldn't fully reconcile", "I wasn't able to confirm". */
const CANNOT = new RegExp(
  String.raw`\b(?:i|we)\s+(?:can['’]?t|cannot|could\s*n['’]?t|could\s+not|was\s*n['’]?t\s+able\s+to|was\s+not\s+able\s+to|were\s*n['’]?t\s+able\s+to|were\s+not\s+able\s+to|am\s+unable\s+to|was\s+unable\s+to|were\s+unable\s+to|did\s*n['’]?t\s+manage\s+to|did\s+not\s+manage\s+to)\s+(?:(?:fully|yet|actually|still)\s+)?${STEP_VERB}\b`,
  'i',
);

/** "unable to locate", whoever the subject is. */
const UNABLE = new RegExp(String.raw`\bunable\s+to\s+(?:(?:fully|yet)\s+)?${STEP_VERB}\b`, 'i');

/** "could not be found", "can't be reconciled". */
const COULD_NOT_BE =
  /\b(?:could\s*n['’]?t|could\s+not|can['’]?t|cannot)\s+be\s+(?:found|located|identified|reconciled|completed|verified|confirmed|done|matched|finished)\b/i;

/** The work as unfinished: "is pending", "remains incomplete", "is not yet identified". */
const UNFINISHED =
  /\b(?:is|are|was|were|remains?|stays?)\s+(?:still\s+)?(?:pending|incomplete|unfinished|unresolved|unreconciled|outstanding|not\s+(?:yet\s+)?(?:done|complete|completed|finished|reconciled|identified|found|confirmed|verified|resolved|available|known))\b/i;

/** "nothing was reconciled". */
const NOTHING_DONE =
  /\bnothing\s+(?:was|has\s+been|could\s+be)\s+(?:reconciled|done|completed|found|verified|identified|matched)\b/i;

/** The data the work needs is not there: "no vendor-charge data ... is available". */
const NO_DATA =
  /\bno\s+(?:[\w-]+\s+){0,4}(?:data|export|exports|file|files|records?|information|details|list|runbook)\b[^.;:!?]*\b(?:is|are|was|were)?\s*(?:available|provided|attached|found|in\s+the\s+office)\b/i;

const NOT_DONE = [CANNOT, UNABLE, COULD_NOT_BE, UNFINISHED, NOTHING_DONE, NO_DATA] as const;

/** Where one statement ends and the next begins: a full stop, a dash of any width between clauses, a colon. */
const CLAUSE_BREAK = /(?<=[.!?])\s+|\s+[\u2014\u2013-]\s+|:\s+|;\s+|\n+/;

/**
 * The statements in a run's own words that say the work was not done, in order, each once.
 *
 * @param texts - The run's draft and the messages it wrote (`runOwnWords`).
 * @returns The clauses that say so, trimmed; empty when the words say nothing of the kind.
 */
export function notDoneStatements(texts: readonly string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const clause of text.split(CLAUSE_BREAK)) {
      const statement = clause.trim();
      if (statement === '' || found.includes(statement)) continue;
      if (NOT_DONE.some((pattern) => pattern.test(statement))) found.push(statement);
    }
  }
  return found;
}

/** What a run wrote that a reader takes as its account of the work. */
export interface RunWords {
  readonly draft?: unknown;
  readonly actions?: readonly MockAction[];
}

/**
 * A run's own words: its draft, and every comment and message it wrote, never a status or a read.
 *
 * @param output - The run's draft and actions.
 */
export function runOwnWords(output: RunWords): string[] {
  const draft =
    typeof output.draft === 'string' && output.draft.trim() !== '' ? [output.draft] : [];
  return [...draft, ...(output.actions ?? []).flatMap((action) => messageTexts(action))];
}

/** The states that say the work is finished. */
const CLOSING_STATE = /^(?:done|complete|completed|closed|resolved|finished)$/i;

/**
 * Whether a ticket state says the work is finished.
 *
 * @param state - A status a change sets ("done", "Done", "In Progress").
 */
export function isClosingState(state: string): boolean {
  return CLOSING_STATE.test(state.trim());
}
