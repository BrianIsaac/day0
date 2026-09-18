import { describe, expect, it } from 'vitest';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import { OUTCOME_UNKNOWN_REASON } from '../../../src/work/reconciliation';
import { LEGACY_SHARED_WRITE_WITHOUT_ATTRIBUTION } from '../../../src/surfaces/policy';
import {
  gateRefusalStop,
  isGateRefusalStop,
  isStopped,
  landedWork,
  STOPPED_PREFIX,
  stopDetail,
  stoppedReason,
} from '../../../src/work/stop';
import { REFUSED_CREATE_RUN } from '../../fixtures/refused-ticket-create-2026-09-19';
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

describe('a run cut short by a gate refusal (19 Sep run, finding N)', (): void => {
  const actions = REFUSED_CREATE_RUN.actions as unknown as MockAction[];
  const applied = REFUSED_CREATE_RUN.applied.map((row) => ({ ...row }));

  it("words the run's own ledger for the manager: what was refused, what stands, what to do", (): void => {
    const reason = gateRefusalStop(actions, applied);
    expect(reason).toBe(
      `${STOPPED_PREFIX}Day0's gate refused 1 of 8 actions before sending it, so the steps that needed it were not done; ` +
        `the other 7 landed and stay as they are. Refused: save_issue on linear (${LEGACY_SHARED_WRITE_WITHOUT_ATTRIBUTION}). ` +
        'Retry with a note that changes the step, or do it by hand',
    );
    expect(isGateRefusalStop(reason)).toBe(true);
    expect(isGateRefusalStop(REFUSED_CREATE_RUN.skipReason)).toBe(false);
    expect(isGateRefusalStop(stoppedReason('no registered skill matches'))).toBe(false);
  });

  it('never shows the payload of the refused row', (): void => {
    expect(gateRefusalStop(actions, applied)).not.toContain('Approved figure for this close');
  });

  it('says so when nothing else landed', (): void => {
    expect(gateRefusalStop(actions.slice(0, 1), applied.slice(0, 1))).toContain(
      "Day0's gate refused 1 of 1 actions before sending it, so the steps that needed it were not done; nothing else landed.",
    );
  });

  it('leaves a run with a provider failure beside the refusal an ordinary failure', (): void => {
    const mixed = [...applied.slice(0, 7), { tool: 'http.request', ok: false, reason: 'HTTP 500', idempotencyKey: 'k:7' }];
    expect(gateRefusalStop(actions, mixed)).toBeUndefined();
    const unknown = [...applied.slice(0, 7), { tool: 'http.request', ok: false, outcomeUnknown: true, reason: OUTCOME_UNKNOWN_REASON, idempotencyKey: 'k:7' }];
    expect(gateRefusalStop(actions, unknown)).toBeUndefined();
  });

  it('leaves a run whose every row landed or was held alone', (): void => {
    expect(gateRefusalStop(actions.slice(1), applied.slice(1))).toBeUndefined();
    expect(gateRefusalStop([], [])).toBeUndefined();
  });

  it('leaves a mock run exactly as it read before', (): void => {
    const mock: MockAction[] = [{ tool: 'ticket.update', args: { slug: 'T-1', status: 'done' } }];
    expect(gateRefusalStop(mock, [{ tool: 'ticket.update', ok: false, reason: 'unknown tool' }])).toBeUndefined();
  });
});
