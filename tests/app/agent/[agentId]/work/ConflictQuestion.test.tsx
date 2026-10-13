/** @vitest-environment jsdom */

import { act, useRef } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';

const backend = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What the deployment's subscriptions draw before the mutation's promise settles. */
  beforeSettle: undefined as (() => void) | undefined,
}));

vi.mock('convex/react', () => ({
  useMutation:
    (reference: unknown) =>
    async (args: unknown): Promise<unknown> => {
      backend.calls.push({ name: getFunctionName(reference as never), args });
      backend.beforeSettle?.();
      return { text: 'B, Pipeline runbook (Handbook) is right' };
    },
  useQuery: (): unknown => undefined,
}));

import {
  ConflictQuestion,
  type ConflictQuestionRow,
} from '../../../../../app/agent/[agentId]/work/ConflictQuestion';
import { WorkItemCard } from '../../../../../app/agent/[agentId]/work/WorkItemCard';
import { AgentZoneContext } from '../../../../../app/components/time';
import { StatusRegion } from '../../../../../app/components/StatusRegion';
import { useChange } from '../../../../../app/components/use-change';
import { DRAWN, EMPLOYEE, SURFACES, ZONE } from '../../../../fixtures/work/drawn-states';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { focusedName, mount, press, said } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

/** A plan's conflict question on its Work tab card (16-O; RM20 (a), section 7). */

const QUESTION: ConflictQuestionRow = {
  _id: 'q1' as Id<'managerQuestions'>,
  workItemId: 'w1' as Id<'workItems'>,
  question:
    'Two pages disagree under “Thresholds”: A, Finance escalation (Finance wiki), and B, Pipeline runbook (Handbook). Which is right? Priya runs the other steps now and holds the ones that may rely on this until you answer and Retry.',
  pages: [
    { title: 'Finance escalation', source: 'Finance wiki' },
    { title: 'Pipeline runbook', source: 'Handbook' },
  ],
};

/** The question on a stand-in card that owns the change, as `WorkItemCard` does. */
function OnCard({ question }: { question: ConflictQuestionRow }) {
  const cardRef = useRef<HTMLElement>(null);
  const change = useChange(cardRef);
  return (
    <article ref={cardRef} tabIndex={-1} aria-label="The plan's card">
      <ConflictQuestion question={question} change={change} />
      <StatusRegion outcome={change.outcome} />
    </article>
  );
}

afterEach((): void => {
  backend.calls.length = 0;
  backend.beforeSettle = undefined;
  document.body.replaceChildren();
});

describe('the conflict question on a plan’s card', (): void => {
  it('asks it in the draft’s words with its three answers, and answers through answerConflict', async (): Promise<void> => {
    const view = mount(<OnCard question={QUESTION} />);
    expect(view.container.textContent).toContain(QUESTION.question);
    expect(
      [...view.container.querySelectorAll('button')].map((control) => control.textContent),
    ).toEqual([
      // Each page by its letter, title and source, as the question names it (W16-R12).
      'A, Finance escalation (Finance wiki) is right',
      'B, Pipeline runbook (Handbook) is right',
      'Both hold',
    ]);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    await press(view.container, 'B, Pipeline runbook (Handbook) is right');
    expect(backend.calls).toEqual([
      { name: 'managerQuestions:answerConflict', args: { questionId: 'q1', choice: 'to' } },
    ]);
    expect(said(view.container).at(-1)).toBe('Recorded: B, Pipeline runbook (Handbook) is right.');
    view.unmount();
  });

  it('offers no answer once the conflict no longer stands, and says nothing waits on it (the second pass’s m4)', async (): Promise<void> => {
    const view = mount(<OnCard question={{ ...QUESTION, pages: null }} />);
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
    expect(view.container.textContent).toContain(
      'The two pages no longer disagree as they did, so nothing waits on this question.',
    );
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    view.unmount();
  });
});

describe('the conflict question answered on its card (W16-R26, W3l)', (): void => {
  /** The plan's card with the questions its conflicts ask beside it. */
  function drawn(conflicts: readonly ConflictQuestionRow[]) {
    const nothing = async (): Promise<void> => undefined;
    return (
      <AgentZoneContext value={ZONE}>
        <WorkItemCard
          item={DRAWN.planPending}
          surfaces={SURFACES}
          autonomousActions={false}
          employeeName={EMPLOYEE}
          conflicts={conflicts}
          onApprovePlan={nothing}
          onCancelPlan={nothing}
          onRetryFailed={nothing}
          onReconcileFailed={nothing}
          onApproveActions={nothing}
          onRejectActions={nothing}
          onResendDecision={nothing}
        />
      </AgentZoneContext>
    );
  }

  it('says the answer on the card and keeps focus there once the question leaves it', async (): Promise<void> => {
    const view = mount(drawn([QUESTION]));
    // Convex draws the answered question gone before the mutation's promise settles, so the
    // section and the pressed button leave the card first.
    backend.beforeSettle = (): void => act((): void => view.root.render(drawn([])));
    await press(view.container, 'B, Pipeline runbook (Handbook) is right');
    expect(view.container.textContent).not.toContain('Two pages disagree');
    expect(said(view.container)).toContain('Recorded: B, Pipeline runbook (Handbook) is right.');
    expect(focusedName()).not.toBe('BODY');
    expect(document.activeElement?.tagName).toBe('ARTICLE');
    view.unmount();
  });
});
