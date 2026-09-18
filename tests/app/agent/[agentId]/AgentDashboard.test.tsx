import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('convex/react', () => ({
  useQuery: (): undefined => undefined,
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

import { declareUndeclaredInputs } from '../../../../src/work/skill-inputs';
import type { Doc } from '../../../../convex/_generated/dataModel';
import {
  ActionPayload,
  AmendCharterPanel,
  CharterCard,
  ConstraintList,
  DashboardHeader,
  DraftDetails,
  PendingActions,
  PlanApprovalForm,
  PlanExecutionLedger,
  RefusedClosingDetails,
  RefusedDraftDetails,
  RegisteredSkillsPanel,
  WithheldActionsDetails,
  retryVerifiesSavedDraft,
  failedItemReason,
  RepairNote,
  SessionRestoreNote,
  WorkItemCard,
  eventLabel,
  phasedLedger,
} from '../../../../app/agent/[agentId]/AgentDashboard';
import { DECISION_REQUEST_RECOVERY_MS } from '../../../../src/work/manager-channel';
import { HELD_BEFORE_AUTONOMY_NOTE, HELD_WITHHELD_TRANSITION_NOTE } from '../../../../src/work/autonomy';
import { HELD_WITHHELD_TRANSITION } from '../../../../src/surfaces/policy';
import { strikeOutcome, strikePreview } from '../../../../src/agent/charter-constraints';
import type { Charter } from '../../../../src/agent/charter';
import { strikeRefusalBody } from '../../../fixtures/charter-strike-refusal-2026-09-15';
import { slackPhaseOne } from '../../../fixtures/browser-phase-split-2026-09-16';
import {
  OPEN_QUESTIONS_2026_09_16,
  RECORDED_QUESTIONS_2026_09_16,
  SYNTHESIS_SELF_CHECK_NOTE_2026_09_16,
} from '../../../fixtures/charter-synthesis-notes-2026-09-16';

describe('live event labels', (): void => {
  it('marks a failure whose run stopped', (): void => {
    expect(
      eventLabel({ type: 'work.failed', payload: { workItemId: 'w1', stopped: true, reason: 'stopped: x' } }),
    ).toBe('work.failed · stopped');
    expect(eventLabel({ type: 'work.failed', payload: { workItemId: 'w1', reason: 'x' } })).toBe('work.failed');
  });

  it('shows every candidate slug when a charter surface match is ambiguous', (): void => {
    expect(
      eventLabel({
        type: 'surface.charter-match-ambiguous',
        payload: {
          namedSystem: 'Looker',
          class: 'analytics',
          candidateSlugs: ['looker-finance-tile', 'looker-sales-tile'],
        },
      }),
    ).toBe(
      'surface.charter-match-ambiguous: looker-finance-tile, looker-sales-tile',
    );
  });
});

describe('held action payload', (): void => {
  it('renders the verb with the arguments it reads and none of the empty flat-bag defaults', (): void => {
    const markup = renderToStaticMarkup(
      <ActionPayload
        action={{
          tool: 'mcp.call',
          args: {
            body: '',
            cells: [],
            channelSlug: '',
            status: 'open',
            surface: 'linear',
            tool: 'get_issue',
            toolArgsJson: '{"id":"REVOPS-5"}',
            tweetSlug: '',
          },
        }}
      />,
    );
    expect(markup).toContain('&quot;tool&quot;: &quot;mcp.call&quot;');
    expect(markup).toContain('&quot;surface&quot;: &quot;linear&quot;');
    expect(markup).toContain('REVOPS-5');
    expect(markup).not.toContain('channelSlug');
    expect(markup).not.toContain('&quot;status&quot;');
    expect(markup).not.toContain('cells');
  });
});

describe('a write re-authored once before the hold', (): void => {
  const reason =
    'Tool input validation failed against the probed schema: unknown argument comment for save_comment on linear; the schema accepts issueId, body';
  const first = '{"issueId":"REVOPS-7","comment":"Set to 74%."}';
  const held = {
    tool: 'mcp.call' as const,
    args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{"issueId":"REVOPS-7","body":"Set to 74%."}' },
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
    expect(markup).toContain('arguments re-authored once before the hold · this payload is the second attempt');
    expect(markup).toContain('the schema accepts issueId, body');
    expect(markup).toContain('first attempt: {&quot;issueId&quot;:&quot;REVOPS-7&quot;,&quot;comment&quot;');
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
    args: { surface: 'linear', tool: 'save_issue', toolArgsJson: '{"id":"REVOPS-5","state":"Done"}' },
  };

  it('says the move is the manager\'s call, not that the run predates the switch', (): void => {
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
    context: { touchedBy: 'plan', text: 'Refresh the Looker pipeline tile.', words: ['looker', 'pipeline', 'tile'] },
    askedAt: 1,
    workItemId: 'w1',
    charterId: 'c1',
  } as unknown as Doc<'managerQuestions'>;
  const noop = (): void => undefined;

  it('shows the question with where it came from, an answer field, the planner\'s note, and one approve button', (): void => {
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
    expect(markup).toContain('aria-label="answer to the planner');
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
        questions={[{ ...question, answer: { text: 'Priya.', answeredAt: 2, via: 'dashboard' } } as Doc<'managerQuestions'>]}
        onApprove={noop}
        onCancel={noop}
      />,
    );
    expect(answered).not.toContain('Who owns the Looker pipeline tile.');
    expect(answered).toContain('>Approve plan<');
  });
});

describe('refused closing set', (): void => {
  it('shows the refused actions, the reason and the outcomes the set claimed, and nothing when there is none', (): void => {
    const markup = renderToStaticMarkup(
      <RefusedClosingDetails
        refused={{
          actions: [
            {
              tool: 'mcp.call',
              args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{"issueId":"REVOPS-7","body":"Refreshed the tile to 74%."}' },
            },
          ],
          planStepOutcomes: [{ step: 3, status: 'satisfied', evidence: 'the audit comment in this response' }],
          draft: 'd',
          notes: '',
          reason: 'approved plan step 3 promised a Linear read, but no landed read or blocking ledger reason was recorded',
          at: 1,
        }}
      />,
    );
    expect(markup).toContain('Refused closing set · 1 action · never sent');
    expect(markup).toContain('approved plan step 3 promised a Linear read');
    expect(markup).toContain('mcp.call linear · save_comment');
    expect(markup).toContain('Refreshed the tile to 74%.');
    expect(markup).toContain('Step 3 · satisfied - the audit comment in this response');
    expect(renderToStaticMarkup(<RefusedClosingDetails refused={undefined} />)).toBe('');
  });
});

describe('actions an audit withheld', (): void => {
  it('shows each withheld action with its reason and payload, and nothing when there is none', (): void => {
    const markup = renderToStaticMarkup(
      <WithheldActionsDetails
        withheld={[
          {
            action: {
              tool: 'http.request',
              args: { surface: 'slack', method: 'POST', path: '/chat.postMessage', headersJson: '{}', body: '{"channel":"D0MANAGER","text":"REVOPS-5 audit comment posted with the three checks."}' },
            },
            reason: 'asserted a fact the ledger, the documentation and the manager\'s feedback do not carry: action 6 (http.request slack · POST /chat.postMessage) says "REVOPS-5 audit comment posted with the three checks"',
          },
        ]}
      />,
    );
    expect(markup).toContain('Withheld by the evidence check · 1 action · never sent');
    expect(markup).toContain('asserted a fact the ledger');
    expect(markup).toContain('REVOPS-5 audit comment posted with the three checks.');
    expect(renderToStaticMarkup(<WithheldActionsDetails withheld={[]} />)).toBe('');
    expect(renderToStaticMarkup(<WithheldActionsDetails withheld={undefined} />)).toBe('');
  });

  it('names a stop at the closing gate as one the prerequisites survived', (): void => {
    expect(failedItemReason({ skipReason: 'stopped: the read did not land' })).toBe(
      'stopped, nothing landed and nothing to decide: the read did not land',
    );
    expect(failedItemReason({
      skipReason: 'stopped: dependent phase omitted the approved ticket state transition without a blocked plan step',
      output: { refusedClosing: { actions: [], planStepOutcomes: [], draft: '', notes: '', reason: 'r', at: 1 } },
    })).toBe(
      'stopped at the closing gate, the prerequisites landed and Retry resumes there: dependent phase omitted the approved ticket state transition without a blocked plan step',
    );
  });
});

describe('plan execution ledger', (): void => {
  it('shows the explicit reason a promised read did not run', (): void => {
    const markup = renderToStaticMarkup(
      <PlanExecutionLedger
        outcomes={[
          {
            step: 1,
            status: 'blocked',
            evidence: 'No Linear list or get action exists in the applied ledger.',
          },
        ]}
      />,
    );
    expect(markup).toContain('Plan execution ledger');
    expect(markup).toContain('Step 1 · blocked');
    expect(markup).toContain('No Linear list or get action exists');
  });
});

describe('a run with two phases', (): void => {
  const twoPhase = {
    draft: 'Verified the tile and closed REVOPS-7.',
    notes: '',
    actions: [{ tool: 'mcp.call' as const, args: { surface: 'linear', tool: 'save_issue', toolArgsJson: '{}' } }],
    applied: [{ tool: 'mcp.call', ok: true, effect: 'save_issue on linear · Done' }],
    initial: {
      applied: [{ tool: 'mcp.call', ok: true, effect: 'browser_snapshot on looker · 74%' }],
    },
    planStepOutcomes: [{ step: 1, status: 'satisfied' as const, evidence: '74%' }],
  };

  it('labels every ledger row with the phase that applied it, and none when there was one phase', (): void => {
    expect(phasedLedger(twoPhase).map((row) => [row.phase, row.effect])).toEqual([
      ['prerequisite', 'browser_snapshot on looker · 74%'],
      ['closing', 'save_issue on linear · Done'],
    ]);
    expect(
      phasedLedger({ draft: 'd', notes: '', applied: twoPhase.applied }).map((row) => row.phase),
    ).toEqual([undefined]);
  });

  it('says the closing draft was written after the prerequisite ledger, not before anything applied', (): void => {
    const closing = renderToStaticMarkup(<DraftDetails output={twoPhase} />);
    expect(closing).toContain('written after the prerequisite actions were applied');
    expect(closing).not.toContain('written before anything was applied');
    const single = renderToStaticMarkup(
      <DraftDetails output={{ draft: 'd', notes: '', applied: twoPhase.applied }} />,
    );
    expect(single).toContain('written before anything was applied');
  });
});

describe('a browser signed in again before a row', (): void => {
  const [navigate, signIn, clickSignIn] = slackPhaseOne;
  const step = (action: typeof navigate, replayOf?: string, reason?: string) => ({
    ok: reason === undefined,
    ...(reason ? { reason } : {}),
    ...(replayOf ? { replayOf } : {}),
    action,
  });

  it('names the replayed calls and the rows they repeat', (): void => {
    const markup = renderToStaticMarkup(
      <SessionRestoreNote
        restore={{
          steps: [
            step(navigate, 'wi:run:0'),
            step(signIn, 'wi:run:1'),
            step(clickSignIn, 'wi:run:2'),
          ],
        }}
      />,
    );
    expect(markup).toContain('signed in again first: navigate, fill, click (replays of rows 0 to 2)');
    expect(markup).toContain(
      'Day0 sent the page restoration calls shown above before this row; this row&#x27;s action was not replayed.',
    );
  });

  it('says when the page was opened from the surface itself because the run never navigated', (): void => {
    const markup = renderToStaticMarkup(
      <SessionRestoreNote
        restore={{ steps: [step(navigate), step(signIn, 'wi:run:0'), step(clickSignIn, 'wi:run:1')] }}
      />,
    );
    expect(markup).toContain(
      "signed in again first: navigate, fill, click (the surface&#x27;s own page, then replays of rows 0 to 1)",
    );
  });

  it('says where a replay stopped and why', (): void => {
    const markup = renderToStaticMarkup(
      <SessionRestoreNote
        restore={{ steps: [step(navigate, 'wi:run:0'), step(signIn, 'wi:run:1', 'no grant (looker:write)')] }}
      />,
    );
    expect(markup).toContain('could not sign in again first: navigate, fill (replays of rows 0 to 1)');
    expect(markup).toContain('stopped at fill: no grant (looker:write)');
    expect(markup).toContain('this row and the rest on the surface were not sent');
    expect(markup).not.toContain('were sent again');
  });

  it('says the page was opened again, not a sign-in, when the run never signed in', (): void => {
    const markup = renderToStaticMarkup(
      <SessionRestoreNote restore={{ steps: [step(navigate, 'wi:run:0')] }} />,
    );
    expect(markup).toContain('opened the page again first: navigate (replays of row 0)');
    expect(markup).toContain('this row&#x27;s action was not replayed.');
  });

  it('stays silent on a row sent without a replay', (): void => {
    expect(renderToStaticMarkup(<SessionRestoreNote restore={undefined} />)).toBe('');
  });

  it('shows the note under the closing row that needed the page, on the item card', (): void => {
    const landed = (effect: string, key: string) => ({ tool: 'mcp.call', ok: true, effect, idempotencyKey: key });
    const row = {
      _id: 'w1',
      _creationTime: 1,
      agentId: 'a1',
      state: 'completed',
      title: 'Slack mention in #revops-asks',
      contentSummary: 'Confirm pipeline coverage.',
      sourceSystem: 'slack',
      sourceCategory: 'event-stream',
      externalId: 'x',
      observedAt: 1,
      contentRefs: [],
      output: {
        draft: 'Refreshed the tile to 74%.',
        notes: '',
        initial: { applied: [landed('browser_snapshot on looker · visible figure 68%', 'wi:run:3')] },
        applied: [
          {
            ...landed('browser_fill_form on looker · ok', 'wi:run:4'),
            sessionRestore: {
              steps: [step(navigate, 'wi:run:0'), step(signIn, 'wi:run:1'), step(clickSignIn, 'wi:run:2')],
            },
          },
          landed('browser_click on looker · ok', 'wi:run:5'),
        ],
        planStepOutcomes: [{ step: 1, status: 'satisfied', evidence: '74%' }],
      },
    } as unknown as Doc<'workItems'>;
    const markup = renderToStaticMarkup(
      <WorkItemCard
        item={row}
        surfaces={[]}
        autonomousActions={true}
        onApprovePlan={(): void => undefined}
        onCancelPlan={(): void => undefined}
        onRetryFailed={(): void => undefined}
        onReconcileFailed={async (): Promise<void> => undefined}
        onApproveActions={async (): Promise<void> => undefined}
        onRejectActions={async (): Promise<void> => undefined}
        onResendDecision={async (): Promise<void> => undefined}
      />,
    );
    expect(markup.match(/signed in again first/g)).toHaveLength(1);
    expect(markup.indexOf('browser_fill_form on looker')).toBeLessThan(markup.indexOf('signed in again first'));
    expect(markup.indexOf('signed in again first')).toBeLessThan(markup.indexOf('browser_click on looker'));
  });
});

describe('sending a finished item back', (): void => {
  const landedDm = {
    draft: 'Told the manager.',
    notes: '',
    actions: [
      {
        tool: 'http.request' as const,
        args: { surface: 'slack', method: 'POST', path: 'chat.postMessage', headersJson: '{}', body: '{}' },
      },
    ],
    applied: [
      { tool: 'http.request', ok: true, effect: 'sent the manager DM', providerId: 'dm-1', idempotencyKey: 'dm' },
    ],
  };
  const item = (state: 'completed' | 'failed'): Doc<'workItems'> =>
    ({
      _id: 'w1',
      _creationTime: 1,
      agentId: 'a1',
      state,
      title: 'Answer the ask in the thread',
      contentSummary: 'Confirm the figure.',
      sourceSystem: 'slack',
      sourceCategory: 'event-stream',
      externalId: 'x',
      observedAt: 1,
      contentRefs: [],
      output: landedDm,
    }) as unknown as Doc<'workItems'>;
  const noop = (): void => undefined;
  const resolved = async (): Promise<void> => undefined;
  const render = (row: Doc<'workItems'>): string =>
    renderToStaticMarkup(
      <WorkItemCard
        item={row}
        surfaces={[]}
        autonomousActions={false}
        onApprovePlan={noop}
        onCancelPlan={noop}
        onRetryFailed={noop}
        onReconcileFailed={resolved}
        onApproveActions={resolved}
        onRejectActions={resolved}
        onResendDecision={resolved}
      />,
    );

  it('shows what the plan declares it owes, who declared it, and when the judgement could not be reached', (): void => {
    const plan = { summary: 'Audit note.', steps: ['Check 1', 'Check 3', 'Check 2', 'Comment', 'Done'], riskNotes: '', reversibility: 'r', estimatedMinutes: 1, expectedOutputType: 'ticket-update' };
    const judged = render({
      ...item('completed'),
      plan: {
        ...plan,
        obligations: {
          steps: [
            { kind: 'write', reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'] },
            { kind: 'read', reads: ['linear'], writes: [] },
            { kind: 'report', reads: [], writes: [] },
            { kind: 'write', reads: [], writes: ['linear'] },
            { kind: 'conditional-write', reads: [], writes: ['linear'] },
          ],
          transition: 'conditional-on-manager', transitionStep: 5, basis: 'judgement',
        },
      },
    } as unknown as Doc<'workItems'>);
    expect(judged).toContain('Declared obligations');
    expect(judged).toContain('judged');
    expect(judged).toContain('ticket state moved only on your approval, held for you (step 5)');
    expect(judged).toContain('step 1 reads looker-pipeline-tile; step 2 reads linear');
    expect(judged).not.toContain('could not be reached');

    const disagreed = render({
      ...item('completed'),
      plan: { ...plan, obligations: { steps: [], transition: 'conditional-on-evidence', transitionStep: 5, basis: 'judgement', plannerTransition: 'withheld' } },
    } as unknown as Doc<'workItems'>);
    expect(disagreed).toContain('The planner declared the ticket state left where it is');
    expect(disagreed).toContain('held for you');

    const unchecked = render({
      ...item('completed'),
      plan: { ...plan, obligations: { steps: [], transition: 'withheld', transitionStep: 5, basis: 'planner', failedOpen: 'provider unavailable' } },
    } as unknown as Doc<'workItems'>);
    expect(unchecked).toContain('unchecked');
    expect(unchecked).toContain('could not be reached (provider unavailable)');

    const open = render({ ...item('completed'), plan: { ...plan, obligationsFailedOpen: 'the judgement reply did not satisfy the schema' } } as unknown as Doc<'workItems'>);
    expect(open).toContain('Obligations not settled: the judgement reply did not satisfy the schema');
    expect(open).toContain('verify no read or ticket state change for this plan');

    const mock = render({ ...item('completed'), plan } as unknown as Doc<'workItems'>);
    expect(mock).not.toContain('Declared obligations');
    expect(mock).not.toContain('Obligations not settled');
  });

  it('shows what the manager answered at approval once the plan is running', (): void => {
    const row = {
      ...item('completed'),
      plan: { summary: 'Refresh the tile.', steps: ['Refresh'], riskNotes: '', reversibility: 'r', estimatedMinutes: 1, expectedOutputType: 'ticket-update' },
      managerAnswers: [{ question: 'Who owns the Looker pipeline tile.', answer: 'Priya owns it.', answeredAt: 2 }],
    } as unknown as Doc<'workItems'>;
    const markup = render(row);
    expect(markup).toContain('Answered at approval');
    expect(markup).toContain('Who owns the Looker pipeline tile.');
    expect(markup).toContain('Priya owns it.');
    expect(render(item('completed'))).not.toContain('Answered at approval');
  });

  it('shows a landed row that was re-authored before the hold with its first attempt', (): void => {
    const row = item('completed');
    const markup = render({
      ...row,
      output: {
        ...landedDm,
        applied: [
          {
            ...landedDm.applied[0]!,
            repair: { reason: 'unknown argument comment for save_comment on linear', toolArgsJson: '{"comment":"x"}' },
          },
        ],
      },
    } as unknown as Doc<'workItems'>);
    expect(markup).toContain('arguments re-authored once before the hold');
    expect(markup).toContain('unknown argument comment for save_comment on linear');
    expect(markup).toContain('first attempt: {&quot;comment&quot;:&quot;x&quot;}');
    expect(render(row)).not.toContain('re-authored');
  });

  it('distinguishes degraded provider evidence in both successful and failed runs', () => {
    for (const state of ['completed', 'failed'] as const) {
      const row = item(state);
      const markup = render({ ...row, output: { ...landedDm, applied: [{
        ...landedDm.applied[0], ok: state === 'completed', redaction: 'structural-only',
      }] } });
      expect(markup).toContain('Limited redaction');
      expect(markup).toContain('may still contain secrets or personal data');
      expect(render(row)).not.toContain('Limited redaction');
    }
  });

  it('offers a finished item the note and Retry only, keeping the reconciliation checklist for a note in progress', (): void => {
    const markup = render(item('completed'));
    expect(markup).toContain('note for the retry');
    expect(markup).toContain('Retry with a note sends this finished work back');
    expect(markup).not.toContain('Provider reconciliation required');
    expect(markup).not.toContain('Retry remains disabled until provider reconciliation is recorded');
  });

  it('still asks a failed run with a landed write to reconcile before Retry', (): void => {
    const markup = render(item('failed'));
    expect(markup).toContain('Provider reconciliation required');
    expect(markup).toContain('Retry remains disabled until provider reconciliation is recorded');
  });
});

describe('header state pill', (): void => {
  const agent = {
    _id: 'agent-1',
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Day0',
    state: 'active',
    createdAt: 1,
  } as unknown as Doc<'agents'>;
  const charter = {
    _id: 'charter-1',
    _creationTime: 2,
    agentId: agent._id,
    version: '0.0',
    body: {},
    approved: true,
    createdAt: 2,
  } as unknown as Doc<'charters'>;

  it('names the supervised state on an active agent, not the retired posture ladder', (): void => {
    const markup = renderToStaticMarkup(<DashboardHeader agent={agent} charter={charter} />);
    expect(markup).toContain('Active · Supervised');
    expect(markup).not.toContain('cold-start');
    expect(markup).not.toContain('posture');
  });
});

describe('retrying a skipped item', (): void => {
  const skipped = (reason: string): Doc<'workItems'> =>
    ({
      _id: 'w1',
      _creationTime: 1,
      agentId: 'a1',
      state: 'skipped',
      title: 'Reconcile the partner invoice',
      contentSummary: 'A finance ask.',
      sourceSystem: 'linear',
      sourceCategory: 'ticket-queue',
      externalId: 'FIN-3',
      observedAt: 1,
      contentRefs: [],
      verdict: { decision: 'skip', reason },
      skipReason: reason,
    }) as unknown as Doc<'workItems'>;
  const noop = (): void => undefined;
  const resolved = async (): Promise<void> => undefined;
  const render = (row: Doc<'workItems'>): string =>
    renderToStaticMarkup(
      <WorkItemCard
        item={row}
        surfaces={[]}
        autonomousActions={false}
        onApprovePlan={noop}
        onCancelPlan={noop}
        onRetryFailed={noop}
        onReconcileFailed={resolved}
        onApproveActions={resolved}
        onRejectActions={resolved}
        onResendDecision={resolved}
      />,
    );

  it('shows a stopped run as stopped, with the reason and Retry', (): void => {
    const markup = render({
      ...skipped('unused'),
      state: 'failed',
      verdict: undefined,
      skipReason: 'stopped: 1 of 1 actions did not change the work environment: mcp.call (snapshot timed out)',
    } as unknown as Doc<'workItems'>);
    expect(markup).toContain('>stopped<');
    expect(markup).not.toContain('>failed<');
    expect(markup).toContain('stopped, nothing landed and nothing to decide: 1 of 1 actions did not change');
    expect(markup).toContain('Retry');
  });

  it('offers Retry on an out-of-scope skip as the manager\'s scope decision', (): void => {
    const markup = render(skipped('out-of-scope: no charter or current documented-system overlap'));
    expect(markup).toContain('Retry');
    expect(markup).toContain('Retry re-evaluates this item as in scope, on your decision');
    expect(markup).not.toContain('without the quality-fit filter');
  });

  it('keeps Retry off a skip that is neither the quality-fit filter nor the scope judgement', (): void => {
    const markup = render(skipped('already-claimed: state=executing'));
    expect(markup).not.toContain('>Retry<');
  });

  it('names the colleague who holds the item, links to their dashboard and offers no Retry', (): void => {
    const reason = 'claimed-by-colleague: Priya holds it (Slack mention in #ops-requests)';
    const markup = render({
      ...skipped(reason),
      verdict: {
        decision: 'skip',
        reason,
        claimedBy: {
          claimId: 'c1',
          agentId: 'a2',
          workItemId: 'w9',
          name: 'Priya',
          title: 'Slack mention in #ops-requests',
        },
      },
    } as unknown as Doc<'workItems'>);
    expect(markup).toMatch(/another employee holds this: <a [^>]*href="\/agent\/a2"[^>]*>Priya<\/a>/);
    expect(markup).not.toContain('claimed-by-colleague:');
    expect(markup).not.toContain('>Retry<');
  });
});

describe('phone approval delivery', (): void => {
  const parked = (decision: Record<string, unknown>): Doc<'workItems'> =>
    ({
      _id: 'w2',
      _creationTime: 1,
      agentId: 'a1',
      state: 'plan-pending',
      title: 'Close the quarter',
      contentSummary: 'Post the close summary.',
      sourceSystem: 'linear',
      sourceCategory: 'ticket',
      externalId: 'REVOPS-7',
      observedAt: 1,
      contentRefs: [],
      plan: { summary: 'Post it.', steps: ['Post.'], estimatedMinutes: 5, reversibility: 'reversible' },
      decision: {
        id: 'ab3xyz',
        kind: 'plan',
        channel: 'D0MANAGER',
        surfaceSlug: 'slack',
        surfaceName: 'Slack',
        ...decision,
      },
    }) as unknown as Doc<'workItems'>;
  const noop = (): void => undefined;
  const resolved = async (): Promise<void> => undefined;
  const render = (row: Doc<'workItems'>): string =>
    renderToStaticMarkup(
      <WorkItemCard
        item={row}
        surfaces={[]}
        autonomousActions={false}
        onApprovePlan={noop}
        onCancelPlan={noop}
        onRetryFailed={noop}
        onReconcileFailed={resolved}
        onApproveActions={resolved}
        onRejectActions={resolved}
        onResendDecision={resolved}
      />,
    );

  it('says a request the channel never confirmed was not delivered and offers a resend', (): void => {
    const stale = render(parked({ requestedAt: Date.now() - DECISION_REQUEST_RECOVERY_MS - 1 }));
    expect(stale).toContain('request not delivered');
    expect(stale).toContain('Resend');
    const failed = render(parked({ requestedAt: Date.now(), requestFailedAt: Date.now(), requestFailure: 'no grant (boss:message)' }));
    expect(failed).toContain('request not delivered');
    expect(failed).toContain('no grant (boss:message)');
    expect(failed).toContain('Resend');
  });

  it('stays quiet while a request is in flight, delivered or decided', (): void => {
    for (const decision of [
      { requestedAt: Date.now() },
      { requestedAt: Date.now() - DECISION_REQUEST_RECOVERY_MS - 1, ts: '1787768406.604379' },
      { requestedAt: 1, ts: '1.1', decidedAt: 2, outcome: 'approved', decidedVia: 'channel' },
    ]) {
      const markup = render(parked(decision));
      expect(markup).not.toContain('request not delivered');
      expect(markup).not.toContain('Resend');
    }
  });
});

describe('charter confirm-or-strike list', (): void => {
  const constraints = [
    {
      kind: 'candidate-property' as const,
      quote: "if it's a ticket it has an owner and a priority",
      wording: ['owned, prioritized'],
      origin: 'synthesis' as const,
    },
    {
      kind: 'system-boundary' as const,
      quote: 'Never post to public channels.',
      wording: ['Post to public Slack channels.'],
      origin: 'derived' as const,
      struck: true,
    },
  ];

  it('shows each rule in the manager\'s words beside the clause phrase, with Strike and Restore before approval', (): void => {
    const markup = renderToStaticMarkup(
      <ConstraintList
        constraints={constraints}
        approved={false}
        onStrike={() => undefined}
        onRestore={() => undefined}
      />,
    );
    expect(markup).toContain('Confirm or strike each one');
    expect(markup).toContain('if it&#x27;s a ticket it has an owner and a priority');
    expect(markup).toContain('owned, prioritized');
    expect(markup).toContain('what work qualifies');
    expect(markup).toContain('found by checking the clauses');
    expect(markup).toContain('>Strike<');
    expect(markup).toContain('>Restore<');
    expect(markup).toContain('line-through');
  });

  it('keeps the list as a record after approval; Strike amends, nothing restores', (): void => {
    const record = renderToStaticMarkup(<ConstraintList constraints={constraints} approved={true} />);
    expect(record).toContain('Rules this charter enforces');
    expect(record).toContain('struck');
    expect(record).not.toContain('>Strike<');
    expect(record).not.toContain('>Restore<');
    const amendable = renderToStaticMarkup(
      <ConstraintList constraints={constraints} approved={true} onStrike={() => undefined} />,
    );
    expect(amendable).toContain('>Strike<');
    expect(amendable).not.toContain('>Restore<');
  });

  it('renders nothing for a charter drafted before constraints existed', (): void => {
    expect(renderToStaticMarkup(<ConstraintList constraints={[]} approved={false} />)).toBe('');
  });

  it('names the struck count on the Approve button', (): void => {
    const charter = {
      _id: 'charter-1',
      _creationTime: 1,
      agentId: 'agent-1',
      version: '0.0',
      approved: false,
      createdAt: 1,
      body: {
        whyThisHire: 'Close week.',
        proposedFunction: 'Own routine revenue operations work from owned, prioritized Linear tickets.',
        shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
        proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
        namedCollaborators: [],
        priorityReading: [],
        openQuestions: [],
        constraints,
      },
    } as unknown as Doc<'charters'>;
    const markup = renderToStaticMarkup(<CharterCard charter={charter} />);
    expect(markup).toContain('>Approve, 1 rule struck<');
    const twoStruck = {
      ...charter,
      body: { ...charter.body, constraints: constraints.map((c) => ({ ...c, struck: true })) },
    } as unknown as Doc<'charters'>;
    expect(renderToStaticMarkup(<CharterCard charter={twoStruck} />)).toContain(
      '>Approve, 2 rules struck<',
    );
  });

  it('says what a strike removes, and disables one the effective charter refuses with the reason', (): void => {
    const markup = renderToStaticMarkup(
      <ConstraintList
        constraints={constraints}
        approved={false}
        onStrike={() => undefined}
        previewStrike={(index) =>
          index === 0
            ? {
                removedClauses: ['Handle owned, prioritized Linear tickets.'],
                rewrittenClauses: [{ from: 'Own the close checklist.', to: 'Run the close checklist.' }],
              }
            : { removedClauses: [], rewrittenClauses: [] }
        }
      />,
    );
    expect(markup).toContain('strikes the clause: “Handle owned, prioritized Linear tickets.”');
    expect(markup).toContain('rewrites the clause: “Own the close checklist.” to “Run the close checklist.”');
    expect(markup).not.toContain('disabled=""');

    const refused = renderToStaticMarkup(
      <ConstraintList
        constraints={constraints}
        approved={false}
        onStrike={() => undefined}
        previewStrike={() => ({ removedClauses: [], rewrittenClauses: [], refusal: 'strike refused: the only clause that bounds Linear' })}
      />,
    );
    expect(refused).toContain('cannot be struck: strike refused: the only clause that bounds Linear');
    expect(refused).toMatch(/<button[^>]*disabled=""[^>]*title="strike refused: the only clause that bounds Linear"[^>]*>Strike<\/button>/);

    const plain = renderToStaticMarkup(
      <ConstraintList
        constraints={constraints}
        approved={false}
        onStrike={() => undefined}
        previewStrike={() => ({ removedClauses: [], rewrittenClauses: [] })}
      />,
    );
    expect(plain).not.toContain('strikes the clause');
    expect(plain).not.toContain('cannot be struck');
  });
});

describe('the charter card and the strikes approval can honour', (): void => {
  function draft(body: Charter): Doc<'charters'> {
    return {
      _id: 'charter-3',
      _creationTime: 3,
      agentId: 'agent-1',
      version: '0.0',
      approved: false,
      createdAt: 3,
      body,
    } as unknown as Doc<'charters'>;
  }

  /** The Strike buttons in order, with whether each is disabled. */
  function strikeButtons(markup: string): boolean[] {
    return [...markup.matchAll(/<button([^>]*)>Strike<\/button>/g)].map((match) =>
      match[1]!.includes('disabled=""'),
    );
  }

  it('offers the 15 September strike as the clause it removes, and disables the one strike that was always refused', (): void => {
    const markup = renderToStaticMarkup(<CharterCard charter={draft(strikeRefusalBody(false))} />);
    expect(markup).toContain(
      'strikes the clause: “Take ownership of Northstar CRM-dependent work that Brain must handle.”',
    );
    expect(markup).toContain(
      'cannot be struck: strike or edit the whole will-not-do clause; removing only part could change its boundary',
    );
    expect(strikeButtons(markup)).toEqual([false, true, false]);
  });

  it('refuses up front the strike that would drop the only clause bounding a system', (): void => {
    const body = strikeRefusalBody(false);
    body.proposedBoundaries.willNotDo = ['Take ownership of Northstar CRM-dependent work that Brain must handle.'];
    body.proposedBoundaries.escalationTriggers = [];
    const markup = renderToStaticMarkup(<CharterCard charter={draft(body)} />);
    expect(markup).toContain(
      'cannot be struck: strike refused: “Take ownership of Northstar CRM-dependent work that Brain must handle.” is the only clause that bounds Northstar CRM',
    );
    expect(strikeButtons(markup)[2]).toBe(true);
  });

  it('enables exactly the strikes whose toggled charter approval would apply', (): void => {
    const bounded = strikeRefusalBody(false);
    bounded.proposedBoundaries.willNotDo = ['Take ownership of Northstar CRM-dependent work that Brain must handle.'];
    bounded.proposedBoundaries.escalationTriggers = [];
    for (const body of [strikeRefusalBody(false), bounded]) {
      const markup = renderToStaticMarkup(<CharterCard charter={draft(body)} />);
      const refusedAtApproval = body.constraints!.map((_, index) => {
        const toggled = {
          ...body,
          constraints: body.constraints!.map((c, i) => (i === index ? { ...c, struck: true } : c)),
        };
        return !strikeOutcome(toggled).ok;
      });
      expect(strikeButtons(markup)).toEqual(refusedAtApproval);
      body.constraints!.forEach((_, index) => {
        expect(strikePreview(body, index).refusal !== undefined).toBe(refusedAtApproval[index]);
      });
    }
  });
});

describe("the synthesiser's notes on the charter card", (): void => {
  const charter = {
    _id: 'charter-3',
    _creationTime: 3,
    agentId: 'agent-1',
    version: '0.0',
    approved: true,
    approvedAt: 3,
    createdAt: 3,
    body: {
      whyThisHire: 'Close week.',
      proposedFunction: 'Own routine revenue operations work from Linear tickets.',
      shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
      proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
      namedCollaborators: [],
      priorityReading: [],
      openQuestions: [...OPEN_QUESTIONS_2026_09_16],
      synthesisNotes: [SYNTHESIS_SELF_CHECK_NOTE_2026_09_16],
      constraints: [
        {
          kind: 'system-boundary',
          quote: 'Never post to public channels.',
          wording: ['Post to public Slack channels.'],
          origin: 'synthesis',
        },
      ],
    },
  } as unknown as Doc<'charters'>;

  it('shows each note under the rules and offers no answer box for it', (): void => {
    const markup = renderToStaticMarkup(<CharterCard charter={charter} />);
    const rules = markup.indexOf('Rules this charter enforces');
    const notes = markup.indexOf('Notes from drafting');
    expect(rules).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(rules);
    expect(markup.slice(notes)).toContain('Evidence check: 1 clause in this draft');
    const answerBoxes = markup.split('>Answer<').length - 1;
    expect(answerBoxes).toBe(OPEN_QUESTIONS_2026_09_16.length);
  });

  it('files a note an older charter recorded as a question under the notes, not the questions', (): void => {
    const legacy = {
      ...charter,
      body: { ...(charter.body as object), openQuestions: [...RECORDED_QUESTIONS_2026_09_16], synthesisNotes: undefined },
    } as unknown as Doc<'charters'>;
    const markup = renderToStaticMarkup(<CharterCard charter={legacy} />);
    expect(markup.split('>Answer<').length - 1).toBe(OPEN_QUESTIONS_2026_09_16.length);
    expect(markup.slice(markup.indexOf('Notes from drafting'))).toContain('Evidence check: 1 clause');
  });
});

describe('amending an approved charter from the card', (): void => {
  const charter = {
    _id: 'charter-2',
    _creationTime: 2,
    agentId: 'agent-1',
    version: '0.1',
    approved: true,
    approvedAt: 2,
    supersedes: 'charter-1',
    createdAt: 2,
    body: {},
  } as unknown as Doc<'charters'>;
  const body = {
    whyThisHire: 'Close week.',
    proposedFunction: 'Own routine revenue operations work from Linear tickets.',
    shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
    proposedBoundaries: {
      willDo: ['Handle Linear tickets in the Q3 close project.'],
      willNotDo: ['Post to public Slack channels.'],
      escalationTriggers: [],
    },
    namedCollaborators: [],
    namedSystems: [{ name: 'Linear', class: 'kanban', whereMentioned: 'Work is in Linear.' }],
    priorityReading: [],
    openQuestions: ['Whether Northstar CRM access will be granted.'],
    answeredQuestions: [{ question: 'Who owns the Looker tile.', answer: 'Priya.', answeredAt: 'x' }],
  };

  it('offers every typed change: the function, each clause list, the open questions, a rule and the systems', (): void => {
    const markup = renderToStaticMarkup(
      <AmendCharterPanel charter={charter} body={body} error={null} onAmend={async () => true} />,
    );
    expect(markup).toContain('next version v0.2');
    expect(markup).toContain('value="Own routine revenue operations work from Linear tickets."');
    expect(markup).toContain('value="Handle Linear tickets in the Q3 close project."');
    expect(markup).toContain('Add to escalation triggers');
    expect(markup).toContain('Whether Northstar CRM access will be granted.');
    expect(markup).toContain('>Answer<');
    expect(markup).toContain('Who owns the Looker tile.');
    expect(markup).toContain('— Priya.');
    expect(markup).toContain('>Add rule<');
    expect(markup).toContain('Linear (kanban)');
    expect(markup).toContain('>Add system<');
    expect(markup).toContain('>Remove<');
  });

  it('shows the refusal the backend returned', (): void => {
    const markup = renderToStaticMarkup(
      <AmendCharterPanel
        charter={charter}
        body={body}
        error="the amendment changes nothing"
        onAmend={async () => false}
      />,
    );
    expect(markup).toContain('the amendment changes nothing');
  });

  it('is absent from a charter awaiting approval', (): void => {
    const draft = { ...charter, approved: false, body } as unknown as Doc<'charters'>;
    const markup = renderToStaticMarkup(<CharterCard charter={draft} />);
    expect(markup).not.toContain('Amend this charter');
    expect(markup).toContain('>Approve<');
  });
});

describe('the refused skill draft', (): void => {
  it('shows the refused SKILL.md and smoke test behind a disclosure', (): void => {
    const markup = renderToStaticMarkup(
      <RefusedDraftDetails
        skill={{
          refusedBody: '# Refresh\n## Inputs\n- analytics-surface: the tile',
          refusedSmokeTest: 'def run(inputs: dict) -> dict:\n    return {}',
        }}
      />,
    );
    expect(markup).toContain('<details');
    expect(markup).toContain('Refused draft');
    expect(markup).toContain('SKILL.md');
    expect(markup).toContain('smoke.py');
    expect(markup).toContain('- analytics-surface: the tile');
    expect(markup).toContain('def run(inputs: dict) -&gt; dict:');
    expect(markup).toContain('not registered');
  });

  it('renders nothing for a row that kept no draft', (): void => {
    expect(renderToStaticMarkup(<RefusedDraftDetails skill={{}} />)).toBe('');
    expect(renderToStaticMarkup(<RefusedDraftDetails skill={{ refusedBody: '' }} />)).toBe('');
  });
});

describe('what Retry does to an unregistered skill', (): void => {
  const noop = (): void => undefined;
  const base = {
    _id: 'skill-1',
    _creationTime: 0,
    agentId: 'agent-1',
    name: 'refresh-the-tile',
    description: 'refresh the analytics tile',
    sourceType: 'agent-authored',
    createdAt: 0,
  };
  const parked = {
    ...base,
    state: 'authoring',
    body: '# Refresh the tile\n## Inputs\n- analytics-surface: the tile',
    pendingSmokeTest: 'def run(inputs: dict) -> dict:\n    return {}',
    verificationLog:
      'the verification sandbox was busy with another skill for 5 minutes; ' +
      'the body is kept and Retry runs the smoke test when it is free',
  } as unknown as Doc<'skills'>;
  const refused = {
    ...base,
    _id: 'skill-2',
    state: 'failed',
    body: '',
    verificationLog: 'the authored skill is not a reusable procedure: it repeats one item values',
  } as unknown as Doc<'skills'>;

  function panel(unregistered: Doc<'skills'>[]): string {
    return renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={unregistered}
        authoringFailure={null}
        onAuthoringAttempt={noop}
      />,
    );
  }

  it('offers a parked skill the check it is waiting for, not a new authoring call', (): void => {
    const markup = panel([parked]);
    expect(markup).toContain('title="Run the body and smoke test this skill already has');
    expect(markup).not.toContain('Author this skill again');
  });

  it('offers a refused skill a fresh authoring call', (): void => {
    const markup = panel([refused]);
    expect(markup).toContain('title="Author this skill again, with the reason it stopped');
    expect(markup).not.toContain('already has');
  });

  it('authors again for a row whose run stopped before a smoke test was saved', (): void => {
    const interrupted = { ...parked, pendingSmokeTest: undefined } as unknown as Doc<'skills'>;
    expect(panel([interrupted])).toContain('title="Author this skill again');
    expect(retryVerifiesSavedDraft(parked)).toBe(true);
    expect(retryVerifiesSavedDraft(interrupted)).toBe(false);
    expect(retryVerifiesSavedDraft(refused)).toBe(false);
  });

  it('states both cases in the help text, keeping the sandbox and one-run-at-a-time rules', (): void => {
    const markup = panel([parked, refused]);
    expect(markup).not.toContain('Retry re-authors the skill');
    expect(markup).toContain('is checked again as it stands, with no second authoring call');
    expect(markup).toContain('is authored again, with the reason fed back');
    expect(markup).toContain('pnpm sandbox:up');
    expect(markup).toContain('DAYTONA_API_KEY');
    expect(markup).toContain('Only one authoring run holds a skill at a time');
  });

  // Rehearsal 1, 0:29: a traceback's caret line has no break opportunity, so
  // the column kept its full width and pushed Retry past the card's edge.
  it('lets the text column shrink beside Retry and wraps a log with no spaces, so Retry stays in the card', (): void => {
    const carets = '^'.repeat(56);
    const traceback = {
      ...refused,
      verificationLog: `verification in the local sandbox failed - smoke test exited 1. stderr: ${carets} AssertionError`,
    } as unknown as Doc<'skills'>;
    const markup = panel([traceback]);
    expect(markup).toMatch(/<div class="flex-1 min-w-0"><div class="font-medium[^"]*">refresh-the-tile</);
    expect(markup).toMatch(new RegExp(`<div class="[^"]*\\bbreak-words\\b[^"]*">verification in the local sandbox failed[^<]*\\^{56}`));
  });

  it('says Revise is the one that always authors again', (): void => {
    const registered = { ...base, state: 'registered', body: '# Refresh' } as unknown as Doc<'skills'>;
    const markup = renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={[registered]}
        unregistered={[]}
        authoringFailure={null}
        onAuthoringAttempt={noop}
      />,
    );
    expect(markup).toContain('title="Discard this body and author the skill again');
    expect(markup).toContain('>Revise<');
  });

  // The manager approves a skill before its body exists, so the skill's own
  // row is the first place its inputs can be shown, and it has to say which of
  // them the author never declared.
  describe('the inputs a skill declares, and which of them the system declared for its author', (): void => {
    const authored = declareUndeclaredInputs(
      ['# Close', '', '## Inputs', '', '- `<record-id>`: the ticket.', '', '## Procedure', '', 'Set `<record-id>` to `<closing-state>`.'].join('\n'),
    ).body;

    it('lists them on a registered skill and marks the one Day0 added, saying so', (): void => {
      const registered = { ...base, state: 'registered', body: authored } as unknown as Doc<'skills'>;
      const markup = renderToStaticMarkup(
        <RegisteredSkillsPanel skills={[registered]} unregistered={[]} authoringFailure={null} onAuthoringAttempt={noop} />,
      );
      expect(markup).toMatch(/>inputs<\/span>[^&]*<code[^>]*>&lt;record-id&gt;<\/code>/);
      expect(markup).toMatch(/<code[^>]*>&lt;closing-state&gt;<\/code> \(added by Day0\)/);
      // A placeholder never wraps inside its own name.
      expect(markup).toMatch(/<code class="[^"]*\bwhitespace-nowrap\b[^"]*">&lt;record-id&gt;<\/code>/);
      expect(markup).toContain('The author used the input marked &quot;added by Day0&quot; without declaring it');
      expect(markup).toContain('the executor reads it from the candidate or its runbook at run time');
    });

    it('says nothing was added when the author declared everything, and nothing at all for a builtin', (): void => {
      const complete = { ...base, state: 'registered', body: '# Close\n\n## Inputs\n\n- `<record-id>`: the ticket.\n' } as unknown as Doc<'skills'>;
      const builtin = { ...complete, _id: 'skill-3', sourceType: 'builtin', body: '# See docs' } as unknown as Doc<'skills'>;
      const markup = renderToStaticMarkup(
        <RegisteredSkillsPanel skills={[complete, builtin]} unregistered={[]} authoringFailure={null} onAuthoringAttempt={noop} />,
      );
      expect(markup).toContain('&lt;record-id&gt;');
      expect(markup).not.toContain('added by Day0');
      expect(markup.match(/>inputs</g)).toHaveLength(1);
    });

    it('lists them on a failed attempt too, read from the draft the row kept', (): void => {
      const failed = { ...refused, body: '', refusedBody: authored } as unknown as Doc<'skills'>;
      expect(panel([failed])).toMatch(/<code[^>]*>&lt;closing-state&gt;<\/code> \(added by Day0\)/);
    });
  });

  // The author's open item 3: a traceback rendered as one run of text cannot be read on camera.
  describe('a verification log with line breaks', (): void => {
    const log = [
      'verification in the local sandbox (local:1f2e) failed - smoke test exited 1',
      '',
      'stderr:',
      'smoke harness: run() raised KeyError on case 2',
      '  File "authored_smoke.py", line 8, in run',
      "KeyError: 'closing-state'",
    ].join('\n');

    it('keeps its line breaks, in a box bounded in height that scrolls, still wrapping a line with no spaces', (): void => {
      const markup = panel([{ ...refused, verificationLog: log } as unknown as Doc<'skills'>]);
      const block = /<div class="([^"]*)" data-skill-log="multiline">([^<]*)<\/div>/.exec(markup);
      expect(block).not.toBeNull();
      const classes = block![1]!.split(' ');
      expect(classes).toEqual(expect.arrayContaining(['whitespace-pre-wrap', 'break-words', 'max-h-40', 'overflow-y-auto', 'font-mono']));
      expect(block![2]).toContain('failed - smoke test exited 1\n\nstderr:\nsmoke harness: run() raised KeyError on case 2\n  File');
    });

    it('leaves a one-line reason as the prose it was', (): void => {
      const markup = panel([refused]);
      expect(markup).not.toContain('data-skill-log="multiline"');
      expect(markup).toMatch(/<div class="[^"]*\bbreak-words\b[^"]*">the authored skill is not a reusable procedure/);
    });
  });
});
