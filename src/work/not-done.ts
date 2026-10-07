/**
 * What a run's own words say it did not do (the 4 October live demo, wave 12, 12-W).
 *
 * On the hosted demo two of three first ticket runs closed their ticket as done while their own
 * comment and DM said the work could not be done ("I can't find the three October deals"; "no
 * vendor-charge data"). The mock action contract decided full or partial closure from the ask
 * and the plan alone and sent the run back to `done`; a real closing phase was held to the
 * transition its plan promised. 12-W read the run's own words first; the wave's review measured
 * that reading misread plain model English both ways (W12-R1).
 *
 * Since v0.16.0 the run is asked for the fact (`./work-done.ts`, decision D-1 (b)) and this
 * reading is no longer the reader. It is kept, its list unchanged, for two things only: the
 * tripwire, which sends a close back once when a run answers `done` and these words say
 * otherwise, and output recorded before the release, which carries no answer and is read as the
 * release before read it.
 *
 * The reading is lexical, as the evidence check's is: a sentence or clause says the work was not
 * done when it says the writer could not do a step of it, that the work is unfinished or not yet
 * found, that nothing was done, or that the data it needs is not there. A finished run's careful
 * words and hand-offs ("no discrepancies found", "sign-off is pending", "pending manager
 * confirmation before committee", "I did not change any deal amount") are not read so.
 */

import { messageTexts } from './evidence-claims';
import type { MockAction } from './types';

/** A step the writer says it could not take: the verbs of finding, reaching and finishing work. */
const STEP_VERB = String.raw`(?:find|locate|identify|access|open|read|reach|reconcile|complete|finish|verify|confirm|match|obtain|get|do|work\s+out)`;

/**
 * What follows a "could not find" in a finished run's result rather than a failure: "I could not
 * find any errors", "I did not find any discrepancies" (the second pass's false positives).
 */
const CLEAN_RESULT = String.raw`(?!\s+(?:any|a\s+single)\s+(?:errors?|issues?|discrepanc\w*|mismatch\w*|problems?|differences?|duplicates?|gaps?)\b)`;

/** How a writer says it could not take a step, with or without "I" or "we" before it. */
const INABILITY = String.raw`(?:can['’]?t|cannot|could\s*n['’]?t|could\s+not|was\s*n['’]?t\s+able\s+to|was\s+not\s+able\s+to|were\s*n['’]?t\s+able\s+to|were\s+not\s+able\s+to|(?:am|was|were)\s+unable\s+to|have\s*n['’]?t\s+been\s+able\s+to|have\s+not\s+been\s+able\s+to|did\s*n['’]?t\s+manage\s+to|did\s+not\s+manage\s+to)`;

/**
 * The writer's own inability: "I can't find", "we couldn't fully reconcile", "I did not find",
 * and the same at the start of a sentence with no subject ("Could not locate the deals").
 */
const CANNOT = new RegExp(
  String.raw`(?:\b(?:i|we)\s+|^)${INABILITY}\s+(?:(?:fully|yet|actually|still)\s+)?${STEP_VERB}\b${CLEAN_RESULT}`,
  'i',
);

/**
 * "I did not find", "didn't reconcile": only the verbs of finding and finishing, since "I did not
 * open a ticket" is a rule kept, not work left undone.
 */
const DID_NOT = new RegExp(
  String.raw`(?:\b(?:i|we)\s+|^)did\s*(?:n['’]?t|\s+not)\s+(?:(?:fully|yet|actually)\s+)?(?:find|locate|identify|reconcile|complete|finish|verify|confirm|match)\b${CLEAN_RESULT}`,
  'i',
);

/** "unable to locate", "not able to find", whoever the subject is. */
const UNABLE = new RegExp(
  String.raw`\b(?:unable|not\s+able)\s+to\s+(?:(?:fully|yet)\s+)?${STEP_VERB}\b${CLEAN_RESULT}`,
  'i',
);

/** "could not be found", "can't be reconciled". */
const COULD_NOT_BE =
  /\b(?:could\s*n['’]?t|could\s+not|can['’]?t|cannot)\s+be\s+(?:found|located|identified|reconciled|completed|verified|confirmed|done|matched|finished)\b/i;

/**
 * The work as unfinished: "remains incomplete", "is not yet identified". A wait on someone else
 * after the work ("sign-off is pending", "pending your review") is a hand-off, not unfinished
 * work, so "pending" alone is not read so; nor is "not yet available" to a person.
 */
const UNFINISHED =
  /\b(?:is|are|was|were|remains?|stays?)\s+(?:still\s+)?(?:incomplete|unfinished|unresolved|unreconciled|outstanding|not\s+(?:yet\s+)?(?:done|complete|completed|finished|reconciled|identified|found|resolved))\b/i;

/** "nothing was reconciled", "nothing is done", "I did nothing". */
const NOTHING_DONE =
  /\bnothing\s+(?:is|was|has\s+been|could\s+be)\s+(?:reconciled|done|completed|found|verified|identified|matched)\b|\b(?:i|we)\s+did\s+nothing\b/i;

/**
 * The data the work needs is not there: "no vendor-charge data ... is available". A result that
 * found nothing wrong ("no duplicate records found") is not this, so only availability counts.
 */
const NO_DATA =
  /\bno\s+(?:[\w-]+\s+){0,4}(?:data|export|exports|file|files|records?|information|details|list|runbook)\b[^.;:!?]*\b(?:available|provided|attached|in\s+the\s+office)\b/i;

const NOT_DONE = [
  CANNOT,
  DID_NOT,
  UNABLE,
  COULD_NOT_BE,
  UNFINISHED,
  NOTHING_DONE,
  NO_DATA,
] as const;

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

/**
 * The states that close a ticket: those that say the work is finished, and those that close it
 * without finishing it (cancelled, a duplicate, rejected, won't fix, archived) or past finishing
 * it (released, shipped), which a run that answers its work was not all done may not land either
 * (12-D's Minor 5). One vocabulary with the list-read rules' words (W13-R42).
 */
const CLOSING_STATES: ReadonlySet<string> = new Set([
  'done',
  'complete',
  'completed',
  'closed',
  'resolved',
  'finished',
  'cancelled',
  'canceled',
  'duplicate',
  'released',
  'shipped',
  'archived',
  'rejected',
  "won't fix",
  'wont fix',
  'wontfix',
]);

/** The closing states as the planner's and the executor's list-read rules name them. */
export const CLOSING_STATES_WORDS =
  "done, cancelled, duplicate, released, shipped, archived, rejected or won't fix";

/**
 * Whether a ticket state closes the ticket: the work finished, cancelled, a duplicate, released,
 * shipped, archived, rejected or won't fix.
 *
 * @param state - A status a change sets ("done", "Done", "In Progress", "Won't Fix").
 */
export function isClosingState(state: string): boolean {
  return CLOSING_STATES.has(
    state
      .trim()
      .toLowerCase()
      .replace(/\u2019/g, "'")
      .replace(/\s+/g, ' '),
  );
}
