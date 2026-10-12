import type { Charter } from '../agent/charter';

/** A sentence's closing mark, in either script: a full stop, a question or exclamation mark, a colon. */
const CLOSED = /[.?!:\u2026\u3002\uff1f\uff01\uff1a]$/u;

/** What may follow a sentence's mark: a closing bracket or quote. */
const CLOSERS = /[)\]"'\u2019\u201d]+$/u;

/**
 * A question the manager answered, closed by a question mark where it was left unpunctuated, so
 * its answer is never read as part of it (W15-R39: "Which carrier handles Asia Answer: DHL").
 */
export function askedQuestion(question: string): string {
  const trimmed = question.trim();
  return trimmed === '' || CLOSED.test(trimmed.replace(CLOSERS, '')) ? trimmed : `${trimmed}?`;
}

/**
 * The questions the manager answered in the charter, as a prompt reads them.
 *
 * An answer is written into the charter by an amendment
 * (`answeredQuestions`), and every later item's scope judgement, plan and
 * executor read it here (P8-9: an answered question reached only the item it
 * was asked on).
 *
 * @param charter - The approved charter.
 * @returns The lines, or none when the manager has answered nothing yet.
 */
export function answeredQuestionLines(charter: Pick<Charter, 'answeredQuestions'>): string[] {
  const answered = charter.answeredQuestions ?? [];
  if (answered.length === 0) return [];
  return [
    'Questions the manager answered in the charter (they hold for this work):',
    ...answered.map((entry) => `  - ${askedQuestion(entry.question)} ${entry.answer}`),
  ];
}
