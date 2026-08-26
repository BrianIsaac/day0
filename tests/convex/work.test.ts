/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { PLAN_CANCELLED_REASON } from '../../convex/work';
import { AWAITING_APPROVAL, HELD_MUTATION, HELD_PUBLIC_POST } from '../../src/surfaces/policy';
import { autonomousActionsOn } from '../../src/work/autonomy';
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
    { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{"issueId":"i","body":"b"}' } },
    { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_issue', toolArgsJson: '{"id":"i","state":"Done"}' } },
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
interface SeedOptions {
  /** The agent's autonomous-actions switch; absent seeds a row without the field (off). */
  autonomousActions?: boolean;
  /** Writes the fields the posture ladder used to write, to prove rows carrying them still load. */
  legacyLadderFields?: boolean;
  /** A connected Slack surface beside Linear. */
  withSlack?: boolean;
}

async function seed(
  harness: Harness,
  state: Doc<'workItems'>['state'] = 'executing',
  grants: string[] = ['boss:message', 'linear:read', 'linear:write'],
  options: SeedOptions = {},
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'>; runId: Id<'events'>; skillId?: Id<'skills'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      ...(options.autonomousActions !== undefined ? { autonomousActions: options.autonomousActions } : {}),
      ...(options.legacyLadderFields ? { posture: 'supervised' as const } : {}),
      createdAt: 1,
    });
    for (const scope of grants) {
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
    if (options.withSlack) {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'team chat token',
        ciphertext: 'ciphertext',
        iv: 'iv',
        source: 'entered',
        createdAt: 1,
      });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        endpoint: 'https://slack.com/api/',
        path: 'documented-api',
        toolAllowlist: ['chat.postMessage'],
        toolArguments: [{ tool: 'chat.postMessage', arguments: ['channel', 'text'] }],
        managerDmChannelId: 'D0MANAGER',
        managerUserId: 'UMANAGER',
        credentialId,
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      });
    }
    let skillId: Id<'skills'> | undefined;
    if (options.legacyLadderFields) {
      skillId = await ctx.db.insert('skills', {
        agentId,
        name: 'update-linear-ticket',
        description: 'Comment on and close a linear ticket.',
        body: 'Comment, then close.',
        sourceType: 'agent-authored',
        state: 'registered',
        supervisedRunsCompleted: 2,
        createdAt: 1,
        registeredAt: 1,
      });
    }
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
      ...(skillId ? { skillId } : {}),
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
    return { agentId, workItemId, runId, skillId };
  });
}

async function eventsOfType(harness: Harness, agentId: Id<'agents'>, type: string): Promise<Doc<'events'>[]> {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .filter((q) => q.eq(q.field('type'), type))
        .collect(),
  );
}

const readIssue = { tool: 'mcp.call', args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-1"}' } };
const workingComment = {
  tool: 'mcp.call',
  args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{"issueId":"REVOPS-1","body":"Audit note."}' },
};
const managerDm = {
  tool: 'http.request',
  args: { surface: 'slack', method: 'POST', path: '/chat.postMessage', body: '{"channel":"D0MANAGER","text":"Done."}' },
};
const publicReply = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    body: '{"channel":"C0PUBLIC","thread_ts":"1787746453.202809","text":"Covered."}',
  },
};

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
  return rows.map((row) => row.name).sort();
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

describe('plan decisions under the autonomous-actions switch', (): void => {
  it('keeps a drafted plan pending while autonomous actions are off', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'claimed');
    const plan = { summary: 'Check the issue, then update it.', steps: ['check', 'update'] };

    await harness.mutation(internal.work.setPlan, { workItemId, plan });
    expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
      approved: false,
    });
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'plan-pending',
      plan,
    });
    expect(await eventsOfType(harness, agentId, 'work.plan-approved')).toEqual([]);
  });

  it('approves the persisted plan autonomously when the switch is on', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'claimed', undefined, {
      autonomousActions: true,
    });
    const plan = { summary: 'Check the issue, then update it.', steps: ['check', 'update'] };

    await harness.mutation(internal.work.setPlan, { workItemId, plan });
    expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
      approved: true,
    });
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'plan-approved',
      plan,
    });
    expect(
      (await eventsOfType(harness, agentId, 'work.plan-approved')).map((event) => event.payload),
    ).toEqual([{ workItemId, by: 'autonomous' }]);
  });

  it('re-reads a switch flipped after the plan was stored but before the decision', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'claimed');

    await harness.mutation(internal.work.setPlan, {
      workItemId,
      plan: { summary: 'Use the current mode.', steps: ['decide'] },
    });
    await harness.run(async (ctx) => await ctx.db.patch(agentId, { autonomousActions: true }));

    expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
      approved: true,
    });
    expect((await readItem(harness, workItemId)).state).toBe('plan-approved');
  });
});

describe('manager channel request claims', (): void => {
  it('claims a plan decision once and stores the selected chat surface', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'plan-pending', undefined, { withSlack: true });

    const first = await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'ab3xyz',
    });
    expect(first).toMatchObject({
      prepared: true,
      decisionId: 'ab3xyz',
      surface: { slug: 'slack', displayName: 'Slack', managerDmChannelId: 'D0MANAGER' },
    });
    expect(
      await harness.mutation(internal.work.prepareDecisionRequest, {
        workItemId,
        kind: 'plan',
        decisionId: 'cd4uvw',
      }),
    ).toEqual({ prepared: false, reason: 'decision request already claimed' });
    expect((await readItem(harness, workItemId)).decision).toMatchObject({
      id: 'ab3xyz',
      kind: 'plan',
      channel: 'D0MANAGER',
      surfaceName: 'Slack',
    });
  });

  it('claims an action decision only when the parked run has held rows', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(
      harness,
      'executing',
      ['boss:message', 'linear:read'],
      { withSlack: true },
    );
    await harness.mutation(internal.work.setActionsPending, {
      workItemId,
      runId,
      output: pendingOutput,
    });

    const prepared = await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'actions',
      decisionId: 'ef5rst',
    });
    expect(prepared).toMatchObject({ prepared: true, heldIndexes: [0, 1] });
    expect((await readItem(harness, workItemId)).decision).toMatchObject({
      id: 'ef5rst',
      kind: 'actions',
    });
  });

  it('lists the sent, undecided requests intake must read threads under', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    const surfaceId = await harness.run(async (ctx) => {
      const row = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
        .unique();
      if (!row) throw new Error('chat surface missing');
      return row._id;
    });
    expect(await harness.query(internal.work.openDecisionRequests, { surfaceId })).toEqual([]);

    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'ab3xyz',
    });
    // Claimed but not yet landed: there is no thread to read.
    expect(await harness.query(internal.work.openDecisionRequests, { surfaceId })).toEqual([]);
    await harness.mutation(internal.work.recordDecisionRequest, {
      workItemId,
      decisionId: 'ab3xyz',
      ts: '1787770700.000100',
    });
    expect(await harness.query(internal.work.openDecisionRequests, { surfaceId })).toEqual([
      { workItemId, ts: '1787770700.000100' },
    ]);

    await harness.withIdentity(OWNER).mutation(api.work.approvePlan, { workItemId });
    expect(await harness.query(internal.work.openDecisionRequests, { surfaceId })).toEqual([]);
  });

  it('asks for no reply through a chat surface whose manager identity has not been probed', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    // A Slack surface connected before the branch carries the DM channel but no
    // `managerUserId` until its next re-probe. Intake cannot read replies from it,
    // so a request that says "reply approve <id>" would be answered into silence.
    await harness.run(async (ctx) => {
      const slack = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
        .unique();
      if (!slack) throw new Error('chat surface missing');
      await ctx.db.patch(slack._id, { managerUserId: undefined });
    });

    expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
      approved: false,
    });
    expect(await scheduledFunctionNames(harness)).not.toContain(
      'managerChannelActions:requestDecision',
    );
    expect(
      await harness.mutation(internal.work.prepareDecisionRequest, {
        workItemId,
        kind: 'plan',
        decisionId: 'gh6npq',
      }),
    ).toEqual({ prepared: false, reason: 'no connected manager chat channel' });
    expect((await readItem(harness, workItemId)).decision).toBeUndefined();
  });
});

describe('single-use manager decisions', (): void => {
  async function chatSurfaceId(harness: Harness, agentId: Id<'agents'>): Promise<Id<'surfaces'>> {
    return await harness.run(async (ctx) => {
      const row = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
        .unique();
      if (!row) throw new Error('chat surface missing');
      return row._id;
    });
  }

  it('lets a channel plan approval win the race and records its source', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    const surfaceId = await chatSurfaceId(harness, agentId);
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'gh6npq',
    });

    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1.100',
        reply: { verb: 'approve', id: 'gh6npq' },
      }),
    ).resolves.toEqual({ status: 'decided', outcome: 'approve' });
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'plan-approved',
      decision: {
        id: 'gh6npq',
        outcome: 'approved',
        decidedVia: 'channel',
        decidedAt: expect.any(Number),
      },
    });
    expect(await scheduledFunctionNames(harness)).toContain(
      'workActions:executeApprovedPlanInternal',
    );
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approvePlan, { workItemId }),
    ).rejects.toThrow('expected plan-pending');
  });

  it('lets a dashboard plan decision win and acknowledges duplicate channel replies once', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    const surfaceId = await chatSurfaceId(harness, agentId);
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'jk7mnr',
    });
    await harness.withIdentity(OWNER).mutation(api.work.cancelPlan, {
      workItemId,
      reason: 'Use the revised runbook',
    });

    const reply = {
      surfaceId,
      userId: 'UMANAGER',
      reply: { verb: 'approve' as const, id: 'jk7mnr' },
    };
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        ...reply,
        messageTs: '2.100',
      }),
    ).resolves.toEqual({ status: 'already-decided', notified: true });
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        ...reply,
        messageTs: '2.200',
      }),
    ).resolves.toEqual({ status: 'already-decided', notified: false });
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'cancelled',
      skipReason: 'plan cancelled by the manager: Use the revised runbook',
      decision: {
        outcome: 'rejected',
        decidedVia: 'dashboard',
        duplicateNotifiedAt: expect.any(Number),
      },
    });
    expect(
      (await scheduledFunctionNames(harness)).filter(
        (name) => name === 'managerChannelActions:sendDecisionNotice',
      ),
    ).toHaveLength(1);
  });

  it('approves every held action from the channel and ignores another user', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(
      harness,
      'executing',
      ['boss:message', 'linear:read'],
      { withSlack: true },
    );
    const surfaceId = await chatSurfaceId(harness, agentId);
    await harness.mutation(internal.work.setActionsPending, {
      workItemId,
      runId,
      output: pendingOutput,
    });
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'actions',
      decisionId: 'pq8rst',
    });

    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UOTHER',
        messageTs: '3.100',
        reply: { verb: 'approve', id: 'pq8rst' },
      }),
    ).resolves.toEqual({ status: 'ignored', reason: 'manager identity mismatch' });
    expect((await readItem(harness, workItemId)).approvedIndexes).toBeUndefined();
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '3.200',
        reply: { verb: 'approve', id: 'pq8rst' },
      }),
    ).resolves.toEqual({ status: 'decided', outcome: 'approve' });
    expect(await readItem(harness, workItemId)).toMatchObject({
      approvedIndexes: [0, 1],
      applyPhase: 'approved',
      decision: { outcome: 'approved', decidedVia: 'channel' },
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.rejectActions, {
        workItemId,
        pendingRunId: runId,
        reason: 'too late',
      }),
    ).rejects.toThrow('actions have already been approved');
    expect(await eventsOfType(harness, agentId, 'work.decision-ignored')).toHaveLength(1);
  });

  it('stays silent when the reply that decided is read again, and notifies a different reply once', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    const surfaceId = await chatSurfaceId(harness, agentId);
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'tv9wxy',
    });
    const winner = {
      surfaceId,
      userId: 'UMANAGER',
      messageTs: '1787770800.000100',
      reply: { verb: 'approve' as const, id: 'tv9wxy' },
    };
    await expect(harness.mutation(internal.work.resolveChannelDecision, winner)).resolves.toEqual({
      status: 'decided',
      outcome: 'approve',
    });
    expect((await readItem(harness, workItemId)).decision).toMatchObject({
      decidedVia: 'channel',
      decidedTs: '1787770800.000100',
    });

    // The intake reads the checkpoint boundary inclusively and re-reads anything that
    // arrived while a sweep was running, so the winning message comes back on the next
    // poll. That is the manager's one reply, not a duplicate: no notice, no event.
    await expect(harness.mutation(internal.work.resolveChannelDecision, winner)).resolves.toEqual({
      status: 'already-decided',
      notified: false,
    });
    expect((await readItem(harness, workItemId)).decision?.duplicateNotifiedAt).toBeUndefined();
    expect(await eventsOfType(harness, agentId, 'work.decision-duplicate')).toEqual([]);
    expect(
      (await scheduledFunctionNames(harness)).filter(
        (name) => name === 'managerChannelActions:sendDecisionNotice',
      ),
    ).toEqual([]);

    // A second, distinct reply is a duplicate and gets exactly one notice.
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        ...winner,
        messageTs: '1787770900.000100',
        reply: { verb: 'reject', id: 'tv9wxy', reason: 'changed my mind' },
      }),
    ).resolves.toEqual({ status: 'already-decided', notified: true });
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'plan-approved',
      decision: { outcome: 'approved', duplicateNotifiedAt: expect.any(Number) },
    });
    expect(
      (await scheduledFunctionNames(harness)).filter(
        (name) => name === 'managerChannelActions:sendDecisionNotice',
      ),
    ).toHaveLength(1);
  });
});

describe('cancelling a pending plan', (): void => {
  it('records why the item is cancelled and refuses any other state', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending');
    await harness.withIdentity(OWNER).mutation(api.work.cancelPlan, { workItemId });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('cancelled');
    expect(row.skipReason).toBe(PLAN_CANCELLED_REASON);
    const cancelled = await harness.run(
      async (ctx) =>
        (await ctx.db.query('events').withIndex('by_agent', (q) => q.eq('agentId', agentId)).collect()).filter(
          (event) => event.type === 'work.cancelled',
        ),
    );
    expect(cancelled.map((event) => event.payload)).toEqual([
      { workItemId, reason: PLAN_CANCELLED_REASON, decidedVia: 'dashboard' },
    ]);
    await expect(harness.withIdentity(OWNER).mutation(api.work.cancelPlan, { workItemId })).rejects.toThrow(
      'expected plan-pending',
    );
  });
});

describe('the exact-action gate', (): void => {
  it('holds an executing run with its literal actions and run id', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing');
    const result = await harness.mutation(internal.work.setActionsPending, { workItemId, runId, output: pendingOutput });
    expect(result).toEqual({ pending: true, phase: 'manager' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('actions-pending');
    expect(row.pendingRunId).toBe(runId);
    expect(row.approvedIndexes).toBeUndefined();
    expect(row.applyPhase).toBeUndefined();
    expect(row.output).toEqual(pendingOutput);
    // An agent row without the switch is supervised: both writes wait for the manager.
    expect(row.actionVerdicts).toEqual([
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_MUTATION },
    ]);
    expect(await eventTypes(harness, agentId)).toContain('work.actions-pending');
    expect((await eventsOfType(harness, agentId, 'work.actions-pending'))[0].payload).toMatchObject({ autonomousActions: false });
    expect(await scheduledFunctionNames(harness)).toEqual([]);
  });

  it('persists a verdict per action at hold time, with the reason a held row carries', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing', ['boss:message', 'linear:read']);
    const output = {
      ...pendingOutput,
      actions: [
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"i"}' } },
        ...pendingOutput.actions,
        { tool: 'http.request', args: { surface: 'slack', method: 'POST', path: '/chat.postMessage', body: '{"channel":"D0MANAGER","text":"hi"}' } },
      ],
    };
    const result = await harness.mutation(internal.work.setActionsPending, { workItemId, runId, output });
    // The read is automatic, so the run enters the auto phase rather than parking at once.
    expect(result).toEqual({ pending: true, phase: 'auto' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('executing');
    expect(row.applyPhase).toBe('auto');
    expect(row.approvedIndexes).toEqual([0]);
    expect(row.actionVerdicts).toEqual([
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'refused', reason: 'unknown surface' },
    ]);
    const holdEvents = await eventsOfType(harness, agentId, 'work.actions-auto-applying');
    expect(holdEvents[0].payload).toEqual({
      workItemId,
      runId,
      actionCount: 4,
      autoIndexes: [0],
      heldIndexes: [1, 2],
      refusedIndexes: [3],
      autonomousActions: false,
    });
  });

  it('refuses a refused row at approval and applies the rest by selection', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing', ['boss:message', 'linear:read']);
    const output = {
      ...pendingOutput,
      actions: [
        pendingOutput.actions[0],
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'delete_issue', toolArgsJson: '{"id":"i"}' } },
      ],
    };
    await harness.mutation(internal.work.setActionsPending, { workItemId, runId, output });
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0, 1] }),
    ).rejects.toThrow('action 2 is refused (tool not in the surface allowlist (delete_issue)); approve the others by selection');
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [1] }),
    ).rejects.toThrow('action 2 is refused');
    expect((await readItem(harness, workItemId)).approvedIndexes).toBeUndefined();
    expect(await scheduledFunctionNames(harness)).toEqual([]);
    const result = await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0] });
    expect(result).toEqual({ ok: true, approvedIndexes: [0] });
    expect((await readItem(harness, workItemId)).applyPhase).toBe('approved');
    const claim = await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    expect(claim).toMatchObject({
      claimed: true,
      phase: 'approved',
      approvedIndexes: [0],
      heldIndexes: [0],
      heldReasons: [[1, 'tool not in the surface allowlist (delete_issue)']],
      autonomousActions: false,
    });
    const approved = await eventsOfType(harness, agentId, 'work.actions-approved');
    expect(approved[0].payload).toMatchObject({ approvedIndexes: [0], rejectedIndexes: [], refusedIndexes: [1], autoIndexes: [] });
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
    const result = await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [1, 0, 1] });
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
    expect(events[0].payload).toEqual({
      workItemId,
      runId,
      approvedIndexes: [0, 1],
      rejectedIndexes: [],
      refusedIndexes: [],
      autoIndexes: [],
      decidedVia: 'dashboard',
    });
    expect(await scheduledFunctionNames(harness)).toEqual([
      'work:recoverInterruptedApply',
      'workActions:applyApprovedActions',
    ]);
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [],
      }),
    ).rejects.toThrow('actions have already been approved');
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.rejectActions, {
        workItemId,
        pendingRunId: runId,
        reason: 'replace the first decision',
      }),
    ).rejects.toThrow('actions have already been approved');
    expect(await scheduledFunctionNames(harness)).toEqual([
      'work:recoverInterruptedApply',
      'workActions:applyApprovedActions',
    ]);
  });

  it('refuses approval from a non-owner, in the wrong state, or for an index outside the list', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await pend(harness);
    await expect(harness.withIdentity({ subject: 'intruder' }).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0] })).rejects.toThrow('forbidden');
    await expect(harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [2] })).rejects.toThrow('outside the pending list');
    await expect(harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [-1] })).rejects.toThrow('outside the pending list');
    await expect(harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0.5] })).rejects.toThrow('outside the pending list');
    const other = await seed(harness, 'plan-approved');
    await expect(harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId: other.workItemId, pendingRunId: other.runId, approvedIndexes: [] })).rejects.toThrow('expected actions-pending');
    expect(await scheduledFunctionNames(harness)).toEqual([]);
  });

  it('refuses a delayed decision from an older pending run', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await pend(harness);
    const replacementRunId = await harness.run(async (ctx) => {
      const nextRunId = await ctx.db.insert('events', {
        agentId,
        type: 'work.execution-claimed',
        payload: { workItemId },
        createdAt: 2,
      });
      await ctx.db.patch(workItemId, { pendingRunId: nextRunId });
      return nextRunId;
    });

    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [0],
      }),
    ).rejects.toThrow('pending run changed');
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.rejectActions, {
        workItemId,
        pendingRunId: runId,
        reason: 'stale card',
      }),
    ).rejects.toThrow('pending run changed');
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'actions-pending',
      pendingRunId: replacementRunId,
    });
    expect(await scheduledFunctionNames(harness)).toEqual([]);
  });

  it('rejects to failed with the reason, keeps the draft, and retries from plan-approved', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await pend(harness);
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason: 'wrong issue' });
    const failed = await readItem(harness, workItemId);
    expect(failed.state).toBe('failed');
    expect(failed.skipReason).toBe('rejected by the manager: wrong issue');
    expect(failed.pendingRunId).toBeUndefined();
    expect(failed.output).toEqual(pendingOutput);
    expect(await eventTypes(harness, agentId)).toContain('work.actions-rejected');
    await expect(harness.withIdentity(OWNER).mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason: 'again' })).rejects.toThrow('expected actions-pending');
    const retried = await harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });
    expect(retried).toEqual({ ok: true, resumeState: 'plan-approved' });
    expect((await readItem(harness, workItemId)).state).toBe('plan-approved');
    const blank = await pend(harness);
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, { workItemId: blank.workItemId, pendingRunId: blank.runId, reason: '  ' });
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
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0] });
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
    const { workItemId, runId } = await pend(harness);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0] });
    await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    await harness.mutation(internal.work.setCompleted, {
      workItemId,
      runId,
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
    const { workItemId, runId } = await seed(harness, 'executing');
    await expect(
      harness.mutation(internal.work.setCompleted, {
        workItemId,
        runId,
        output: {
          applied: [
            { tool: 'mcp.call', ok: true, held: true, idempotencyKey: 'k0' },
            { tool: 'mcp.call', ok: false, reason: 'no grant', idempotencyKey: 'k1' },
          ],
        },
      }),
    ).rejects.toThrow('1 action(s) that did not change the work environment');
  });

  it('fences a stale run from holding or completing a newer execution', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing');
    const newerRunId = await harness.run(async (ctx) => {
      const id = await ctx.db.insert('events', {
        agentId,
        type: 'work.execution-claimed',
        payload: { workItemId },
        createdAt: 2,
      });
      await ctx.db.patch(workItemId, { executionRunId: id });
      return id;
    });
    await expect(
      harness.mutation(internal.work.setActionsPending, {
        workItemId,
        runId,
        output: pendingOutput,
      }),
    ).resolves.toEqual({ pending: false });
    await expect(
      harness.mutation(internal.work.setCompleted, {
        workItemId,
        runId,
        output: { applied: [{ tool: 'mcp.call', ok: true }] },
      }),
    ).rejects.toThrow('execution run changed');
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'executing',
      executionRunId: newerRunId,
    });
  });

  it('records unknown outcomes after an interrupted apply and refuses replay', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await pend(harness);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0],
    });
    await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    await expect(
      harness.mutation(internal.work.recoverInterruptedApply, {
        workItemId,
        pendingRunId: runId,
        phase: 'approved',
      }),
    ).resolves.toEqual({ recovered: 'outcome-unknown' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(row.pendingRunId).toBe(runId);
    expect((row.output as { applied: unknown[] }).applied).toEqual([
      {
        tool: 'mcp.call',
        ok: false,
        reason: 'outcome unknown after interrupted apply - verify provider before retry',
        idempotencyKey: `${workItemId}:${runId}:0`,
      },
      {
        tool: 'mcp.call',
        ok: true,
        held: true,
        reason: 'not approved by the manager',
        idempotencyKey: `${workItemId}:${runId}:1`,
      },
    ]);
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId }),
    ).rejects.toThrow('reconcile the provider first');
  });

  it('reschedules an approved run that was interrupted before its apply claim', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await pend(harness);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0],
    });
    await expect(
      harness.mutation(internal.work.recoverInterruptedApply, {
        workItemId,
        pendingRunId: runId,
        phase: 'approved',
      }),
    ).resolves.toEqual({ recovered: 'rescheduled' });
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'actions-pending',
      pendingRunId: runId,
      approvedIndexes: [0],
    });
    expect(await scheduledFunctionNames(harness)).toEqual([
      'work:recoverInterruptedApply',
      'work:recoverInterruptedApply',
      'workActions:applyApprovedActions',
      'workActions:applyApprovedActions',
    ]);
  });

  it('refuses retry when part of a failed run already landed', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'executing');
    await harness.mutation(internal.work.setFailed, {
      workItemId,
      runId,
      reason: 'one action failed',
      output: {
        applied: [
          { tool: 'mcp.call', ok: true },
          { tool: 'http.request', ok: false, reason: 'refused' },
        ],
      },
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId }),
    ).rejects.toThrow('reconcile the provider first');
  });

  it('applies the auto rows straight from the hold and parks the held ones after they land', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing', ['boss:message', 'linear:read', 'linear:write', 'slack:read', 'slack:write'], {
      withSlack: true,
    });
    const output = { draft: 'd', notes: '', actions: [readIssue, workingComment, managerDm, publicReply, pendingOutput.actions[1]] };
    const result = await harness.mutation(internal.work.setActionsPending, { workItemId, runId, output });
    expect(result).toEqual({ pending: true, phase: 'auto' });
    const held = await readItem(harness, workItemId);
    expect(held.state).toBe('executing');
    expect(held.applyPhase).toBe('auto');
    expect(held.approvedIndexes).toEqual([0, 2]);
    // The switch is off: the read and the DM apply on their own; the comment,
    // the reply and the state change wait for the manager, write grant or not.
    expect(held.actionVerdicts).toEqual([
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_PUBLIC_POST },
      { disposition: 'held', reason: HELD_MUTATION },
    ]);
    expect(await eventTypes(harness, agentId)).toEqual(['work.execution-claimed', 'work.actions-auto-applying']);
    expect((await eventsOfType(harness, agentId, 'work.actions-auto-applying'))[0].payload).toEqual({
      workItemId,
      runId,
      actionCount: 5,
      autoIndexes: [0, 2],
      heldIndexes: [1, 3, 4],
      refusedIndexes: [],
      autonomousActions: false,
    });
    expect(await scheduledFunctionNames(harness)).toEqual(['work:recoverInterruptedApply', 'workActions:applyApprovedActions']);
    // The manager cannot decide while the auto phase is in flight.
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [3] }),
    ).rejects.toThrow('expected actions-pending');

    const claim = await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    expect(claim).toMatchObject({ claimed: true, phase: 'auto', approvedIndexes: [0, 2], heldIndexes: [1, 3, 4], heldReasons: [], autonomousActions: false });
    if (!claim.claimed) throw new Error('unreachable');
    expect(await harness.mutation(internal.work.claimApprovedActions, { workItemId })).toEqual({
      claimed: false,
      reason: 'workItem state is executing; expected actions-pending',
    });
    const applied = [
      { tool: 'mcp.call', ok: true, effect: 'read', authority: 'standing', idempotencyKey: 'k0' },
      { tool: 'mcp.call', ok: true, held: true, awaitingApproval: true, reason: AWAITING_APPROVAL, idempotencyKey: 'k1' },
      { tool: 'http.request', ok: true, providerId: '1.1', authority: 'standing', idempotencyKey: 'k2' },
      { tool: 'http.request', ok: true, held: true, awaitingApproval: true, reason: AWAITING_APPROVAL, idempotencyKey: 'k3' },
      { tool: 'mcp.call', ok: true, held: true, awaitingApproval: true, reason: AWAITING_APPROVAL, idempotencyKey: 'k4' },
    ];
    await expect(
      harness.mutation(internal.work.setAwaitingApproval, { workItemId, runId, applyAttemptId: runId, output: { ...output, applied } }),
    ).resolves.toEqual({ parked: false });
    await expect(
      harness.mutation(internal.work.setAwaitingApproval, { workItemId, runId, applyAttemptId: claim.applyAttemptId, output: { ...output, applied } }),
    ).resolves.toEqual({ parked: true });
    const parked = await readItem(harness, workItemId);
    expect(parked).toMatchObject({ state: 'actions-pending', pendingRunId: runId, executionRunId: runId });
    expect(parked.approvedIndexes).toBeUndefined();
    expect(parked.applyPhase).toBeUndefined();
    expect(parked.applyAttemptId).toBeUndefined();
    expect((await eventsOfType(harness, agentId, 'work.actions-pending'))[0].payload).toEqual({
      workItemId,
      runId,
      actionCount: 5,
      autoIndexes: [0, 2],
      heldIndexes: [1, 3, 4],
      refusedIndexes: [],
      autoApplied: true,
    });
    // An auto row cannot be approved again; the held ones can, and the claim carries the auto ledger.
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [2, 3] }),
    ).rejects.toThrow('action 3 was applied automatically and cannot be approved again');
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [3] });
    const second = await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    expect(second).toMatchObject({ claimed: true, phase: 'approved', approvedIndexes: [3], heldIndexes: [1, 3, 4] });
    expect((second as { output: { applied: unknown[] } }).output.applied).toEqual(applied);
    expect((await eventsOfType(harness, agentId, 'work.actions-approved'))[0].payload).toMatchObject({
      approvedIndexes: [3],
      rejectedIndexes: [1, 4],
      autoIndexes: [0, 2],
    });
    // No counter, no window: the only events of the run are the gate's own.
    expect((await eventTypes(harness, agentId)).filter((type) => type.startsWith('skill.') || type.startsWith('agent.'))).toEqual([]);
  });

  it('does not let a duplicate hold clear a claimed auto-phase attempt', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(
      harness,
      'executing',
      ['boss:message', 'linear:read', 'linear:write', 'slack:read', 'slack:write'],
      { withSlack: true },
    );
    const output = { draft: 'd', notes: '', actions: [readIssue, publicReply] };
    await harness.mutation(internal.work.setActionsPending, { workItemId, runId, output });
    const firstClaim = await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    if (!firstClaim.claimed) throw new Error('first apply claim missing');

    await expect(
      harness.mutation(internal.work.setActionsPending, { workItemId, runId, output }),
    ).resolves.toEqual({ pending: false });
    expect(await readItem(harness, workItemId)).toMatchObject({
      applyPhase: 'auto',
      applyAttemptId: firstClaim.applyAttemptId,
    });
    await expect(
      harness.mutation(internal.work.claimApprovedActions, { workItemId }),
    ).resolves.toEqual({
      claimed: false,
      reason: 'workItem state is executing; expected actions-pending',
    });
  });

  it('with the switch on classifies every non-refused row auto, and the claim reads the switch as it is then', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    // No write grant at all: the switch is the manager's standing authority for writes.
    const grants = ['boss:message', 'linear:read', 'slack:read'];
    const { agentId, workItemId, runId } = await seed(harness, 'executing', grants, { autonomousActions: true, withSlack: true });
    const output = {
      draft: 'd',
      notes: '',
      actions: [
        readIssue,
        workingComment,
        managerDm,
        publicReply,
        pendingOutput.actions[1],
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'delete_issue', toolArgsJson: '{"id":"REVOPS-1"}' } },
      ],
    };
    const result = await harness.mutation(internal.work.setActionsPending, { workItemId, runId, output });
    expect(result).toEqual({ pending: true, phase: 'auto' });
    const held = await readItem(harness, workItemId);
    expect(held.state).toBe('executing');
    expect(held.approvedIndexes).toEqual([0, 1, 2, 3, 4]);
    expect(held.actionVerdicts).toEqual([
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'refused', reason: 'tool not in the surface allowlist (delete_issue)' },
    ]);
    expect((await eventsOfType(harness, agentId, 'work.actions-auto-applying'))[0].payload).toMatchObject({
      autoIndexes: [0, 1, 2, 3, 4],
      heldIndexes: [],
      refusedIndexes: [5],
      autonomousActions: true,
    });
    const claim = await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    expect(claim).toMatchObject({ claimed: true, phase: 'auto', autonomousActions: true, heldIndexes: [], heldReasons: [[5, 'tool not in the surface allowlist (delete_issue)']] });

    // A read or the DM without its own grant is refused under the switch too.
    const ungranted = await seed(harness, 'executing', ['linear:write'], { autonomousActions: true, withSlack: true });
    await harness.mutation(internal.work.setActionsPending, { workItemId: ungranted.workItemId, runId: ungranted.runId, output: { draft: 'd', notes: '', actions: [readIssue, managerDm, publicReply] } });
    expect((await readItem(harness, ungranted.workItemId)).actionVerdicts).toEqual([
      { disposition: 'refused', reason: 'no grant (linear:read)' },
      { disposition: 'refused', reason: 'no grant (boss:message)' },
      { disposition: 'auto' },
    ]);

    // Turning the switch off between the hold and the apply claim is what the claim reports.
    const flipped = await seed(harness, 'executing', grants, { autonomousActions: true, withSlack: true });
    await harness.mutation(internal.work.setActionsPending, { workItemId: flipped.workItemId, runId: flipped.runId, output: { draft: 'd', notes: '', actions: [publicReply] } });
    await harness.run(async (ctx) => await ctx.db.patch(flipped.agentId, { autonomousActions: false }));
    expect(await harness.mutation(internal.work.claimApprovedActions, { workItemId: flipped.workItemId })).toMatchObject({
      claimed: true,
      phase: 'auto',
      approvedIndexes: [0],
      autonomousActions: false,
    });
  });

  it('reads rows the posture ladder wrote as supervised and leaves the agent row alone on completion', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId, skillId } = await seed(harness, 'executing', undefined, { legacyLadderFields: true });
    if (!skillId) throw new Error('skill missing');
    // The removed fields validate and change nothing: a trusted skill under
    // `supervised` posture used to apply the working comment on its own.
    await harness.mutation(internal.work.setActionsPending, { workItemId, runId, output: { draft: 'd', notes: '', actions: [readIssue, workingComment] } });
    expect((await readItem(harness, workItemId)).actionVerdicts).toEqual([{ disposition: 'auto' }, { disposition: 'held', reason: HELD_MUTATION }]);
    const agent = await harness.run(async (ctx) => await ctx.db.get(agentId));
    expect(agent?.posture).toBe('supervised');
    expect(autonomousActionsOn(agent ?? {})).toBe(false);
    expect((await harness.run(async (ctx) => await ctx.db.get(skillId)))?.supervisedRunsCompleted).toBe(2);

    const done = await seed(harness, 'executing');
    await harness.mutation(internal.work.setCompleted, {
      workItemId: done.workItemId,
      runId: done.runId,
      output: { ...pendingOutput, applied: [{ tool: 'mcp.call', ok: true, idempotencyKey: 'k0' }] },
    });
    const completedAgent = await harness.run(async (ctx) => await ctx.db.get(done.agentId));
    expect(completedAgent?.autonomousActions).toBeUndefined();
    expect(completedAgent?.posture).toBeUndefined();
    expect((await eventTypes(harness, done.agentId)).filter((type) => type.startsWith('agent.'))).toEqual([]);
  });

  it('keeps the auto rows in the ledger when the held ones are rejected, and fences retry on them', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'actions-pending');
    const applied = [
      { tool: 'mcp.call', ok: true, providerId: 'c-1', idempotencyKey: 'k0' },
      { tool: 'mcp.call', ok: true, held: true, awaitingApproval: true, reason: AWAITING_APPROVAL, idempotencyKey: 'k1' },
    ];
    await harness.run(async (ctx) =>
      await ctx.db.patch(workItemId, {
        pendingRunId: runId,
        executionRunId: runId,
        actionVerdicts: [{ disposition: 'auto' }, { disposition: 'held', reason: HELD_MUTATION }],
        output: { ...pendingOutput, applied },
      }),
    );
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason: 'not now' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect((row.output as { applied: unknown[] }).applied).toEqual([
      applied[0],
      { tool: 'mcp.call', ok: true, held: true, reason: 'rejected by the manager: not now', idempotencyKey: 'k1' },
    ]);
    await expect(harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId })).rejects.toThrow('reconcile the provider first');
  });

  it('reschedules an unclaimed auto phase and records unknown outcomes for a claimed one', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'executing', ['boss:message', 'linear:read', 'linear:write', 'slack:read', 'slack:write'], {
      withSlack: true,
    });
    await harness.mutation(internal.work.setActionsPending, { workItemId, runId, output: { draft: 'd', notes: '', actions: [readIssue, publicReply] } });
    await expect(harness.mutation(internal.work.recoverInterruptedApply, { workItemId, pendingRunId: runId, phase: 'auto' })).resolves.toEqual({ recovered: 'rescheduled' });
    await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    await expect(harness.mutation(internal.work.recoverInterruptedApply, { workItemId, pendingRunId: runId, phase: 'auto' })).resolves.toEqual({ recovered: 'outcome-unknown' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect((row.output as { applied: Array<Record<string, unknown>> }).applied.map((entry) => [entry.ok, entry.held ?? false, entry.reason])).toEqual([
      [false, false, 'outcome unknown after interrupted apply - verify provider before retry'],
      [true, true, HELD_PUBLIC_POST],
    ]);
  });

  it('keeps a prior phase\'s landed rows when the approved phase is interrupted', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'actions-pending');
    const landed = { tool: 'mcp.call', ok: true, providerId: 'c-1', idempotencyKey: 'k0' };
    await harness.run(async (ctx) =>
      await ctx.db.patch(workItemId, {
        pendingRunId: runId,
        executionRunId: runId,
        actionVerdicts: [{ disposition: 'auto' }, { disposition: 'held', reason: HELD_MUTATION }],
        output: { ...pendingOutput, applied: [landed, { tool: 'mcp.call', ok: true, held: true, awaitingApproval: true, reason: AWAITING_APPROVAL, idempotencyKey: 'k1' }] },
      }),
    );
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [1] });
    await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    await expect(harness.mutation(internal.work.recoverInterruptedApply, { workItemId, pendingRunId: runId, phase: 'approved' })).resolves.toEqual({ recovered: 'outcome-unknown' });
    const row = await readItem(harness, workItemId);
    expect((row.output as { applied: unknown[] }).applied).toEqual([
      landed,
      expect.objectContaining({ ok: false, reason: 'outcome unknown after interrupted apply - verify provider before retry' }),
    ]);
  });

  it('ignores the auto-phase recovery timer after the manager phase has been claimed', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'actions-pending');
    const landed = { tool: 'mcp.call', ok: true, providerId: 'read-1', idempotencyKey: 'k0' };
    await harness.run(async (ctx) =>
      await ctx.db.patch(workItemId, {
        pendingRunId: runId,
        executionRunId: runId,
        actionVerdicts: [{ disposition: 'auto' }, { disposition: 'held', reason: HELD_MUTATION }],
        output: {
          ...pendingOutput,
          applied: [
            landed,
            {
              tool: 'mcp.call',
              ok: true,
              held: true,
              awaitingApproval: true,
              reason: AWAITING_APPROVAL,
              idempotencyKey: 'k1',
            },
          ],
        },
      }),
    );
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [1],
    });
    await harness.mutation(internal.work.claimApprovedActions, { workItemId });

    await expect(
      harness.mutation(internal.work.recoverInterruptedApply, {
        workItemId,
        pendingRunId: runId,
        phase: 'auto',
      }),
    ).resolves.toEqual({ recovered: 'ignored' });
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'executing',
      applyPhase: 'approved',
      approvedIndexes: [1],
    });
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
