import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('convex/react', () => ({
  useQuery: (): undefined => undefined,
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

import {
  ActionPayload,
  DraftDetails,
  PlanExecutionLedger,
  phasedLedger,
} from '../../../../app/agent/[agentId]/AgentDashboard';

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
