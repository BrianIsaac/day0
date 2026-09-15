import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('convex/react', () => ({
  useQuery: (): undefined => undefined,
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

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
  RefusedDraftDetails,
  RepairNote,
  WorkItemCard,
  eventLabel,
  phasedLedger,
} from '../../../../app/agent/[agentId]/AgentDashboard';
import { DECISION_REQUEST_RECOVERY_MS } from '../../../../src/work/manager-channel';
import { strikeOutcome, strikePreview } from '../../../../src/agent/charter-constraints';
import type { Charter } from '../../../../src/agent/charter';
import { strikeRefusalBody } from '../../../fixtures/charter-strike-refusal-2026-09-15';
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
