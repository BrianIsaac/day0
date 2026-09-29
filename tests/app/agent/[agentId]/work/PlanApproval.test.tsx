/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../../../../convex/_generated/dataModel';
import {
  PlanApprovalForm,
  planApprovalRequest,
  typedEstimateMinutes,
} from '../../../../../app/agent/[agentId]/work/PlanApproval';

describe('a question at plan approval', (): void => {
  const question = {
    _id: 'q1',
    _creationTime: 1,
    agentId: 'a1',
    key: 'who owns the looker pipeline tile',
    question: 'Who owns the Looker pipeline tile.',
    context: {
      touchedBy: 'plan',
      text: 'Refresh the Looker pipeline tile.',
      words: ['looker', 'pipeline', 'tile'],
    },
    askedAt: 1,
    workItemId: 'w1',
    charterId: 'c1',
  } as unknown as Doc<'managerQuestions'>;
  const noop = (): void => undefined;

  it("shows the question with where it came from, an answer field, the planner's note, and one approve button", (): void => {
    const markup = renderToStaticMarkup(
      <PlanApprovalForm
        riskNotes="The runbook does not say which figure to enter if the deck and the sheet disagree."
        questions={[question]}
        onApprove={noop}
        onCancel={noop}
      />,
    );
    expect(markup).toContain('A question from your charter');
    expect(markup).toContain('Who owns the Looker pipeline tile.');
    expect(markup).toContain('Asked because the plan touches it (looker, pipeline, tile).');
    expect(markup).toContain('Your answer is written into the charter with the approval');
    expect(markup).toContain('aria-label="answer: Who owns the Looker pipeline tile."');
    expect(markup).toContain('Planner');
    expect(markup).toContain('which figure to enter if the deck and the sheet disagree');
    expect(markup).toMatch(
      /<label for="[^"]+"[^>]*>Your answer to the note, for this run \(optional\)<\/label>/,
    );
    expect(markup).not.toContain('aria-label="answer to the planner');
    expect(markup).toContain('Approve plan with answers');
    expect(markup).toContain('>Cancel this item<');
    // The consequence is said under the controls: approving still holds every write.
    expect(markup).toContain(
      'Approving runs the plan. Every write it produces is still held for you.',
    );
  });

  it('keeps the plain approve button when the plan raises nothing, and skips an answered question', (): void => {
    const plain = renderToStaticMarkup(
      <PlanApprovalForm riskNotes="" questions={[]} onApprove={noop} onCancel={noop} />,
    );
    expect(plain).toContain('>Approve plan<');
    expect(plain).not.toContain('aria-label="answer');
    const answered = renderToStaticMarkup(
      <PlanApprovalForm
        riskNotes=""
        questions={[
          {
            ...question,
            answer: { text: 'Priya.', answeredAt: 2, via: 'dashboard' },
          } as Doc<'managerQuestions'>,
        ]}
        onApprove={noop}
        onCancel={noop}
      />,
    );
    expect(answered).not.toContain('Who owns the Looker pipeline tile.');
    expect(answered).toContain('>Approve plan<');
  });
});

describe("the plan card's minutes field (N11)", (): void => {
  it('asks for the manual estimate beside the approval, optional and labelled', (): void => {
    const markup = renderToStaticMarkup(
      <PlanApprovalForm
        riskNotes=""
        questions={[]}
        onApprove={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(markup).toMatch(/<label for="[^"]+">This would have taken me about<\/label>/);
    expect(markup).toContain('type="number"');
    expect(markup).toContain('>minutes</span>');
    expect(markup).toContain(
      'Optional. Summed over finished work as hours saved, a gauge for you, never a headline.',
    );
  });

  it('sends the minutes with the approval only when given, and reads the field as the server does', (): void => {
    const workItemId = 'w1' as Id<'workItems'>;
    expect(planApprovalRequest(workItemId, { answers: [], manualEstimateMinutes: 45 })).toEqual({
      workItemId,
      manualEstimateMinutes: 45,
    });
    expect(planApprovalRequest(workItemId, { answers: [] })).toEqual({ workItemId });
    expect(typedEstimateMinutes('')).toBeUndefined();
    expect(typedEstimateMinutes(' 45 ')).toBe(45);
    expect(typedEstimateMinutes('0')).toBeNull();
    expect(typedEstimateMinutes('1.5')).toBeNull();
    expect(typedEstimateMinutes('-3')).toBeNull();
  });
});
