import { describe, expect, it } from 'vitest';
import type { AppliedAction, SurfaceRecord } from '../../../src/surfaces/types';
import { OUTCOME_UNKNOWN_REASON } from '../../../src/work/reconciliation';
import { LEGACY_SHARED_WRITE_WITHOUT_ATTRIBUTION, SHARED_WRITE_WITHOUT_ATTRIBUTION } from '../../../src/surfaces/policy';
import {
  DROPPED_READ_PREFIX,
  droppedReadRefusal,
  gateRefusalStop,
  isGateRefusalStop,
  isStopped,
  landedWork,
  STOPPED_PREFIX,
  stopDetail,
  stoppedReason,
  withRefusedReadsDropped,
} from '../../../src/work/stop';
import { FIN_1_ITEM, FIN_1_ITEM_ACTIONS } from '../../fixtures/mateo-stopped-rows-2026-09-19';
import { OPS_REQUESTS_ASK, OPS_REQUESTS_ASK_ACTIONS } from '../../fixtures/priya-stopped-rows-2026-09-19';
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

describe('a read the gate refused is dropped, not a stop (19 Sep third run, finding R)', (): void => {
  const actions = FIN_1_ITEM_ACTIONS;
  const ledger = FIN_1_ITEM.applied as Array<Partial<AppliedAction>>;
  // The run's own refusal names a write; a read is refused for its grant, its
  // surface or its allowlist, so the row is replayed under each of those.
  const refusedAs = (reason: string): Array<Partial<AppliedAction>> => [ledger[0]!, { ...ledger[1]!, reason }];

  it("keeps the run's list_issues and marks the refused Slack read dropped, with the gate's reason", (): void => {
    const dropped = withRefusedReadsDropped(actions, refusedAs('no grant (slack:read)'));
    expect(dropped[0]).toBe(ledger[0]);
    expect(dropped[1]).toMatchObject({
      tool: 'http.request',
      ok: true,
      held: true,
      reason: `${DROPPED_READ_PREFIX}no grant (slack:read)`,
      idempotencyKey: ledger[1]!.idempotencyKey,
    });
    expect(droppedReadRefusal(dropped[1]!.reason)).toBe('no grant (slack:read)');
    expect(gateRefusalStop(actions, dropped)).toBeUndefined();
  });

  it('drops the row as the run recorded it too, now that the operation is read as a read', (): void => {
    const dropped = withRefusedReadsDropped(actions, ledger);
    expect(dropped[1]).toMatchObject({ ok: true, held: true });
    expect(droppedReadRefusal(dropped[1]!.reason)).toBe(SHARED_WRITE_WITHOUT_ATTRIBUTION);
  });

  it('never drops a refused write: the run still stops at it', (): void => {
    const rows = [{ tool: 'mcp.call', ...ok }, { tool: 'mcp.call', ok: false, reason: 'no grant (linear:write)' }];
    const kept = withRefusedReadsDropped([read, comment], rows);
    expect(kept).toEqual(rows);
    expect(gateRefusalStop([read, comment], kept)).toContain("Day0's gate refused 1 of 2 actions");
  });

  it('never drops a read the provider failed, or one whose outcome is unknown', (): void => {
    const failed = [{ tool: 'mcp.call', ...ok }, { tool: 'mcp.call', ok: false, reason: 'provider said no' }];
    expect(withRefusedReadsDropped([comment, read], failed)).toEqual(failed);
    const unknown = [
      { tool: 'mcp.call', ...ok },
      { tool: 'mcp.call', ok: false, outcomeUnknown: true, reason: 'no grant (linear:read)' },
    ];
    expect(withRefusedReadsDropped([comment, read], unknown)).toEqual(unknown);
  });

  it('drops nothing when no other row stands: a run that did nothing still stops', (): void => {
    const only = [{ tool: 'mcp.call', ok: false, reason: 'no grant (linear:read)' }];
    expect(withRefusedReadsDropped([read], only)).toEqual(only);
    expect(gateRefusalStop([read], only)).toContain('nothing else landed');
  });

  it('leaves a mock run and an unparsable row alone', (): void => {
    const mock: MockAction[] = [{ tool: 'slack.postMessage', args: { slug: 'dm-manager' } }, { tool: 'ticket.update', args: { slug: 'T-1' } }];
    const rows = [{ tool: 'slack.postMessage', ok: false, reason: 'unknown tool' }, { tool: 'ticket.update', ...ok }];
    expect(withRefusedReadsDropped(mock, rows)).toEqual(rows);
    const broken: MockAction[] = [{ tool: 'mcp.call', args: { surface: 'linear' } }, comment];
    const malformed = [{ tool: 'mcp.call', ok: false, reason: 'malformed surface action (tool is required)' }, { tool: 'mcp.call', ...ok }];
    expect(withRefusedReadsDropped(broken, malformed)).toEqual(malformed);
  });

  it('reads only its own line back as a dropped read', (): void => {
    expect(droppedReadRefusal('no grant (slack:read)')).toBeUndefined();
    expect(droppedReadRefusal(undefined)).toBeUndefined();
    expect(droppedReadRefusal(`${DROPPED_READ_PREFIX}provider said no`)).toBeUndefined();
  });
});

describe('a refused read-back sent as GET with a body is dropped, not a stop (19 Sep fourth run, finding U)', (): void => {
  const actions = OPS_REQUESTS_ASK_ACTIONS;
  const ledger = OPS_REQUESTS_ASK.applied as Array<Partial<AppliedAction>>;

  it("is the run's own stop: eight landed, the ninth refused, and the item failed on it", (): void => {
    expect(ledger.slice(0, 8).every((row) => row.ok === true)).toBe(true);
    expect(ledger[8]).toMatchObject({ ok: false, reason: SHARED_WRITE_WITHOUT_ATTRIBUTION });
    expect(OPS_REQUESTS_ASK.skipReason).toContain("stopped: Day0's gate refused 1 of 9 actions");
  });

  it('drops the row as the run recorded it, with a ledger line, and the run does not stop', (): void => {
    const dropped = withRefusedReadsDropped(actions, ledger);
    expect(dropped.slice(0, 8)).toEqual(ledger.slice(0, 8));
    expect(dropped[8]).toMatchObject({
      tool: 'http.request',
      ok: true,
      held: true,
      reason: `${DROPPED_READ_PREFIX}${SHARED_WRITE_WITHOUT_ATTRIBUTION}`,
      idempotencyKey: ledger[8]!.idempotencyKey,
    });
    expect(droppedReadRefusal(dropped[8]!.reason)).toBe(SHARED_WRITE_WITHOUT_ATTRIBUTION);
    expect(gateRefusalStop(actions, dropped)).toBeUndefined();
  });

  it('still stops on the same refusal when the ninth action is a write', (): void => {
    const write: MockAction = {
      tool: 'http.request',
      args: { ...actions[8]!.args, path: '/conversations.mark' },
    };
    const kept = withRefusedReadsDropped([...actions.slice(0, 8), write], ledger);
    expect(kept).toEqual(ledger);
    expect(gateRefusalStop([...actions.slice(0, 8), write], kept)).toContain("Day0's gate refused 1 of 9 actions");
  });
});
