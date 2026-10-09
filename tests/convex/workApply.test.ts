/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { HELD_NOT_APPROVED, HELD_WRITE } from '../../src/surfaces/policy';
import { OUTCOME_UNKNOWN_REASON } from '../../src/work/reconciliation';
import type { MockAction } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * A run's held set at the gate and at the apply (`convex/workApply.ts`, moved out of
 * `convex/work.ts` by the wave 15 helpers split): the verdicts decided as the run is held, the
 * surface an approved write still waits to connect, the set parked on that connection, and the
 * ledger an interrupted apply leaves.
 */

type Harness = TestConvex<typeof schema>;

const HELD = { disposition: 'held' as const, reason: 'a write the manager approves' };
const COMMENT: MockAction = {
  tool: 'mcp.call',
  args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{"issueId":"i","body":"b"}' },
};

// Parking a set schedules its next step; the scheduler's timer is faked so
// nothing runs after the test.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

/** The module under the mode the test chose; `SURFACE_MODE` is read at import. */
async function applyModule(): Promise<typeof import('../../convex/workApply')> {
  return await import('../../convex/workApply');
}

async function seed(
  harness: Harness,
  fields: (runId: Id<'events'>) => Partial<Doc<'workItems'>>,
): Promise<{ row: Doc<'workItems'>; runId: Id<'events'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Aiko',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId,
      type: 'work.skill-run',
      payload: {},
      createdAt: 1,
    });
    const id = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-1',
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state: 'actions-pending',
      observedAt: 1,
      createdAt: 1,
      ...fields(runId),
    });
    const row = await ctx.db.get(id);
    if (!row) throw new Error('work item missing');
    return { row, runId };
  });
}

async function seedLinear(
  harness: Harness,
  agentId: Id<'agents'>,
  verdict: Doc<'surfaces'>['verdict'],
): Promise<void> {
  await harness.run(async (ctx) => {
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict,
      endpoint: 'https://mcp.linear.app/mcp',
      path: 'mcp',
      toolAllowlist: ['save_comment'],
      credentialLanded: false,
      whereFound: [],
      createdAt: 1,
    } as never);
  });
}

describe('reviewHeldActions', (): void => {
  it('holds every write for the manager in mock mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { reviewHeldActions } = await applyModule();
    const harness = convexTest(schema, allConvexModules());
    const { row } = await seed(harness, () => ({}));

    const review = await harness.run(
      async (ctx) => await reviewHeldActions(ctx, row, [COMMENT, COMMENT], undefined),
    );

    expect(review).toEqual({
      verdicts: [
        { disposition: 'held', reason: HELD_WRITE },
        { disposition: 'held', reason: HELD_WRITE },
      ],
      autonomousActions: false,
      transitionDirectedByNote: false,
    });
  });
});

describe('surfaceAwaitingConnection and parkOnConnection', (): void => {
  it('names the surface an approved write waits on and parks the set on it', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { parkOnConnection, surfaceAwaitingConnection } = await applyModule();
    const harness = convexTest(schema, allConvexModules());
    const { row } = await seed(harness, (runId) => ({
      pendingRunId: runId,
      output: { actions: [COMMENT] },
      actionVerdicts: [HELD],
      approvedIndexes: [0],
      applyPhase: 'approved',
    }));
    await seedLinear(harness, row.agentId, 'proposed');

    const waiting = await harness.run(
      async (ctx) => (await surfaceAwaitingConnection(ctx.db, row, Date.now())) ?? null,
    );
    await harness.run(async (ctx) => {
      await parkOnConnection(ctx, row, 'linear');
    });
    const parked = await harness.run(async (ctx) => await ctx.db.get(row._id));

    expect(waiting).toBe('linear');
    expect(parked).toMatchObject({
      state: 'deferred',
      verdict: { decision: 'defer', reason: 'awaiting-connection', missingSurface: 'linear' },
    });
    expect(parked?.approvedIndexes).toBeUndefined();
    expect(parked?.pendingRunId).toBeUndefined();
  });

  it('names nothing when no approved write goes through a surface', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { surfaceAwaitingConnection } = await applyModule();
    const harness = convexTest(schema, allConvexModules());
    const { row } = await seed(harness, () => ({
      output: { actions: [COMMENT] },
      actionVerdicts: [HELD],
    }));
    await seedLinear(harness, row.agentId, 'proposed');

    const waiting = await harness.run(
      async (ctx) => (await surfaceAwaitingConnection(ctx.db, row, Date.now())) ?? null,
    );

    expect(waiting).toBeNull();
  });
});

describe('interruptedApplyLedger', (): void => {
  it('records an approved row the apply never reported as unknown and the rest as not approved', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { interruptedApplyLedger } = await applyModule();
    const harness = convexTest(schema, allConvexModules());
    const { row, runId } = await seed(harness, (pendingRunId) => ({
      pendingRunId,
      output: { actions: [COMMENT, COMMENT] },
      actionVerdicts: [HELD, HELD],
      approvedIndexes: [0],
      applyPhase: 'approved',
    }));

    const ledger = interruptedApplyLedger(row, runId, 'interrupted');

    expect(ledger.applied).toEqual([
      expect.objectContaining({ tool: 'mcp.call', ok: false, reason: OUTCOME_UNKNOWN_REASON }),
      expect.objectContaining({
        tool: 'mcp.call',
        ok: true,
        held: true,
        reason: HELD_NOT_APPROVED,
      }),
    ]);
    expect(ledger.applied[0]?.idempotencyKey).not.toBe(ledger.applied[1]?.idempotencyKey);
  });
});
