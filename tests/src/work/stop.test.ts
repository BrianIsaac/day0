import { describe, expect, it } from 'vitest';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import { OUTCOME_UNKNOWN_REASON } from '../../../src/work/reconciliation';
import { isStopped, landedWork, STOPPED_PREFIX, stopDetail, stoppedReason } from '../../../src/work/stop';
import type { MockAction } from '../../../src/work/types';

const slack: SurfaceRecord = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  toolAllowlist: ['chat.postMessage'],
  managerDmChannelId: 'D0MANAGER',
};
const linear: SurfaceRecord = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'mcp',
  endpoint: 'https://mcp.linear.app/mcp',
  toolAllowlist: ['get_issue', 'save_comment'],
};

const read: MockAction = {
  tool: 'mcp.call',
  args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"iss-1"}' },
};
const comment: MockAction = {
  tool: 'mcp.call',
  args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{"issueId":"iss-1","body":"Done."}' },
};
const dm: MockAction = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: '{"Authorization":"Bearer {{secret}}"}',
    body: JSON.stringify({ channel: 'D0MANAGER', text: 'Question for you.' }),
  },
};
const ok = { ok: true, idempotencyKey: 'k' };

describe('the landed work of a run', (): void => {
  it('counts landed writes and unknown outcomes, never reads, held rows, failures or the manager DM', (): void => {
    const output = {
      actions: [read, dm, comment, comment, comment],
      applied: [
        { tool: 'mcp.call', ...ok },
        { tool: 'http.request', ...ok },
        { tool: 'mcp.call', ok: true, held: true, idempotencyKey: 'k' },
        { tool: 'mcp.call', ok: false, reason: 'provider said no', idempotencyKey: 'k' },
        { tool: 'mcp.call', ok: false, reason: OUTCOME_UNKNOWN_REASON, idempotencyKey: 'k' },
      ],
    };
    expect(landedWork(output, [slack, linear]).map((entry) => [entry.actionIndex, entry.outcome])).toEqual([
      [4, 'outcome-unknown'],
    ]);
    const landed = { actions: [dm, comment], applied: [{ tool: 'http.request', ...ok }, { tool: 'mcp.call', ...ok }] };
    expect(landedWork(landed, [slack, linear]).map((entry) => entry.actionIndex)).toEqual([1]);
    // Without the chat surface the DM cannot be told from any other write, so it counts.
    expect(landedWork(landed, [linear]).map((entry) => entry.actionIndex)).toEqual([0, 1]);
  });

  it('reads both phases of a run with a closing phase', (): void => {
    const output = {
      initial: { actions: [read], applied: [{ tool: 'mcp.call', ...ok }] },
      actions: [comment],
      applied: [{ tool: 'mcp.call', ...ok }],
    };
    expect(landedWork(output, [linear]).map((entry) => [entry.phase, entry.actionIndex])).toEqual([
      ['closing', 0],
    ]);
    expect(landedWork(undefined, [])).toEqual([]);
  });
});

describe('the stopped record', (): void => {
  it('prefixes a reason once and reads it back', (): void => {
    const reason = stoppedReason('1 of 2 actions did not change the work environment');
    expect(reason).toBe(`${STOPPED_PREFIX}1 of 2 actions did not change the work environment`);
    expect(stoppedReason(reason)).toBe(reason);
    expect(isStopped(reason)).toBe(true);
    expect(isStopped('rejected by the manager: wrong issue')).toBe(false);
    expect(isStopped(undefined)).toBe(false);
    expect(stopDetail(reason)).toBe('1 of 2 actions did not change the work environment');
    expect(stopDetail('plain')).toBe('plain');
  });
});
