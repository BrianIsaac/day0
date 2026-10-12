/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';

const backend = vi.hoisted(() => ({ calls: [] as Array<{ name: string; args: unknown }> }));

vi.mock('convex/react', () => ({
  useMutation:
    (reference: unknown) =>
    async (args: unknown): Promise<unknown> => {
      backend.calls.push({ name: getFunctionName(reference as never), args });
      return { text: 'Pipeline runbook is right' };
    },
  useQuery: (): unknown => undefined,
}));

import {
  ConflictQuestion,
  type ConflictQuestionRow,
} from '../../../../../app/agent/[agentId]/work/ConflictQuestion';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { mount, press, said } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

/** A plan's conflict question on its Work tab card (16-O; RM20 (a), section 7). */

const QUESTION: ConflictQuestionRow = {
  _id: 'q1' as Id<'managerQuestions'>,
  workItemId: 'w1' as Id<'workItems'>,
  question:
    'Two pages disagree under “Thresholds”: Finance escalation (Finance wiki) and Pipeline runbook (Handbook). Which is right? Priya runs the other steps now and holds the ones that rely on this until you answer.',
  pages: [
    { title: 'Finance escalation', source: 'Finance wiki' },
    { title: 'Pipeline runbook', source: 'Handbook' },
  ],
};

afterEach((): void => {
  backend.calls.length = 0;
  document.body.replaceChildren();
});

describe('the conflict question on a plan’s card', (): void => {
  it('asks it in the draft’s words with its three answers, and answers through answerConflict', async (): Promise<void> => {
    const view = mount(<ConflictQuestion question={QUESTION} />);
    expect(view.container.textContent).toContain(QUESTION.question);
    expect(
      [...view.container.querySelectorAll('button')].map((control) => control.textContent),
    ).toEqual(['Finance escalation is right', 'Pipeline runbook is right', 'Both hold']);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    await press(view.container, 'Pipeline runbook is right');
    expect(backend.calls).toEqual([
      { name: 'managerQuestions:answerConflict', args: { questionId: 'q1', choice: 'to' } },
    ]);
    expect(said(view.container).at(-1)).toBe('Recorded: Pipeline runbook is right.');
    view.unmount();
  });

  it('offers no answer once the conflict was settled elsewhere, and says where', async (): Promise<void> => {
    const view = mount(<ConflictQuestion question={{ ...QUESTION, pages: null }} />);
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
    expect(view.container.textContent).toContain(
      'The two pages no longer disagree: the conflict was settled on the Documentation tab.',
    );
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    view.unmount();
  });
});
