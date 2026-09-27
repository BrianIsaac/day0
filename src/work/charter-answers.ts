import type { Charter } from '../agent/charter';

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
    ...answered.map((entry) => `  - ${entry.question} ${entry.answer}`),
  ];
}
