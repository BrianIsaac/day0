/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../../../../convex/_generated/dataModel';
import type { MockAction } from '../../../../../src/work/types';
import { RepairNote } from '../../../../../app/agent/[agentId]/work/RunDetails';
import {
  PendingDecisionsPanel,
  PendingActions,
  PlanApprovalForm,
  planApprovalRequest,
  typedEstimateMinutes,
} from '../../../../../app/agent/[agentId]/work/PendingActions';
import { button, mount, press, said } from '../../../../fixtures/dom/press';
import {
  HELD_BEFORE_AUTONOMY_NOTE,
  HELD_WITHHELD_TRANSITION_NOTE,
} from '../../../../../src/work/autonomy';
import { HELD_WITHHELD_TRANSITION } from '../../../../../src/surfaces/policy';

const backend = vi.hoisted(() => ({
  /** Mutations and actions that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    };
  return {
    useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
    useMutation: call,
    useAction: call,
  };
});

describe('a write re-authored once before the hold', (): void => {
  const reason =
    'Tool input validation failed against the probed schema: unknown argument comment for save_comment on linear; the schema accepts issueId, body';
  const first = '{"issueId":"REVOPS-7","comment":"Set to 74%."}';
  const held = {
    tool: 'mcp.call' as const,
    args: {
      surface: 'linear',
      tool: 'save_comment',
      toolArgsJson: '{"issueId":"REVOPS-7","body":"Set to 74%."}',
    },
  };
  const resolved = async (): Promise<void> => undefined;

  it('tells the manager the held payload is the second attempt and shows the first beside it', (): void => {
    const markup = renderToStaticMarkup(
      <PendingActions
        actions={[held]}
        verdicts={[{ disposition: 'held', reason: 'held for approval' }]}
        surfaces={[]}
        repairs={[{ index: 0, reason, toolArgsJson: first, repaired: true }]}
        onApprove={resolved}
        onReject={resolved}
      />,
    );
    expect(markup).toContain(
      'arguments re-authored once before the hold · this payload is the second attempt',
    );
    expect(markup).toContain('the schema accepts issueId, body');
    expect(markup).toContain(
      'first attempt: {&quot;issueId&quot;:&quot;REVOPS-7&quot;,&quot;comment&quot;',
    );
    expect(markup).toContain('Set to 74%.');
  });

  it('says when the one repair produced nothing and the first attempt stands, and stays silent with no repair', (): void => {
    const failed = renderToStaticMarkup(
      <RepairNote repair={{ reason, toolArgsJson: first, repaired: false }} />,
    );
    expect(failed).toContain('the one repair produced nothing usable · first attempt stands');
    expect(renderToStaticMarkup(<RepairNote repair={undefined} />)).toBe('');
    const untouched = renderToStaticMarkup(
      <PendingActions
        actions={[held]}
        verdicts={[{ disposition: 'held', reason: 'held for approval' }]}
        surfaces={[]}
        onApprove={resolved}
        onReject={resolved}
      />,
    );
    expect(untouched).not.toContain('re-authored');
  });
});

describe('a ticket state change the plan withholds', (): void => {
  const resolved = async (): Promise<void> => undefined;
  const done = {
    tool: 'mcp.call' as const,
    args: {
      surface: 'linear',
      tool: 'save_issue',
      toolArgsJson: '{"id":"REVOPS-5","state":"Done"}',
    },
  };

  it("says the move is the manager's call, not that the run predates the switch", (): void => {
    const markup = renderToStaticMarkup(
      <PendingActions
        actions={[done]}
        verdicts={[{ disposition: 'held', reason: HELD_WITHHELD_TRANSITION }]}
        surfaces={[]}
        autonomousActions
        onApprove={resolved}
        onReject={resolved}
      />,
    );
    expect(markup).toContain(HELD_WITHHELD_TRANSITION_NOTE);
    expect(markup).not.toContain(HELD_BEFORE_AUTONOMY_NOTE);
    expect(markup).toContain(HELD_WITHHELD_TRANSITION);
  });
});

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
    expect(markup).toContain('A question for you before this plan runs');
    expect(markup).toContain('Who owns the Looker pipeline tile.');
    expect(markup).toContain('from the charter · touched by the plan: looker, pipeline, tile');
    expect(markup).toContain('aria-label="answer: Who owns the Looker pipeline tile."');
    expect(markup).toContain('Planner');
    expect(markup).toContain('which figure to enter if the deck and the sheet disagree');
    expect(markup).toMatch(
      /<label for="[^"]*-note"[^>]*>Your answer to the note, for this run \(optional\)<\/label>/,
    );
    expect(markup).not.toContain('aria-label="answer to the planner');
    expect(markup).toContain('Approve plan with answers');
    expect(markup).toContain('Cancel');
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

describe('approving held actions across items at once (step 45)', (): void => {
  const action: MockAction = {
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'POST',
      path: '/chat.postMessage',
      headersJson: '{"Authorization":"Bearer {{secret}}"}',
      body: JSON.stringify({ channel: 'C0PUBLIC', text: 'Covered.' }),
    },
  };
  const member = (id: string) => ({
    workItemId: id as Id<'workItems'>,
    pendingRunId: `run-${id}` as Id<'events'>,
    title: `Answer ${id}`,
    actions: [action],
    heldIndexes: [0],
    refused: 0,
  });

  it('says what the batch came to, and keeps saying it once the panel has emptied', async (): Promise<void> => {
    const sent: unknown[] = [];
    const panel = (members: ReturnType<typeof member>[]) => (
      <PendingDecisionsPanel
        members={members}
        surfaces={[]}
        onApproveBatch={async (batch) => {
          sent.push(batch);
        }}
      />
    );
    const view = mount(panel([member('w1'), member('w2')]));
    expect(button(view.container, 'Approve 2 held actions across 2 items').className).toMatch(
      /\bmin-h-11\b/,
    );
    await press(view.container, 'Approve 2 held actions across 2 items');
    expect(sent).toHaveLength(1);
    act((): void => view.root.render(panel([])));
    expect(said(view.container)).toEqual([
      'Approved 2 held actions across 2 items: they apply now.',
    ]);
    view.unmount();
  });
});
