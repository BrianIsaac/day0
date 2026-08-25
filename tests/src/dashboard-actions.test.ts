import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/agent/[agentId]/ChatRoom', () => ({ ChatRoom: (): null => null }));
vi.mock('../../app/agent/[agentId]/VoiceRoom', () => ({ VoiceRoom: (): null => null }));
vi.mock('../../app/agent/[agentId]/MockEnvironment', () => ({
  MockEnvironment: (): null => null,
}));

import {
  PendingActions,
  retryRequiresReconciliation,
} from '../../app/agent/[agentId]/AgentDashboard';
import type { SurfaceRecord } from '../../src/surfaces/types';
import type { MockAction } from '../../src/work/types';

const connectedSlack: SurfaceRecord = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: Date.now(),
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  toolAllowlist: ['chat.postMessage'],
  managerDmChannelId: 'D0MANAGER',
};

function render(actions: MockAction[], surfacesReady = true): string {
  return renderToStaticMarkup(
    createElement(PendingActions, {
      actions,
      surfaces: [connectedSlack],
      surfacesReady,
      onApprove: vi.fn(async (): Promise<void> => {}),
      onReject: vi.fn(async (): Promise<void> => {}),
    }),
  );
}

describe('dashboard exact-action gate', (): void => {
  it('disables both approval controls when the skill emitted zero actions', (): void => {
    const html = render([]);
    expect(html).toContain('The skill emitted no actions');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve selected \(0\)<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve all<\/button>/);
  });

  it('shows the complete literal action and disables approve-all for a held action', (): void => {
    const longBody = 'x'.repeat(240);
    const action: MockAction = {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'POST',
        path: '/chat.postMessage',
        headersJson: '{"Authorization":"Bearer {{secret}}"}',
        body: JSON.stringify({ channel: 'C0PUBLIC', text: longBody }),
      },
    };
    const html = render([action]);
    expect(html).toContain(longBody);
    expect(html).toContain('public post · will be held for you even if approved');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve all<\/button>/);
  });

  it('keeps approval disabled until surface rules have loaded', (): void => {
    const action: MockAction = {
      tool: 'http.request',
      args: { surface: 'slack', path: '/chat.postMessage' },
    };
    const html = render([action], false);
    expect(html).toContain('Loading the surface rules before approval.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve selected \(1\)<\/button>/);
  });

  it('requires reconciliation for landed or interrupted provider effects', (): void => {
    expect(retryRequiresReconciliation([{ tool: 'mcp.call', ok: true }])).toBe(true);
    expect(
      retryRequiresReconciliation(
        [{ tool: 'mcp.call', ok: false, reason: 'unknown' }],
        'apply was interrupted; provider outcomes are unknown',
      ),
    ).toBe(true);
    expect(retryRequiresReconciliation([{ tool: 'mcp.call', ok: false }])).toBe(false);
  });
});
