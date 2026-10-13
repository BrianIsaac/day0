import type { Charter } from '../agent/charter';

/**
 * A sentence's closing mark, in any script the manager may write: a full stop, a question or
 * exclamation mark, a colon, an ellipsis, the full-width forms and the Arabic question mark
 * (W16-R31: "؟" gained an ASCII "?" after it).
 */
const CLOSED = /[.?!:\u2026\u3002\uff1f\uff01\uff1a\u061f]$/u;

/** What may follow a sentence's mark: a closing bracket or quote, in any of those scripts. */
const CLOSERS = /[)\]"'\u2019\u201d\u00bb\uff09\u300d\u300f]+$/u;

/**
 * What a question was left hanging on in place of its mark: a comma, a semicolon or a dash, in
 * any of those scripts, with the space round it.
 */
const LEFT_HANGING = /[\s,;\u060c\u061b\uff0c\uff1b\u3001\u2013\u2014-]+$/u;

/**
 * A question the manager answered, closed by a question mark where it was left unpunctuated, so
 * its answer is never read as part of it (W15-R39: "Which carrier handles Asia Answer: DHL"). A
 * comma, a semicolon or a dash it was left on gives way to the mark (W16-R31: "Asia,?").
 */
export function askedQuestion(question: string): string {
  const trimmed = question.trim();
  if (trimmed === '' || CLOSED.test(trimmed.replace(CLOSERS, ''))) return trimmed;
  const closers = CLOSERS.exec(trimmed)?.[0] ?? '';
  const open = trimmed.slice(0, trimmed.length - closers.length).replace(LEFT_HANGING, '');
  return open === '' ? trimmed : `${open}${closers}?`;
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
