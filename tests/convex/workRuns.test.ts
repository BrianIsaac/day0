/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { OUTCOME_UNKNOWN_REASON } from '../../src/work/reconciliation';
import { STOPPED_PREFIX } from '../../src/work/stop';
import type { AppliedAction } from '../../src/surfaces/types';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

// A transition schedules the next step; on fake timers a job runs only when a test drains it.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

type Harness = TestConvex<typeof schema>;

const OWNER = managerIdentity();

const comment = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: '{"issueId":"REVOPS-1","body":"Audit note."}',
  },
};
const status = {
  tool: 'mcp.call',
  args: { surface: 'linear', tool: 'save_issue', toolArgsJson: '{"id":"REVOPS-1","state":"Done"}' },
};
const heldOutput = { draft: 'Closed the audit note.', notes: '', actions: [comment, status] };

/** An owned employee with Linear connected and one item in the given state. */
async function seed(
  harness: Harness,
  state: Doc<'workItems'>['state'] = 'executing',
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    for (const scope of ['linear:read', 'linear:write']) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'connected',
      endpoint: 'https://mcp.linear.app/mcp',
      path: 'mcp',
      toolAllowlist: ['get_issue', 'save_comment', 'save_issue'],
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      whereFound: [],
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-1',
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state,
      plan: { summary: 'Comment then close.', steps: ['comment', 'close'] },
      observedAt: 1,
      createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId,
      type: 'work.execution-claimed',
      payload: { workItemId },
      createdAt: 1,
    });
    if (state === 'executing') await ctx.db.patch(workItemId, { executionRunId: runId });
    return { agentId, workItemId, runId };
  });
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

/** A held run the manager approved whole, with its apply claimed: an apply in flight. */
async function applyInFlight(harness: Harness): Promise<{
  agentId: Id<'agents'>;
  workItemId: Id<'workItems'>;
  runId: Id<'events'>;
  applyAttemptId: Id<'events'>;
}> {
  const ids = await seed(harness);
  await harness.mutation(internal.workRuns.setActionsPending, {
    workItemId: ids.workItemId,
    runId: ids.runId,
    output: heldOutput,
  });
  await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
    workItemId: ids.workItemId,
    pendingRunId: ids.runId,
    approvedIndexes: [0, 1],
  });
  const claim = await harness.mutation(internal.workRuns.claimApprovedActions, {
    workItemId: ids.workItemId,
  });
  if (!claim.claimed) throw new Error(`apply not claimed: ${claim.reason}`);
  return { ...ids, applyAttemptId: claim.applyAttemptId };
}

const landedComment: AppliedAction = {
  tool: 'mcp.call',
  ok: true,
  effect: 'comment on REVOPS-1',
  providerId: 'comment-1',
  authority: 'manager',
  landedAt: 1_000,
  idempotencyKey: 'key-0',
};

describe('the apply persisted per action (P4-2)', (): void => {
  it('keeps a row that landed before the apply threw landed, and only the rest unknown', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId, applyAttemptId } = await applyInFlight(harness);
    await expect(
      harness.mutation(internal.workRuns.recordApplyOutcome, {
        workItemId,
        applyAttemptId,
        index: 0,
        row: landedComment,
      }),
    ).resolves.toBe(true);

    // The apply's catch, as `applyApprovedActions` calls it after a throw.
    await harness.mutation(internal.work.recoverInterruptedApply, {
      workItemId,
      pendingRunId: runId,
      phase: 'approved',
    });

    const row = await readItem(harness, workItemId);
    const applied = (row.output as { applied: AppliedAction[] }).applied;
    expect(row.state).toBe('failed');
    expect(applied[0]).toMatchObject({
      ok: true,
      providerId: 'comment-1',
      effect: 'comment on REVOPS-1',
    });
    expect(applied[0].reason).toBeUndefined();
    expect(applied[1]).toMatchObject({ ok: false, reason: OUTCOME_UNKNOWN_REASON });
    expect(row.output).not.toHaveProperty('applyProgress');
  });

  it('refuses a row reported after the apply lost its claim, and keeps nothing of it', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await applyInFlight(harness);
    const otherAttempt = await harness.run(
      async (ctx) =>
        await ctx.db.insert('events', {
          agentId: (await ctx.db.get(workItemId))!.agentId,
          type: 'work.actions-applying',
          payload: { workItemId, runId, phase: 'approved' },
          createdAt: 2,
        }),
    );
    await expect(
      harness.mutation(internal.workRuns.recordApplyOutcome, {
        workItemId,
        applyAttemptId: otherAttempt,
        index: 0,
        row: landedComment,
      }),
    ).resolves.toBe(false);
    expect(await readItem(harness, workItemId)).not.toHaveProperty('output.applyProgress');
  });
});

/** The state of a scheduled function, by id. */
async function jobState(harness: Harness, id: Id<'_scheduled_functions'>): Promise<string> {
  const job = await harness.run(async (ctx) => await ctx.db.system.get(id));
  if (!job) throw new Error('scheduled function missing');
  return job.state.kind;
}

describe('Stop on a working item', (): void => {
  it('moves an executing run to failed with the stopped prefix and cancels its scheduled step', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness);
    await harness.run(async (ctx) => await ctx.db.patch(agentId, { autonomousActions: true }));
    // Autonomous actions apply the run's rows on their own: the apply is queued, not yet claimed.
    await expect(
      harness.mutation(internal.workRuns.setActionsPending, {
        workItemId,
        runId,
        output: heldOutput,
      }),
    ).resolves.toEqual({ pending: true, phase: 'auto' });
    const queued = (await readItem(harness, workItemId)).stepJobId;
    if (!queued) throw new Error('the queued apply was not recorded');
    expect(await jobState(harness, queued)).toBe('pending');

    await harness
      .withIdentity(OWNER)
      .mutation(api.workRuns.stopRun, { workItemId, reason: 'Wrong ticket, leave it.' });

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(row.skipReason).toBe(`${STOPPED_PREFIX}stopped by the manager: Wrong ticket, leave it.`);
    expect(row.executionRunId).toBeUndefined();
    expect(row.stepJobId).toBeUndefined();
    expect(await jobState(harness, queued)).toBe('canceled');
    const stopped = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .filter((q) => q.eq(q.field('type'), 'work.stopped'))
          .collect(),
    );
    expect(stopped.map((event) => event.payload)).toEqual([
      {
        workItemId,
        fromState: 'executing',
        actor: 'owner',
        reason: 'Wrong ticket, leave it.',
        applyInFlight: false,
      },
    ]);
  });

  it('cancels the queued execution of an approved plan and runs nothing', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'plan-approved');
    // The sweep queues the approved plan's execution, as every route to `plan-approved` does.
    await harness.mutation(internal.work.resumeStalledSteps, {});
    const queued = (await readItem(harness, workItemId)).stepJobId;
    if (!queued) throw new Error('the queued execution was not recorded');

    await harness.withIdentity(OWNER).mutation(api.workRuns.stopRun, { workItemId });

    expect(await jobState(harness, queued)).toBe('canceled');
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'failed',
      skipReason: `${STOPPED_PREFIX}stopped by the manager`,
    });
  });

  it('refuses every later write of the stopped run at its fence', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness);
    await harness.withIdentity(OWNER).mutation(api.workRuns.stopRun, { workItemId });

    await expect(
      harness.mutation(internal.workRuns.setActionsPending, {
        workItemId,
        runId,
        output: heldOutput,
      }),
    ).resolves.toEqual({ pending: false });
    await expect(
      harness.mutation(internal.workRuns.setCompleted, {
        workItemId,
        runId,
        output: { ...heldOutput, applied: [landedComment, landedComment] },
      }),
    ).rejects.toThrow('execution run changed before completion');
    expect(await readItem(harness, workItemId)).toMatchObject({ state: 'failed' });
  });

  it('accounts for an apply in flight: the reported row stays landed, the rest is unknown, never lost', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, applyAttemptId } = await applyInFlight(harness);
    await harness.mutation(internal.workRuns.recordApplyOutcome, {
      workItemId,
      applyAttemptId,
      index: 0,
      row: landedComment,
    });

    await harness.withIdentity(OWNER).mutation(api.workRuns.stopRun, { workItemId });

    const row = await readItem(harness, workItemId);
    const applied = (row.output as { applied: AppliedAction[] }).applied;
    expect(row.state).toBe('failed');
    expect(row.skipReason).toBe(`${STOPPED_PREFIX}stopped by the manager`);
    expect(applied[0]).toMatchObject({ ok: true, providerId: 'comment-1' });
    expect(applied[1]).toMatchObject({ ok: false, reason: OUTCOME_UNKNOWN_REASON });
    expect(row.applyAttemptId).toBeUndefined();
    // The apply's next report is refused, so it sends nothing more.
    await expect(
      harness.mutation(internal.workRuns.recordApplyOutcome, {
        workItemId,
        applyAttemptId,
        index: 1,
        row: { ...landedComment, idempotencyKey: 'key-1' },
      }),
    ).resolves.toBe(false);
    const stopped = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .filter((q) => q.eq(q.field('type'), 'work.stopped'))
          .first(),
    );
    expect(stopped?.payload).toMatchObject({ applyInFlight: true });
  });

  it('refuses an item that is not under way, and another manager’s item', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'plan-pending');
    await expect(
      harness.withIdentity(OWNER).mutation(api.workRuns.stopRun, { workItemId }),
    ).rejects.toThrow('Only work under way can be stopped');
    const working = await seed(harness, 'executing');
    await expect(
      harness
        .withIdentity(managerIdentity('someone-else@example.com'))
        .mutation(api.workRuns.stopRun, { workItemId: working.workItemId }),
    ).rejects.toThrow();
    expect(await readItem(harness, working.workItemId)).toMatchObject({ state: 'executing' });
  });
});
