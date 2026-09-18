import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import { computeAgentMetrics } from '../../convex/metrics';
import {
  isGateRefusal,
  LEGACY_SHARED_WRITE_WITHOUT_ATTRIBUTION,
  SHARED_WRITE_WITHOUT_ATTRIBUTION,
  STATUS_WITHOUT_COMMENT,
  WITHHELD_AFTER_FAILED_WRITE,
} from '../../src/surfaces/policy';
import { REFUSED_CREATE_RUN } from '../fixtures/refused-ticket-create-2026-09-19';

function item(id: string, applied: readonly unknown[]): Doc<'workItems'> {
  return {
    _id: id as Id<'workItems'>,
    _creationTime: 1,
    agentId: 'agent' as Id<'agents'>,
    sourceCategory: 'event-stream',
    sourceSystem: 'slack',
    externalId: id,
    title: REFUSED_CREATE_RUN.title,
    contentSummary: REFUSED_CREATE_RUN.contentSummary,
    contentRefs: [],
    state: 'failed',
    createdAt: 1,
    observedAt: 1,
    output: { applied },
  } as unknown as Doc<'workItems'>;
}

describe('a write the gate refused at apply time is a refusal on the card (19 Sep run, finding N)', (): void => {
  it("counts the run's refused ticket create, which no hold-time review saw", (): void => {
    const metrics = computeAgentMetrics([], [item(REFUSED_CREATE_RUN.workItemId, REFUSED_CREATE_RUN.applied)], []);
    expect(metrics.actions).toMatchObject({ autoApplied: 7, held: 0, rejected: 0, refused: 1 });
  });

  it('counts it once when the completion event and the row both carry the ledger', (): void => {
    const row = item(REFUSED_CREATE_RUN.workItemId, REFUSED_CREATE_RUN.applied);
    const event = {
      _id: 'event' as Id<'events'>,
      _creationTime: 2,
      agentId: 'agent' as Id<'agents'>,
      type: 'work.failed',
      payload: { workItemId: row._id, output: row.output },
      createdAt: 2,
    } as unknown as Doc<'events'>;
    expect(computeAgentMetrics([event], [row], []).actions.refused).toBe(1);
  });

  it('counts it once when the hold-time review had already refused the same row', (): void => {
    const [runId] = REFUSED_CREATE_RUN.applied[0].idempotencyKey.split(':').slice(1);
    const pending = {
      _id: 'pending' as Id<'events'>,
      _creationTime: 1,
      agentId: 'agent' as Id<'agents'>,
      type: 'work.actions-auto-applying',
      payload: { workItemId: REFUSED_CREATE_RUN.workItemId, runId, heldIndexes: [], refusedIndexes: [0] },
      createdAt: 1,
    } as unknown as Doc<'events'>;
    const row = item(REFUSED_CREATE_RUN.workItemId, REFUSED_CREATE_RUN.applied);
    expect(computeAgentMetrics([pending], [row], []).actions.refused).toBe(1);
  });

  it('does not count a provider failure, a held row or a landed row as a refusal', (): void => {
    const ledger = [
      {
        tool: 'mcp.call',
        ok: false,
        reason: 'Error POSTing to endpoint: {"title":"Error 1101: Worker threw exception"}',
        idempotencyKey: 'wi:run:0',
      },
      { tool: 'http.request', ok: true, held: true, reason: WITHHELD_AFTER_FAILED_WRITE, idempotencyKey: 'wi:run:1' },
      { tool: 'mcp.call', ok: true, authority: 'autonomous', effect: 'ok', idempotencyKey: 'wi:run:2' },
      { tool: 'mcp.call', ok: false, outcomeUnknown: true, reason: 'timed out', idempotencyKey: 'wi:run:3' },
    ];
    expect(computeAgentMetrics([], [item('wi', ledger)], []).actions.refused).toBe(0);
  });

  it('counts every rule the gate refuses by, not only a missing grant', (): void => {
    const ledger = [
      { tool: 'mcp.call', ok: false, reason: STATUS_WITHOUT_COMMENT, idempotencyKey: 'wi:run:0' },
      { tool: 'mcp.call', ok: false, reason: SHARED_WRITE_WITHOUT_ATTRIBUTION, idempotencyKey: 'wi:run:1' },
      { tool: 'mcp.call', ok: false, reason: 'no grant (linear:write)', idempotencyKey: 'wi:run:2' },
    ];
    expect(computeAgentMetrics([], [item('wi', ledger)], []).actions.refused).toBe(3);
  });
});

describe('telling a gate refusal from any other reason', (): void => {
  it('knows the reason as rows before 19 Sep carry it and as rows carry it now', (): void => {
    expect(REFUSED_CREATE_RUN.applied[0].reason).toBe(LEGACY_SHARED_WRITE_WITHOUT_ATTRIBUTION);
    expect(isGateRefusal(LEGACY_SHARED_WRITE_WITHOUT_ATTRIBUTION)).toBe(true);
    expect(isGateRefusal(SHARED_WRITE_WITHOUT_ATTRIBUTION)).toBe(true);
  });

  it('knows a parameterised refusal by its constant', (): void => {
    expect(isGateRefusal('no grant (linear:write)')).toBe(true);
    expect(isGateRefusal('tool not in the surface allowlist (delete_issue)')).toBe(true);
    expect(isGateRefusal('surface not connected (listed-dead)')).toBe(true);
    expect(isGateRefusal('mcp.call is not allowed on surface path documented-api')).toBe(true);
  });

  it('reads nothing else as one', (): void => {
    expect(isGateRefusal(undefined)).toBe(false);
    expect(isGateRefusal('HTTP 500')).toBe(false);
    expect(isGateRefusal('the provider said: no grant for this token')).toBe(false);
    // A provider's own words may open like one of the constants; only the constant, alone or with its bracketed detail, counts.
    expect(isGateRefusal('unknown tool save_isue; did you mean save_issue?')).toBe(false);
    expect(isGateRefusal('no grant: token lacks the write scope')).toBe(false);
    expect(isGateRefusal('unknown tool')).toBe(true);
    expect(isGateRefusal(WITHHELD_AFTER_FAILED_WRITE)).toBe(false);
  });
});
