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
import type { ActionVerdict } from '../../src/surfaces/policy';
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
  managerName: 'Brian',
};

function render(actions: MockAction[], verdicts: ActionVerdict[] = actions.map(() => ({ held: false }))): string {
  return renderToStaticMarkup(
    createElement(PendingActions, {
      actions,
      verdicts,
      surfaces: [connectedSlack],
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

  it('shows the complete literal action, the gate reason on a held row, and disables approve-all', (): void => {
    const longBody = 'x'.repeat(240);
    const dm: MockAction = {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'POST',
        path: '/chat.postMessage',
        headersJson: '{"Authorization":"Bearer {{secret}}"}',
        body: JSON.stringify({ channel: 'D0MANAGER', text: 'Draft ready.' }),
      },
    };
    const publicPost: MockAction = {
      tool: 'http.request',
      args: { ...dm.args, body: JSON.stringify({ channel: 'C0PUBLIC', text: longBody }) },
    };
    const html = render([dm, publicPost], [{ held: false }, { held: true, reason: 'public post held for the manager' }]);
    expect(html).toContain(longBody);
    // The plain line comes first, the held reason on the same line, and the literal payload is folded away.
    expect(html).toMatch(/<p[^>]*>Send Brian a Slack DM: Draft ready\.<\/p>/);
    expect(html).toMatch(/<p[^>]*>Post to Slack channel C0PUBLIC: x{120}…<span[^>]*> · held · public post held for the manager<\/span><\/p>/);
    expect(html.indexOf('Send Brian a Slack DM')).toBeLessThan(html.indexOf('&quot;tool&quot;: &quot;http.request&quot;'));
    expect(html).toMatch(/<details[^>]*><summary[^>]*>exact payload<\/summary><code/);
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).toContain('{{secret}}');
    expect(html).toMatch(/<input type="checkbox"[^>]*aria-label="approve action 1" checked=""/);
    expect(html).toMatch(/<input type="checkbox"[^>]*disabled="" aria-label="approve action 2"\/>/);
    expect(html).toMatch(/<button[^>]*>Approve selected \(1\)<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve all<\/button>/);
    expect(html).not.toMatch(/approve action 2"[^]*?reject this action/);
  });

  it('enables approve-all when every row is approvable', (): void => {
    const action: MockAction = {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-5"}' },
    };
    const html = render([action]);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve all<\/button>/);
    expect(html).toMatch(/<button[^>]*>Approve selected \(1\)<\/button>/);
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
