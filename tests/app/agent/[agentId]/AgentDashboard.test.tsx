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
  DashboardHeader,
  DraftDetails,
  PlanExecutionLedger,
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
