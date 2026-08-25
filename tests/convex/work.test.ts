/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

afterEach((): void => {
  restoreSurfaceMode();
});

type Harness = TestConvex<typeof schema>;

const OWNER = { subject: 'owner' };
const pendingOutput = {
  draft: 'Prepared the close summary.',
  notes: '',
  actions: [
    { tool: 'mcp.call', args: { surface: 'linear', tool: 'create_comment', toolArgsJson: '{"issueId":"i","body":"b"}' } },
    { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_issue', toolArgsJson: '{"id":"i","status":"Done"}' } },
  ],
};

/**
 * Seed an owned agent with one work item in the given state and a run claim.
 *
 * Args:
 *   harness: Convex test harness.
 *   state: Initial work item state.
 *
 * Returns:
 *   The agent, work item and claim event ids.
 */
async function seed(
  harness: Harness,
  state: Doc<'workItems'>['state'] = 'executing',
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'Priya',
      userId: 'owner',
      state: 'active',
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
    return { agentId, workItemId, runId };
  });
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

async function eventTypes(harness: Harness, agentId: Id<'agents'>): Promise<string[]> {
  const rows = await harness.run(
    async (ctx) =>
      await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .collect(),
  );
  return rows.map((row) => row.type);
}

async function scheduledFunctionNames(harness: Harness): Promise<string[]> {
  const rows = await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect());
  return rows.map((row) => row.name);
}

async function pend(harness: Harness): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  const ids = await seed(harness, 'executing');
  await harness.mutation(internal.work.setActionsPending, {
    workItemId: ids.workItemId,
    runId: ids.runId,
    output: pendingOutput,
  });
  return ids;
}

describe('the exact-action gate', (): void => {
  it('holds an executing run with its literal actions and run id', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing');
    const result = await harness.mutation(internal.work.setActionsPending, { workItemId, runId, output: pendingOutput });
    expect(result).toEqual({ pending: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('actions-pending');
    expect(row.pendingRunId).toBe(runId);
    expect(row.approvedIndexes).toBeUndefined();
    expect(row.output).toEqual(pendingOutput);
    expect(await eventTypes(harness, agentId)).toContain('work.actions-pending');
  });

  it('refuses to hold a run that is not executing, and an output without actions', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'completed');
    await expect(harness.mutation(internal.work.setActionsPending, { workItemId, runId, output: pendingOutput })).resolves.toEqual({ pending: false });
    expect((await readItem(harness, workItemId)).state).toBe('completed');
    const executing = await seed(harness, 'executing');
    await expect(
      harness.mutation(internal.work.setActionsPending, {
        workItemId: executing.workItemId,
        runId: executing.runId,
        output: { draft: 'd', notes: '' },
      }),
    ).rejects.toThrow('output.actions must be a list');
  });

  it('records one approval decision and refuses a competing decision', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await pend(harness);
    const result = await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, approvedIndexes: [1, 0, 1] });
    expect(result).toEqual({ ok: true, approvedIndexes: [0, 1] });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('actions-pending');
    expect(row.approvedIndexes).toEqual([0, 1]);
    expect(row.pendingRunId).toBe(runId);
    const events = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .filter((q) => q.eq(q.field('type'), 'work.actions-approved'))
          .collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ workItemId, runId, approvedIndexes: [0, 1], heldIndexes: [] });
    expect(await scheduledFunctionNames(harness)).toEqual(['workActions:applyApprovedActions']);
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        approvedIndexes: [],
      }),
    ).rejects.toThrow('actions have already been approved');
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.rejectActions, {
        workItemId,
        reason: 'replace the first decision',
      }),
    ).rejects.toThrow('actions have already been approved');
    expect(await scheduledFunctionNames(harness)).toEqual(['workActions:applyApprovedActions']);
  });

  it('refuses approval from a non-owner, in the wrong state, or for an index outside the list', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await pend(harness);
    await expect(harness.withIdentity({ subject: 'intruder' }).mutation(api.work.approveActions, { workItemId, approvedIndexes: [0] })).rejects.toThrow('forbidden');
    await expect(harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, approvedIndexes: [2] })).rejects.toThrow('outside the pending list');
    await expect(harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, approvedIndexes: [-1] })).rejects.toThrow('outside the pending list');
    const other = await seed(harness, 'plan-approved');
    await expect(harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId: other.workItemId, approvedIndexes: [] })).rejects.toThrow('expected actions-pending');
    expect(await scheduledFunctionNames(harness)).toEqual([]);
  });

  it('rejects to failed with the reason, keeps the draft, and retries from plan-approved', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await pend(harness);
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, { workItemId, reason: 'wrong issue' });
    const failed = await readItem(harness, workItemId);
    expect(failed.state).toBe('failed');
    expect(failed.skipReason).toBe('rejected by the manager: wrong issue');
    expect(failed.pendingRunId).toBeUndefined();
    expect(failed.output).toEqual(pendingOutput);
    expect(await eventTypes(harness, agentId)).toContain('work.actions-rejected');
    await expect(harness.withIdentity(OWNER).mutation(api.work.rejectActions, { workItemId, reason: 'again' })).rejects.toThrow('expected actions-pending');
    const retried = await harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });
    expect(retried).toEqual({ ok: true, resumeState: 'plan-approved' });
    expect((await readItem(harness, workItemId)).state).toBe('plan-approved');
    const blank = await pend(harness);
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, { workItemId: blank.workItemId, reason: '  ' });
    expect((await readItem(harness, blank.workItemId)).skipReason).toBe('rejected by the manager');
  });

  it('claims the approved actions exactly once with the preserved run id', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await pend(harness);
    await expect(harness.mutation(internal.work.claimApprovedActions, { workItemId })).resolves.toEqual({
      claimed: false,
      reason: 'no actions have been approved',
    });
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, approvedIndexes: [0] });
    const claim = await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    expect(claim).toMatchObject({ claimed: true, runId, approvedIndexes: [0], output: pendingOutput });
    expect((await readItem(harness, workItemId)).state).toBe('executing');
    await expect(harness.mutation(internal.work.claimApprovedActions, { workItemId })).resolves.toEqual({
      claimed: false,
      reason: 'workItem state is executing; expected actions-pending',
    });
  });

  it('completes a run whose only unlanded rows are held, and clears the gate fields', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await pend(harness);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, approvedIndexes: [0] });
    await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    await harness.mutation(internal.work.setCompleted, {
      workItemId,
      output: {
        ...pendingOutput,
        applied: [
          { tool: 'mcp.call', ok: true, effect: 'landed', idempotencyKey: 'k0' },
          { tool: 'mcp.call', ok: true, held: true, reason: 'not approved by the manager', idempotencyKey: 'k1' },
        ],
      },
    });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    expect(row.pendingRunId).toBeUndefined();
    expect(row.approvedIndexes).toBeUndefined();
  });

  it('still refuses to complete a run with a failed unheld action', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'executing');
    await expect(
      harness.mutation(internal.work.setCompleted, {
        workItemId,
        output: {
          applied: [
            { tool: 'mcp.call', ok: true, held: true, idempotencyKey: 'k0' },
            { tool: 'mcp.call', ok: false, reason: 'no grant', idempotencyKey: 'k1' },
          ],
        },
      }),
    ).rejects.toThrow('1 action(s) that did not change the work environment');
  });

  it('counts a pending run as open work and as an existing claim', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await pend(harness);
    await expect(harness.withIdentity(OWNER).query(api.work.countOpenForAgent, { agentId })).resolves.toBe(1);
    await expect(
      harness.withIdentity(OWNER).query(api.work.findExistingClaim, { agentId, sourceSystem: 'linear', externalId: 'REVOPS-1' }),
    ).resolves.toEqual({ state: 'actions-pending' });
  });
});
