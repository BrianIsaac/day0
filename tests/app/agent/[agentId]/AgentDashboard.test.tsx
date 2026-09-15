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
  PlanExecutionLedger,
  RepairNote,
  WorkItemCard,
  eventLabel,
  phasedLedger,
} from '../../../../app/agent/[agentId]/AgentDashboard';
import { DECISION_REQUEST_RECOVERY_MS } from '../../../../src/work/manager-channel';

describe('live event labels', (): void => {
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
    expect(markup).toContain('Approve without 1 struck rule');
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
