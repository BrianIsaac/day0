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

  it('leaves an audit event when the one request could not be delivered', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'ab3xyz',
    });
    await harness.mutation(internal.work.recordDecisionRequest, {
      workItemId,
      decisionId: 'ab3xyz',
      failure: 'Slack returned HTTP 503.',
    });
    expect((await readItem(harness, workItemId)).decision).toMatchObject({
      id: 'ab3xyz',
      requestFailure: 'Slack returned HTTP 503.',
      requestFailedAt: expect.any(Number),
    });
    // The request is single-use even when it did not land: the dashboard decides,
    // and the feed says why no channel reply is coming.
    expect(
      (await eventsOfType(harness, agentId, 'work.decision-request-failed')).map(
        (event) => event.payload,
      ),
    ).toEqual([{ workItemId, decisionId: 'ab3xyz', kind: 'plan', reason: 'Slack returned HTTP 503.' }]);
    expect(
      await harness.mutation(internal.work.prepareDecisionRequest, {
        workItemId,
        kind: 'plan',
        decisionId: 'cd4uvw',
      }),
    ).toEqual({ prepared: false, reason: 'decision request already claimed' });
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

  it('keeps the decision poll checkpoint independent and monotonic', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seed(harness, 'plan-pending', undefined, { withSlack: true });
    const surfaceId = await harness.run(async (ctx) => {
      const surface = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
        .unique();
      if (!surface) throw new Error('chat surface missing');
      await ctx.db.patch(surface._id, { lastPolledAt: 100 });
      return surface._id;
    });

    await harness.mutation(internal.work.recordDecisionPoll, { surfaceId, polledAt: 300 });
    await harness.mutation(internal.work.recordDecisionPoll, { surfaceId, polledAt: 200 });

    expect(await harness.run(async (ctx) => await ctx.db.get(surfaceId))).toMatchObject({
      lastPolledAt: 100,
      lastDecisionPolledAt: 300,
    });

    // A failure must be visible on the row and must not move the checkpoint
    // past the window it could not read.
    await harness.mutation(internal.work.recordDecisionPoll, {
      surfaceId,
      failure: `decision poll failed: ${'x'.repeat(300)}`,
    });
    const failed = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(failed?.lastDecisionPolledAt).toBe(300);
    expect(failed?.lastDecisionError).toHaveLength(240);

    await harness.mutation(internal.work.recordDecisionPoll, { surfaceId, polledAt: 400 });
    const recovered = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(recovered?.lastDecisionPolledAt).toBe(400);
    expect(recovered?.lastDecisionError).toBeUndefined();
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
    expect(
      (await scheduledFunctionNames(harness)).filter(
        (name) => name === 'managerChannelActions:sendManagerReplyNotice',
      ),
    ).toHaveLength(1);
    expect(
      await harness.run(async (ctx) =>
        await ctx.db
          .query('managerDecisionNotices')
          .withIndex('by_surface_message', (q) =>
            q.eq('surfaceId', surfaceId).eq('messageTs', '1.100'),
          )
          .unique(),
      ),
    ).toMatchObject({
      workItemId,
      decisionId: 'gh6npq',
      kind: 'received',
      text: 'Approval gh6npq received. I’m starting the approved plan now.',
    });
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
    expect(
      await harness.run(async (ctx) => await ctx.db.query('managerDecisionNotices').collect()),
    ).toEqual([]);
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
    expect(
      await harness.run(async (ctx) => await ctx.db.query('managerDecisionNotices').collect()),
    ).toEqual([
      expect.objectContaining({
        kind: 'received',
        text: 'Approval pq8rst received. I’m applying the approved actions now.',
      }),
    ]);
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.rejectActions, {
        workItemId,
        pendingRunId: runId,
        reason: 'too late',
      }),
    ).rejects.toThrow('actions have already been approved');
    expect(await eventsOfType(harness, agentId, 'work.decision-ignored')).toHaveLength(1);
  });

  it('notifies the manager once for an unknown token without giving another user an oracle', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    const surfaceId = await chatSurfaceId(harness, agentId);
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'ab3xyz',
    });
    const unknown = {
      surfaceId,
      messageTs: '4.100',
      reply: { verb: 'approve' as const, id: 'cd4uvw' },
    };

    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        ...unknown,
        userId: 'UOTHER',
      }),
    ).resolves.toEqual({ status: 'ignored', reason: 'manager identity mismatch' });
    expect(
      await harness.run(async (ctx) => await ctx.db.query('managerDecisionNotices').collect()),
    ).toEqual([]);

    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        ...unknown,
        userId: 'UMANAGER',
      }),
    ).resolves.toEqual({ status: 'ignored', reason: 'unknown decision id', notified: true });
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        ...unknown,
        userId: 'UMANAGER',
      }),
    ).resolves.toEqual({ status: 'ignored', reason: 'unknown decision id', notified: false });
    expect(
      await harness.run(async (ctx) => await ctx.db.query('managerDecisionNotices').collect()),
    ).toEqual([
      expect.objectContaining({
        surfaceId,
        workItemId,
        decisionId: 'cd4uvw',
        messageTs: '4.100',
        kind: 'unknown',
        text: 'I couldn’t find decision cd4uvw. Check the six-character token and try again.',
      }),
    ]);
    expect(
      (await scheduledFunctionNames(harness)).filter(
        (name) => name === 'managerChannelActions:sendManagerReplyNotice',
      ),
    ).toHaveLength(1);
  });

  it('cancels a plan or fails a run from a channel reject, with the bounded reason and no apply', async (): Promise<void> => {
    useSurfaceMode('real');
    const longReason = `${'x'.repeat(230)}  <script>alert(1)</script>`;

    const planHarness = convexTest(schema, allConvexModules());
    const plan = await seed(planHarness, 'plan-pending', undefined, { withSlack: true });
    await planHarness.mutation(internal.work.prepareDecisionRequest, {
      workItemId: plan.workItemId,
      kind: 'plan',
      decisionId: 'wx2yz3',
    });
    await expect(
      planHarness.mutation(internal.work.resolveChannelDecision, {
        surfaceId: await chatSurfaceId(planHarness, plan.agentId),
        userId: 'UMANAGER',
        messageTs: '5.100',
        reply: { verb: 'reject', id: 'wx2yz3', reason: longReason },
      }),
    ).resolves.toEqual({ status: 'decided', outcome: 'reject' });
    const cancelled = await readItem(planHarness, plan.workItemId);
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      decision: { outcome: 'rejected', decidedVia: 'channel', decidedTs: '5.100' },
    });
    expect(cancelled.skipReason).toBe(`plan cancelled by the manager: ${longReason.slice(0, 200)}`);
    expect(await scheduledFunctionNames(planHarness)).not.toContain(
      'workActions:executeApprovedPlanInternal',
    );
    expect(
      (await eventsOfType(planHarness, plan.agentId, 'work.cancelled')).map((event) => event.payload),
    ).toEqual([
      { workItemId: plan.workItemId, reason: cancelled.skipReason, decidedVia: 'channel' },
    ]);
    expect(
      await planHarness.run(async (ctx) => await ctx.db.query('managerDecisionNotices').collect()),
    ).toEqual([
      expect.objectContaining({
        kind: 'received',
        text: 'Rejection wx2yz3 received. I won’t apply it.',
      }),
    ]);

    const actionsHarness = convexTest(schema, allConvexModules());
    const actions = await seed(actionsHarness, 'executing', ['boss:message', 'linear:read'], {
      withSlack: true,
    });
    await actionsHarness.mutation(internal.work.setActionsPending, {
      workItemId: actions.workItemId,
      runId: actions.runId,
      output: pendingOutput,
    });
    await actionsHarness.mutation(internal.work.prepareDecisionRequest, {
      workItemId: actions.workItemId,
      kind: 'actions',
      decisionId: 'yz3ab4',
    });
    await expect(
      actionsHarness.mutation(internal.work.resolveChannelDecision, {
        surfaceId: await chatSurfaceId(actionsHarness, actions.agentId),
        userId: 'UMANAGER',
        messageTs: '6.100',
        reply: { verb: 'reject', id: 'yz3ab4', reason: 'not this week' },
      }),
    ).resolves.toEqual({ status: 'decided', outcome: 'reject' });
    const failed = await readItem(actionsHarness, actions.workItemId);
    expect(failed).toMatchObject({
      state: 'failed',
      skipReason: 'rejected by the manager: not this week',
      decision: { outcome: 'rejected', decidedVia: 'channel', decidedTs: '6.100' },
    });
    expect(failed.approvedIndexes).toBeUndefined();
    expect(failed.pendingRunId).toBeUndefined();
    expect(await scheduledFunctionNames(actionsHarness)).not.toContain('workActions:applyApprovedActions');
    expect(
      (await eventsOfType(actionsHarness, actions.agentId, 'work.actions-rejected')).map(
        (event) => event.payload,
      ),
    ).toEqual([
      {
        workItemId: actions.workItemId,
        reason: 'rejected by the manager: not this week',
        decidedVia: 'channel',
      },
    ]);
    expect(
      await actionsHarness.run(async (ctx) =>
        await ctx.db.query('managerDecisionNotices').collect(),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'received',
        text: 'Rejection yz3ab4 received. I won’t apply it.',
      }),
    ]);
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
    expect(
      (await scheduledFunctionNames(harness)).filter(
        (name) => name === 'managerChannelActions:sendManagerReplyNotice',
      ),
    ).toHaveLength(1);
    expect(
      await harness.run(async (ctx) => await ctx.db.query('managerDecisionNotices').collect()),
    ).toHaveLength(1);

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
      refusals: [{ index: 3, reason: 'unknown surface' }],
      autonomousActions: false,
    });
  });

  it('refuses a stale connected browser row at hold time when its component is absent', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', '');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing', ['looker:read']);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker',
        displayName: 'Looker',
        class: 'analytics',
        verdict: 'connected',
        whereFound: [],
        path: 'browser-driven',
        endpoint: 'http://looker-tile:8080/',
        toolAllowlist: ['browser_navigate'],
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        createdAt: 1,
      });
    });
    const output = {
      draft: 'Read the tile.',
      notes: '',
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'looker',
            tool: 'browser_navigate',
            toolArgsJson: '{"url":"http://looker-tile:8080/"}',
          },
        },
      ],
    };

    await expect(
      harness.mutation(internal.work.setActionsPending, { workItemId, runId, output }),
    ).resolves.toEqual({ pending: true, phase: 'manager' });
    expect((await readItem(harness, workItemId)).actionVerdicts).toEqual([
      { disposition: 'refused', reason: 'surface not connected (ungranted)' },
    ]);
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

  it('keeps dependent action indexes disjoint when recovering an interrupted apply', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'actions-pending');
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        pendingRunId: runId,
        executionRunId: runId,
        output: { ...pendingOutput, phase: 'dependent', actionIndexOffset: 6 },
        actionVerdicts: [
          { disposition: 'held', reason: HELD_MUTATION },
          { disposition: 'held', reason: HELD_MUTATION },
        ],
      });
    });
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0],
    });
    await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    await harness.mutation(internal.work.recoverInterruptedApply, {
      workItemId,
      pendingRunId: runId,
      phase: 'approved',
    });
    const applied = ((await readItem(harness, workItemId)).output as {
      applied: Array<{ idempotencyKey: string }>;
    }).applied;
    expect(applied.map((entry) => entry.idempotencyKey)).toEqual([
      `${workItemId}:${runId}:6`,
      `${workItemId}:${runId}:7`,
    ]);
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

  it('requires the owning operator to record provider reconciliation before retry', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing');
    await harness.mutation(internal.work.setFailed, {
      workItemId,
      runId,
      reason: 'provider outcome needs review',
      output: {
        actions: [readIssue, workingComment, pendingOutput.actions[1]],
        applied: [
          { tool: 'mcp.call', ok: true, effect: 'read issue', idempotencyKey: 'read' },
          {
            tool: 'mcp.call',
            ok: true,
            effect: 'added audit note',
            providerId: 'comment-17',
            idempotencyKey: 'comment',
          },
          {
            tool: 'mcp.call',
            ok: false,
            outcomeUnknown: true,
            reason: 'provider accepted the request but the response was lost',
            idempotencyKey: 'transition',
          },
        ],
      },
    });

    await expect(
      harness.withIdentity(OWNER).mutation(api.work.reconcileFailed, {
        workItemId,
        confirmed: false,
      }),
    ).rejects.toThrow('explicit provider verification is required');
    await expect(
      harness.withIdentity({ subject: 'intruder' }).mutation(api.work.reconcileFailed, {
        workItemId,
        confirmed: true,
      }),
    ).rejects.toThrow('forbidden');

    await expect(
      harness.withIdentity(OWNER).mutation(api.work.reconcileFailed, {
        workItemId,
        confirmed: true,
      }),
    ).resolves.toEqual({ ok: true, reconciledEntries: 2 });

    const reconciled = await readItem(harness, workItemId);
    expect(reconciled.providerReconciliation).toEqual({
      actor: 'owner',
      confirmedAt: expect.any(Number),
      entries: [
        {
          phase: 'single',
          actionIndex: 1,
          tool: 'mcp.call',
          outcome: 'landed',
          effect: 'added audit note',
          providerId: 'comment-17',
          idempotencyKey: 'comment',
        },
        {
          phase: 'single',
          actionIndex: 2,
          tool: 'mcp.call',
          outcome: 'outcome-unknown',
          reason: 'provider accepted the request but the response was lost',
          idempotencyKey: 'transition',
        },
      ],
    });
    const events = await eventsOfType(harness, agentId, 'work.provider-reconciled');
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      workItemId,
      actor: 'owner',
      confirmedAt: reconciled.providerReconciliation?.confirmedAt,
      entries: reconciled.providerReconciliation?.entries,
    });

    await expect(
      harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId }),
    ).resolves.toEqual({ ok: true, resumeState: 'plan-approved' });
    expect((await readItem(harness, workItemId)).providerReconciliation).toBeUndefined();
  });

  it('retains a failed action ledger on the terminal event for revocation metrics', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing');
    const output = {
      applied: [
        {
          tool: 'mcp.call',
          ok: false,
          reason: 'no grant (linear:read)',
          idempotencyKey: `${workItemId}:${runId}:0`,
        },
      ],
    };
    await harness.mutation(internal.work.setFailed, {
      workItemId,
      runId,
      reason: 'the revoked read was refused',
      output,
    });
    await expect(eventsOfType(harness, agentId, 'work.failed')).resolves.toMatchObject([
      { payload: { workItemId, output } },
    ]);
  });

  it('permits retry after only reads landed and every write failed or stayed held', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'executing');
    await harness.mutation(internal.work.setFailed, {
      workItemId,
      runId,
      reason: 'automatic manager note failed',
      output: {
        actions: [readIssue, workingComment],
        applied: [
          { tool: 'mcp.call', ok: true, idempotencyKey: 'read' },
          { tool: 'mcp.call', ok: false, reason: 'provider refused', idempotencyKey: 'write' },
        ],
      },
    });

    await expect(
      harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId }),
    ).resolves.toEqual({ ok: true, resumeState: 'plan-approved' });
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

  it('claims the dependent authoring turn once and never prepares a second phase', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'executing');
    await expect(
      harness.mutation(internal.work.prepareDependentPhase, {
        workItemId,
        runId,
        output: { ...pendingOutput, needsDependentPhase: true, phase: 'dependent-authoring', applied: [] },
      }),
    ).resolves.toEqual({ prepared: true });
    const first = await harness.mutation(internal.work.claimDependentAuthoring, { workItemId, runId });
    expect(first.claimed).toBe(true);
    await expect(
      harness.mutation(internal.work.claimDependentAuthoring, { workItemId, runId }),
    ).resolves.toEqual({
      claimed: false,
      reason: 'another dependent authoring turn already claimed the run',
    });
    if (!first.claimed) throw new Error('unreachable');
    await expect(
      harness.mutation(internal.work.setActionsPending, {
        workItemId,
        runId,
        authoringAttemptId: first.authoringAttemptId,
        output: { ...pendingOutput, phase: 'dependent', actionIndexOffset: 0, planStepOutcomes: [], initial: {} },
      }),
    ).resolves.toEqual({ pending: true, phase: 'manager' });
    // The closing set is now pending; a second phase cannot be prepared behind it.
    await expect(
      harness.mutation(internal.work.prepareDependentPhase, {
        workItemId,
        runId,
        output: { ...pendingOutput, phase: 'dependent-authoring', applied: [] },
      }),
    ).resolves.toEqual({ prepared: false });
    await expect(
      harness.mutation(internal.work.claimDependentAuthoring, { workItemId, runId }),
    ).resolves.toEqual({ claimed: false, reason: 'dependent phase is not awaiting authoring' });
  });

  it('fences retry on prerequisite writes that landed before a rejected dependent set', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'actions-pending');
    const initial = {
      draft: 'Refreshing the tile.',
      notes: '',
      needsDependentPhase: true,
      phase: 'dependent-authoring',
      actions: [
        { tool: 'mcp.call', args: { surface: 'looker', tool: 'browser_click', toolArgsJson: '{"element":"Save"}' } },
        { tool: 'mcp.call', args: { surface: 'looker', tool: 'browser_snapshot', toolArgsJson: '{}' } },
      ],
      applied: [
        { tool: 'mcp.call', ok: true, effect: 'browser_click on looker · Save', idempotencyKey: 'k0' },
        { tool: 'mcp.call', ok: true, effect: 'browser_snapshot on looker · 74%', idempotencyKey: 'k1' },
      ],
    };
    await harness.run(async (ctx) =>
      await ctx.db.patch(workItemId, {
        pendingRunId: runId,
        executionRunId: runId,
        actionVerdicts: [{ disposition: 'held', reason: HELD_MUTATION }],
        output: {
          ...pendingOutput,
          actions: [pendingOutput.actions[0]],
          phase: 'dependent',
          actionIndexOffset: 2,
          planStepOutcomes: [],
          initial,
        },
      }),
    );
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason: 'not now' });
    expect((await readItem(harness, workItemId)).state).toBe('failed');
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

  it('enforces the autonomous WIP cap when stale claim verdicts arrive together', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'discovered', [], {
      autonomousActions: true,
    });
    const workItemIds = await harness.run(async (ctx): Promise<Id<'workItems'>[]> => {
      const ids = [workItemId];
      for (let index = 1; index < 4; index += 1) {
        ids.push(
          await ctx.db.insert('workItems', {
            agentId,
            sourceCategory: 'ticket-queue',
            sourceSystem: 'linear',
            externalId: `concurrent-${index}`,
            title: `Concurrent item ${index}`,
            contentSummary: 'Evaluated against the same stale open-work count.',
            contentRefs: [],
            state: 'discovered',
            observedAt: 1,
            createdAt: 1,
          }),
        );
      }
      return ids;
    });
    const claim = {
      decision: 'claim',
      value: 80,
      risk: 30,
      requiredPermissions: ['boss:message', 'linear:read'],
    };

    const stored = await Promise.all(
      workItemIds.map(
        async (id) =>
          await harness.mutation(internal.work.setVerdict, { workItemId: id, verdict: claim }),
      ),
    );

    const rows = await harness.run(
      async (ctx): Promise<Doc<'workItems'>[]> =>
        await ctx.db
          .query('workItems')
          .withIndex('by_agent_state', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(rows.filter((row): boolean => row.state === 'claimed')).toHaveLength(3);
    expect(rows.filter((row): boolean => row.verdict?.decision === 'queue')).toHaveLength(1);
    expect(stored.filter((verdict): boolean => verdict.decision === 'claim')).toHaveLength(3);
    expect(stored.filter((verdict): boolean => verdict.decision === 'queue')).toHaveLength(1);
  });
});

describe('manager feedback kept for the retry', (): void => {
  afterEach(restoreSurfaceMode);

  it('stores the full rejection reason beside the truncated skip reason and keeps it through a retry', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await pend(harness);
    const reason = `Do not post a blocker note. ${'The close checks are complete. '.repeat(12)}Rewrite the comment as a close summary.`;
    expect(reason.length).toBeGreaterThan(200);
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason });
    const failed = await readItem(harness, workItemId);
    expect(failed.skipReason).toBe(`rejected by the manager: ${reason.slice(0, 200)}`);
    expect(failed.managerFeedback).toMatchObject({ reason, runId });
    await harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });
    expect((await readItem(harness, workItemId)).managerFeedback?.reason).toBe(reason);
  });
});
