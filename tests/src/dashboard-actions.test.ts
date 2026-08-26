import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/agent/[agentId]/ChatRoom', () => ({ ChatRoom: (): null => null }));
vi.mock('../../app/agent/[agentId]/VoiceRoom', () => ({ VoiceRoom: (): null => null }));
vi.mock('../../app/agent/[agentId]/MockEnvironment', () => ({
  MockEnvironment: (): null => null,
}));

import {
  cancelledReason,
  PendingActions,
  pendingHeadline,
  pendingVerdicts,
  PostureControl,
  retryRequiresReconciliation,
} from '../../app/agent/[agentId]/AgentDashboard';
import { HELD_MUTATION, HELD_PUBLIC_POST, type ActionVerdict } from '../../src/surfaces/policy';
import type { SurfaceRecord } from '../../src/surfaces/types';
import type { MockAction, ReplyTarget } from '../../src/work/types';

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

function render(
  actions: MockAction[],
  verdicts: ActionVerdict[] = actions.map((): ActionVerdict => ({ disposition: 'held', reason: HELD_MUTATION })),
  replyTarget?: ReplyTarget,
): string {
  return renderToStaticMarkup(
    createElement(PendingActions, {
      actions,
      verdicts,
      surfaces: [connectedSlack],
      replyTarget,
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

  it('shows the complete literal action, the gate reason on a refused row, and disables approve-all', (): void => {
    const longBody = 'x'.repeat(240);
    const publicPost: MockAction = {
      tool: 'http.request',
      args: { ...dm.args, body: JSON.stringify({ channel: 'C0PUBLIC', text: longBody }) },
    };
    const html = render(
      [dm, publicPost],
      [
        { disposition: 'held', reason: HELD_MUTATION },
        { disposition: 'refused', reason: 'no grant (slack:write)' },
      ],
    );
    expect(html).toContain(longBody);
    expect(html).toContain('1 action awaiting your approval · 1 refused by the gate · nothing has reached a surface');
    // The plain line comes first, the reason on the same line, and the literal payload is folded away.
    expect(html).toMatch(/<p[^>]*>Send Brian a Slack DM: &quot;Draft ready\.&quot;<span[^>]*> · system-of-record mutation held for the manager<\/span><\/p>/);
    expect(html).toMatch(/<p[^>]*>Post to Slack channel C0PUBLIC: &quot;x{120}…&quot;<span[^>]*> · refused · no grant \(slack:write\)<\/span><\/p>/);
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

  it('lists only the rows that need the manager and says how many applied on their own', (): void => {
    const read: MockAction = {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-10"}' },
    };
    const reply: MockAction = {
      tool: 'http.request',
      args: { ...dm.args, body: JSON.stringify({ channel: 'C0BSF04TZ19', thread_ts: '1787746453.202809', text: 'Covered.' }) },
    };
    const verdicts: ActionVerdict[] = [
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_PUBLIC_POST },
    ];
    const html = render([read, dm, reply], verdicts, { channel: 'C0BSF04TZ19', channelName: 'revops-asks', threadTs: '1787746453.202809' });
    expect(html).toContain('2 applied automatically · 1 action awaiting your approval');
    expect(html).not.toContain('Read issue REVOPS-10');
    expect(html).not.toContain('Send Brian a Slack DM');
    expect(html).toContain('Reply in #revops-asks thread: &quot;Covered.&quot;');
    expect(html).toMatch(/<input type="checkbox"[^>]*aria-label="approve action 3" checked=""/);
    expect(html).not.toMatch(/aria-label="approve action 1"/);
    expect(html).toMatch(/<button[^>]*>Approve selected \(1\)<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve all<\/button>/);
    expect(pendingHeadline(verdicts)).toBe('2 applied automatically · 1 action awaiting your approval');
    expect(pendingHeadline([{ disposition: 'held', reason: HELD_MUTATION }, { disposition: 'refused', reason: 'x' }])).toBe(
      '1 action awaiting your approval · 1 refused by the gate · nothing has reached a surface',
    );
  });

  it('reads persisted verdicts of either shape and pads a run held before verdicts existed', (): void => {
    expect(pendingVerdicts([{ held: true, reason: 'no grant (linear:write)' }, { held: false }], 3)).toEqual([
      { disposition: 'refused', reason: 'no grant (linear:write)' },
      { disposition: 'held', reason: 'write held for the manager' },
      { disposition: 'held', reason: 'write held for the manager' },
    ]);
    expect(pendingVerdicts([{ disposition: 'auto' }, { disposition: 'held', reason: HELD_PUBLIC_POST }], 2)).toEqual([
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_PUBLIC_POST },
    ]);
  });

  it('renders the posture control with the current posture selected and the three options', (): void => {
    const html = renderToStaticMarkup(
      createElement(PostureControl, {
        posture: 'supervised',
        tone: 'tone',
        onChange: vi.fn(async (): Promise<void> => {}),
      }),
    );
    expect(html).toContain('Active ·');
    expect(html).toMatch(/<select[^>]*aria-label="agent posture"/);
    expect(html).toMatch(/<option(?=[^>]*selected="")(?=[^>]*value="supervised")[^>]*>supervised posture<\/option>/);
    expect(html).toContain('value="cold-start">cold-start posture</option>');
    expect(html).toContain('value="trusted">trusted posture</option>');
  });

  it('explains a cancelled item from its recorded reason, else from what it was doing', (): void => {
    expect(cancelledReason({ skipReason: 'skill proposal "linear-action-revops-6" rejected by the manager' })).toBe(
      'skill proposal "linear-action-revops-6" rejected by the manager',
    );
    expect(
      cancelledReason({
        verdict: { decision: 'needs-skill', suggestedSkillName: 'linear-action-revops-6' },
      }),
    ).toBe('skill proposal "linear-action-revops-6" rejected by the manager');
    expect(cancelledReason({ verdict: { decision: 'needs-skill' } })).toBe('skill proposal rejected by the manager');
    expect(cancelledReason({ verdict: { decision: 'claim' }, plan: { summary: 'x' } })).toBe('plan cancelled by the manager');
    expect(cancelledReason({})).toBe('cancelled by the manager');
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
