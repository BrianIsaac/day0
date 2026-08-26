import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/agent/[agentId]/ChatRoom', () => ({ ChatRoom: (): null => null }));
vi.mock('../../app/agent/[agentId]/VoiceRoom', () => ({ VoiceRoom: (): null => null }));
vi.mock('../../app/agent/[agentId]/MockEnvironment', () => ({
  MockEnvironment: (): null => null,
}));

import {
  AutonomyConfirm,
  AutonomyControl,
  cancelsAutonomyConfirm,
  cancelledReason,
  decisionAttribution,
  landedHeadline,
  PendingActions,
  pendingHeadline,
  pendingVerdicts,
  retryRequiresReconciliation,
} from '../../app/agent/[agentId]/AgentDashboard';
import { HELD_MUTATION, HELD_PUBLIC_POST, type ActionVerdict } from '../../src/surfaces/policy';
import { AUTONOMY_WARNING, HELD_BEFORE_AUTONOMY_NOTE, HELD_WHILE_SUPERVISED_NOTE } from '../../src/work/autonomy';
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
  autonomousActions = false,
): string {
  return renderToStaticMarkup(
    createElement(PendingActions, {
      actions,
      verdicts,
      surfaces: [connectedSlack],
      replyTarget,
      autonomousActions,
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
    // The card says plainly why the row is waiting.
    expect(html).toContain(HELD_WHILE_SUPERVISED_NOTE);
    expect(html).not.toContain(HELD_BEFORE_AUTONOMY_NOTE);
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
    expect(html).toContain(HELD_WHILE_SUPERVISED_NOTE);
    // A run held before the switch was turned on still needs the click, and says so.
    const after = render([read, dm, reply], verdicts, undefined, true);
    expect(after).toContain(HELD_BEFORE_AUTONOMY_NOTE);
    expect(after).not.toContain(HELD_WHILE_SUPERVISED_NOTE);
    expect(render([dm], [{ disposition: 'refused', reason: 'x' }])).not.toContain('held for your approval');
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

  it('renders the autonomous-actions switch with its state named plainly, off and on', (): void => {
    const off = renderToStaticMarkup(
      createElement(AutonomyControl, { on: false, tone: 'tone', onChange: vi.fn(async (): Promise<void> => {}) }),
    );
    expect(off).toContain('Active · Supervised');
    expect(off).toContain('Autonomous actions');
    expect(off).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"[^>]*aria-label="Autonomous actions"/);
    expect(off).not.toContain(AUTONOMY_WARNING);
    expect(off).not.toContain('supervised posture');
    const on = renderToStaticMarkup(
      createElement(AutonomyControl, { on: true, tone: 'tone', onChange: vi.fn(async (): Promise<void> => {}) }),
    );
    expect(on).toContain('Active · Autonomous');
    expect(on).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="true"/);
    expect(on).not.toContain(AUTONOMY_WARNING);
  });

  it('renders the confirmation with the warning in the operator\'s words and its two buttons', (): void => {
    const html = renderToStaticMarkup(
      createElement(AutonomyConfirm, { onConfirm: vi.fn(), onCancel: vi.fn() }),
    );
    expect(html).toMatch(/<div[^>]*role="alertdialog"[^>]*aria-modal="true"[^>]*aria-label="Turn on autonomous actions"/);
    expect(html).toContain('Turn on autonomous actions?');
    expect(html).toContain('The agent will act on connected systems without asking - post, comment, change status - within the connections and skills you have approved.');
    expect(html).toContain('Turn this on only after its behaviour has been what you want.');
    expect(html).toContain('Skills and connections still need your approval either way.');
    expect(html).toMatch(/<button[^>]*>Turn on<\/button>/);
    expect(html).toMatch(/<button[^>]*autofocus=""[^>]*>Cancel<\/button>/);
    expect(cancelsAutonomyConfirm('Escape', false)).toBe(true);
    expect(cancelsAutonomyConfirm('Enter', false)).toBe(false);
    expect(cancelsAutonomyConfirm('Escape', true)).toBe(false);
    expect(renderToStaticMarkup(createElement(AutonomyConfirm, { onConfirm: vi.fn(), onCancel: vi.fn(), busy: true }))).toMatch(
      /<button[^>]*disabled=""[^>]*>Turn on<\/button>/,
    );
  });

  it('names how many landed changes applied under the switch', (): void => {
    expect(landedHeadline([{ authority: 'autonomous' }, { authority: 'autonomous' }, { authority: 'autonomous' }])).toBe(
      '3 changes reached the work environment · 3 applied autonomously',
    );
    expect(landedHeadline([{ authority: 'standing' }, { authority: 'manager' }, { authority: 'autonomous' }])).toBe(
      '3 changes reached the work environment · 1 applied autonomously',
    );
    expect(landedHeadline([{ authority: 'manager' }])).toBe('1 change reached the work environment');
    expect(landedHeadline([{}, {}])).toBe('2 changes reached the work environment');
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

  it('names whether the dashboard or company chat won the decision', (): void => {
    expect(
      decisionAttribution({
        decidedAt: 1,
        outcome: 'approved',
        decidedVia: 'channel',
        surfaceName: 'Slack',
      }),
    ).toBe('approved from Slack');
    expect(
      decisionAttribution({
        decidedAt: 1,
        outcome: 'rejected',
        decidedVia: 'dashboard',
        surfaceName: 'Company chat',
      }),
    ).toBe('rejected from the day0 dashboard');
    expect(
      decisionAttribution({ surfaceName: 'Slack' }),
    ).toBeUndefined();
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
