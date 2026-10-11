/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  approveActionsInTransaction,
  approvePlanInTransaction,
  managerText,
  PLAN_CANCELLED_REASON,
} from '../../convex/managerDecisions';
import { MANAGER_FEEDBACK_MAX_CHARS } from '../../src/work/manager-channel';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * The manager's decision as applied in the deciding transaction (`convex/managerDecisions.ts`,
 * moved out of `convex/work.ts` by the wave 15 helpers split): a plan approved or turned down, a
 * held set approved row by row or rejected, the same whether the card or the channel decided, the
 * request marked decided and the manager's words kept for the next draft.
 */

type Harness = TestConvex<typeof schema>;
type Decision = NonNullable<Doc<'workItems'>['decision']>;

// Every decision schedules the next step or the apply; the scheduler's timer is
// faked so nothing runs after the test.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

/** The module under the mode the test chose; `SURFACE_MODE` is read at import. */
async function decisionsModule(): Promise<typeof import('../../convex/managerDecisions')> {
  return await import('../../convex/managerDecisions');
}

function request(kind: Decision['kind']): Decision {
  return {
    id: 'K7Q2',
    kind,
    requestedAt: 1,
    channel: 'D0MANAGER',
    surfaceSlug: 'team-chat',
    surfaceName: 'Team chat',
  };
}

const HELD = { disposition: 'held' as const, reason: 'a write the manager approves' };

async function seed(
  harness: Harness,
  state: Doc<'workItems'>['state'],
  fields: (runId: Id<'events'>) => Partial<Doc<'workItems'>> = () => ({}),
): Promise<{ agentId: Id<'agents'>; row: Doc<'workItems'>; runId: Id<'events'> }> {
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
      state,
      observedAt: 1,
      createdAt: 1,
      ...fields(runId),
    });
    const row = await ctx.db.get(id);
    if (!row) throw new Error('work item missing');
    return { agentId, row, runId };
  });
}

function heldSet(runId: Id<'events'>): Partial<Doc<'workItems'>> {
  return {
    pendingRunId: runId,
    decision: request('actions'),
    output: {
      actions: [
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_comment' } },
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_issue' } },
      ],
    },
    actionVerdicts: [HELD, HELD],
  };
}

async function reread(harness: Harness, id: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(id));
  if (!row) throw new Error('work item missing');
  return row;
}

async function eventsOf(harness: Harness, agentId: Id<'agents'>): Promise<Doc<'events'>[]> {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .collect(),
  );
}

describe('managerText', (): void => {
  it("keeps the manager's words with whitespace collapsed, capped", (): void => {
    expect(managerText('  too\n\nbroad  ')).toBe('too broad');
    expect(managerText(undefined)).toBe('');
    expect(managerText('x'.repeat(MANAGER_FEEDBACK_MAX_CHARS + 5))).toHaveLength(
      MANAGER_FEEDBACK_MAX_CHARS,
    );
  });
});

describe('approvePlanInTransaction', (): void => {
  it('approves the plan with the answers given and marks the request decided by its reply', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, row } = await seed(harness, 'plan-pending', () => ({
      decision: request('plan'),
    }));
    const answers = [{ question: 'Which customer?', answer: 'Acme', answeredAt: 3 }];

    await harness.run(async (ctx) => {
      await approvePlanInTransaction(ctx, row, 'channel', '1787770800.000100', answers);
    });

    expect(await reread(harness, row._id)).toMatchObject({
      state: 'plan-approved',
      managerAnswers: answers,
      decision: { outcome: 'approved', decidedVia: 'channel', decidedTs: '1787770800.000100' },
    });
    const approved = (await eventsOf(harness, agentId)).find(
      (event) => event.type === 'work.plan-approved',
    );
    expect(approved?.payload).toMatchObject({
      decidedVia: 'channel',
      answered: [{ question: 'Which customer?' }],
    });
  });

  it('refuses a row that is not waiting on its plan', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { row } = await seed(harness, 'claimed');

    await expect(
      harness.run(async (ctx) => {
        await approvePlanInTransaction(ctx, row, 'dashboard');
      }),
    ).rejects.toThrow('workItem state is claimed; expected plan-pending');
  });
});

describe('cancelPlanInTransaction', (): void => {
  it("cancels the plan with the manager's reason and, in real mode, keeps it as a correction", async (): Promise<void> => {
    useSurfaceMode('real');
    const { cancelPlanInTransaction } = await decisionsModule();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, row } = await seed(harness, 'plan-pending', () => ({
      decision: request('plan'),
    }));

    await harness.run(async (ctx) => {
      await cancelPlanInTransaction(ctx, row, 'dashboard', '  too   broad ');
    });

    expect(await reread(harness, row._id)).toMatchObject({
      state: 'cancelled',
      skipReason: `${PLAN_CANCELLED_REASON}: too broad`,
      managerFeedback: { reason: 'too broad', kind: 'plan-rejection' },
      planRejectedAt: expect.any(Number),
      decision: { outcome: 'rejected', decidedVia: 'dashboard' },
    });
    const corrections = await harness.run(
      async (ctx) => await ctx.db.query('corrections').collect(),
    );
    expect(corrections.map((correction) => [correction.kind, correction.text])).toEqual([
      ['plan-rejection', 'too broad'],
    ]);
    expect((await eventsOf(harness, agentId)).map((event) => event.type)).toContain(
      'work.cancelled',
    );
  });
});

describe('approveActionsInTransaction', (): void => {
  it('approves the chosen rows, records the rest as rejected and schedules the apply', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, row, runId } = await seed(harness, 'actions-pending', heldSet);

    const result = await harness.run(
      async (ctx) =>
        await approveActionsInTransaction(
          ctx,
          row,
          { workItemId: row._id, pendingRunId: runId, approvedIndexes: [0, 0] },
          { via: 'dashboard' },
        ),
    );

    expect(result).toEqual({ ok: true, approvedIndexes: [0] });
    expect(await reread(harness, row._id)).toMatchObject({
      approvedIndexes: [0],
      applyPhase: 'approved',
      decision: { outcome: 'approved', decidedVia: 'dashboard' },
    });
    const approved = (await eventsOf(harness, agentId)).find(
      (event) => event.type === 'work.actions-approved',
    );
    expect(approved?.payload).toMatchObject({ approvedIndexes: [0], rejectedIndexes: [1] });
  });

  it('refuses a stale run and an index outside the list', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { row, runId } = await seed(harness, 'actions-pending', heldSet);
    const other = await harness.run(
      async (ctx) =>
        await ctx.db.insert('events', {
          agentId: row.agentId,
          type: 'work.skill-run',
          payload: {},
          createdAt: 2,
        }),
    );

    await expect(
      harness.run(
        async (ctx) =>
          await approveActionsInTransaction(
            ctx,
            row,
            { workItemId: row._id, pendingRunId: other, approvedIndexes: [0] },
            { via: 'dashboard' },
          ),
      ),
    ).rejects.toThrow('pending run changed; refresh the action list');
    await expect(
      harness.run(
        async (ctx) =>
          await approveActionsInTransaction(
            ctx,
            row,
            { workItemId: row._id, pendingRunId: runId, approvedIndexes: [2] },
            { via: 'dashboard' },
          ),
      ),
    ).rejects.toThrow('action index 2 is outside the pending list');
  });
});

describe('rejectActionsInTransaction', (): void => {
  it("fails the row with the manager's reason, clears the set and, in real mode, keeps a correction", async (): Promise<void> => {
    useSurfaceMode('real');
    const { rejectActionsInTransaction } = await decisionsModule();
    const harness = convexTest(schema, allConvexModules());
    const { row, runId } = await seed(harness, 'actions-pending', heldSet);

    await harness.run(async (ctx) => {
      await rejectActionsInTransaction(
        ctx,
        row,
        { workItemId: row._id, pendingRunId: runId, reason: 'wrong customer' },
        'channel',
        '1787770800.000200',
      );
    });

    const rejected = await reread(harness, row._id);
    expect(rejected).toMatchObject({
      state: 'failed',
      skipReason: 'rejected by the manager: wrong customer',
      managerFeedback: { reason: 'wrong customer', kind: 'rejection', runId },
      rejectedAt: expect.any(Number),
      decision: { outcome: 'rejected', decidedVia: 'channel', decidedTs: '1787770800.000200' },
    });
    expect(rejected.pendingRunId).toBeUndefined();
    expect(rejected.actionVerdicts).toBeUndefined();
    const corrections = await harness.run(
      async (ctx) => await ctx.db.query('corrections').collect(),
    );
    expect(corrections.map((correction) => correction.kind)).toEqual(['rejection']);
  });
});
