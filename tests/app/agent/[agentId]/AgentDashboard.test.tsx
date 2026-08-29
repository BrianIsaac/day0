import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('convex/react', () => ({
  useQuery: (): undefined => undefined,
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

import {
  ActionPayload,
  PlanExecutionLedger,
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
