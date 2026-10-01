/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import type { WithoutSystemFields } from 'convex/server';
import { ConvexError } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import {
  DEPENDENT_AUTHORING_INTERRUPTED_REASON,
  DEPENDENT_AUTHORING_RECOVERY_MS,
  INTERRUPTED_APPLY_REASON,
  MANAGER_CHANGED_RESEND_REASON,
  NOTHING_TO_DECIDE_REASON,
  PLAN_CANCELLED_REASON,
  REEVALUATION_BATCH,
  THREAD_NOT_FOUND_REASON,
  UNREADABLE_REPLY_REASON,
  UNSENT_NOTE_REASON,
} from '../../convex/work';
import { AWAITING_APPROVAL, HELD_MUTATION, HELD_PUBLIC_POST } from '../../src/surfaces/policy';
import { openQuestionStopReason } from '../../src/work/obligations';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { runThroughBody } from '../fixtures/run-through-charter-2026-09-14';
import type { Charter } from '../../src/agent/charter';
import { skillBodyHash } from '../../src/work/skill-body';
import { collectLedgerObservations } from '../../convex/metrics';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

// In real mode a transition schedules the server's next step. The scheduler's
// timer is faked for every test here, so a job runs only when a test drains it
// and none outlives the test that scheduled it; the clock stays real.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

type Harness = TestConvex<typeof schema>;

const OWNER = managerIdentity();
const pendingOutput = {
  draft: 'Prepared the close summary.',
  notes: '',
  actions: [
    {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{"issueId":"i","body":"b"}' },
    },
    {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'save_issue', toolArgsJson: '{"id":"i","state":"Done"}' },
    },
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
  /** A connected Slack surface beside Linear. */
  withSlack?: boolean;
}

async function seed(
  harness: Harness,
  state: Doc<'workItems'>['state'] = 'executing',
  grants: string[] = ['boss:message', 'linear:read', 'linear:write'],
  options: SeedOptions = {},
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      ...(options.autonomousActions !== undefined
        ? { autonomousActions: options.autonomousActions }
        : {}),
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

async function eventsOfType(
  harness: Harness,
  agentId: Id<'agents'>,
  type: string,
): Promise<Doc<'events'>[]> {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .filter((q) => q.eq(q.field('type'), type))
        .collect(),
  );
}

const readIssue = {
  tool: 'mcp.call',
  args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-1"}' },
};
const workingComment = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: '{"issueId":"REVOPS-1","body":"Audit note."}',
  },
};
const managerDm = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    body: '{"channel":"D0MANAGER","text":"Done."}',
  },
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
  const rows = await harness.run(
    async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
  );
  return rows.map((row) => row.name).sort();
}

async function pend(
  harness: Harness,
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  const ids = await seed(harness, 'executing');
  await harness.mutation(internal.work.setActionsPending, {
    workItemId: ids.workItemId,
    runId: ids.runId,
    output: pendingOutput,
  });
  return ids;
}

/** A second parked run under the same agent, so a batch has two members. */
async function pendAnother(
  harness: Harness,
  agentId: Id<'agents'>,
  title = 'Close REVOPS-2',
): Promise<{ workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  const ids = await harness.run(async (ctx) => {
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: title,
      title,
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state: 'executing',
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
    await ctx.db.patch(workItemId, { executionRunId: runId });
    return { workItemId, runId };
  });
  await harness.mutation(internal.work.setActionsPending, { ...ids, output: pendingOutput });
  return ids;
}

describe('batched decisions', (): void => {
  it('approves held actions across items in one transaction, each fenced by its own run', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const first = await pend(harness);
    const second = await pendAnother(harness, first.agentId);

    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActionsBatch, {
        members: [
          { workItemId: first.workItemId, pendingRunId: first.runId, approvedIndexes: [0, 1] },
          { workItemId: second.workItemId, pendingRunId: second.runId, approvedIndexes: [0] },
        ],
      }),
    ).resolves.toEqual({
      ok: true,
      approved: [
        { workItemId: first.workItemId, approvedIndexes: [0, 1] },
        { workItemId: second.workItemId, approvedIndexes: [0] },
      ],
    });
    expect(await readItem(harness, first.workItemId)).toMatchObject({
      applyPhase: 'approved',
      approvedIndexes: [0, 1],
    });
    expect(await readItem(harness, second.workItemId)).toMatchObject({
      applyPhase: 'approved',
      approvedIndexes: [0],
    });
    const approvals = await eventsOfType(harness, first.agentId, 'work.actions-approved');
    expect(approvals.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        workItemId: first.workItemId,
        runId: first.runId,
        approvedIndexes: [0, 1],
        rejectedIndexes: [],
        decidedVia: 'dashboard',
      }),
      expect.objectContaining({
        workItemId: second.workItemId,
        runId: second.runId,
        approvedIndexes: [0],
        rejectedIndexes: [1],
        decidedVia: 'dashboard',
      }),
    ]);
    expect(
      (await scheduledFunctionNames(harness)).filter(
        (name) => name === 'workActions:applyApprovedActions',
      ),
    ).toHaveLength(2);
  });

  it('refuses the whole batch when one member has moved on, approving nothing', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const first = await pend(harness);
    const second = await pendAnother(harness, first.agentId);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId: first.workItemId,
      pendingRunId: first.runId,
      approvedIndexes: [0],
    });

    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActionsBatch, {
        members: [
          { workItemId: second.workItemId, pendingRunId: second.runId, approvedIndexes: [0, 1] },
          { workItemId: first.workItemId, pendingRunId: first.runId, approvedIndexes: [0, 1] },
        ],
      }),
    ).rejects.toThrow('actions have already been approved');
    expect((await readItem(harness, second.workItemId)).approvedIndexes).toBeUndefined();
    await expect(
      harness.withIdentity(managerIdentity('intruder')).mutation(api.work.approveActionsBatch, {
        members: [
          { workItemId: second.workItemId, pendingRunId: second.runId, approvedIndexes: [0] },
        ],
      }),
    ).rejects.toThrow('forbidden');
  });

  async function batchOnChannel(harness: Harness): Promise<{
    agentId: Id<'agents'>;
    surfaceId: Id<'surfaces'>;
    first: { workItemId: Id<'workItems'>; runId: Id<'events'> };
    second: { workItemId: Id<'workItems'>; runId: Id<'events'> };
  }> {
    const ids = await seed(harness, 'executing', undefined, { withSlack: true });
    await harness.mutation(internal.work.setActionsPending, {
      workItemId: ids.workItemId,
      runId: ids.runId,
      output: pendingOutput,
    });
    const second = await pendAnother(harness, ids.agentId);
    const surfaceId = await harness.run(async (ctx) => {
      const row = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', ids.agentId).eq('slug', 'slack'))
        .unique();
      if (!row) throw new Error('chat surface missing');
      return row._id;
    });
    for (const [item, decisionId] of [
      [ids, 'gh6npq'],
      [second, 'hk7rst'],
    ] as const) {
      await harness.mutation(internal.work.prepareDecisionRequest, {
        workItemId: item.workItemId,
        kind: 'actions',
        decisionId,
      });
      await harness.mutation(internal.work.recordDecisionRequest, {
        workItemId: item.workItemId,
        decisionId,
        ts: `1.${decisionId}`,
      });
    }
    await expect(
      harness.mutation(internal.work.prepareDecisionBatch, {
        agentId: ids.agentId,
        batchId: 'bq2wxy',
        surfaceSlug: 'slack',
        channel: 'D0MANAGER',
        members: [
          { workItemId: ids.workItemId, decisionId: 'gh6npq', pendingRunId: ids.runId },
          { workItemId: second.workItemId, decisionId: 'hk7rst', pendingRunId: second.runId },
        ],
      }),
    ).resolves.toEqual({ prepared: true });
    return { agentId: ids.agentId, surfaceId, first: ids, second };
  }

  it('marks a batch decided once its last member is decided one at a time, so it leaves the open read (S2 D6)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId, first, second } = await batchOnChannel(harness);
    const batch = async (): Promise<Doc<'decisionBatches'> | null> =>
      await harness.run(
        async (ctx) =>
          await ctx.db
            .query('decisionBatches')
            .withIndex('by_agent_id', (q) => q.eq('agentId', agentId).eq('id', 'bq2wxy'))
            .unique(),
      );
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId: second.workItemId,
      pendingRunId: second.runId,
      approvedIndexes: [0],
    });
    // One member is still open, so the batch is too.
    expect((await batch())?.decidedAt).toBeUndefined();
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, {
      workItemId: first.workItemId,
      pendingRunId: first.runId,
      reason: 'not this week',
    });
    // Decided member by member: no single outcome, and no reply decided it.
    expect(await batch()).toMatchObject({ decidedAt: expect.any(Number) });
    expect((await batch())?.outcome).toBeUndefined();
    expect((await batch())?.decidedTs).toBeUndefined();
    const open = await harness.query(internal.work.openDecisions, { surfaceId });
    expect(open.batches).toEqual([]);
  });

  it('settles a batch whose last open member left by a new code, not a decision', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId, first, second } = await batchOnChannel(harness);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId: second.workItemId,
      pendingRunId: second.runId,
      approvedIndexes: [0],
    });
    // The first member's thread is gone, so its request is marked failed and
    // sent again under a new code: the batch's code no longer decides it.
    await expect(
      harness.mutation(internal.work.closeDecisionThread, { surfaceId, decisionId: 'gh6npq' }),
    ).resolves.toBe(true);
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId: first.workItemId,
      kind: 'actions',
      decisionId: 'jm8uvw',
      supersedes: 'gh6npq',
    });
    const batch = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('decisionBatches')
          .withIndex('by_agent_id', (q) => q.eq('agentId', agentId).eq('id', 'bq2wxy'))
          .unique(),
    );
    expect(batch).toMatchObject({ decidedAt: expect.any(Number) });
    expect(batch?.outcome).toBeUndefined();
  });

  it('decides every open member of a batch code from one channel reply, and names what it left', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId, first, second } = await batchOnChannel(harness);
    // The manager decided the second one from the dashboard meanwhile.
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId: second.workItemId,
      pendingRunId: second.runId,
      approvedIndexes: [0],
    });

    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1.200',
        reply: { verb: 'approve', id: 'bq2wxy' },
      }),
    ).resolves.toEqual({
      status: 'decided',
      outcome: 'approve',
      decided: ['gh6npq'],
      skipped: [{ decisionId: 'hk7rst', reason: 'already approved' }],
    });
    expect(await readItem(harness, first.workItemId)).toMatchObject({
      applyPhase: 'approved',
      approvedIndexes: [0, 1],
      decision: { id: 'gh6npq', outcome: 'approved', decidedVia: 'channel', decidedTs: '1.200' },
    });
    expect(await readItem(harness, second.workItemId)).toMatchObject({
      approvedIndexes: [0],
      decision: { decidedVia: 'dashboard' },
    });
    const batch = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('decisionBatches')
          .withIndex('by_agent_id', (q) => q.eq('agentId', agentId).eq('id', 'bq2wxy'))
          .unique(),
    );
    expect(batch).toMatchObject({
      outcome: 'approved',
      decidedTs: '1.200',
      decidedAt: expect.any(Number),
    });
    const notice = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('managerDecisionNotices')
          .withIndex('by_surface_message', (q) =>
            q.eq('surfaceId', surfaceId).eq('messageTs', '1.200'),
          )
          .unique(),
    );
    expect(notice?.text).toBe(
      'Approval bq2wxy received for 1 of 2 decisions (gh6npq). I’m applying the approved actions now. Left as they were: hk7rst: already approved.',
    );
    expect(
      (await eventsOfType(harness, agentId, 'work.decision-batch-decided')).map(
        (event) => event.payload,
      ),
    ).toEqual([
      {
        batchId: 'bq2wxy',
        outcome: 'approved',
        decided: ['gh6npq'],
        skipped: [{ decisionId: 'hk7rst', reason: 'already approved' }],
        messageTs: '1.200',
      },
    ]);

    // The same code again is single-use, like an item's.
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1.300',
        reply: { verb: 'approve', id: 'bq2wxy' },
      }),
    ).resolves.toEqual({ status: 'already-decided', notified: true });
  });

  it('rejects every open member of a batch with the reason on each item', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, first, second } = await batchOnChannel(harness);
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1.200',
        reply: { verb: 'reject', id: 'bq2wxy', reason: 'not this week' },
      }),
    ).resolves.toEqual({
      status: 'decided',
      outcome: 'reject',
      decided: ['gh6npq', 'hk7rst'],
      skipped: [],
    });
    for (const item of [first, second]) {
      expect(await readItem(harness, item.workItemId)).toMatchObject({
        state: 'failed',
        skipReason: 'rejected by the manager: not this week',
        managerFeedback: { reason: 'not this week', kind: 'rejection' },
        decision: { outcome: 'rejected', decidedVia: 'channel' },
      });
    }
    // The reason is kept once per item for each item's employee's later work.
    const kept = await harness.run(async (ctx) => await ctx.db.query('corrections').collect());
    expect(kept.map((row) => [row.workItemId, row.kind, row.text]).sort()).toEqual(
      [
        [first.workItemId, 'rejection', 'not this week'],
        [second.workItemId, 'rejection', 'not this week'],
      ].sort(),
    );
  });

  it('answers a batch code the poller hands to the resolver only from the manager on its own channel', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await batchOnChannel(harness);
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'USOMEONE',
        messageTs: '1.200',
        reply: { verb: 'approve', id: 'bq2wxy' },
      }),
    ).resolves.toEqual({ status: 'ignored', reason: 'manager identity mismatch' });
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1.201',
        reply: { verb: 'approve', id: 'zz9zzz' },
      }),
    ).resolves.toMatchObject({ status: 'ignored', reason: 'unknown decision id' });
  });
});

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

  it.each([
    ['quality-fit', { qualityFitWaivedAt: 5 }],
    ['scope', { scopeWaivedAt: 5 }],
  ] as const)(
    'holds the plan of an item the manager took anyway after a %s skip, whatever the switch says',
    async (waived, waiver): Promise<void> => {
      useSurfaceMode('real');
      const harness = convexTest(schema, allConvexModules());
      const { agentId, workItemId } = await seed(harness, 'claimed', undefined, {
        autonomousActions: true,
      });
      await harness.run(async (ctx) => await ctx.db.patch(workItemId, waiver));
      const plan = { summary: 'Check the issue, then update it.', steps: ['check', 'update'] };

      await harness.mutation(internal.work.setPlan, { workItemId, plan });
      expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
        approved: false,
      });
      expect((await readItem(harness, workItemId)).state).toBe('plan-pending');
      expect(await eventsOfType(harness, agentId, 'work.plan-approved')).toEqual([]);
      expect(
        (await eventsOfType(harness, agentId, 'work.plan-held')).map((event) => event.payload),
      ).toEqual([{ workItemId, reason: 'skip-overruled', waived }]);
      // The sweep re-deciding the row does not log the hold again.
      await harness.mutation(internal.work.decidePlan, { workItemId, recovery: true });
      expect(await eventsOfType(harness, agentId, 'work.plan-held')).toHaveLength(1);
    },
  );

  it.each([
    [
      'the planner’s fields standing unchecked',
      {
        obligations: {
          steps: [
            { reads: [], writes: [], kind: 'read' },
            { reads: [], writes: ['linear'], kind: 'write' },
          ],
          transition: 'none',
          transitionStep: null,
          basis: 'planner',
          failedOpen: 'the judgement reply did not satisfy the schema',
        },
      },
    ],
    [
      'no fields at all',
      { obligationsFailedOpen: 'the judgement reply did not satisfy the schema' },
    ],
  ] as const)(
    'holds an autonomous plan for the manager when its obligations judgement failed open, with %s (E-70 D4)',
    async (_shape, failedOpen): Promise<void> => {
      useSurfaceMode('real');
      const harness = convexTest(schema, allConvexModules());
      const { agentId, workItemId } = await seed(harness, 'claimed', undefined, {
        autonomousActions: true,
      });
      const plan = {
        summary: 'Check the issue, then update it.',
        steps: ['check', 'update'],
        ...failedOpen,
      };

      await harness.mutation(internal.work.setPlan, { workItemId, plan });
      expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
        approved: false,
      });
      expect((await readItem(harness, workItemId)).state).toBe('plan-pending');
      expect(await eventsOfType(harness, agentId, 'work.plan-approved')).toEqual([]);
      expect(
        (await eventsOfType(harness, agentId, 'work.plan-held')).map((event) => event.payload),
      ).toEqual([
        {
          workItemId,
          reason: 'obligations-failed-open',
          failure: 'the judgement reply did not satisfy the schema',
        },
      ]);
      await harness.mutation(internal.work.decidePlan, { workItemId, recovery: true });
      expect(await eventsOfType(harness, agentId, 'work.plan-held')).toHaveLength(1);
      expect((await readItem(harness, workItemId)).state).toBe('plan-pending');
    },
  );

  it('approves an autonomous plan whose obligations the judgement settled', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'claimed', undefined, { autonomousActions: true });
    await harness.mutation(internal.work.setPlan, {
      workItemId,
      plan: {
        summary: 'Check the issue, then update it.',
        steps: ['check', 'update'],
        obligations: {
          steps: [
            { reads: [], writes: [], kind: 'read' },
            { reads: [], writes: ['linear'], kind: 'write' },
          ],
          transition: 'none',
          transitionStep: null,
          basis: 'judgement',
        },
      },
    });
    expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
      approved: true,
    });
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

  /**
   * Another employee's row for the same provider item, its plan rejected.
   *
   * Args:
   *   harness: Convex test harness.
   *   userId: The other employee's owner.
   *
   * Returns:
   *   The other employee's rejected work item.
   */
  async function rejectedElsewhere(harness: Harness, userId: string): Promise<Id<'workItems'>> {
    return await harness.run(async (ctx) => {
      const colleague = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Mateo',
        userId,
        state: 'active',
        createdAt: 1,
      });
      return await ctx.db.insert('workItems', {
        agentId: colleague,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        externalClaimKey: 'linear:REVOPS-1',
        title: 'Add the close-summary audit note',
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state: 'cancelled',
        planRejectedAt: 5,
        observedAt: 1,
        createdAt: 1,
      });
    });
  }

  it("holds a plan for the manager when the owner rejected another employee's plan for the same item", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'claimed', undefined, {
      autonomousActions: true,
    });
    await harness.run(
      async (ctx) => await ctx.db.patch(workItemId, { externalClaimKey: 'linear:REVOPS-1' }),
    );
    const rejected = await rejectedElsewhere(harness, 'owner');

    await harness.mutation(internal.work.setPlan, {
      workItemId,
      plan: { summary: 'Check the issue, then update it.', steps: ['check', 'update'] },
    });
    expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
      approved: false,
    });
    expect(
      await harness.mutation(internal.work.decidePlan, { workItemId, recovery: true }),
    ).toEqual({
      approved: false,
    });

    expect((await readItem(harness, workItemId)).state).toBe('plan-pending');
    expect(await eventsOfType(harness, agentId, 'work.plan-approved')).toEqual([]);
    expect(
      (await eventsOfType(harness, agentId, 'work.plan-held')).map((event) => event.payload),
    ).toEqual([
      {
        workItemId,
        reason: 'plan-rejected-for-this-item',
        rejectedWorkItemId: rejected,
        rejectedAgentId: expect.any(String),
        rejectedAt: 5,
      },
    ]);
  });

  it('approves autonomously when the rejected plan for the same item belongs to another owner', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'claimed', undefined, { autonomousActions: true });
    await harness.run(
      async (ctx) => await ctx.db.patch(workItemId, { externalClaimKey: 'linear:REVOPS-1' }),
    );
    await rejectedElsewhere(harness, 'someone-else');

    await harness.mutation(internal.work.setPlan, {
      workItemId,
      plan: { summary: 'Check the issue, then update it.', steps: ['check', 'update'] },
    });

    expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
      approved: true,
    });
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

  it('re-sends a delivered request to the new manager when a probe resolves a different one', async (): Promise<void> => {
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
      ts: '1787746453.000100',
    });
    // Delivered to the manager who holds the code: never replaced.
    expect(
      await harness.mutation(internal.work.prepareDecisionRequest, {
        workItemId,
        kind: 'plan',
        decisionId: 'cd4uvw',
        supersedes: 'ab3xyz',
      }),
    ).toEqual({ prepared: false, reason: 'decision request already claimed' });

    const slackId = await harness.run(async (ctx) => {
      const row = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
        .unique();
      if (!row) throw new Error('slack surface missing');
      return row._id;
    });
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId: slackId });
    if (!probe.reserved) throw new Error('probe was not reserved');
    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId: slackId,
      generation: probe.generation,
      toolAllowlist: ['chat.postMessage'],
      toolArguments: [{ tool: 'chat.postMessage', arguments: ['channel', 'text'] }],
      managerDmChannelId: 'D0SUCCESSOR',
      managerUserId: 'USUCCESSOR',
      verifiedAt: Date.now(),
    });

    expect((await readItem(harness, workItemId)).decision).toMatchObject({
      id: 'ab3xyz',
      requestFailure: MANAGER_CHANGED_RESEND_REASON,
    });
    expect(
      (await eventsOfType(harness, agentId, 'work.decision-request-resent')).map(
        (event) => event.payload,
      ),
    ).toEqual([
      { workItemId, decisionId: 'ab3xyz', kind: 'plan', reason: MANAGER_CHANGED_RESEND_REASON },
    ]);
    expect(await scheduledFunctionNames(harness)).toContain(
      'managerChannelActions:requestDecision',
    );
    await expect(
      harness.mutation(internal.work.prepareDecisionRequest, {
        workItemId,
        kind: 'plan',
        decisionId: 'cd4uvw',
        supersedes: 'ab3xyz',
      }),
    ).resolves.toMatchObject({ prepared: true, surface: { managerDmChannelId: 'D0SUCCESSOR' } });
    expect((await readItem(harness, workItemId)).decision).toMatchObject({
      id: 'cd4uvw',
      channel: 'D0SUCCESSOR',
    });
  });

  it("re-sends to the new manager after the old one's lookup failed and wiped the DM", async (): Promise<void> => {
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
      ts: '1787746453.000100',
    });
    const slackId = await harness.run(async (ctx) => {
      const row = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
        .unique();
      if (!row) throw new Error('slack surface missing');
      return row._id;
    });
    const failed = await harness.mutation(internal.surfaces.beginProbe, { surfaceId: slackId });
    if (!failed.reserved) throw new Error('probe was not reserved');
    await harness.mutation(internal.surfaces.recordProbeFailure, {
      surfaceId: slackId,
      generation: failed.generation,
      verdict: 'ungranted',
      reason: 'the manager email boss@day0.local resolves to a deactivated Slack user.',
    });
    const reconnect = await harness.mutation(internal.surfaces.beginProbe, { surfaceId: slackId });
    if (!reconnect.reserved) throw new Error('probe was not reserved');
    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId: slackId,
      generation: reconnect.generation,
      toolAllowlist: ['chat.postMessage'],
      toolArguments: [{ tool: 'chat.postMessage', arguments: ['channel', 'text'] }],
      managerDmChannelId: 'D0SUCCESSOR',
      managerUserId: 'USUCCESSOR',
      verifiedAt: Date.now(),
    });
    expect((await readItem(harness, workItemId)).decision).toMatchObject({
      id: 'ab3xyz',
      requestFailure: MANAGER_CHANGED_RESEND_REASON,
    });
    expect(await scheduledFunctionNames(harness)).toContain(
      'managerChannelActions:requestDecision',
    );
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
    ).toEqual([
      { workItemId, decisionId: 'ab3xyz', kind: 'plan', reason: 'Slack returned HTTP 503.' },
    ]);
    expect(
      await harness.mutation(internal.work.prepareDecisionRequest, {
        workItemId,
        kind: 'plan',
        decisionId: 'cd4uvw',
      }),
    ).toEqual({ prepared: false, reason: 'decision request already claimed' });
  });

  it('arms a recovery timer with the claim and resends once when the send never reported back', async (): Promise<void> => {
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
    // The claim and its dead-man's switch are one transaction.
    expect(await scheduledFunctionNames(harness)).toEqual([
      'work:recoverUndeliveredDecisionRequest',
    ]);

    // The action died between the claim and the record: no ts, no failure.
    expect(
      await harness.mutation(internal.work.recoverUndeliveredDecisionRequest, {
        workItemId,
        decisionId: 'ab3xyz',
      }),
    ).toEqual({ recovered: 'resent' });
    expect((await readItem(harness, workItemId)).decision).toMatchObject({
      id: 'ab3xyz',
      requestFailedAt: expect.any(Number),
      requestFailure: 'request not delivered',
    });
    expect(await scheduledFunctionNames(harness)).toEqual([
      'managerChannelActions:requestDecision',
      'work:recoverUndeliveredDecisionRequest',
    ]);
    expect(
      (await eventsOfType(harness, agentId, 'work.decision-request-resent')).map(
        (event) => event.payload,
      ),
    ).toEqual([
      { workItemId, decisionId: 'ab3xyz', kind: 'plan', reason: 'request not delivered' },
    ]);

    // A second timer for the same claim finds the resend already under way.
    expect(
      await harness.mutation(internal.work.recoverUndeliveredDecisionRequest, {
        workItemId,
        decisionId: 'ab3xyz',
      }),
    ).toEqual({ recovered: 'ignored' });
    expect(
      (await scheduledFunctionNames(harness)).filter(
        (name) => name === 'managerChannelActions:requestDecision',
      ),
    ).toHaveLength(1);

    // The resend claims a fresh code by naming the one it replaces ...
    expect(
      await harness.mutation(internal.work.prepareDecisionRequest, {
        workItemId,
        kind: 'plan',
        decisionId: 'cd4uvw',
        supersedes: 'ab3xyz',
      }),
    ).toMatchObject({ prepared: true, decisionId: 'cd4uvw' });
    const resent = (await readItem(harness, workItemId)).decision;
    expect(resent).toMatchObject({ id: 'cd4uvw', kind: 'plan' });
    expect(resent).not.toHaveProperty('requestFailedAt');
    expect(resent).not.toHaveProperty('ts');
    // ... and a duplicate of the same resend is refused: one request is recorded.
    expect(
      await harness.mutation(internal.work.prepareDecisionRequest, {
        workItemId,
        kind: 'plan',
        decisionId: 'ef5rst',
        supersedes: 'ab3xyz',
      }),
    ).toEqual({ prepared: false, reason: 'decision request already claimed' });
    // The dead send reporting late cannot overwrite the live claim.
    expect(
      await harness.mutation(internal.work.recordDecisionRequest, {
        workItemId,
        decisionId: 'ab3xyz',
        ts: '1787770700.000100',
      }),
    ).toBe(false);
    expect((await readItem(harness, workItemId)).decision).toMatchObject({ id: 'cd4uvw' });
    expect((await readItem(harness, workItemId)).decision).not.toHaveProperty('ts');
    expect(
      (await eventsOfType(harness, agentId, 'work.decision-requesting')).map(
        (event) => event.payload,
      ),
    ).toEqual([
      { workItemId, decisionId: 'ab3xyz', kind: 'plan' },
      { workItemId, decisionId: 'cd4uvw', kind: 'plan', supersedes: 'ab3xyz' },
    ]);
  });

  it('leaves a delivered or decided request alone and never replaces a code the manager holds', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'plan-pending', undefined, { withSlack: true });
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'ab3xyz',
    });
    await harness.mutation(internal.work.recordDecisionRequest, {
      workItemId,
      decisionId: 'ab3xyz',
      ts: '1787770700.000100',
    });
    expect(
      await harness.mutation(internal.work.recoverUndeliveredDecisionRequest, {
        workItemId,
        decisionId: 'ab3xyz',
      }),
    ).toEqual({ recovered: 'ignored' });
    expect(
      await harness.mutation(internal.work.prepareDecisionRequest, {
        workItemId,
        kind: 'plan',
        decisionId: 'cd4uvw',
        supersedes: 'ab3xyz',
      }),
    ).toEqual({ prepared: false, reason: 'decision request already claimed' });
    expect((await readItem(harness, workItemId)).decision).toMatchObject({
      id: 'ab3xyz',
      ts: '1787770700.000100',
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.resendDecisionRequest, { workItemId }),
    ).rejects.toThrow('delivered');

    await harness.withIdentity(OWNER).mutation(api.work.approvePlan, { workItemId });
    expect(
      await harness.mutation(internal.work.recoverUndeliveredDecisionRequest, {
        workItemId,
        decisionId: 'ab3xyz',
      }),
    ).toEqual({ recovered: 'ignored' });
  });

  it('lets the owner resend a failed request from the card, and nobody else', async (): Promise<void> => {
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
    // Still in flight: nothing to resend yet.
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.resendDecisionRequest, { workItemId }),
    ).rejects.toThrow('still being delivered');
    await harness.mutation(internal.work.recordDecisionRequest, {
      workItemId,
      decisionId: 'ab3xyz',
      failure: 'Slack returned HTTP 503.',
    });
    await expect(
      harness.withIdentity(managerIdentity('stranger')).mutation(api.work.resendDecisionRequest, {
        workItemId,
      }),
    ).rejects.toThrow('forbidden');
    await harness.withIdentity(OWNER).mutation(api.work.resendDecisionRequest, { workItemId });
    expect(
      (await scheduledFunctionNames(harness)).filter(
        (name) => name === 'managerChannelActions:requestDecision',
      ),
    ).toHaveLength(1);
    expect(
      (await eventsOfType(harness, agentId, 'work.decision-request-resent')).map(
        (event) => event.payload,
      ),
    ).toEqual([
      {
        workItemId,
        decisionId: 'ab3xyz',
        kind: 'plan',
        reason: 'resend requested from the dashboard',
      },
    ]);
  });

  /** The Slack surface `seed` adds, by id. */
  async function slackSurfaceId(harness: Harness, agentId: Id<'agents'>): Promise<Id<'surfaces'>> {
    return await harness.run(async (ctx) => {
      const row = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
        .unique();
      if (!row) throw new Error('chat surface missing');
      return row._id;
    });
  }

  it('lists the requests open on the DM from their claim to their decision, and owes a notice for an hour after', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(Date.UTC(2026, 8, 28, 9, 0));
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    const surfaceId = await slackSurfaceId(harness, agentId);
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toEqual({
      requests: [],
      batches: [],
      noticeOwed: false,
    });

    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'ab3xyz',
    });
    // Claimed, not landed: open, with no thread to read yet.
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toMatchObject({
      requests: [{ decisionId: 'ab3xyz' }],
    });
    await harness.mutation(internal.work.recordDecisionRequest, {
      workItemId,
      decisionId: 'ab3xyz',
      ts: '1787770700.000100',
    });
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toEqual({
      requests: [{ decisionId: 'ab3xyz', ts: '1787770700.000100' }],
      batches: [],
      noticeOwed: false,
    });

    await harness.withIdentity(OWNER).mutation(api.work.approvePlan, { workItemId });
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toEqual({
      requests: [],
      batches: [],
      noticeOwed: true,
    });
    vi.setSystemTime(Date.UTC(2026, 8, 28, 10, 1));
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toMatchObject({
      noticeOwed: false,
    });
    vi.useRealTimers();
  });

  it('leaves out a delivered request marked failed and one delivered to another DM (wave 3 review M7)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    const other = await pendAnother(harness, agentId);
    const surfaceId = await slackSurfaceId(harness, agentId);
    const delivered = (id: string, channel: string, failed: boolean) => ({
      id,
      kind: 'plan' as const,
      requestedAt: 1,
      channel,
      surfaceSlug: 'slack',
      surfaceName: 'Slack',
      ts: '1787770700.000100',
      ...(failed ? { requestFailedAt: 2, requestFailure: MANAGER_CHANGED_RESEND_REASON } : {}),
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, { decision: delivered('ab3xyz', 'D0MANAGER', true) });
      await ctx.db.patch(other.workItemId, {
        decision: { ...delivered('cd4uvw', 'D0PREVIOUS', false), kind: 'actions' },
      });
    });
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toEqual({
      requests: [],
      batches: [],
      noticeOwed: false,
    });
  });

  it('lists a batch while a member is open, with its open members', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'actions-pending', undefined, {
      withSlack: true,
    });
    const other = await pendAnother(harness, agentId);
    const surfaceId = await slackSurfaceId(harness, agentId);
    const asked = (id: string) => ({
      id,
      kind: 'actions' as const,
      requestedAt: 1,
      channel: 'D0MANAGER',
      surfaceSlug: 'slack',
      surfaceName: 'Slack',
      ts: `17877707${id === 'ab3xyz' ? '00' : '01'}.000100`,
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, { pendingRunId: runId, decision: asked('ab3xyz') });
      await ctx.db.patch(other.workItemId, { decision: asked('cd4uvw') });
    });
    await harness.mutation(internal.work.prepareDecisionBatch, {
      agentId,
      batchId: 'ef5rst',
      surfaceSlug: 'slack',
      channel: 'D0MANAGER',
      members: [
        { workItemId, decisionId: 'ab3xyz', pendingRunId: runId },
        { workItemId: other.workItemId, decisionId: 'cd4uvw', pendingRunId: other.runId },
      ],
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(other.workItemId, { decision: { ...asked('cd4uvw'), decidedAt: 5 } });
    });
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toMatchObject({
      requests: [{ decisionId: 'ab3xyz' }],
      batches: [{ batchId: 'ef5rst', decisionIds: ['ab3xyz'] }],
    });
  });

  it('finds a batch opened after two hundred older batches that were never decided, by index under the transaction limits (M D3 (b))', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const { agentId, workItemId, runId } = await seed(harness, 'actions-pending', undefined, {
      withSlack: true,
    });
    const other = await pendAnother(harness, agentId);
    const surfaceId = await slackSurfaceId(harness, agentId);
    const asked = (id: string) => ({
      id,
      kind: 'actions' as const,
      requestedAt: 1,
      channel: 'D0MANAGER',
      surfaceSlug: 'slack',
      surfaceName: 'Slack',
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, { pendingRunId: runId, decision: asked('ab3xyz') });
      await ctx.db.patch(other.workItemId, { decision: asked('cd4uvw') });
      // Batches whose members were decided one by one: undecided for good.
      for (let index = 0; index < 201; index += 1) {
        await ctx.db.insert('decisionBatches', {
          agentId,
          id: `a${String(index).padStart(5, '2')}`,
          surfaceSlug: 'slack',
          channel: 'D0MANAGER',
          members: [
            { workItemId, decisionId: `old-${index}`, pendingRunId: runId },
            {
              workItemId: other.workItemId,
              decisionId: `old-${index}-b`,
              pendingRunId: other.runId,
            },
          ],
          requestedAt: 1,
        });
      }
    });
    await harness.mutation(internal.work.prepareDecisionBatch, {
      agentId,
      batchId: 'zzzzzz',
      surfaceSlug: 'slack',
      channel: 'D0MANAGER',
      members: [
        { workItemId, decisionId: 'ab3xyz', pendingRunId: runId },
        { workItemId: other.workItemId, decisionId: 'cd4uvw', pendingRunId: other.runId },
      ],
    });
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toMatchObject({
      batches: [{ batchId: 'zzzzzz', decisionIds: ['ab3xyz', 'cd4uvw'] }],
    });
  });

  it('finds an open batch behind two hundred newer undecided batches of another channel (adversarial pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const { agentId, workItemId, runId } = await seed(harness, 'actions-pending', undefined, {
      withSlack: true,
    });
    const other = await pendAnother(harness, agentId);
    const surfaceId = await slackSurfaceId(harness, agentId);
    const asked = (id: string) => ({
      id,
      kind: 'actions' as const,
      requestedAt: 1,
      channel: 'D0MANAGER',
      surfaceSlug: 'slack',
      surfaceName: 'Slack',
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, { pendingRunId: runId, decision: asked('ab3xyz') });
      await ctx.db.patch(other.workItemId, { decision: asked('cd4uvw') });
    });
    await harness.mutation(internal.work.prepareDecisionBatch, {
      agentId,
      batchId: 'ef5rst',
      surfaceSlug: 'slack',
      channel: 'D0MANAGER',
      members: [
        { workItemId, decisionId: 'ab3xyz', pendingRunId: runId },
        { workItemId: other.workItemId, decisionId: 'cd4uvw', pendingRunId: other.runId },
      ],
    });
    // Newer batches a previous manager's DM was sent, decided one by one there.
    await harness.run(async (ctx): Promise<void> => {
      for (let index = 0; index < 201; index += 1) {
        await ctx.db.insert('decisionBatches', {
          agentId,
          id: `p${String(index).padStart(5, '2')}`,
          surfaceSlug: 'slack',
          channel: 'D0PREVIOUS',
          members: [
            { workItemId, decisionId: `old-${index}`, pendingRunId: runId },
            {
              workItemId: other.workItemId,
              decisionId: `old-${index}-b`,
              pendingRunId: other.runId,
            },
          ],
          requestedAt: 1,
        });
      }
    });
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toMatchObject({
      batches: [{ batchId: 'ef5rst', decisionIds: ['ab3xyz', 'cd4uvw'] }],
    });
  });

  it('owes the notice for a row decided within the hour behind fifty newer rows asked on the DM (M D3 (b))', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const now = Date.UTC(2026, 8, 28, 9, 0);
    vi.setSystemTime(now);
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const { agentId, workItemId } = await seed(harness, 'plan-approved', undefined, {
      withSlack: true,
    });
    const surfaceId = await slackSurfaceId(harness, agentId);
    const asked = (id: string, decidedAt?: number) => ({
      id,
      kind: 'plan' as const,
      requestedAt: 1,
      channel: 'D0MANAGER',
      surfaceSlug: 'slack',
      surfaceName: 'Slack',
      ...(decidedAt !== undefined ? { decidedAt, outcome: 'approved' as const } : {}),
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, { decision: asked('ab3xyz', now - 10 * 60_000) });
      for (let index = 0; index < 60; index += 1) {
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: `REVOPS-${100 + index}`,
          title: `Ticket ${index}`,
          contentSummary: 'Asked long ago, never answered.',
          contentRefs: [],
          state: 'plan-pending',
          observedAt: 1,
          createdAt: 1,
          decision: asked(`q${index}`),
        });
      }
    });
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toMatchObject({
      noticeOwed: true,
    });
    vi.setSystemTime(now + 51 * 60_000);
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toMatchObject({
      noticeOwed: false,
    });
    vi.useRealTimers();
  });

  it('re-sends a delivered request marked failed whose replacement was never claimed, once the manager is resolved (M7)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        decision: {
          id: 'ab3xyz',
          kind: 'plan',
          requestedAt: 1,
          channel: 'D0PREVIOUS',
          surfaceSlug: 'slack',
          surfaceName: 'Slack',
          ts: '1787770700.000100',
          requestFailedAt: 2,
          requestFailure: MANAGER_CHANGED_RESEND_REASON,
        },
      });
    });
    const surfaceId = await slackSurfaceId(harness, agentId);
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!probe.reserved) throw new Error('probe was not reserved');
    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId,
      generation: probe.generation,
      toolAllowlist: ['chat.postMessage'],
      toolArguments: [{ tool: 'chat.postMessage', arguments: ['channel', 'text'] }],
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
      verifiedAt: Date.now(),
    });
    expect(
      (await eventsOfType(harness, agentId, 'work.decision-request-resent')).map(
        (event) => event.payload,
      ),
    ).toEqual([
      { workItemId, decisionId: 'ab3xyz', kind: 'plan', reason: MANAGER_CHANGED_RESEND_REASON },
    ]);
    expect(await scheduledFunctionNames(harness)).toContain(
      'managerChannelActions:requestDecision',
    );
  });

  it('closes a delivered request whose thread is gone and sends it again, once (M7)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    const surfaceId = await slackSurfaceId(harness, agentId);
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'ab3xyz',
    });
    await harness.mutation(internal.work.recordDecisionRequest, {
      workItemId,
      decisionId: 'ab3xyz',
      ts: '1787770700.000100',
    });

    await expect(
      harness.mutation(internal.work.closeDecisionThread, { surfaceId, decisionId: 'ab3xyz' }),
    ).resolves.toBe(true);
    await expect(
      harness.mutation(internal.work.closeDecisionThread, { surfaceId, decisionId: 'ab3xyz' }),
    ).resolves.toBe(false);
    expect((await readItem(harness, workItemId)).decision).toMatchObject({
      id: 'ab3xyz',
      requestFailure: THREAD_NOT_FOUND_REASON,
    });
    expect(
      (await eventsOfType(harness, agentId, 'work.decision-request-resent')).map(
        (event) => event.payload,
      ),
    ).toEqual([
      { workItemId, decisionId: 'ab3xyz', kind: 'plan', reason: THREAD_NOT_FOUND_REASON },
    ]);
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toMatchObject({
      requests: [],
    });
  });

  it('tells the manager once that a reply after an open request could not be read, and nobody else', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    const surfaceId = await slackSurfaceId(harness, agentId);
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'ab3xyz',
    });
    const requestedAt = (await readItem(harness, workItemId)).decision?.requestedAt ?? 0;
    const after = (1 + requestedAt / 1_000).toFixed(6);
    const before = (requestedAt / 1_000 - 60).toFixed(6);
    const notice = async (userId: string, messageTs: string): Promise<boolean> =>
      await harness.mutation(internal.work.noticeUnreadableReply, { surfaceId, userId, messageTs });

    await expect(notice('UMANAGER', before)).resolves.toBe(false);
    await expect(notice('UOTHER', after)).resolves.toBe(false);
    await expect(notice('UMANAGER', after)).resolves.toBe(true);
    await expect(notice('UMANAGER', after)).resolves.toBe(false);
    const notices = await harness.run(
      async (ctx) => await ctx.db.query('managerDecisionNotices').collect(),
    );
    expect(
      notices.map(({ decisionId, messageTs, kind, text }) => ({
        decisionId,
        messageTs,
        kind,
        text,
      })),
    ).toEqual([
      {
        decisionId: 'ab3xyz',
        messageTs: after,
        kind: 'unknown',
        text: 'I couldn’t read that as a decision. Reply “approve ab3xyz” or “reject ab3xyz <reason>”, with the code from the request.',
      },
    ]);
    expect(
      (await eventsOfType(harness, agentId, 'work.decision-ignored')).map((event) => event.payload),
    ).toEqual([
      { surfaceId, messageTs: after, userId: 'UMANAGER', reason: UNREADABLE_REPLY_REASON },
    ]);
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
      await harness.run(
        async (ctx) =>
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

  it('keeps the reason of a plan rejected from the manager channel on the item and as a correction', async (): Promise<void> => {
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

    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '3.100',
        reply: { verb: 'reject', id: 'jk7mnr', reason: 'Use the revised runbook' },
      }),
    ).resolves.toMatchObject({ status: 'decided' });

    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'cancelled',
      managerFeedback: { reason: 'Use the revised runbook', kind: 'plan-rejection' },
      decision: { outcome: 'rejected', decidedVia: 'channel' },
    });
    const kept = await harness.run(async (ctx) => await ctx.db.query('corrections').collect());
    expect(kept).toMatchObject([
      { agentId, workItemId, kind: 'plan-rejection', text: 'Use the revised runbook' },
    ]);
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

  it('drops a reply that predates the agent without an event or a manager notice', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    const deployedAt = 1_787_000_000_000;
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { createdAt: deployedAt });
    });
    const surfaceId = await chatSurfaceId(harness, agentId);
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'ab3xyz',
    });
    const secondsBefore = (deployedAt - 1_000) / 1_000;
    const secondsAfter = (deployedAt + 60_000) / 1_000;

    // A code left in the manager DM by an earlier agent is not this agent's business.
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: `${secondsBefore}.000100`,
        reply: { verb: 'approve', id: 'cd4uvw' },
      }),
    ).resolves.toEqual({ status: 'ignored', reason: 'predates the agent' });
    expect(await eventsOfType(harness, agentId, 'work.decision-ignored')).toEqual([]);
    expect(
      await harness.run(async (ctx) => await ctx.db.query('managerDecisionNotices').collect()),
    ).toEqual([]);

    // The same unknown code sent after the deploy is still answered as unknown.
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: `${secondsAfter}.000100`,
        reply: { verb: 'approve', id: 'cd4uvw' },
      }),
    ).resolves.toEqual({ status: 'ignored', reason: 'unknown decision id', notified: true });
    expect(await eventsOfType(harness, agentId, 'work.decision-ignored')).toHaveLength(1);

    // A live approval after the deploy decides as before.
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: `${secondsAfter + 1}.000100`,
        reply: { verb: 'approve', id: 'ab3xyz' },
      }),
    ).resolves.toEqual({ status: 'decided', outcome: 'approve' });
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
      (await eventsOfType(planHarness, plan.agentId, 'work.cancelled')).map(
        (event) => event.payload,
      ),
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
    expect(await scheduledFunctionNames(actionsHarness)).not.toContain(
      'workActions:applyApprovedActions',
    );
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
      await actionsHarness.run(
        async (ctx) => await ctx.db.query('managerDecisionNotices').collect(),
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

describe('approving a plan with answers', (): void => {
  afterEach(restoreSurfaceMode);

  const lookerPlan = {
    summary: 'Refresh the Looker pipeline tile and comment on the ticket.',
    steps: ['Read REVOPS-7.', 'Refresh the Looker pipeline tile.', 'Comment on REVOPS-7.'],
    riskNotes:
      'The runbook does not say which figure to enter if the standup deck and the sheet disagree.',
    reversibility: 'reversible',
    estimatedMinutes: 10,
    expectedOutputType: 'ticket-update',
  };

  async function askedAtPlan(harness: Harness): Promise<{
    agentId: Id<'agents'>;
    workItemId: Id<'workItems'>;
    charterId: Id<'charters'>;
    question: Doc<'managerQuestions'>;
  }> {
    const { agentId, workItemId } = await seed(harness, 'claimed');
    const charterId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('charters', {
          agentId,
          version: '0.0',
          body: runThroughBody(),
          approved: true,
          approvedAt: 2,
          createdAt: 2,
        }),
    );
    await harness.mutation(internal.work.setPlan, { workItemId, plan: lookerPlan });
    const [question] = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('managerQuestions')
          .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
          .collect(),
    );
    if (!question) throw new Error('the plan asked no question');
    return { agentId, workItemId, charterId, question };
  }

  it('answers the question and the note, amends the charter, and approves in one decision', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, charterId, question } = await askedAtPlan(harness);
    expect(question.question).toBe('Who owns the Looker pipeline tile.');

    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approvePlan, {
        workItemId,
        answers: [
          {
            questionId: question._id,
            text: '  Priya owns it;  ask her before changing the source. ',
          },
        ],
        note: 'Use the sheet figure.',
      }),
    ).resolves.toEqual({ ok: true });

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('plan-approved');
    expect(row.managerAnswers).toEqual([
      {
        question: 'Who owns the Looker pipeline tile.',
        answer: 'Priya owns it; ask her before changing the source.',
        answeredAt: expect.any(Number),
        questionId: question._id,
      },
      {
        question: lookerPlan.riskNotes,
        answer: 'Use the sheet figure.',
        answeredAt: expect.any(Number),
      },
    ]);
    const answered = await harness.run(async (ctx) => await ctx.db.get(question._id));
    expect(answered?.answer).toMatchObject({
      text: 'Priya owns it; ask her before changing the source.',
      via: 'plan-approval',
    });
    const latest = await harness.withIdentity(OWNER).query(api.charters.latest, { agentId });
    expect(latest).toMatchObject({ version: '0.1', approved: true, supersedes: charterId });
    expect(latest?._id).toBe(answered?.answer?.amendedCharterId);
    const body = latest?.body as Charter;
    expect(body.openQuestions).not.toContain('Who owns the Looker pipeline tile.');
    expect(body.answeredQuestions).toEqual([
      expect.objectContaining({
        question: 'Who owns the Looker pipeline tile.',
        answer: 'Priya owns it; ask her before changing the source.',
      }),
    ]);
    const approvals = await eventsOfType(harness, agentId, 'work.plan-approved');
    expect(approvals.map((event) => event.payload)).toEqual([
      {
        workItemId,
        decidedVia: 'dashboard',
        answered: [
          { question: 'Who owns the Looker pipeline tile.', questionId: question._id },
          { question: lookerPlan.riskNotes },
        ],
      },
    ]);
    expect(await eventTypes(harness, agentId)).toContain('charter.amended');
  });

  it('approves without answers as before, and leaves the question open', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, question } = await askedAtPlan(harness);
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approvePlan, { workItemId }),
    ).resolves.toEqual({ ok: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('plan-approved');
    expect(row.managerAnswers).toBeUndefined();
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(question._id)))?.answer,
    ).toBeUndefined();
    expect((await eventsOfType(harness, agentId, 'work.plan-approved'))[0]?.payload).toEqual({
      workItemId,
      decidedVia: 'dashboard',
    });
    expect(
      await harness.withIdentity(OWNER).query(api.managerQuestions.openForAgent, { agentId }),
    ).toHaveLength(1);
  });

  it('refuses an answer to a question asked on another item, an empty answer and a stranger, and approves nothing then', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, question } = await askedAtPlan(harness);
    const other = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-2',
          title: 'Northstar account clean-up',
          contentSummary: 'Merge the duplicate Northstar accounts.',
          contentRefs: [],
          state: 'claimed',
          observedAt: 1,
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.work.setPlan, {
      workItemId: other,
      plan: {
        summary: 'Merge the accounts.',
        steps: ['Read the accounts.', 'Draft the merge.'],
        riskNotes: '',
      },
    });
    const owner = harness.withIdentity(OWNER);
    await expect(
      owner.mutation(api.work.approvePlan, {
        workItemId: other,
        answers: [{ questionId: question._id, text: 'Priya.' }],
      }),
    ).rejects.toThrow('not asked on this work item');
    await expect(
      owner.mutation(api.work.approvePlan, {
        workItemId,
        answers: [{ questionId: question._id, text: '   ' }],
      }),
    ).rejects.toThrow('cannot be empty');
    await expect(
      harness.withIdentity(managerIdentity('stranger')).mutation(api.work.approvePlan, {
        workItemId,
        answers: [{ questionId: question._id, text: 'Priya.' }],
      }),
    ).rejects.toThrow(/forbidden/);
    expect((await readItem(harness, workItemId)).state).toBe('plan-pending');
    expect((await readItem(harness, other)).state).toBe('plan-pending');
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(question._id)))?.answer,
    ).toBeUndefined();
  });

  it('clears the answers when the run completes', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'executing');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        managerAnswers: [{ question: 'Who owns the tile.', answer: 'Priya.', answeredAt: 2 }],
      });
    });
    await harness.mutation(internal.work.setCompleted, {
      workItemId,
      runId,
      output: {
        ...pendingOutput,
        applied: [{ tool: 'mcp.call', ok: true, effect: 'landed', idempotencyKey: 'k0' }],
      },
    });
    expect((await readItem(harness, workItemId)).managerAnswers).toBeUndefined();
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
    const cancelled = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect()
      ).filter((event) => event.type === 'work.cancelled'),
    );
    expect(cancelled.map((event) => event.payload)).toEqual([
      { workItemId, reason: PLAN_CANCELLED_REASON, decidedVia: 'dashboard' },
    ]);
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.cancelPlan, { workItemId }),
    ).rejects.toThrow('expected plan-pending');
  });
});

describe('when an item’s run began (second review x4)', (): void => {
  it('stamps the claim when the verdict claims the item, and anew when Retry puts it back into a run', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const claimed = Date.UTC(2026, 8, 30, 9);
      vi.setSystemTime(claimed);
      const harness = convexTest(schema, allConvexModules());
      const { workItemId } = await seed(harness, 'discovered');
      await harness.mutation(internal.work.setVerdict, {
        workItemId,
        verdict: { decision: 'claim' },
      });
      expect((await readItem(harness, workItemId)).claimedAt).toBe(claimed);

      await harness.run(async (ctx): Promise<void> => {
        await ctx.db.patch(workItemId, { state: 'failed', skipReason: 'the provider said no' });
      });
      const retried = Date.UTC(2026, 8, 30, 12);
      vi.setSystemTime(retried);
      await harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });
      const row = await readItem(harness, workItemId);
      expect(row.state).toBe('plan-approved');
      expect(row.claimedAt).toBe(retried);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('retrying an item the quality-fit filter skipped', (): void => {
  it('records the manager waiver on the item and in the ledger', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'skipped');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        plan: undefined,
        verdict: { decision: 'skip', reason: 'quality-fit-fail: the request is too thin' },
        skipReason: 'quality-fit-fail: the request is too thin',
      });
    });

    const result = await harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });

    expect(result).toEqual({ ok: true, resumeState: 'discovered' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('discovered');
    expect(row.skipReason).toBeUndefined();
    expect(typeof row.qualityFitWaivedAt).toBe('number');
    const retries = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect()
      ).filter((event) => event.type === 'work.retry'),
    );
    expect(retries.map((event) => event.payload)).toEqual([
      { workItemId, resumeState: 'discovered', fromState: 'skipped', waived: 'quality-fit' },
    ]);
  });

  it("records the manager's scope waiver for an out-of-scope skip on the item and in the ledger", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'skipped');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        plan: undefined,
        verdict: {
          decision: 'skip',
          reason: 'out-of-scope: no charter or current documented-system overlap',
        },
        skipReason: 'out-of-scope: no charter or current documented-system overlap',
      });
    });

    const result = await harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });

    expect(result).toEqual({ ok: true, resumeState: 'discovered' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('discovered');
    expect(row.skipReason).toBeUndefined();
    expect(typeof row.scopeWaivedAt).toBe('number');
    expect(row.qualityFitWaivedAt).toBeUndefined();
    const retries = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect()
      ).filter((event) => event.type === 'work.retry'),
    );
    expect(retries.map((event) => event.payload)).toEqual([
      { workItemId, resumeState: 'discovered', fromState: 'skipped', waived: 'scope' },
    ]);
  });

  it('carries a note given with Retry to the retried run as manager feedback', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'failed');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        skipReason: 'the closing phase asked the manager for evidence',
      });
    });

    await harness.withIdentity(OWNER).mutation(api.work.retryFailed, {
      workItemId,
      feedback: '  The three checks are done;   propose Done.  ',
    });

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('plan-approved');
    expect(row.managerFeedback).toMatchObject({
      reason: 'The three checks are done; propose Done.',
      kind: 'retry-note',
    });
    expect(row.managerFeedback?.addressedAt).toBeUndefined();
    // The stop asked nothing, so the note is a direction and answers no question (review D2).
    expect(row.managerFeedback?.answersQuestion).toBeUndefined();
    const retries = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect()
      ).filter((event) => event.type === 'work.retry'),
    );
    // The note itself is in the ledger: the manager's direction is part of the record of the run.
    expect(retries.map((event) => event.payload)).toEqual([
      {
        workItemId,
        resumeState: 'plan-approved',
        fromState: 'failed',
        feedback: 'The three checks are done; propose Done.',
      },
    ]);
  });

  it('marks a note given with Retry on a question stop as the answer to it (review D2)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'failed');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        skipReason: `stopped: ${openQuestionStopReason({ question: 'Which template?', steps: [2] })}`,
      });
    });

    await harness
      .withIdentity(OWNER)
      .mutation(api.work.retryFailed, { workItemId, feedback: 'Use delay notice B.' });

    expect((await readItem(harness, workItemId)).managerFeedback).toMatchObject({
      reason: 'Use delay notice B.',
      kind: 'retry-note',
      answersQuestion: true,
    });
  });

  it('records the eligibility waiver when the manager retries an out-of-scope skip', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'skipped');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        plan: undefined,
        verdict: {
          decision: 'skip',
          reason: 'out-of-scope: no charter or current documented-system overlap',
        },
        skipReason: 'out-of-scope: no charter or current documented-system overlap',
      });
    });

    const result = await harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });

    expect(result).toEqual({ ok: true, resumeState: 'discovered' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('discovered');
    expect(row.skipReason).toBeUndefined();
    expect(typeof row.scopeWaivedAt).toBe('number');
    expect(row.qualityFitWaivedAt).toBeUndefined();
    const retries = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect()
      ).filter((event) => event.type === 'work.retry'),
    );
    expect(retries.map((event) => event.payload)).toEqual([
      { workItemId, resumeState: 'discovered', fromState: 'skipped', waived: 'scope' },
    ]);
  });

  it('does not waive the filter for a run that failed for another reason', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'failed');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, { plan: undefined, skipReason: 'the model returned no plan' });
    });

    await harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });

    const row = await readItem(harness, workItemId);
    expect(row.qualityFitWaivedAt).toBeUndefined();
    expect(row.scopeWaivedAt).toBeUndefined();
  });
});

describe('the exact-action gate', (): void => {
  it('holds an executing run with its literal actions and run id', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing');
    const result = await harness.mutation(internal.work.setActionsPending, {
      workItemId,
      runId,
      output: pendingOutput,
    });
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
    expect((await eventsOfType(harness, agentId, 'work.actions-pending'))[0].payload).toMatchObject(
      { autonomousActions: false },
    );
    expect(await scheduledFunctionNames(harness)).toEqual([]);
  });

  it('persists a verdict per action at hold time, with the reason a held row carries', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing', [
      'boss:message',
      'linear:read',
    ]);
    const output = {
      ...pendingOutput,
      actions: [
        {
          tool: 'mcp.call',
          args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"i"}' },
        },
        ...pendingOutput.actions,
        {
          tool: 'http.request',
          args: {
            surface: 'slack',
            method: 'POST',
            path: '/chat.postMessage',
            body: '{"channel":"D0MANAGER","text":"hi"}',
          },
        },
      ],
    };
    const result = await harness.mutation(internal.work.setActionsPending, {
      workItemId,
      runId,
      output,
    });
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

    // Refused at hold time, the only action leaves nothing to decide, so the
    // run stops naming the refusal instead of parking with no approve control.
    await expect(
      harness.mutation(internal.work.setActionsPending, { workItemId, runId, output }),
    ).resolves.toEqual({ pending: false });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(row.skipReason).toContain(
      "Day0's gate refused every action (surface not connected (ungranted))",
    );
    expect(
      (await eventsOfType(harness, agentId, 'work.actions-pending')).map(
        (event) => (event.payload as { refusals?: unknown }).refusals,
      ),
    ).toEqual([[{ index: 0, reason: 'surface not connected (ungranted)' }]]);
  });

  it('refuses a refused row at approval and applies the rest by selection', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing', [
      'boss:message',
      'linear:read',
    ]);
    const output = {
      ...pendingOutput,
      actions: [
        pendingOutput.actions[0],
        {
          tool: 'mcp.call',
          args: { surface: 'linear', tool: 'delete_issue', toolArgsJson: '{"id":"i"}' },
        },
      ],
    };
    await harness.mutation(internal.work.setActionsPending, { workItemId, runId, output });
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [0, 1],
      }),
    ).rejects.toThrow(
      'action 2 is refused (tool not in the surface allowlist (delete_issue)); approve the others by selection',
    );
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [1],
      }),
    ).rejects.toThrow('action 2 is refused');
    expect((await readItem(harness, workItemId)).approvedIndexes).toBeUndefined();
    expect(await scheduledFunctionNames(harness)).toEqual([]);
    const result = await harness
      .withIdentity(OWNER)
      .mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0] });
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
    expect(approved[0].payload).toMatchObject({
      approvedIndexes: [0],
      rejectedIndexes: [],
      refusedIndexes: [1],
      autoIndexes: [],
    });
  });

  it('refuses to hold a run that is not executing, and an output without actions', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'completed');
    await expect(
      harness.mutation(internal.work.setActionsPending, {
        workItemId,
        runId,
        output: pendingOutput,
      }),
    ).resolves.toEqual({ pending: false });
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
    const result = await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [1, 0, 1],
    });
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
    await expect(
      harness.withIdentity(managerIdentity('intruder')).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [0],
      }),
    ).rejects.toThrow('forbidden');
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [2],
      }),
    ).rejects.toThrow('outside the pending list');
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [-1],
      }),
    ).rejects.toThrow('outside the pending list');
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [0.5],
      }),
    ).rejects.toThrow('outside the pending list');
    const other = await seed(harness, 'plan-approved');
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId: other.workItemId,
        pendingRunId: other.runId,
        approvedIndexes: [],
      }),
    ).rejects.toThrow('expected actions-pending');
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

  it('stamps the rejection and lets go of the item, keeping the claim on a page field the run wrote', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await pend(harness);
    const [itemClaim, fieldClaim] = await harness.run(async (ctx) => [
      await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:REVOPS-7',
        agentId,
        workItemId,
        claimedAt: 1,
      }),
      await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'looker:tile',
        agentId,
        workItemId,
        claimedAt: 1,
        writeTarget: { surface: 'looker', field: 'tile' },
      }),
    ]);

    await harness
      .withIdentity(OWNER)
      .mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason: 'wrong issue' });

    const failed = await readItem(harness, workItemId);
    expect(failed.rejectedAt).toEqual(expect.any(Number));
    expect(failed.planRejectedAt).toBeUndefined();
    const claims = await harness.run(async (ctx) => [
      await ctx.db.get(itemClaim!),
      await ctx.db.get(fieldClaim!),
    ]);
    expect(claims[0]?.releasedAt).toEqual(expect.any(Number));
    expect(claims[1]?.releasedAt).toBeUndefined();
    expect(claims[1]?.settledAt).toEqual(expect.any(Number));
  });

  it('keeps a plan rejection from before the rejection stamp existed as the first rejection', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await pend(harness);
    await harness.run(async (ctx) => await ctx.db.patch(workItemId, { planRejectedAt: 5 }));

    await harness
      .withIdentity(OWNER)
      .mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason: 'wrong issue' });

    expect((await readItem(harness, workItemId)).rejectedAt).toBe(5);
  });

  it('rejects to failed with the reason, keeps the draft, and retries from plan-approved', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await pend(harness);
    await harness
      .withIdentity(OWNER)
      .mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason: 'wrong issue' });
    const failed = await readItem(harness, workItemId);
    expect(failed.state).toBe('failed');
    expect(failed.skipReason).toBe('rejected by the manager: wrong issue');
    expect(failed.pendingRunId).toBeUndefined();
    expect(failed.output).toEqual(pendingOutput);
    expect(await eventTypes(harness, agentId)).toContain('work.actions-rejected');
    await expect(
      harness
        .withIdentity(OWNER)
        .mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason: 'again' }),
    ).rejects.toThrow('expected actions-pending');
    const retried = await harness
      .withIdentity(OWNER)
      .mutation(api.work.retryFailed, { workItemId });
    expect(retried).toEqual({ ok: true, resumeState: 'plan-approved' });
    expect((await readItem(harness, workItemId)).state).toBe('plan-approved');
    const blank = await pend(harness);
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, {
      workItemId: blank.workItemId,
      pendingRunId: blank.runId,
      reason: '  ',
    });
    expect((await readItem(harness, blank.workItemId)).skipReason).toBe('rejected by the manager');
  });

  it('claims the approved actions exactly once with the preserved run id', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await pend(harness);
    await expect(
      harness.mutation(internal.work.claimApprovedActions, { workItemId }),
    ).resolves.toEqual({
      claimed: false,
      reason: 'no actions have been approved',
    });
    await harness
      .withIdentity(OWNER)
      .mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0] });
    const claim = await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    expect(claim).toMatchObject({
      claimed: true,
      runId,
      approvedIndexes: [0],
      output: pendingOutput,
    });
    expect((await readItem(harness, workItemId)).state).toBe('executing');
    await expect(
      harness.mutation(internal.work.claimApprovedActions, { workItemId }),
    ).resolves.toEqual({
      claimed: false,
      reason: 'workItem state is executing; expected actions-pending',
    });
  });

  it('completes a run whose only unlanded rows are held, and clears the gate fields', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await pend(harness);
    await harness
      .withIdentity(OWNER)
      .mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0] });
    await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    await harness.mutation(internal.work.setCompleted, {
      workItemId,
      runId,
      output: {
        ...pendingOutput,
        applied: [
          { tool: 'mcp.call', ok: true, effect: 'landed', idempotencyKey: 'k0' },
          {
            tool: 'mcp.call',
            ok: true,
            held: true,
            reason: 'not approved by the manager',
            idempotencyKey: 'k1',
          },
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
    const applied = (
      (await readItem(harness, workItemId)).output as {
        applied: Array<{ idempotencyKey: string }>;
      }
    ).applied;
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
      harness.withIdentity(managerIdentity('intruder')).mutation(api.work.reconcileFailed, {
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

  it('keeps a note for the manager when work landed, and none for a stop, per run', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing', undefined, {
      withSlack: true,
    });
    const comment = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: JSON.stringify({ issueId: 'iss-1', body: 'x' }),
      },
    };
    await harness.mutation(internal.work.setCompleted, {
      workItemId,
      runId,
      output: {
        draft: '',
        notes: '',
        actions: [comment],
        applied: [
          { tool: 'mcp.call', ok: true, effect: 'commented on REVOPS-1', idempotencyKey: 'a' },
        ],
      },
    });
    const notes = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('managerNotes')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(notes.map((note) => [note.kind, note.workItemId, note.claimedAt])).toEqual([
      ['landed', workItemId, undefined],
    ]);
    // The line is the action in a manager's words, never the provider's echo of it.
    expect(notes[0].text).toBe(
      'Priya finished “Add the close-summary audit note”: 1 change landed.\n- Comment on iss-1: "x"',
    );
    expect(await scheduledFunctionNames(harness)).toContain(
      'managerChannelActions:sendManagerNote',
    );

    // A stop is read on the card, not sent: nothing needs deciding.
    const { workItemId: stoppedItem, runId: stoppedRun } = await seed(
      harness,
      'executing',
      undefined,
      { withSlack: true },
    );
    await harness.mutation(internal.work.setFailed, {
      workItemId: stoppedItem,
      runId: stoppedRun,
      reason: 'the read did not land',
      output: {
        draft: '',
        notes: '',
        actions: [comment],
        applied: [{ tool: 'mcp.call', ok: false, reason: 'timeout', idempotencyKey: 'a' }],
      },
    });
    const all = await harness.run(async (ctx) => await ctx.db.query('managerNotes').collect());
    expect(all.filter((note) => note.workItemId === stoppedItem)).toEqual([]);

    // Without a manager channel there is nowhere to send, so nothing is kept.
    const bare = convexTest(schema, allConvexModules());
    const { workItemId: bareItem, runId: bareRun } = await seed(bare, 'executing');
    await bare.mutation(internal.work.setCompleted, {
      workItemId: bareItem,
      runId: bareRun,
      output: {
        draft: '',
        notes: '',
        actions: [comment],
        applied: [{ tool: 'mcp.call', ok: true, idempotencyKey: 'a' }],
      },
    });
    expect(await bare.run(async (ctx) => await ctx.db.query('managerNotes').collect())).toEqual([]);
  });

  it('keeps both landed and stopped notes for the hourly digest without sending them', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing', undefined, {
      withSlack: true,
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { managerNotifications: 'digest' });
    });
    await harness.mutation(internal.work.setFailed, {
      workItemId,
      runId,
      reason: 'the read did not land',
      output: { draft: '', notes: '', actions: [], applied: [] },
    });
    const { workItemId: landedItem, runId: landedRun } = await harness.run(async (ctx) => {
      const id = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-2',
        title: 'Close REVOPS-2',
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state: 'executing',
        observedAt: 1,
        createdAt: 1,
      });
      const run = await ctx.db.insert('events', {
        agentId,
        type: 'work.execution-claimed',
        payload: { workItemId: id },
        createdAt: 1,
      });
      await ctx.db.patch(id, { executionRunId: run });
      return { workItemId: id, runId: run };
    });
    await harness.mutation(internal.work.setCompleted, {
      workItemId: landedItem,
      runId: landedRun,
      output: {
        draft: '',
        notes: '',
        actions: [
          {
            tool: 'mcp.call',
            args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{}' },
          },
        ],
        applied: [{ tool: 'mcp.call', ok: true, effect: 'commented', idempotencyKey: 'a' }],
      },
    });
    const notes = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('managerNotes')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(notes.map((note) => note.kind)).toEqual(['stopped', 'landed']);
    expect(notes[0].text).toBe(
      'Priya stopped on “Add the close-summary audit note”: the read did not land. Nothing landed; Retry stands in day0.',
    );
    expect(await scheduledFunctionNames(harness)).not.toContain(
      'managerChannelActions:sendManagerNote',
    );
    expect(
      (await harness.query(internal.work.digestCandidates, { cursor: null })).agentIds,
    ).toEqual([agentId]);
  });

  it("finds every agent holding an unsent note, however many one agent's stuck notes pile up first (review m18)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [stuck, waiting] = await harness.run(async (ctx) => {
      const ids: Id<'agents'>[] = [];
      for (const [name, notes] of [
        ['Stuck', 600],
        ['Waiting', 1],
      ] as const) {
        const agentId = await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name,
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
        const workItemId = await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: `${name}-1`,
          title: 'A ticket',
          contentSummary: 'A ticket.',
          contentRefs: [],
          state: 'completed',
          observedAt: 1,
          createdAt: 1,
        });
        for (let index = 0; index < notes; index += 1) {
          await ctx.db.insert('managerNotes', {
            agentId,
            workItemId,
            kind: 'landed',
            text: 'landed',
            createdAt: index,
          });
        }
        ids.push(agentId);
      }
      return ids;
    });
    const found: Id<'agents'>[] = [];
    let cursor: string | null = null;
    do {
      const page: { agentIds: Id<'agents'>[]; cursor: string | null } = await harness.query(
        internal.work.digestCandidates,
        { cursor },
      );
      found.push(...page.agentIds);
      cursor = page.cursor;
    } while (cursor !== null);
    expect(found.sort()).toEqual([stuck, waiting].sort());
  });

  it('records a failure with nothing landed as stopped, and one after a landed write as failed', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing', undefined, {
      withSlack: true,
    });
    const read = {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'get_issue', toolArgsJson: JSON.stringify({ id: 'iss-1' }) },
    };
    const dm = {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'POST',
        path: '/chat.postMessage',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
        body: JSON.stringify({ channel: 'D0MANAGER', text: 'Which figure?' }),
      },
    };
    const comment = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: JSON.stringify({ issueId: 'iss-1', body: 'x' }),
      },
    };
    // A read and the manager DM landed; neither is work.
    await harness.mutation(internal.work.setFailed, {
      workItemId,
      runId,
      reason: 'the closing phase could not settle the owner',
      output: {
        draft: '',
        notes: '',
        actions: [read, dm, comment],
        applied: [
          { tool: 'mcp.call', ok: true, idempotencyKey: 'a' },
          { tool: 'http.request', ok: true, idempotencyKey: 'b' },
          { tool: 'mcp.call', ok: false, reason: 'provider refused', idempotencyKey: 'c' },
        ],
      },
    });
    const stopped = await readItem(harness, workItemId);
    expect(stopped.state).toBe('failed');
    expect(stopped.skipReason).toBe('stopped: the closing phase could not settle the owner');
    await expect(eventsOfType(harness, agentId, 'work.failed')).resolves.toMatchObject([
      {
        payload: {
          workItemId,
          stopped: true,
          reason: 'stopped: the closing phase could not settle the owner',
        },
      },
    ]);

    // A landed comment is work: the failure is a failure, and Retry reconciles it.
    const {
      agentId: other,
      workItemId: landedItem,
      runId: landedRun,
    } = await seed(harness, 'executing');
    await harness.mutation(internal.work.setFailed, {
      workItemId: landedItem,
      runId: landedRun,
      reason: 'the status change was refused',
      output: {
        draft: '',
        notes: '',
        actions: [comment, comment],
        applied: [
          { tool: 'mcp.call', ok: true, idempotencyKey: 'a' },
          { tool: 'mcp.call', ok: false, reason: 'provider refused', idempotencyKey: 'b' },
        ],
      },
    });
    const failed = await readItem(harness, landedItem);
    expect(failed.skipReason).toBe('the status change was refused');
    const events = await eventsOfType(harness, other, 'work.failed');
    expect(events).toHaveLength(1);
    expect((events[0].payload as { stopped?: boolean }).stopped).toBeUndefined();
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
    const { agentId, workItemId, runId } = await seed(
      harness,
      'executing',
      ['boss:message', 'linear:read', 'linear:write', 'slack:read', 'slack:write'],
      {
        withSlack: true,
      },
    );
    const output = {
      draft: 'd',
      notes: '',
      actions: [readIssue, workingComment, managerDm, publicReply, pendingOutput.actions[1]],
    };
    const result = await harness.mutation(internal.work.setActionsPending, {
      workItemId,
      runId,
      output,
    });
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
    expect(await eventTypes(harness, agentId)).toEqual([
      'work.execution-claimed',
      'work.actions-auto-applying',
    ]);
    expect((await eventsOfType(harness, agentId, 'work.actions-auto-applying'))[0].payload).toEqual(
      {
        workItemId,
        runId,
        actionCount: 5,
        autoIndexes: [0, 2],
        heldIndexes: [1, 3, 4],
        refusedIndexes: [],
        autonomousActions: false,
      },
    );
    expect(await scheduledFunctionNames(harness)).toEqual([
      'work:recoverInterruptedApply',
      'workActions:applyApprovedActions',
    ]);
    // The manager cannot decide while the auto phase is in flight.
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [3],
      }),
    ).rejects.toThrow('expected actions-pending');

    const claim = await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    expect(claim).toMatchObject({
      claimed: true,
      phase: 'auto',
      approvedIndexes: [0, 2],
      heldIndexes: [1, 3, 4],
      heldReasons: [],
      autonomousActions: false,
    });
    if (!claim.claimed) throw new Error('unreachable');
    expect(await harness.mutation(internal.work.claimApprovedActions, { workItemId })).toEqual({
      claimed: false,
      reason: 'workItem state is executing; expected actions-pending',
    });
    const applied = [
      { tool: 'mcp.call', ok: true, effect: 'read', authority: 'standing', idempotencyKey: 'k0' },
      {
        tool: 'mcp.call',
        ok: true,
        held: true,
        awaitingApproval: true,
        reason: AWAITING_APPROVAL,
        idempotencyKey: 'k1',
      },
      {
        tool: 'http.request',
        ok: true,
        providerId: '1.1',
        authority: 'standing',
        idempotencyKey: 'k2',
      },
      {
        tool: 'http.request',
        ok: true,
        held: true,
        awaitingApproval: true,
        reason: AWAITING_APPROVAL,
        idempotencyKey: 'k3',
      },
      {
        tool: 'mcp.call',
        ok: true,
        held: true,
        awaitingApproval: true,
        reason: AWAITING_APPROVAL,
        idempotencyKey: 'k4',
      },
    ];
    await expect(
      harness.mutation(internal.work.setAwaitingApproval, {
        workItemId,
        runId,
        applyAttemptId: runId,
        output: { ...output, applied },
      }),
    ).resolves.toEqual({ parked: false });
    await expect(
      harness.mutation(internal.work.setAwaitingApproval, {
        workItemId,
        runId,
        applyAttemptId: claim.applyAttemptId,
        output: { ...output, applied },
      }),
    ).resolves.toEqual({ parked: true });
    const parked = await readItem(harness, workItemId);
    expect(parked).toMatchObject({
      state: 'actions-pending',
      pendingRunId: runId,
      executionRunId: runId,
    });
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
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [2, 3],
      }),
    ).rejects.toThrow('action 3 was applied automatically and cannot be approved again');
    await harness
      .withIdentity(OWNER)
      .mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [3] });
    const second = await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    expect(second).toMatchObject({
      claimed: true,
      phase: 'approved',
      approvedIndexes: [3],
      heldIndexes: [1, 3, 4],
    });
    expect((second as { output: { applied: unknown[] } }).output.applied).toEqual(applied);
    expect(
      (await eventsOfType(harness, agentId, 'work.actions-approved'))[0].payload,
    ).toMatchObject({
      approvedIndexes: [3],
      rejectedIndexes: [1, 4],
      autoIndexes: [0, 2],
    });
    // No counter, no window: the only events of the run are the gate's own.
    expect(
      (await eventTypes(harness, agentId)).filter(
        (type) => type.startsWith('skill.') || type.startsWith('agent.'),
      ),
    ).toEqual([]);
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
    const { agentId, workItemId, runId } = await seed(harness, 'executing', grants, {
      autonomousActions: true,
      withSlack: true,
    });
    const output = {
      draft: 'd',
      notes: '',
      actions: [
        readIssue,
        workingComment,
        managerDm,
        publicReply,
        pendingOutput.actions[1],
        {
          tool: 'mcp.call',
          args: { surface: 'linear', tool: 'delete_issue', toolArgsJson: '{"id":"REVOPS-1"}' },
        },
      ],
    };
    const result = await harness.mutation(internal.work.setActionsPending, {
      workItemId,
      runId,
      output,
    });
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
    expect(
      (await eventsOfType(harness, agentId, 'work.actions-auto-applying'))[0].payload,
    ).toMatchObject({
      autoIndexes: [0, 1, 2, 3, 4],
      heldIndexes: [],
      refusedIndexes: [5],
      autonomousActions: true,
    });
    const claim = await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    expect(claim).toMatchObject({
      claimed: true,
      phase: 'auto',
      autonomousActions: true,
      heldIndexes: [],
      heldReasons: [[5, 'tool not in the surface allowlist (delete_issue)']],
    });

    // A read or the DM without its own grant is refused under the switch too.
    const ungranted = await seed(harness, 'executing', ['linear:write'], {
      autonomousActions: true,
      withSlack: true,
    });
    await harness.mutation(internal.work.setActionsPending, {
      workItemId: ungranted.workItemId,
      runId: ungranted.runId,
      output: { draft: 'd', notes: '', actions: [readIssue, managerDm, publicReply] },
    });
    expect((await readItem(harness, ungranted.workItemId)).actionVerdicts).toEqual([
      { disposition: 'refused', reason: 'no grant (linear:read)' },
      { disposition: 'refused', reason: 'no grant (boss:message)' },
      { disposition: 'auto' },
    ]);

    // Turning the switch off between the hold and the apply claim is what the claim reports.
    const flipped = await seed(harness, 'executing', grants, {
      autonomousActions: true,
      withSlack: true,
    });
    await harness.mutation(internal.work.setActionsPending, {
      workItemId: flipped.workItemId,
      runId: flipped.runId,
      output: { draft: 'd', notes: '', actions: [publicReply] },
    });
    await harness.run(
      async (ctx) => await ctx.db.patch(flipped.agentId, { autonomousActions: false }),
    );
    expect(
      await harness.mutation(internal.work.claimApprovedActions, {
        workItemId: flipped.workItemId,
      }),
    ).toMatchObject({
      claimed: true,
      phase: 'auto',
      approvedIndexes: [0],
      autonomousActions: false,
    });
  });

  it('leaves the agent row alone on completion', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const done = await seed(harness, 'executing');
    await harness.mutation(internal.work.setCompleted, {
      workItemId: done.workItemId,
      runId: done.runId,
      output: { ...pendingOutput, applied: [{ tool: 'mcp.call', ok: true, idempotencyKey: 'k0' }] },
    });
    const completedAgent = await harness.run(async (ctx) => await ctx.db.get(done.agentId));
    expect(completedAgent?.autonomousActions).toBeUndefined();
    expect(
      (await eventTypes(harness, done.agentId)).filter((type) => type.startsWith('agent.')),
    ).toEqual([]);
  });

  it('keeps the auto rows in the ledger when the held ones are rejected, and fences retry on them', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'actions-pending');
    const applied = [
      { tool: 'mcp.call', ok: true, providerId: 'c-1', idempotencyKey: 'k0' },
      {
        tool: 'mcp.call',
        ok: true,
        held: true,
        awaitingApproval: true,
        reason: AWAITING_APPROVAL,
        idempotencyKey: 'k1',
      },
    ];
    await harness.run(
      async (ctx) =>
        await ctx.db.patch(workItemId, {
          pendingRunId: runId,
          executionRunId: runId,
          actionVerdicts: [{ disposition: 'auto' }, { disposition: 'held', reason: HELD_MUTATION }],
          output: { ...pendingOutput, applied },
        }),
    );
    await harness
      .withIdentity(OWNER)
      .mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason: 'not now' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect((row.output as { applied: unknown[] }).applied).toEqual([
      applied[0],
      {
        tool: 'mcp.call',
        ok: true,
        held: true,
        reason: 'rejected by the manager: not now',
        idempotencyKey: 'k1',
      },
    ]);
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId }),
    ).rejects.toThrow('reconcile the provider first');
  });

  it('carries phase one’s ledger on the dependent-authoring event, so the trail keeps it whatever the closing set becomes', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing');
    const landed = {
      tool: 'mcp.call',
      ok: true,
      authority: 'standing',
      effect: 'Refreshed the tile',
      idempotencyKey: `${workItemId}:${runId}:0`,
    };
    await harness.mutation(internal.work.prepareDependentPhase, {
      workItemId,
      runId,
      output: {
        ...pendingOutput,
        needsDependentPhase: true,
        phase: 'dependent-authoring',
        applied: [landed],
      },
    });
    const [event] = await eventsOfType(harness, agentId, 'work.dependent-authoring');
    expect(event?.payload).toMatchObject({ workItemId, runId, output: { applied: [landed] } });
    const ledger = collectLedgerObservations([event!], []);
    expect(ledger.map((observation) => observation.entry)).toEqual([landed]);
  });

  it('claims the dependent authoring turn once and never prepares a second phase', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'executing');
    await expect(
      harness.mutation(internal.work.prepareDependentPhase, {
        workItemId,
        runId,
        output: {
          ...pendingOutput,
          needsDependentPhase: true,
          phase: 'dependent-authoring',
          applied: [],
        },
      }),
    ).resolves.toEqual({ prepared: true });
    const first = await harness.mutation(internal.work.claimDependentAuthoring, {
      workItemId,
      runId,
    });
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
        output: {
          ...pendingOutput,
          phase: 'dependent',
          actionIndexOffset: 0,
          planStepOutcomes: [],
          initial: {},
        },
      }),
    ).resolves.toEqual({ pending: true, phase: 'manager' });
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [0],
      }),
    ).rejects.toThrow('pending run changed');
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
        {
          tool: 'mcp.call',
          args: { surface: 'looker', tool: 'browser_click', toolArgsJson: '{"element":"Save"}' },
        },
        {
          tool: 'mcp.call',
          args: { surface: 'looker', tool: 'browser_snapshot', toolArgsJson: '{}' },
        },
      ],
      applied: [
        {
          tool: 'mcp.call',
          ok: true,
          effect: 'browser_click on looker · Save',
          idempotencyKey: 'k0',
        },
        {
          tool: 'mcp.call',
          ok: true,
          effect: 'browser_snapshot on looker · 74%',
          idempotencyKey: 'k1',
        },
      ],
    };
    await harness.run(
      async (ctx) =>
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
    await harness
      .withIdentity(OWNER)
      .mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason: 'not now' });
    expect((await readItem(harness, workItemId)).state).toBe('failed');
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId }),
    ).rejects.toThrow('reconcile the provider first');
  });

  it('reschedules an unclaimed auto phase and records unknown outcomes for a claimed one', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(
      harness,
      'executing',
      ['boss:message', 'linear:read', 'linear:write', 'slack:read', 'slack:write'],
      {
        withSlack: true,
      },
    );
    await harness.mutation(internal.work.setActionsPending, {
      workItemId,
      runId,
      output: { draft: 'd', notes: '', actions: [readIssue, publicReply] },
    });
    await expect(
      harness.mutation(internal.work.recoverInterruptedApply, {
        workItemId,
        pendingRunId: runId,
        phase: 'auto',
      }),
    ).resolves.toEqual({ recovered: 'rescheduled' });
    await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    await expect(
      harness.mutation(internal.work.recoverInterruptedApply, {
        workItemId,
        pendingRunId: runId,
        phase: 'auto',
      }),
    ).resolves.toEqual({ recovered: 'outcome-unknown' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(
      (row.output as { applied: Array<Record<string, unknown>> }).applied.map((entry) => [
        entry.ok,
        entry.held ?? false,
        entry.reason,
      ]),
    ).toEqual([
      [false, false, 'outcome unknown after interrupted apply - verify provider before retry'],
      [true, true, HELD_PUBLIC_POST],
    ]);
  });

  it("keeps a prior phase's landed rows when the approved phase is interrupted", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'actions-pending');
    const landed = { tool: 'mcp.call', ok: true, providerId: 'c-1', idempotencyKey: 'k0' };
    await harness.run(
      async (ctx) =>
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
    await harness
      .withIdentity(OWNER)
      .mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [1] });
    await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    await expect(
      harness.mutation(internal.work.recoverInterruptedApply, {
        workItemId,
        pendingRunId: runId,
        phase: 'approved',
      }),
    ).resolves.toEqual({ recovered: 'outcome-unknown' });
    const row = await readItem(harness, workItemId);
    expect((row.output as { applied: unknown[] }).applied).toEqual([
      landed,
      expect.objectContaining({
        ok: false,
        reason: 'outcome unknown after interrupted apply - verify provider before retry',
      }),
    ]);
  });

  it('ignores the auto-phase recovery timer after the manager phase has been claimed', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'actions-pending');
    const landed = { tool: 'mcp.call', ok: true, providerId: 'read-1', idempotencyKey: 'k0' };
    await harness.run(
      async (ctx) =>
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
    await expect(
      harness.withIdentity(OWNER).query(api.work.countOpenForAgent, { agentId }),
    ).resolves.toBe(1);
    await expect(
      harness.withIdentity(OWNER).query(api.work.findExistingClaim, {
        agentId,
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
      }),
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
    await harness
      .withIdentity(OWNER)
      .mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason });
    const failed = await readItem(harness, workItemId);
    expect(failed.skipReason).toBe(`rejected by the manager: ${reason.slice(0, 200)}`);
    expect(failed.managerFeedback).toMatchObject({ reason, runId, kind: 'rejection' });
    await harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });
    expect((await readItem(harness, workItemId)).managerFeedback?.reason).toBe(reason);
  });

  it('keeps the feedback the completed run addressed, marked as addressed', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'executing');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        managerFeedback: {
          reason: 'Rewrite this as a close summary.',
          at: 2,
          runId,
          kind: 'rejection',
        },
      });
    });
    await harness.mutation(internal.work.setCompleted, {
      workItemId,
      runId,
      output: {
        ...pendingOutput,
        applied: [{ tool: 'mcp.call', ok: true, effect: 'landed', idempotencyKey: 'k0' }],
      },
    });

    // The reason stays readable on the finished item; the mark says the run
    // that completed is the one that answered it, so no later run reads it as
    // a live direction.
    expect((await readItem(harness, workItemId)).managerFeedback).toEqual({
      reason: 'Rewrite this as a close summary.',
      at: 2,
      runId,
      kind: 'rejection',
      addressedAt: expect.any(Number),
    });
  });
});

describe('sending a completed item back with a note', (): void => {
  it('retries a completed item from its plan with the note as manager feedback', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'completed');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        output: {
          actions: [readIssue],
          applied: [{ tool: 'mcp.call', ok: true, effect: 'read issue', idempotencyKey: 'read' }],
        },
      });
    });

    const result = await harness.withIdentity(OWNER).mutation(api.work.retryFailed, {
      workItemId,
      feedback: 'Draft the reply for the thread and hold it.',
    });

    expect(result).toEqual({ ok: true, resumeState: 'plan-approved' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('plan-approved');
    expect(row.managerFeedback).toMatchObject({
      reason: 'Draft the reply for the thread and hold it.',
      kind: 'retry-note',
    });
    const retries = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect()
      ).filter((event) => event.type === 'work.retry'),
    );
    expect(retries.map((event) => event.payload)).toEqual([
      {
        workItemId,
        resumeState: 'plan-approved',
        fromState: 'completed',
        feedback: 'Draft the reply for the thread and hold it.',
      },
    ]);
  });

  it('refuses to retry a completed item without a note', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'completed');
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId, feedback: '   ' }),
    ).rejects.toThrow('a completed item is sent back with a note');
    expect((await readItem(harness, workItemId)).state).toBe('completed');
  });

  it('fences the retry of a completed item on its landed writes until they are reconciled', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'completed');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        output: {
          actions: [pendingOutput.actions[1]],
          applied: [
            {
              tool: 'http.request',
              ok: true,
              effect: 'sent the manager DM',
              providerId: 'dm-1',
              idempotencyKey: 'dm',
            },
          ],
        },
      });
    });
    await expect(
      harness
        .withIdentity(OWNER)
        .mutation(api.work.retryFailed, { workItemId, feedback: 'Draft the reply.' }),
    ).rejects.toThrow('reconcile the provider first');

    const reconciled = await harness
      .withIdentity(OWNER)
      .mutation(api.work.reconcileFailed, { workItemId, confirmed: true });
    expect(reconciled).toEqual({ ok: true, reconciledEntries: 1 });

    await expect(
      harness
        .withIdentity(OWNER)
        .mutation(api.work.retryFailed, { workItemId, feedback: 'Draft the reply.' }),
    ).resolves.toEqual({ ok: true, resumeState: 'plan-approved' });
  });
});

describe('re-admitting pending work when the policy changes', (): void => {
  type Seeded = { agentId: Id<'agents'>; ids: Record<string, Id<'workItems'>> };

  /** One agent with a connected Linear and one parked row per verdict kind. */
  async function seedParked(harness: Harness): Promise<Seeded> {
    const { agentId } = await seed(harness, 'completed');
    const ids = await harness.run(async (ctx): Promise<Record<string, Id<'workItems'>>> => {
      const insert = async (
        externalId: string,
        state: Doc<'workItems'>['state'],
        verdict: Record<string, unknown>,
      ): Promise<Id<'workItems'>> =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId,
          title: `Item ${externalId}`,
          contentSummary: 'Triage.',
          contentRefs: [],
          observedAt: 1,
          createdAt: 1,
          state,
          verdict,
          ...(state === 'skipped' ? { skipReason: String(verdict.reason) } : {}),
        });
      return {
        outOfScope: await insert('REVOPS-10', 'skipped', {
          decision: 'skip',
          reason: 'out-of-scope: no charter or current documented-system overlap',
        }),
        qualityFit: await insert('REVOPS-11', 'skipped', {
          decision: 'skip',
          reason: 'quality-fit-fail: the request is too thin',
        }),
        lowValue: await insert('REVOPS-12', 'skipped', {
          decision: 'skip',
          reason: 'low-value: 10',
        }),
        awaitingConnection: await insert('REVOPS-13', 'deferred', {
          decision: 'defer',
          reason: 'awaiting-connection',
          missingSurface: 'northstar-crm',
        }),
        awaitingPermission: await insert('REVOPS-14', 'deferred', {
          decision: 'defer',
          reason: 'awaiting-permission',
          missingPermissions: ['northstar-crm:read'],
        }),
      };
    });
    return { agentId, ids };
  }

  async function states(
    harness: Harness,
    ids: Record<string, Id<'workItems'>>,
  ): Promise<Record<string, string>> {
    return await harness.run(async (ctx): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const [name, id] of Object.entries(ids))
        out[name] = (await ctx.db.get(id))?.state ?? 'missing';
      return out;
    });
  }

  async function requeuedEvents(
    harness: Harness,
    agentId: Id<'agents'>,
  ): Promise<Array<Record<string, unknown>>> {
    return await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect()
      )
        .filter((event) => event.type === 'work.requeued')
        .map((event) => event.payload as Record<string, unknown>),
    );
  }

  it('re-admits the skips a charter amendment can change, once per amendment, and records each', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, ids } = await seedParked(harness);

    const first = await harness.mutation(internal.work.reevaluatePending, {
      agentId,
      trigger: 'charter',
      key: 'charter:v2',
    });

    expect(first).toEqual({ readmitted: 2, examined: 5, continued: false });
    expect(await states(harness, ids)).toEqual({
      outOfScope: 'discovered',
      qualityFit: 'discovered',
      lowValue: 'skipped',
      awaitingConnection: 'deferred',
      awaitingPermission: 'deferred',
    });
    const row = await readItem(harness, ids.outOfScope);
    expect(row.verdict).toBeUndefined();
    expect(row.skipReason).toBeUndefined();
    expect(row.reevaluation).toEqual({
      trigger: 'charter',
      key: 'charter:v2',
      at: expect.any(Number),
      spent: ['charter:v2'],
    });
    expect(await requeuedEvents(harness, agentId)).toEqual([
      {
        workItemId: ids.outOfScope,
        trigger: 'charter',
        key: 'charter:v2',
        previousState: 'skipped',
      },
      {
        workItemId: ids.qualityFit,
        trigger: 'charter',
        key: 'charter:v2',
        previousState: 'skipped',
      },
    ]);

    // The evaluator skips it again; the same amendment firing twice is a no-op.
    await harness.run(async (ctx) => {
      await ctx.db.patch(ids.outOfScope, {
        state: 'skipped',
        verdict: {
          decision: 'skip',
          reason: 'out-of-scope: no charter or current documented-system overlap',
        },
      });
    });
    const again = await harness.mutation(internal.work.reevaluatePending, {
      agentId,
      trigger: 'charter',
      key: 'charter:v2',
    });
    expect(again).toEqual({ readmitted: 0, examined: 4, continued: false });
    expect((await states(harness, ids)).outOfScope).toBe('skipped');

    // The next amendment is a new decision and re-admits it again.
    const next = await harness.mutation(internal.work.reevaluatePending, {
      agentId,
      trigger: 'charter',
      key: 'charter:v3',
    });
    expect(next).toEqual({ readmitted: 1, examined: 4, continued: false });
    expect((await states(harness, ids)).outOfScope).toBe('discovered');
    expect(await requeuedEvents(harness, agentId)).toHaveLength(3);
  });

  it('re-admits only out-of-scope skips when the documentation changes', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, ids } = await seedParked(harness);

    const result = await harness.mutation(internal.work.reevaluatePending, {
      agentId,
      trigger: 'documentation',
      key: 'documentation:source-1:abc',
    });

    expect(result).toEqual({ readmitted: 1, examined: 5, continued: false });
    expect(await states(harness, ids)).toMatchObject({
      outOfScope: 'discovered',
      qualityFit: 'skipped',
      lowValue: 'skipped',
      awaitingConnection: 'deferred',
      awaitingPermission: 'deferred',
    });
  });

  it('re-admits out-of-scope skips and the work parked on a surface when that surface connects', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, ids } = await seedParked(harness);
    const surfaceId = await harness.run(
      async (ctx): Promise<Id<'surfaces'>> =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'northstar-crm',
          displayName: 'Northstar CRM',
          class: 'crm',
          verdict: 'connected',
          whereFound: [],
          credentialLanded: true,
          lastVerifiedAt: 1,
          createdAt: 1,
        }),
    );

    const result = await harness.mutation(internal.work.reevaluatePending, {
      agentId,
      trigger: 'surface',
      key: `surface:${surfaceId}:100`,
      surfaceId,
    });

    expect(result).toEqual({ readmitted: 3, examined: 5, continued: false });
    expect(await states(harness, ids)).toEqual({
      outOfScope: 'discovered',
      qualityFit: 'skipped',
      lowValue: 'skipped',
      awaitingConnection: 'discovered',
      awaitingPermission: 'discovered',
    });
    const events = await requeuedEvents(harness, agentId);
    expect(events.find((event) => event.workItemId === ids.awaitingConnection)).toEqual({
      workItemId: ids.awaitingConnection,
      trigger: 'surface',
      key: `surface:${surfaceId}:100`,
      previousState: 'deferred',
      surfaceId,
      slug: 'northstar-crm',
      previousMissingSurface: 'northstar-crm',
    });
  });

  it('examines a bounded batch per call and continues by scheduling itself', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seed(harness, 'completed');
    const total = REEVALUATION_BATCH + 3;
    await harness.run(async (ctx) => {
      for (let index = 0; index < total; index += 1) {
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: `REVOPS-${1000 + index}`,
          title: `Item ${index}`,
          contentSummary: 'Triage.',
          contentRefs: [],
          observedAt: 1,
          createdAt: 1,
          state: 'skipped',
          verdict: {
            decision: 'skip',
            reason: 'out-of-scope: no charter or current documented-system overlap',
          },
        });
      }
    });

    const first = await harness.mutation(internal.work.reevaluatePending, {
      agentId,
      trigger: 'charter',
      key: 'charter:v2',
    });
    expect(first).toEqual({
      readmitted: REEVALUATION_BATCH,
      examined: REEVALUATION_BATCH,
      continued: true,
    });
    const pending = await harness.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.state.kind === 'pending' && job.name === 'work:reevaluatePending',
      ),
    );
    expect(pending).toHaveLength(1);
    expect((pending[0].args as Array<Record<string, unknown>>)[0]).toMatchObject({
      agentId,
      trigger: 'charter',
      key: 'charter:v2',
      after: { skipped: expect.any(Number) },
    });

    // Each readmitted row wakes the loop, which schedules its evaluation in workActions. The
    // drain allows a fixed number of macrotask pumps, and the first import of that module on a
    // busy runner can outlast them, so it is loaded before the drain waits on its actions.
    await allConvexModules()['../../convex/workActions.ts']?.();
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    const remaining = await harness.run(
      async (ctx) =>
        (
          await ctx.db
            .query('workItems')
            .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', 'skipped'))
            .collect()
        ).length,
    );
    expect(remaining).toBe(0);
    expect(await requeuedEvents(harness, agentId)).toHaveLength(total);
    vi.useRealTimers();
  });
});

describe('a re-listed ticket keeps its row current (Q11)', (): void => {
  const listed = (agentId: Id<'agents'>) => ({
    agentId,
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId: 'REVOPS-9',
    title: 'Reconcile the September pipeline',
    contentSummary: 'First read of the ticket.',
    contentRefs: ['https://linear.app/day0/issue/REVOPS-9'],
    owner: 'Kestrel Ops',
  });

  /** An owned agent with no work yet, for the seed to fill. */
  async function emptyAgent(harness: Harness): Promise<Id<'agents'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
  }

  async function onlyRow(harness: Harness): Promise<Doc<'workItems'>> {
    const rows = await harness.run(async (ctx) => await ctx.db.query('workItems').collect());
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it('dates the ask by the provider’s own time when intake gives one, or a chat message’s ts, and by the seed otherwise', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 8, 28, 9, 0));
    const harness = convexTest(schema, allConvexModules());
    const agentId = await emptyAgent(harness);
    const askedAt = Date.UTC(2026, 8, 27, 23, 30);
    await harness.mutation(internal.work.seedItem, { ...listed(agentId), askedAt });
    await harness.mutation(internal.work.seedItem, {
      ...listed(agentId),
      sourceCategory: 'inbox',
      sourceSystem: 'team-chat',
      externalId: 'C0REVOPS:1790551800.123456',
    });
    await harness.mutation(internal.work.seedItem, { ...listed(agentId), externalId: 'REVOPS-10' });
    const rows = await harness.run(async (ctx) => await ctx.db.query('workItems').collect());
    expect(Object.fromEntries(rows.map((row) => [row.externalId, row.observedAt]))).toEqual({
      'REVOPS-9': askedAt,
      'C0REVOPS:1790551800.123456': 1_790_551_800_123,
      'REVOPS-10': Date.UTC(2026, 8, 28, 9, 0),
    });
    vi.useRealTimers();
  });

  it('dates an ask the provider gives no time for by when intake read it, not by when the seed landed', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 8, 28, 9, 7));
    const harness = convexTest(schema, allConvexModules());
    const agentId = await emptyAgent(harness);
    const polledAt = Date.UTC(2026, 8, 28, 9, 0);
    await harness.mutation(internal.work.seedItem, { ...listed(agentId), observedAt: polledAt });
    expect((await onlyRow(harness)).observedAt).toBe(polledAt);
    vi.useRealTimers();
  });

  it('updates the title, summary and owner the tracker now shows instead of keeping the first read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await emptyAgent(harness);
    const first = await harness.mutation(internal.work.seedItem, listed(agentId));
    const again = await harness.mutation(internal.work.seedItem, {
      ...listed(agentId),
      title: 'Reconcile the September pipeline by Friday',
      contentSummary: 'The ticket as it reads now.',
      owner: 'day0 bot',
    });
    expect(again).toBe(first);
    expect(await onlyRow(harness)).toMatchObject({
      state: 'discovered',
      title: 'Reconcile the September pipeline by Friday',
      contentSummary: 'The ticket as it reads now.',
      owner: 'day0 bot',
    });
  });

  it('withdraws a waiting row whose ticket left the queue, says why on the card, and takes it back when it returns', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await emptyAgent(harness);
    await harness.mutation(internal.work.seedItem, listed(agentId));
    await harness.mutation(internal.work.withdrawListedItem, {
      ...listed(agentId),
      owner: 'Ana Ruiz',
      leftQueue: 'the ticket is assigned to someone else',
    });
    expect(await onlyRow(harness)).toMatchObject({
      state: 'cancelled',
      owner: 'Ana Ruiz',
      skipReason: 'withdrawn from the queue on the tracker: the ticket is assigned to someone else',
    });
    await harness.mutation(internal.work.withdrawListedItem, {
      ...listed(agentId),
      owner: 'Ana Ruiz',
      leftQueue: 'the ticket is completed',
    });
    expect((await onlyRow(harness)).skipReason).toBe(
      'withdrawn from the queue on the tracker: the ticket is completed',
    );
    await harness.mutation(internal.work.seedItem, { ...listed(agentId), owner: undefined });
    const returned = await onlyRow(harness);
    expect(returned.state).toBe('discovered');
    expect(returned.skipReason).toBeUndefined();
    const events = await harness.run(async (ctx) => await ctx.db.query('events').collect());
    expect(events.map((event) => event.type)).toEqual([
      'work.discovered',
      'work.withdrawn',
      'work.returned',
    ]);
  });

  it('creates no row for a ticket that left the queue before Day0 saw it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await emptyAgent(harness);
    await expect(
      harness.mutation(internal.work.withdrawListedItem, {
        ...listed(agentId),
        leftQueue: 'the ticket is completed',
      }),
    ).resolves.toBeNull();
    expect(await harness.run(async (ctx) => await ctx.db.query('workItems').collect())).toEqual([]);
  });

  it('shows the owner the newest listing of the ticket, without the assignee address, and no one else', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await emptyAgent(harness);
    const todo = { assigned: false, state: 'Todo', stateType: 'unstarted', doNotAutomate: false };
    const workItemId = await harness.mutation(internal.work.seedItem, {
      ...listed(agentId),
      tracker: todo,
    });
    const owner = harness.withIdentity(OWNER);
    // Only the discovery's listing so far: that is the newest.
    expect(await owner.query(api.work.latestListing, { workItemId })).toMatchObject({
      tracker: todo,
    });
    const taken = {
      ...todo,
      assigned: true,
      assigneeId: 'user-ana',
      assigneeEmail: 'ana@example.test',
      state: 'In Progress',
    };
    await harness.run(async (ctx) => {
      await ctx.db.insert('ticketListings', {
        agentId,
        workItemId,
        tracker: taken,
        refused: 'assigned to someone else',
        listedAt: Date.now() + 60_000,
      });
    });
    const latest = await owner.query(api.work.latestListing, { workItemId });
    expect(latest).toEqual({
      tracker: {
        assigned: true,
        assigneeId: 'user-ana',
        state: 'In Progress',
        stateType: 'unstarted',
        doNotAutomate: false,
      },
      refused: 'assigned to someone else',
      listedAt: expect.any(Number),
    });
    await expect(
      harness
        .withIdentity(managerIdentity('stranger'))
        .query(api.work.latestListing, { workItemId }),
    ).rejects.toThrow();
  });

  it('keeps each changed listing of the ticket and gives the apply the one the plan was made under', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await emptyAgent(harness);
    const todo = { assigned: false, state: 'Todo', stateType: 'unstarted', doNotAutomate: false };
    const workItemId = await harness.mutation(internal.work.seedItem, {
      ...listed(agentId),
      tracker: todo,
    });
    await harness.mutation(internal.work.seedItem, { ...listed(agentId), tracker: todo });
    // The first listing rides on the discovery; the unchanged second adds nothing.
    expect(
      await harness.run(async (ctx) => await ctx.db.query('ticketListings').collect()),
    ).toEqual([]);
    const planMadeAt = Date.now();
    const taken = { ...todo, assigned: true, assigneeId: 'user-ana', state: 'In Progress' };
    await harness.run(async (ctx) => {
      // A listing after the plan, as the next poll would keep it.
      await ctx.db.insert('ticketListings', {
        agentId,
        workItemId,
        tracker: taken,
        listedAt: planMadeAt + 60_000,
      });
    });
    const discovered = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent_type', (q) => q.eq('agentId', agentId).eq('type', 'work.discovered'))
          .collect(),
    );
    expect(discovered.map((event) => (event.payload as { tracker?: unknown }).tracker)).toEqual([
      todo,
    ]);
    await expect(
      harness.query(internal.work.listedSnapshot, { workItemId, before: planMadeAt }),
    ).resolves.toEqual({ planned: todo, acknowledged: null });
    await expect(
      harness.query(internal.work.listedSnapshot, { workItemId, before: planMadeAt + 120_000 }),
    ).resolves.toEqual({ planned: taken, acknowledged: null });

    // The manager pressed Retry after reading the taken listing: that listing is acknowledged.
    await harness.run(async (ctx) => {
      await ctx.db.insert('events', {
        agentId,
        type: 'work.retry',
        payload: { workItemId, resumeState: 'plan-approved', fromState: 'failed' },
        createdAt: planMadeAt + 90_000,
      });
    });
    await expect(
      harness.query(internal.work.listedSnapshot, { workItemId, before: planMadeAt }),
    ).resolves.toEqual({ planned: todo, acknowledged: taken });
  });

  it("keeps one listing for an unchanged ticket whatever order its fields were stored in, and finds it behind other tickets' listings", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await emptyAgent(harness);
    const tracker = {
      assigned: false,
      state: 'Todo',
      stateType: 'unstarted',
      doNotAutomate: false,
    };
    const workItemId = await harness.mutation(internal.work.seedItem, {
      ...listed(agentId),
      tracker,
    });
    await harness.run(async (ctx) => {
      const [listing] = await ctx.db
        .query('events')
        .withIndex('by_agent_type', (q) => q.eq('agentId', agentId).eq('type', 'work.discovered'))
        .collect();
      // As a backend that sorts an object's fields would hand it back.
      await ctx.db.patch(listing!._id, {
        payload: {
          title: 'Reconcile the September pipeline',
          tracker: { doNotAutomate: false, stateType: 'unstarted', state: 'Todo', assigned: false },
          workItemId,
        },
      });
      for (let index = 0; index < 600; index += 1) {
        await ctx.db.insert('events', {
          agentId,
          type: 'work.listed',
          payload: { workItemId: `other-${index}`, tracker },
          createdAt: Date.now(),
        });
      }
    });
    await harness.mutation(internal.work.seedItem, { ...listed(agentId), tracker });
    const mine = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent_type', (q) => q.eq('agentId', agentId).eq('type', 'work.listed'))
          .collect()
      ).filter((event) => (event.payload as { workItemId: unknown }).workItemId === workItemId),
    );
    expect(mine).toEqual([]);
    await expect(
      harness.query(internal.work.listedSnapshot, { workItemId, before: Date.now() }),
    ).resolves.toMatchObject({ planned: { state: 'Todo' } });
  });

  it('keeps a changed listing in ticketListings by work item and gives the apply that one (review M4)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await emptyAgent(harness);
    const todo = { assigned: false, state: 'Todo', stateType: 'unstarted', doNotAutomate: false };
    const workItemId = await harness.mutation(internal.work.seedItem, {
      ...listed(agentId),
      tracker: todo,
    });
    const taken = { ...todo, assigned: true, assigneeId: 'user-ana', state: 'In Progress' };

    await harness.mutation(internal.work.seedItem, { ...listed(agentId), tracker: taken });

    const kept = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('ticketListings')
          .withIndex('by_work_item_listed_at', (q) => q.eq('workItemId', workItemId))
          .collect(),
    );
    expect(kept.map((listing) => listing.tracker)).toEqual([taken]);
    await expect(
      harness.query(internal.work.listedSnapshot, { workItemId, before: Date.now() }),
    ).resolves.toEqual({ planned: taken, acknowledged: null });
  });

  it('withdraws a claimed row whose ticket left the queue, so no plan is stored for it (review B1)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await emptyAgent(harness);
    const workItemId = await harness.mutation(internal.work.seedItem, listed(agentId));
    await harness.run(async (ctx) => await ctx.db.patch(workItemId, { state: 'claimed' }));

    await harness.mutation(internal.work.withdrawListedItem, {
      ...listed(agentId),
      owner: 'Ana Ruiz',
      leftQueue: 'the ticket is assigned to someone else',
    });

    expect(await onlyRow(harness)).toMatchObject({
      state: 'cancelled',
      skipReason: 'withdrawn from the queue on the tracker: the ticket is assigned to someone else',
    });
    // The plan the in-flight draft finishes is not stored, so nothing reaches an apply.
    await expect(
      harness.mutation(internal.work.setPlan, {
        workItemId,
        plan: { summary: 'Reconcile it.', steps: ['reconcile'] },
      }),
    ).resolves.toEqual({ stored: false });
    expect((await onlyRow(harness)).plan).toBeUndefined();
  });

  it('never gives the apply a listing intake refused as the one the plan was made under (review B1)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await emptyAgent(harness);
    const todo = { assigned: false, state: 'Todo', stateType: 'unstarted', doNotAutomate: false };
    const workItemId = await harness.mutation(internal.work.seedItem, {
      ...listed(agentId),
      tracker: todo,
    });
    const taken = { ...todo, assigned: true, assigneeId: 'user-ana' };
    const refusal = {
      ...listed(agentId),
      owner: 'Ana Ruiz',
      leftQueue: 'the ticket is assigned to someone else',
      tracker: taken,
    };
    await harness.mutation(internal.work.withdrawListedItem, refusal);
    // The same refusal on the next poll adds no second listing.
    await harness.mutation(internal.work.withdrawListedItem, refusal);
    // Retry on the withdrawn row, then a plan made after the refusal.
    await harness.run(async (ctx) => await ctx.db.patch(workItemId, { state: 'plan-approved' }));

    await expect(
      harness.query(internal.work.listedSnapshot, { workItemId, before: Date.now() }),
    ).resolves.toEqual({ planned: todo, acknowledged: null });
    const listings = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent_type', (q) => q.eq('agentId', agentId).eq('type', 'work.listed'))
          .collect(),
    );
    expect(listings.map((event) => event.payload)).toEqual([
      { workItemId, tracker: taken, refused: 'the ticket is assigned to someone else' },
    ]);

    // Back in the queue as it was: a listing again, and the baseline it gives.
    await harness.mutation(internal.work.seedItem, { ...listed(agentId), tracker: todo });
    await expect(
      harness.query(internal.work.listedSnapshot, { workItemId, before: Date.now() }),
    ).resolves.toEqual({ planned: todo, acknowledged: null });
  });

  it('acknowledges no listing intake refused when the manager presses Retry after it (review B1)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await emptyAgent(harness);
    const todo = { assigned: false, state: 'Todo', stateType: 'unstarted', doNotAutomate: false };
    const workItemId = await harness.mutation(internal.work.seedItem, {
      ...listed(agentId),
      tracker: todo,
    });
    const planMadeAt = Date.now();
    await harness.run(async (ctx) => await ctx.db.patch(workItemId, { state: 'failed' }));
    await harness.mutation(internal.work.withdrawListedItem, {
      ...listed(agentId),
      leftQueue: 'the ticket is completed',
      tracker: { ...todo, state: 'Done', stateType: 'completed' },
    });
    await harness.run(async (ctx) => {
      await ctx.db.insert('events', {
        agentId,
        type: 'work.retry',
        payload: { workItemId, resumeState: 'plan-approved', fromState: 'failed' },
        createdAt: Date.now() + 1,
      });
    });

    await expect(
      harness.query(internal.work.listedSnapshot, { workItemId, before: planMadeAt }),
    ).resolves.toEqual({ planned: todo, acknowledged: todo });
  });

  it('leaves a row with a plan or a run to the re-read before apply, and a finished row alone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending');
    const row = await harness.run(async (ctx) => (await ctx.db.get(workItemId))!);
    const relisted = {
      agentId,
      sourceCategory: row.sourceCategory,
      sourceSystem: row.sourceSystem,
      externalId: row.externalId,
      title: 'Renamed on the tracker',
      contentSummary: row.contentSummary,
      contentRefs: row.contentRefs,
      leftQueue: 'the ticket is assigned to someone else',
    };
    await harness.mutation(internal.work.withdrawListedItem, relisted);
    const planned = await harness.run(async (ctx) => (await ctx.db.get(workItemId))!);
    expect(planned).toMatchObject({ state: 'plan-pending', title: 'Renamed on the tracker' });
    await harness.run(async (ctx) => await ctx.db.patch(workItemId, { state: 'completed' }));
    await harness.mutation(internal.work.withdrawListedItem, {
      ...relisted,
      title: 'Renamed again',
    });
    const finished = await harness.run(async (ctx) => (await ctx.db.get(workItemId))!);
    expect(finished).toMatchObject({ state: 'completed', title: 'Renamed on the tracker' });
  });
});
describe('the owner-wide claim before the model call and on parked verdicts', (): void => {
  /**
   * Seed two employees of one owner, each with a connected Linear surface and
   * a discovered row for the same ticket.
   *
   * Args:
   *   harness: Convex test harness.
   *
   * Returns:
   *   Each employee's row for the ticket.
   */
  async function seedSiblings(
    harness: Harness,
  ): Promise<{ priyaRow: Id<'workItems'>; mateoRow: Id<'workItems'> }> {
    return await harness.run(async (ctx) => {
      const row = async (name: string): Promise<Id<'workItems'>> => {
        const agentId = await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name,
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'linear',
          displayName: 'Linear',
          class: 'kanban',
          verdict: 'connected',
          endpoint: 'https://mcp.linear.app/mcp',
          path: 'mcp',
          toolAllowlist: ['list_issues', 'save_comment'],
          credentialLanded: true,
          lastVerifiedAt: Date.now(),
          whereFound: [],
          createdAt: 1,
        });
        return await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-7',
          title: 'Refresh the pipeline summary',
          contentSummary: 'Synthetic.',
          contentRefs: [],
          state: 'discovered',
          observedAt: 1,
          createdAt: 1,
        });
      };
      return { priyaRow: await row('Priya'), mateoRow: await row('Mateo') };
    });
  }

  it.each([
    { decision: 'needs-skill', reason: 'no registered skill refreshes a summary' },
    { decision: 'defer', reason: 'waiting on a grant', missingPermissions: ['linear:write'] },
  ])(
    'turns a $decision verdict on an item a colleague holds into a skip naming the holder',
    async (verdict): Promise<void> => {
      useSurfaceMode('real');
      const harness = convexTest(schema, allConvexModules());
      const { priyaRow, mateoRow } = await seedSiblings(harness);
      await harness.mutation(internal.work.setVerdict, {
        workItemId: priyaRow,
        verdict: { decision: 'claim' },
      });

      const stored = await harness.mutation(internal.work.setVerdict, {
        workItemId: mateoRow,
        verdict,
      });

      expect(stored.decision).toBe('skip');
      const refused = await readItem(harness, mateoRow);
      expect(refused.state).toBe('skipped');
      expect(refused.skipReason).toBe(
        'claimed-by-colleague: Priya holds it (Refresh the pipeline summary)',
      );
      const mateo = refused.agentId;
      expect(
        (await eventsOfType(harness, mateo, 'work.claim-refused')).map(
          (event) => event.payload.key,
        ),
      ).toEqual(['linear:REVOPS-7']);
    },
  );

  it('leaves a needs-skill verdict parked and unclaimed when no colleague holds the item', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { priyaRow, mateoRow } = await seedSiblings(harness);

    const stored = await harness.mutation(internal.work.setVerdict, {
      workItemId: mateoRow,
      verdict: { decision: 'needs-skill', reason: 'no registered skill refreshes a summary' },
    });
    expect(stored.decision).toBe('needs-skill');
    expect((await readItem(harness, mateoRow)).state).toBe('needs-skill');

    // The parked row takes nothing, so a colleague with the skill still claims the item.
    await harness.mutation(internal.work.setVerdict, {
      workItemId: priyaRow,
      verdict: { decision: 'claim' },
    });
    expect((await readItem(harness, priyaRow)).state).toBe('claimed');
  });

  it('skips an item a colleague holds before the evaluation step reaches the model', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { priyaRow, mateoRow } = await seedSiblings(harness);
    await harness.mutation(internal.work.setVerdict, {
      workItemId: priyaRow,
      verdict: { decision: 'claim' },
    });

    const step = await harness.mutation(internal.work.claimLoopStep, {
      workItemId: mateoRow,
      step: 'evaluation',
    });

    expect(step).toEqual({ claimed: false, reason: 'held-elsewhere' });
    const refused = await readItem(harness, mateoRow);
    expect(refused.state).toBe('skipped');
    expect(refused.skipReason).toBe(
      'claimed-by-colleague: Priya holds it (Refresh the pipeline summary)',
    );
    expect(refused.evaluationClaimedAt).toBeUndefined();
  });

  it('lets the evaluation step through when nobody holds the item', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { mateoRow } = await seedSiblings(harness);

    await expect(
      harness.mutation(internal.work.claimLoopStep, { workItemId: mateoRow, step: 'evaluation' }),
    ).resolves.toEqual({ claimed: true, claimedAt: expect.any(Number) });
    expect((await readItem(harness, mateoRow)).state).toBe('discovered');
  });
});

describe('the execution claim and the skill body it runs', (): void => {
  /**
   * Seed a plan-approved row and a skill of the same employee.
   *
   * Args:
   *   harness: Convex test harness.
   *   skill: The skill's state and body.
   *
   * Returns:
   *   The row and the skill.
   */
  async function seedApproved(
    harness: Harness,
    skill: { state: Doc<'skills'>['state']; body: string },
  ): Promise<{ workItemId: Id<'workItems'>; skillId: Id<'skills'> }> {
    const { agentId, workItemId } = await seed(harness, 'plan-approved');
    const skillId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId,
          name: 'update-linear-ticket',
          description: 'Comment on and close a linear ticket.',
          body: skill.body,
          sourceType: 'agent-authored',
          state: skill.state,
          createdAt: 1,
          ...(skill.state === 'registered' ? { registeredAt: 5 } : {}),
        }),
    );
    return { workItemId, skillId };
  }

  it('refuses a skill sent back for revision after the executor picked it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, skillId } = await seedApproved(harness, { state: 'approved', body: '' });

    const claim = await harness.mutation(internal.work.claimForExecution, { workItemId, skillId });

    expect(claim).toEqual({
      claimed: false,
      reason: 'the skill is being revised; it runs once it registers again',
    });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('plan-approved');
    expect(row.skillId).toBeUndefined();
  });

  it('records the item the skill was made for, so a run for another item counts as a reuse', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, skillId } = await seedApproved(harness, {
      state: 'registered',
      body: 'Comment, then close.',
    });
    const madeFor = await harness.run(async (ctx) => {
      const skill = await ctx.db.get(skillId);
      const other = await ctx.db.insert('workItems', {
        agentId: skill!.agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-2',
        title: 'The item the skill was authored for',
        contentSummary: 'Earlier work.',
        contentRefs: [],
        state: 'completed',
        observedAt: 1,
        createdAt: 1,
      });
      await ctx.db.patch(skillId, { proposedFor: other });
      return other;
    });

    await harness.mutation(internal.work.claimForExecution, { workItemId, skillId });

    const row = await readItem(harness, workItemId);
    const [event] = (await eventsOfType(harness, row.agentId, 'work.execution-claimed')).filter(
      (entry) => entry._id === row.executionRunId,
    );
    expect(event?.payload).toMatchObject({ workItemId, skillId, proposedFor: madeFor });
  });

  it('records the registration and the hash of the body the run claimed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, skillId } = await seedApproved(harness, {
      state: 'registered',
      body: 'Comment, then close.',
    });

    const claim = await harness.mutation(internal.work.claimForExecution, { workItemId, skillId });

    expect(claim.claimed).toBe(true);
    const row = await readItem(harness, workItemId);
    const [event] = (await eventsOfType(harness, row.agentId, 'work.execution-claimed')).filter(
      (entry) => entry._id === row.executionRunId,
    );
    expect(event?.payload).toEqual({
      workItemId,
      skillId,
      skillRegisteredAt: 5,
      skillBodyHash: skillBodyHash('Comment, then close.'),
    });
  });
});

describe('the cap count behind every evaluation (P9-1)', (): void => {
  it('counts open work up to the largest cap without reading the closed rows', async (): Promise<void> => {
    // More closed rows than the read limit allows in one query: the count
    // reads the open states by index, never the employee's whole history.
    const harness = convexTest({
      schema,
      modules: allConvexModules(),
      transactionLimits: { documentsRead: 60 },
    });
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    const insert = async (state: Doc<'workItems'>['state'], from: number, count: number) => {
      await harness.run(async (ctx) => {
        for (let index = from; index < from + count; index += 1) {
          await ctx.db.insert('workItems', {
            agentId,
            sourceCategory: 'ticket-queue',
            sourceSystem: 'linear',
            externalId: `REVOPS-${index}`,
            title: `Triage REVOPS-${index}`,
            contentSummary: 'Triage.',
            contentRefs: [],
            observedAt: 1,
            state,
            createdAt: 1,
          });
        }
      });
    };
    for (let from = 0; from < 100; from += 20) await insert('completed', from, 20);
    await insert('plan-pending', 100, 5);

    await expect(harness.query(internal.work.countOpenForAgentInternal, { agentId })).resolves.toBe(
      3,
    );
  });
});

describe('the apply dead-man switch (P9-1)', (): void => {
  afterEach((): void => {
    vi.useRealTimers();
  });

  it('fires six minutes after the apply claim, not six minutes after the apply was scheduled', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await pend(harness);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0],
    });
    // The apply action starts five minutes late, so its scheduled run is held back here.
    await harness.run(async (ctx) => {
      for (const job of await ctx.db.system.query('_scheduled_functions').collect()) {
        if (job.name === 'workActions:applyApprovedActions') await ctx.scheduler.cancel(job._id);
      }
    });
    vi.advanceTimersByTime(5 * 60_000);
    await harness.mutation(internal.work.claimApprovedActions, { workItemId });

    vi.advanceTimersByTime(60_000);
    await harness.finishInProgressScheduledFunctions();
    expect(await readItem(harness, workItemId)).toMatchObject({ state: 'executing' });

    vi.advanceTimersByTime(5 * 60_000);
    await harness.finishInProgressScheduledFunctions();
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'failed',
      skipReason: INTERRUPTED_APPLY_REASON,
    });
  });
});

describe('what an outage leaves for the manager (P7-18)', (): void => {
  it('asks about an action set parked in an outage after its plan was approved from Slack (wave 3 review M5)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing', undefined, {
      withSlack: true,
    });
    const slackPlanDecision = {
      id: 'ab3xyz',
      kind: 'plan' as const,
      requestedAt: 1,
      channel: 'D0MANAGER',
      surfaceSlug: 'slack',
      surfaceName: 'Slack',
      ts: '1787770700.000100',
      decidedAt: 2,
      outcome: 'approved' as const,
      decidedVia: 'channel' as const,
      decidedTs: '1787770760.000100',
    };
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, { executionRunId: runId, decision: slackPlanDecision });
      // Slack is down when execution parks the set.
      const slack = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
        .first();
      if (slack) await ctx.db.patch(slack._id, { verdict: 'listed-dead' });
    });
    await harness.mutation(internal.work.setActionsPending, {
      workItemId,
      runId,
      output: pendingOutput,
    });
    const parked = await readItem(harness, workItemId);
    expect(parked.state).toBe('actions-pending');
    expect(parked).not.toHaveProperty('decision');

    // Slack comes back: the card's ask reaches the parked set.
    await harness.run(async (ctx): Promise<void> => {
      const slack = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
        .first();
      if (slack) await ctx.db.patch(slack._id, { verdict: 'connected' });
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.resendDecisionRequest, { workItemId }),
    ).resolves.toEqual({ ok: true });
    expect(
      (await eventsOfType(harness, agentId, 'work.decision-request-asked')).map(
        (event) => event.payload,
      ),
    ).toEqual([{ workItemId, kind: 'actions' }]);
  });

  it('asks from the card about a set a row parked before the fix, with the plan’s Slack decision still on it (M5)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await pend(harness);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        decision: {
          id: 'ab3xyz',
          kind: 'plan',
          requestedAt: 1,
          channel: 'D0MANAGER',
          surfaceSlug: 'slack',
          surfaceName: 'Slack',
          ts: '1787770700.000100',
          decidedAt: 2,
          outcome: 'approved',
          decidedVia: 'channel',
        },
      });
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
        managerDmChannelId: 'D0MANAGER',
        managerUserId: 'UMANAGER',
        credentialId,
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      });
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.resendDecisionRequest, { workItemId }),
    ).resolves.toEqual({ ok: true });
    expect(await scheduledFunctionNames(harness)).toContain(
      'managerChannelActions:requestDecision',
    );
  });

  it('asks on the chat surface from the card for a parked row that was never asked', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.resendDecisionRequest, { workItemId }),
    ).resolves.toEqual({ ok: true });
    expect(await scheduledFunctionNames(harness)).toContain(
      'managerChannelActions:requestDecision',
    );
    expect(
      (await eventsOfType(harness, agentId, 'work.decision-request-asked')).map(
        (event) => event.payload,
      ),
    ).toEqual([{ workItemId, kind: 'plan' }]);
  });

  it('says there is nowhere to ask while no manager channel is connected', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'plan-pending');
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.resendDecisionRequest, { workItemId }),
    ).rejects.toThrow('No manager chat channel is connected');
  });

  it('tells the manager an interrupted apply left outcomes to check', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'actions-pending', undefined, {
      withSlack: true,
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        pendingRunId: runId,
        executionRunId: runId,
        output: pendingOutput,
        actionVerdicts: [
          { disposition: 'held', reason: HELD_MUTATION },
          { disposition: 'held', reason: HELD_MUTATION },
        ],
      });
    });
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0, 1],
    });
    await harness.mutation(internal.work.claimApprovedActions, { workItemId });
    await harness.mutation(internal.work.recoverInterruptedApply, {
      workItemId,
      pendingRunId: runId,
      phase: 'approved',
    });
    const notes = await harness.run(async (ctx) => await ctx.db.query('managerNotes').collect());
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ workItemId, kind: 'landed' });
    expect(notes[0].text).toContain('the apply was interrupted');
    expect(notes[0].text).toContain('(outcome unknown)');
  });

  it('marks a note whose send died mid-flight as not delivered', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'completed', undefined, {
      withSlack: true,
    });
    const noteId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('managerNotes', {
          agentId,
          workItemId,
          kind: 'landed',
          text: 'Priya finished the close summary.',
          createdAt: 1,
        }),
    );
    await expect(
      harness.mutation(internal.work.prepareManagerNote, { noteId }),
    ).resolves.toMatchObject({
      prepared: true,
    });
    expect(await scheduledFunctionNames(harness)).toContain('work:recoverUnsentManagerNote');
    await expect(
      harness.mutation(internal.work.recoverUnsentManagerNote, { noteId }),
    ).resolves.toEqual({ recovered: 'marked-undelivered' });
    const note = await harness.run(async (ctx) => await ctx.db.get(noteId));
    expect(note?.failure).toBe(UNSENT_NOTE_REASON);
    expect(
      (await eventsOfType(harness, agentId, 'work.manager-note-failed')).map(
        (event) => event.payload,
      ),
    ).toEqual([{ workItemId, noteId, kind: 'landed', reason: UNSENT_NOTE_REASON }]);
    // A delivered note is left alone.
    await harness.mutation(internal.work.recordManagerNote, { noteId, ts: '1.0' });
    await expect(
      harness.mutation(internal.work.recoverUnsentManagerNote, { noteId }),
    ).resolves.toEqual({ recovered: 'ignored' });
  });
});

describe('a plan drafted while its system was down (P7-18)', (): void => {
  it('is drafted again when the system connects, and a plan whose read failed is left to the manager', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending');
    const request = {
      id: 'ab3xyz',
      kind: 'plan' as const,
      requestedAt: 1,
      channel: 'D0MANAGER',
      surfaceSlug: 'slack',
      surfaceName: 'Slack',
      ts: '1787770700.000100',
    };
    const { linearId, readFailedId } = await harness.run(async (ctx) => {
      const linear = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'linear'))
        .unique();
      await ctx.db.patch(linear!._id, { verdict: 'listed-dead' });
      await ctx.db.patch(workItemId, {
        plan: { summary: 'Close the month.', steps: [] },
        planPendingAt: 1,
        decision: request,
        planDraftedWithout: { surfaceSlug: 'linear', subject: 'record', cause: 'not-connected' },
      });
      const row = Object.fromEntries(
        Object.entries((await ctx.db.get(workItemId))!).filter(([key]) => !key.startsWith('_')),
      ) as WithoutSystemFields<Doc<'workItems'>>;
      const readFailedId = await ctx.db.insert('workItems', {
        ...row,
        externalId: 'iss-2',
        decision: undefined,
        planDraftedWithout: { surfaceSlug: 'linear', subject: 'record', cause: 'read-failed' },
      });
      return { linearId: linear!._id, readFailedId };
    });
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId: linearId });
    if (!probe.reserved) throw new Error('probe was not reserved');
    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId: linearId,
      generation: probe.generation,
      toolAllowlist: ['get_issue', 'save_comment', 'save_issue'],
      toolArguments: [],
      verifiedAt: Date.now(),
    });

    const redrafted = await readItem(harness, workItemId);
    expect(redrafted.state).toBe('claimed');
    expect(redrafted.plan).toBeUndefined();
    expect(redrafted.decision).toBeUndefined();
    expect(redrafted.planDraftedWithout).toBeUndefined();
    expect(
      (await eventsOfType(harness, agentId, 'work.plan-redrafting')).map((event) => event.payload),
    ).toEqual([{ workItemId, surfaceId: linearId, slug: 'linear' }]);
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(
      scheduled.filter(
        (job) =>
          job.name === 'workActions:draftPlanInternal' &&
          (job.args[0] as { workItemId?: string }).workItemId === workItemId,
      ),
    ).toHaveLength(1);
    // Its system was connected when its read failed; the manager decides it.
    expect(await readItem(harness, readFailedId)).toMatchObject({
      state: 'plan-pending',
      planDraftedWithout: { cause: 'read-failed' },
    });
    vi.useRealTimers();
  });
});

describe('a plan drafted while its system was down, when the system is back first (P7-18)', (): void => {
  it('is drafted again at once when the system connected while it was being drafted', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'claimed');
    // Linear was down when the draft read it and connected before the plan was stored.
    const stored = await harness.mutation(internal.work.setPlan, {
      workItemId,
      plan: { summary: 'Close the month.', steps: [] },
      draftedWithout: { surfaceSlug: 'linear', subject: 'record', cause: 'not-connected' },
    });
    expect(stored).toEqual({ stored: false, redrafting: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('claimed');
    expect(row.plan).toBeUndefined();
    expect(
      (await eventsOfType(harness, agentId, 'work.plan-redrafting')).map((event) => event.payload),
    ).toEqual([{ workItemId, surfaceId: expect.any(String), slug: 'linear' }]);
    vi.useRealTimers();
  });

  it('is drafted again when a probe finds the system alive, even if its stored verdict never changed', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending');
    const linearId = await harness.run(async (ctx) => {
      const linear = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'linear'))
        .unique();
      // Stored as connected, but unverified for a day: the planner read it as dead.
      await ctx.db.patch(linear!._id, { lastVerifiedAt: Date.now() - 24 * 60 * 60 * 1000 });
      await ctx.db.patch(workItemId, {
        plan: { summary: 'Close the month.', steps: [] },
        planPendingAt: 1,
        planDraftedWithout: { surfaceSlug: 'linear', subject: 'record', cause: 'not-connected' },
      });
      return linear!._id;
    });
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId: linearId });
    if (!probe.reserved) throw new Error('probe was not reserved');
    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId: linearId,
      generation: probe.generation,
      toolAllowlist: ['get_issue', 'save_comment', 'save_issue'],
      toolArguments: [],
      verifiedAt: Date.now(),
    });
    expect((await readItem(harness, workItemId)).state).toBe('claimed');
    vi.useRealTimers();
  });
});

describe('the plan-grounding read the evidence check cites (P7-18)', (): void => {
  it('cites the newest read that landed, not a newer one that failed, and never another item’s', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'claimed');
    const action = { tool: 'mcp.call', args: { surface: 'linear', tool: 'get_issue' } };
    await harness.run(async (ctx): Promise<void> => {
      const read = async (payload: Record<string, unknown>): Promise<void> => {
        await ctx.db.insert('events', {
          agentId,
          type: 'work.plan-grounding-read',
          payload: { action, ...payload },
          createdAt: Date.now(),
        });
      };
      await read({ workItemId, applied: { ok: true, effect: 'REVOPS-5: close August' } });
      // Linear went down before the next draft: its read failed.
      await read({ workItemId, applied: { ok: false, reason: 'HTTP 503' } });
      await read({ workItemId, applied: { ok: true, held: true, reason: 'held' } });
      await read({ workItemId: 'another-item', applied: { ok: true, effect: 'REVOPS-9' } });
    });
    await expect(harness.query(internal.work.planGroundingReads, { workItemId })).resolves.toEqual([
      { action, applied: { ok: true, effect: 'REVOPS-5: close August' } },
    ]);
  });
});

describe('a recovery for every claim (P5-1, P5-2, P5-3)', (): void => {
  const landedPrerequisite = {
    ...pendingOutput,
    needsDependentPhase: true,
    phase: 'dependent-authoring',
    actions: [pendingOutput.actions[0]],
    applied: [{ tool: 'mcp.call', ok: true, providerId: 'c-1', idempotencyKey: 'k0' }],
  };

  it('fails a closing phase whose authoring died after its claim, once the bound has passed', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness, 'executing');
    await harness.mutation(internal.work.prepareDependentPhase, {
      workItemId,
      runId,
      output: landedPrerequisite,
    });
    const claim = await harness.mutation(internal.work.claimDependentAuthoring, {
      workItemId,
      runId,
    });
    if (!claim.claimed) throw new Error('authoring was not claimed');
    expect(
      (await scheduledFunctionNames(harness)).filter(
        (name) => name === 'work:recoverDependentAuthoring',
      ),
    ).toHaveLength(1);

    // Fired early, or for another attempt, the switch leaves the row alone.
    await expect(
      harness.mutation(internal.work.recoverDependentAuthoring, {
        workItemId,
        runId,
        authoringAttemptId: claim.authoringAttemptId,
      }),
    ).resolves.toEqual({ recovered: 'ignored' });
    await expect(
      harness.mutation(internal.work.recoverDependentAuthoring, { workItemId, runId }),
    ).resolves.toEqual({ recovered: 'ignored' });
    expect((await readItem(harness, workItemId)).state).toBe('executing');

    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        applyClaimedAt: Date.now() - DEPENDENT_AUTHORING_RECOVERY_MS - 1,
      });
    });
    await expect(
      harness.mutation(internal.work.recoverDependentAuthoring, {
        workItemId,
        runId,
        authoringAttemptId: claim.authoringAttemptId,
      }),
    ).resolves.toEqual({ recovered: 'failed' });
    const row = await readItem(harness, workItemId);
    expect(row).toMatchObject({
      state: 'failed',
      skipReason: DEPENDENT_AUTHORING_INTERRUPTED_REASON,
    });
    expect(row.applyAttemptId).toBeUndefined();
    expect((row.output as { applied: unknown[] }).applied).toEqual(landedPrerequisite.applied);
    expect(
      (await eventsOfType(harness, agentId, 'work.failed')).map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ workItemId, reason: DEPENDENT_AUTHORING_INTERRUPTED_REASON }),
    ]);
  });

  it('fails a closing phase whose authoring never claimed it', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'executing');
    await harness.mutation(internal.work.prepareDependentPhase, {
      workItemId,
      runId,
      output: landedPrerequisite,
    });
    await expect(
      harness.mutation(internal.work.recoverDependentAuthoring, { workItemId, runId }),
    ).resolves.toEqual({ recovered: 'failed' });
    expect((await readItem(harness, workItemId)).state).toBe('failed');
  });

  it('fails a needs-skill row whose proposal never landed, naming the skill', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'discovered');
    await harness.run(async (ctx) => await ctx.db.patch(workItemId, { plan: undefined }));
    await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: {
        decision: 'needs-skill',
        reason: 'no registered skill closes a Linear ticket',
        suggestedSkillName: 'linear-close',
        suggestedSkillRationale: 'closing tickets is the charter work',
        suggestedSkillShape: { surfaceClass: 'kanban', operation: 'close' },
      },
    });
    expect((await readItem(harness, workItemId)).state).toBe('needs-skill');
    const [evaluated] = await eventsOfType(harness, agentId, 'work.evaluated');
    expect(await scheduledFunctionNames(harness)).toContain('work:recoverUnproposedSkill');

    await expect(
      harness.mutation(internal.work.recoverUnproposedSkill, {
        workItemId,
        evaluatedId: evaluated._id,
      }),
    ).resolves.toEqual({ recovered: 'failed' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(row.skipReason).toContain('"linear-close"');
    expect(row.skipReason).toContain('Retry evaluates the item again');
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId }),
    ).resolves.toEqual({ ok: true, resumeState: 'discovered' });
  });

  it('leaves a needs-skill row whose proposal landed', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'discovered');
    await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: {
        decision: 'needs-skill',
        reason: 'no registered skill closes a Linear ticket',
        suggestedSkillName: 'linear-close',
        suggestedSkillRationale: 'closing tickets is the charter work',
        suggestedSkillShape: { surfaceClass: 'kanban', operation: 'close' },
      },
    });
    const [evaluated] = await eventsOfType(harness, agentId, 'work.evaluated');
    const skillId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId,
          name: 'linear-close',
          description: 'Close a Linear ticket.',
          body: '',
          sourceType: 'agent-authored',
          state: 'proposed',
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.work.setProposedSkill, { workItemId, skillId });
    await expect(
      harness.mutation(internal.work.recoverUnproposedSkill, {
        workItemId,
        evaluatedId: evaluated._id,
      }),
    ).resolves.toEqual({ recovered: 'ignored' });
    expect((await readItem(harness, workItemId)).state).toBe('needs-skill');
  });

  it('stops a phase-one run that emitted nothing to decide instead of parking it', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness, 'executing');
    await expect(
      harness.mutation(internal.work.setActionsPending, {
        workItemId,
        runId,
        output: { draft: 'No surface is connected.', notes: '', actions: [] },
      }),
    ).resolves.toEqual({ pending: false });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(row.skipReason).toContain(NOTHING_TO_DECIDE_REASON);
    expect(await scheduledFunctionNames(harness)).not.toContain(
      'managerChannelActions:requestDecision',
    );
  });
});

describe('the evaluation’s record (step 29)', (): void => {
  it('names the charter the verdict was reached under and writes a terminal event for a skip', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId, workItemId } = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('charters', {
        agentId,
        version: '1.0',
        body: {},
        approved: true,
        createdAt: 1,
      });
      const charterId = await ctx.db.insert('charters', {
        agentId,
        version: '1.1',
        body: {},
        approved: true,
        createdAt: 2,
      });
      const workItemId = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-11',
        title: 'Northstar renewal',
        contentSummary: 'Out of scope.',
        contentRefs: [],
        state: 'discovered',
        observedAt: 1,
        createdAt: 1,
      });
      return { agentId, charterId, workItemId };
    });
    await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: { decision: 'skip', reason: 'outside the charter' },
    });
    const events = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(events.find((event) => event.type === 'work.evaluated')?.payload).toMatchObject({
      workItemId,
      decision: 'skip',
      charterId,
      charterVersion: '1.1',
    });
    expect(events.find((event) => event.type === 'work.skipped')?.payload).toEqual({
      workItemId,
      reason: 'outside the charter',
    });
    vi.useRealTimers();
  });
});

describe('the charter a verdict names (review M17, Q14)', (): void => {
  /** An employee whose approved charter 1.0 has a newer row above it, and a waiting row. */
  async function evaluatedUnder(
    harness: Harness,
    newer: { approved: boolean },
  ): Promise<{
    agentId: Id<'agents'>;
    approved: Id<'charters'>;
    newest: Id<'charters'>;
    workItemId: Id<'workItems'>;
  }> {
    return await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const approved = await ctx.db.insert('charters', {
        agentId,
        version: '1.0',
        body: {},
        approved: true,
        createdAt: 1,
      });
      const newest = await ctx.db.insert('charters', {
        agentId,
        version: '1.1',
        body: {},
        approved: newer.approved,
        createdAt: 2,
      });
      const workItemId = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-12',
        title: 'Northstar renewal',
        contentSummary: 'Out of scope.',
        contentRefs: [],
        state: 'discovered',
        observedAt: 1,
        createdAt: 1,
      });
      return { agentId, approved, newest, workItemId };
    });
  }

  async function evaluatedPayload(
    harness: Harness,
    agentId: Id<'agents'>,
  ): Promise<Record<string, unknown> | undefined> {
    const [evaluated] = await eventsOfType(harness, agentId, 'work.evaluated');
    return evaluated?.payload as Record<string, unknown> | undefined;
  }

  it('never names a draft above the approved charter', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, approved, workItemId } = await evaluatedUnder(harness, { approved: false });
    await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: { decision: 'skip', reason: 'outside the charter' },
    });
    expect(await evaluatedPayload(harness, agentId)).toMatchObject({
      charterId: approved,
      charterVersion: '1.0',
    });
  });

  it('names the charter the evaluation read, not one approved during its model call', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, approved, workItemId } = await evaluatedUnder(harness, { approved: true });
    await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: { decision: 'skip', reason: 'outside the charter' },
      charterId: approved,
    });
    expect(await evaluatedPayload(harness, agentId)).toMatchObject({
      charterId: approved,
      charterVersion: '1.0',
    });
  });
});

describe('the manager’s estimate at plan approval (N11)', (): void => {
  it('keeps the optional minutes the manager says the work would have taken, and refuses a nonsense figure', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'plan-pending');
    const owner = harness.withIdentity(OWNER);
    await expect(
      owner.mutation(api.work.approvePlan, { workItemId, manualEstimateMinutes: -5 }),
    ).rejects.toThrow('whole number of minutes');
    expect((await readItem(harness, workItemId)).state).toBe('plan-pending');
    await owner.mutation(api.work.approvePlan, { workItemId, manualEstimateMinutes: 45 });
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'plan-approved',
      manualEstimateMinutes: 45,
    });
    vi.useRealTimers();
  });
});

describe('the resend refusals the card shows (wave 3 review m9)', (): void => {
  it('throws each refusal as a ConvexError whose data is the sentence the card reads', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'plan-pending', undefined, { withSlack: true });
    const owner = harness.withIdentity(OWNER);
    const refusal = async (): Promise<unknown> =>
      await owner.mutation(api.work.resendDecisionRequest, { workItemId }).then(
        () => undefined,
        (error: unknown) => error,
      );
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'ab3xyz',
    });
    const inFlight = await refusal();
    expect(inFlight).toBeInstanceOf(ConvexError);
    expect((inFlight as ConvexError<string>).data).toBe('The request is still being delivered.');

    await harness.mutation(internal.work.recordDecisionRequest, {
      workItemId,
      decisionId: 'ab3xyz',
      ts: '1787770700.000100',
    });
    const delivered = await refusal();
    expect(delivered).toBeInstanceOf(ConvexError);
    expect((delivered as ConvexError<string>).data).toBe(
      'The request was delivered; the manager holds its code.',
    );

    await owner.mutation(api.work.approvePlan, { workItemId });
    const decided = await refusal();
    expect(decided).toBeInstanceOf(ConvexError);
    expect((decided as ConvexError<string>).data).toBe(
      'There is no open decision request to resend.',
    );
  });
});

describe('the manager channel past its access end date (wave 2 review D4, M21)', (): void => {
  it('asks nothing through a chat surface whose end date passed before the sweep ended it', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    await harness.run(async (ctx): Promise<void> => {
      const slack = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
        .first();
      if (slack) await ctx.db.patch(slack._id, { expiresAt: Date.UTC(2026, 8, 1) });
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.resendDecisionRequest, { workItemId }),
    ).rejects.toThrow('No manager chat channel is connected');
    await expect(
      harness.mutation(internal.work.prepareDecisionRequest, {
        workItemId,
        kind: 'plan',
        decisionId: 'ab3xyz',
      }),
    ).resolves.toEqual({ prepared: false, reason: 'no connected manager chat channel' });
  });
});

describe('work.needsYou', (): void => {
  /** Insert an employee of the owner's (or another subject's) with nothing waiting yet. */
  async function employee(
    harness: Harness,
    name: string,
    fields: Partial<WithoutSystemFields<Doc<'agents'>>> = {},
  ): Promise<Id<'agents'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name,
          userId: 'owner',
          state: 'active',
          createdAt: 1,
          ...fields,
        }),
    );
  }

  /** Insert one work item in a state, with the fields that state carries. */
  async function item(
    harness: Harness,
    agentId: Id<'agents'>,
    title: string,
    state: Doc<'workItems'>['state'],
    fields: Partial<WithoutSystemFields<Doc<'workItems'>>> = {},
  ): Promise<Id<'workItems'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: title,
          title,
          contentSummary: 'Synthetic.',
          contentRefs: [],
          state,
          observedAt: 1,
          createdAt: 1,
          ...fields,
        }),
    );
  }

  /** Record the event a transition writes, returning when it was stored. */
  async function entered(
    harness: Harness,
    agentId: Id<'agents'>,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    return await harness.run(async (ctx) => {
      const id = await ctx.db.insert('events', { agentId, type, payload, createdAt: Date.now() });
      return (await ctx.db.get(id))!._creationTime;
    });
  }

  it('lists what waits on the manager across employees, one entry per decision, longest wait first', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness, 'Mira');
    const aiko = await employee(harness, 'Aiko', { state: 'charter-pending' });

    const charterId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('charters', {
          agentId: aiko,
          version: '1',
          body: {},
          approved: false,
          createdAt: 1_000,
        }),
    );
    const plan = await item(harness, mira, 'Draft the tier-two reply', 'plan-pending', {
      planPendingAt: 2_000,
    });
    await harness.run(async (ctx) => {
      for (const [key, answered] of [
        ['owner', false],
        ['deadline', true],
      ] as const) {
        await ctx.db.insert('managerQuestions', {
          agentId: mira,
          key,
          question: `Who is the ${key}?`,
          context: { touchedBy: 'plan', text: 'x', words: [] },
          askedAt: 2_000,
          workItemId: plan,
          charterId,
          ...(answered
            ? { answer: { text: 'Sam', answeredAt: 2_500, via: 'plan-approval' as const } }
            : {}),
        });
      }
    });
    const skillId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId: mira,
          name: 'chat-thread-reply',
          description: 'Reply in a thread.',
          body: '',
          sourceType: 'agent-authored',
          rationale: 'So she can reply in a Slack thread.',
          state: 'proposed',
          createdAt: 3_000,
        }),
    );
    await item(harness, mira, 'Reply to Priya', 'needs-skill', { proposedSkillId: skillId });
    await item(harness, mira, 'Reply to Aman', 'needs-skill', { proposedSkillId: skillId });

    const heldItem = await item(harness, mira, 'Post the escalation guidance', 'actions-pending', {
      output: pendingOutput,
      actionVerdicts: [{ disposition: 'held', reason: 'write' }, { disposition: 'auto' }],
    });
    const heldAt = await entered(harness, mira, 'work.actions-pending', { workItemId: heldItem });
    await item(harness, mira, 'Already decided', 'actions-pending', {
      output: pendingOutput,
      approvedIndexes: [0],
    });

    const deferred = await item(harness, mira, 'Read the tracker', 'deferred', {
      verdict: { decision: 'defer', reason: 'awaiting-connection', missingPermissions: [] },
    });
    const deferredAt = await entered(harness, mira, 'work.evaluated', { workItemId: deferred });
    await item(harness, mira, 'Waits for the charter', 'deferred', {
      verdict: { decision: 'defer', reason: 'awaiting-charter', missingPermissions: [] },
    });

    const failed = await item(harness, mira, 'Close REVOPS-9', 'failed', {
      skipReason: 'the run stopped',
    });
    const failedAt = await entered(harness, mira, 'work.failed', { workItemId: failed });
    await item(harness, mira, 'Rejected', 'failed', {
      skipReason: 'rejected by the manager: not this week',
    });

    const surfaceId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('surfaces', {
          agentId: aiko,
          slug: 'looker',
          displayName: 'Looker',
          class: 'dashboard',
          verdict: 'proposed',
          credentialLanded: false,
          whereFound: [],
          createdAt: 1,
        }),
    );
    const surfaceAt = await entered(harness, aiko, 'surface.proposed', {
      surfaceId,
      verdict: 'proposed',
    });

    const inbox = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

    expect(inbox.total).toBe(7);
    expect(inbox.entries.map((entry) => [entry.kind, entry.employeeName, entry.subject])).toEqual([
      ['charter', 'Aiko', 'charter'],
      ['plan', 'Mira', 'Draft the tier-two reply'],
      ['skill', 'Mira', 'chat-thread-reply'],
      ['held', 'Mira', 'Post the escalation guidance'],
      ['parked', 'Mira', 'Read the tracker'],
      ['stopped', 'Mira', 'Close REVOPS-9'],
      ['surface', 'Aiko', 'Looker'],
    ]);
    const [charter, planEntry, skill, held, parked, stopped, surface] = inbox.entries;
    expect(charter.waitingSince).toBe(1_000);
    expect(planEntry).toMatchObject({ waitingSince: 2_000, questions: 1, workItemId: plan });
    expect(skill).toMatchObject({ waitingSince: 3_000, waitingItems: 2, skillId });
    expect(held).toMatchObject({ waitingSince: heldAt, heldWrites: 1, workItemId: heldItem });
    expect(parked).toMatchObject({ waitingSince: deferredAt, reason: 'connection' });
    expect(stopped.waitingSince).toBe(failedAt);
    expect(surface).toMatchObject({ waitingSince: surfaceAt, surfaceId, agentId: aiko });
    expect(inbox.entries.every((entry) => !entry.waitingAtLeast)).toBe(true);
    expect(inbox.waitingByEmployee).toEqual([
      { agentId: aiko, waiting: 2 },
      { agentId: mira, waiting: 5 },
    ]);
  });

  it('shows the owner only their own employees and an anonymous caller nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mine = await employee(harness, 'Mira');
    const theirs = await employee(harness, 'Stranger’s employee', { userId: 'stranger' });
    await item(harness, mine, 'Mine', 'plan-pending', { planPendingAt: 1 });
    await item(harness, theirs, 'Theirs', 'plan-pending', { planPendingAt: 1 });

    const owner = await harness.withIdentity(OWNER).query(api.work.needsYou, {});
    const stranger = await harness
      .withIdentity(managerIdentity('stranger'))
      .query(api.work.needsYou, {});

    expect(owner.entries.map((entry) => entry.subject)).toEqual(['Mine']);
    expect(stranger.entries.map((entry) => entry.subject)).toEqual(['Theirs']);
    await expect(harness.query(api.work.needsYou, {})).resolves.toEqual({
      entries: [],
      total: 0,
      waitingByEmployee: [],
    });
  });

  it('leaves evaluation agents out, as the roster does', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const evaluation = await employee(harness, 'Day0 evaluation 1', {
      bossEmail: 'eval-day0-r1-1758000000000@day0.local',
    });
    await item(harness, evaluation, 'Evaluation item', 'plan-pending', { planPendingAt: 1 });

    await expect(harness.withIdentity(OWNER).query(api.work.needsYou, {})).resolves.toEqual({
      entries: [],
      total: 0,
      waitingByEmployee: [],
    });
  });

  it('says a wait is at least as long as the bounded read reaches when the entry lies beyond it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness, 'Mira');
    const held = await item(harness, mira, 'Old held write', 'actions-pending', {
      output: pendingOutput,
    });
    await entered(harness, mira, 'work.actions-pending', { workItemId: held });
    const others: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const other = await item(harness, mira, `Other ${index}`, 'completed');
      others.push(await entered(harness, mira, 'work.actions-pending', { workItemId: other }));
    }

    const [entry] = (await harness.withIdentity(OWNER).query(api.work.needsYou, {})).entries;

    expect(entry).toMatchObject({ kind: 'held', waitingAtLeast: true, waitingSince: others[0] });
  });

  it('lists a deployed employee’s Day-1 one-to-one as the manager’s to hold, dated from its deploy (D4 (b))', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const waiting = await employee(harness, 'Aiko', { state: 'deployed' });
    const deployedAt = await entered(harness, waiting, 'agent.deployed', {});
    await employee(harness, 'Mira', { state: 'day-one-in-progress' });
    await employee(harness, 'Ren', { state: 'active' });

    const inbox = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

    expect(inbox.entries).toEqual([
      expect.objectContaining({
        kind: 'one-to-one',
        key: `one-to-one:${waiting}`,
        agentId: waiting,
        employeeName: 'Aiko',
        subject: 'one-to-one',
        waitingSince: deployedAt,
        waitingAtLeast: false,
      }),
    ]);
    expect(inbox.total).toBe(1);
    expect(inbox.waitingByEmployee.find((row) => row.agentId === waiting)?.waiting).toBe(1);

    await harness.run(async (ctx) => await ctx.db.patch(waiting, { state: 'day-one-in-progress' }));
    expect((await harness.withIdentity(OWNER).query(api.work.needsYou, {})).total).toBe(0);
  });

  it('dates the one-to-one from a charter sent back, when that put the employee back to deployed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const aiko = await employee(harness, 'Aiko', { state: 'deployed' });
    await entered(harness, aiko, 'agent.deployed', {});
    const sentBackAt = await entered(harness, aiko, 'charter.request_changes', {
      charterId: 'charter-1',
      notes: '',
    });

    const [entry] = (await harness.withIdentity(OWNER).query(api.work.needsYou, {})).entries;

    expect(entry).toMatchObject({ kind: 'one-to-one', waitingSince: sentBackAt });
  });

  it('keeps the newest proposed system when an employee holds more systems than the read takes (m7)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness, 'Mira');
    await harness.run(async (ctx) => {
      for (let index = 0; index < 100; index += 1) {
        await ctx.db.insert('surfaces', {
          agentId: mira,
          slug: `connected-${index}`,
          displayName: `Connected ${index}`,
          class: 'dashboard',
          verdict: 'connected',
          credentialLanded: true,
          whereFound: [],
          createdAt: 1,
        });
      }
      await ctx.db.insert('surfaces', {
        agentId: mira,
        slug: 'looker',
        displayName: 'Looker',
        class: 'dashboard',
        verdict: 'proposed',
        credentialLanded: false,
        whereFound: [],
        createdAt: 2,
      });
    });

    const inbox = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

    expect(inbox.entries.map((entry) => [entry.kind, entry.subject])).toEqual([
      ['surface', 'Looker'],
    ]);
  });

  it('returns the fifty longest waits and says how many there are', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness, 'Mira');
    for (let index = 0; index < 55; index += 1) {
      await item(harness, mira, `Plan ${index}`, 'plan-pending', { planPendingAt: 10_000 + index });
    }

    const inbox = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

    expect(inbox.total).toBe(55);
    expect(inbox.entries).toHaveLength(50);
    expect(inbox.waitingByEmployee).toEqual([{ agentId: mira, waiting: 55 }]);
    expect(inbox.entries[0].subject).toBe('Plan 0');
    expect(inbox.entries.at(-1)?.subject).toBe('Plan 49');
  });

  describe('work.needsYouForAgent', (): void => {
    it('lists one employee’s entries, longest wait first, as the owner-wide inbox lists them', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const mira = await employee(harness, 'Mira');
      const aiko = await employee(harness, 'Aiko');
      const held = await item(harness, mira, 'Post the escalation guidance', 'actions-pending', {
        output: pendingOutput,
        actionVerdicts: [{ disposition: 'held', reason: 'write' }, { disposition: 'auto' }],
      });
      const heldAt = await entered(harness, mira, 'work.actions-pending', { workItemId: held });
      await item(harness, mira, 'Draft the tier-two reply', 'plan-pending', { planPendingAt: 1 });
      await item(harness, aiko, 'Aiko’s plan', 'plan-pending', { planPendingAt: 2 });

      const own = await harness
        .withIdentity(OWNER)
        .query(api.work.needsYouForAgent, { agentId: mira });
      const everyone = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

      expect(own.total).toBe(2);
      expect(own.entries.map((entry) => [entry.kind, entry.subject])).toEqual([
        ['plan', 'Draft the tier-two reply'],
        ['held', 'Post the escalation guidance'],
      ]);
      expect(own.entries[1]).toMatchObject({ waitingSince: heldAt, heldWrites: 1 });
      expect(own.entries).toEqual(everyone.entries.filter((entry) => entry.agentId === mira));
    });

    it('lists a deployed employee’s one-to-one, the one entry its page waits on', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const waiting = await employee(harness, 'Aiko', { state: 'deployed' });

      const own = await harness
        .withIdentity(OWNER)
        .query(api.work.needsYouForAgent, { agentId: waiting });

      expect(own.entries.map((entry) => entry.kind)).toEqual(['one-to-one']);
    });

    it('refuses a caller who does not own the employee, and an anonymous one', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const theirs = await employee(harness, 'Stranger’s employee', { userId: 'stranger' });
      await item(harness, theirs, 'Theirs', 'plan-pending', { planPendingAt: 1 });

      await expect(
        harness.withIdentity(OWNER).query(api.work.needsYouForAgent, { agentId: theirs }),
      ).rejects.toThrow('forbidden');
      await expect(harness.query(api.work.needsYouForAgent, { agentId: theirs })).rejects.toThrow();
    });
  });
});

describe('work.dismissFailed (N7)', (): void => {
  async function stopped(harness: Harness): Promise<{
    agentId: Id<'agents'>;
    workItemId: Id<'workItems'>;
  }> {
    const { agentId, workItemId } = await seed(harness, 'failed');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        skipReason: 'stopped: nothing landed and nothing to decide',
      });
    });
    return { agentId, workItemId };
  }

  it('takes a stopped item out of the inbox and keeps it, until a Retry sends it back', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await stopped(harness);
    const inbox = async (): Promise<string[]> =>
      (await harness.withIdentity(OWNER).query(api.work.needsYouForAgent, { agentId })).entries.map(
        (entry) => entry.kind,
      );
    expect(await inbox()).toEqual(['stopped']);

    await harness.withIdentity(OWNER).mutation(api.work.dismissFailed, { workItemId });

    const dismissed = await readItem(harness, workItemId);
    expect(dismissed.state).toBe('failed');
    expect(dismissed.dismissedAt).toEqual(expect.any(Number));
    expect(await inbox()).toEqual([]);

    await harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });
    expect((await readItem(harness, workItemId)).dismissedAt).toBeUndefined();
  });

  it('records the dismissal as a work.dismissed event, once however often it is pressed (m16)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await stopped(harness);

    await harness.withIdentity(OWNER).mutation(api.work.dismissFailed, { workItemId });
    await harness.withIdentity(OWNER).mutation(api.work.dismissFailed, { workItemId });

    const dismissed = await eventsOfType(harness, agentId, 'work.dismissed');
    expect(dismissed.map((event) => event.payload)).toEqual([{ workItemId }]);
    expect(dismissed[0]?.createdAt).toBe((await readItem(harness, workItemId)).dismissedAt);
  });

  it('refuses to dismiss a stop whose write may have landed until the provider is reconciled', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'failed');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        skipReason: 'stopped: a write may have landed',
        output: {
          draft: 'd',
          notes: '',
          actions: [pendingOutput.actions[0]],
          applied: [
            { tool: 'mcp.call', ok: false, outcomeUnknown: true, idempotencyKey: 'comment' },
          ],
        },
      });
    });
    const refusal = harness.withIdentity(OWNER).mutation(api.work.dismissFailed, { workItemId });
    await expect(refusal).rejects.toBeInstanceOf(ConvexError);
    await expect(refusal).rejects.toMatchObject({
      data: 'A write on this item may have landed: confirm it against the provider before you dismiss it.',
    });
    expect((await readItem(harness, workItemId)).dismissedAt).toBeUndefined();
  });

  it('dismisses once, and refuses an item that is not failed or not the caller’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await stopped(harness);
    await harness.withIdentity(OWNER).mutation(api.work.dismissFailed, { workItemId });
    const first = (await readItem(harness, workItemId)).dismissedAt;
    await harness.withIdentity(OWNER).mutation(api.work.dismissFailed, { workItemId });
    expect((await readItem(harness, workItemId)).dismissedAt).toBe(first);

    await expect(
      harness
        .withIdentity(managerIdentity('intruder'))
        .mutation(api.work.dismissFailed, { workItemId }),
    ).rejects.toThrow('forbidden');
    const { workItemId: pending } = await seed(harness, 'plan-pending');
    const refusal = harness
      .withIdentity(OWNER)
      .mutation(api.work.dismissFailed, { workItemId: pending });
    await expect(refusal).rejects.toBeInstanceOf(ConvexError);
    await expect(refusal).rejects.toMatchObject({
      data: 'Only a stopped or rejected item can be dismissed; this one has moved on.',
    });
  });
});

describe('work.earlierPlan (round two 3.7, attempt two)', (): void => {
  it('reads the plan drafted for the item before the manager cancelled it, and none of another item’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending');
    const other = await harness.run(async (ctx) => {
      const draft = (id: Id<'workItems'>, summary: string) =>
        ctx.db.insert('events', {
          agentId,
          type: 'work.plan-drafted',
          payload: { workItemId: id, plan: { summary, steps: [`${summary} step`] } },
          createdAt: 1,
        });
      await draft(workItemId, 'First plan');
      const otherId = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-2',
        title: 'Another',
        contentSummary: 's',
        contentRefs: [],
        state: 'plan-pending',
        observedAt: 1,
        createdAt: 1,
      });
      await draft(otherId, 'Another item’s plan');
      return otherId;
    });
    // The cancel comes after the first plan; the redraft after the cancel.
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, { planRejectedAt: Date.now() + 1 });
    });
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await harness.run(async (ctx) => {
      await ctx.db.insert('events', {
        agentId,
        type: 'work.plan-drafted',
        payload: { workItemId, plan: { summary: 'Redraft', steps: ['Redraft step'] } },
        createdAt: 2,
      });
    });
    const owner = harness.withIdentity(OWNER);
    expect(await owner.query(api.work.earlierPlan, { workItemId })).toEqual({
      summary: 'First plan',
      steps: ['First plan step'],
      draftedAt: expect.any(Number),
    });
    expect(await owner.query(api.work.earlierPlan, { workItemId: other })).toBeNull();
    await expect(
      harness.withIdentity(managerIdentity('stranger')).query(api.work.earlierPlan, { workItemId }),
    ).rejects.toThrow('forbidden');
  });
});

describe('work.needsYou, dating a wait', (): void => {
  async function employee(harness: Harness): Promise<Id<'agents'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Mira',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
          zone: 'Asia/Singapore',
        }),
    );
  }

  async function row(
    harness: Harness,
    agentId: Id<'agents'>,
    title: string,
    state: Doc<'workItems'>['state'],
    fields: Partial<WithoutSystemFields<Doc<'workItems'>>> = {},
  ): Promise<Doc<'workItems'>> {
    return await harness.run(async (ctx) => {
      const id = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: title,
        title,
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state,
        observedAt: 1,
        createdAt: 1,
        ...fields,
      });
      return (await ctx.db.get(id))!;
    });
  }

  async function otherEvents(
    harness: Harness,
    agentId: Id<'agents'>,
    count: number,
  ): Promise<void> {
    await harness.run(async (ctx) => {
      for (let index = 0; index < count; index += 1) {
        await ctx.db.insert('events', {
          agentId,
          type: 'work.actions-pending',
          payload: { workItemId: `elsewhere-${index}` },
          createdAt: Date.now(),
        });
      }
    });
  }

  it('dates a row with no entering event by its insert when every event was read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness);
    const held = await row(harness, mira, 'Seeded held write', 'actions-pending', {
      output: pendingOutput,
    });
    await otherEvents(harness, mira, 100);

    const [entry] = (await harness.withIdentity(OWNER).query(api.work.needsYou, {})).entries;

    expect(entry).toMatchObject({ waitingSince: held._creationTime, waitingAtLeast: false });
  });

  it('never dates a wait before its row existed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness);
    await otherEvents(harness, mira, 101);
    const held = await row(harness, mira, 'Imported held write', 'actions-pending', {
      output: pendingOutput,
    });

    const [entry] = (await harness.withIdentity(OWNER).query(api.work.needsYou, {})).entries;

    expect(entry).toMatchObject({ waitingSince: held._creationTime, waitingAtLeast: false });
  });

  it('lists a new stop even when older rejected rows fill the stopped read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness);
    for (let index = 0; index < 25; index += 1) {
      await row(harness, mira, `Rejected ${index}`, 'failed', {
        skipReason: 'rejected by the manager: not now',
      });
    }
    await row(harness, mira, 'Stopped today', 'failed', { skipReason: 'the run stopped' });

    const inbox = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

    expect(inbox.entries.map((entry) => entry.subject)).toEqual(['Stopped today']);
  });

  it('carries the employee’s zone, so the home stamps the wait in the employee’s day', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness);
    await row(harness, mira, 'Plan', 'plan-pending', { planPendingAt: 1 });

    const [entry] = (await harness.withIdentity(OWNER).query(api.work.needsYou, {})).entries;

    expect(entry?.zone).toBe('Asia/Singapore');
  });
});
