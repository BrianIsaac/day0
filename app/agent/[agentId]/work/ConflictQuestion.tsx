'use client';

import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { conflictChoiceWords, type ConflictChoice } from '@/agent/reorientation-words';
import { Button } from '../../../components/Button';
import type { Change } from '../../../components/use-change';
import { ItemSection } from './ItemParts';

/** One conflict question waiting beside a plan, as `managerQuestions.conflictsForAgent` draws it. */
export type ConflictQuestionRow = FunctionReturnType<
  typeof api.managerQuestions.conflictsForAgent
>[number];

/**
 * The question a plan's conflict asks beside it, on the plan's card (RM20 (a); section 7): which
 * of two pages is right. The plan goes on meanwhile; the steps that rely on the passage wait for
 * the answer, which decides the relation as the Documentation tab's card would. With the conflict
 * no longer standing since (settled elsewhere, a page archived or gone), the question is read,
 * nothing waits on it, and its answers are not offered.
 *
 * The answer is said in the card's own live region and focus comes back to the card (`change`,
 * the card's): an answered question leaves the list, and its section with it (W16-R26, W3l).
 *
 * @param question - The question, with the two pages it is about.
 * @param change - The card's change, whose live region and focus outlive the question.
 */
export function ConflictQuestion({
  question,
  change,
}: {
  question: ConflictQuestionRow;
  change: Change;
}) {
  const answerConflict = useMutation(api.managerQuestions.answerConflict);
  const pages = question.pages;
  const answer = (choice: ConflictChoice): void =>
    change.run(() => answerConflict({ questionId: question._id, choice }), {
      done: (outcome) => `Recorded: ${outcome.text}.`,
      refused: 'The answer was not recorded.',
    });
  return (
    <ItemSection>
      <section aria-label="A question beside the plan" className="grid gap-2">
        <p className="text-sm text-[var(--color-fg-2)] [overflow-wrap:anywhere]">
          {question.question}
        </p>
        {pages !== null ? (
          <div className="flex flex-wrap gap-2">
            {(['from', 'to', 'both'] as const).map((choice) => (
              <Button
                key={choice}
                size="small"
                className="!whitespace-normal text-left [overflow-wrap:anywhere]"
                disabled={change.busy}
                onClick={() => answer(choice)}
              >
                {conflictChoiceWords(choice, pages)}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-[var(--color-muted)]">
            The two pages no longer disagree as they did, so nothing waits on this question.
          </p>
        )}
      </section>
    </ItemSection>
  );
}
