/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { MANAGER_CHANGED_RESEND_REASON } from '../../convex/decisionRequests';
import * as workManagerChannelModule from '../../convex/workManagerChannel';
import {
  THREAD_NOT_FOUND_REASON,
  UNREADABLE_REPLY_REASON,
  UNSENT_NOTE_REASON,
} from '../../convex/workManagerChannel';
import { HELD_MUTATION } from '../../src/surfaces/policy';
import { convexRuntimeImports, reachedFrom } from '../fixtures/import-graph';
import { allConvexModules } from './all-modules';
import { guardRefusal } from './fakes/anonymous-caller';
import { managerIdentity } from './fakes/manager-identity';
import {
  eventsOfType,
  type Harness,
  OWNER,
  pend,
  pendAnother,
  pendingOutput,
  readItem,
  scheduledFunctionNames,
  seed,
} from './fakes/work-items';
import { registeredIn } from './registered-functions';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/*
 * The manager channel's tests (wave 18, 18-s): the decision request, the batch, the single-use
 * code, what an outage leaves for the manager and the resend's refusals, whose handler bodies are
 * `convex/workManagerChannel.ts`'s. Each describe moved here from `tests/convex/work.test.ts` as it
 * stood, with that file's mock and timers, below; the functions are still called at their
 * `api.work.*` and `internal.work.*` paths, which did not move (S-1).
 */

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

describe('convex/workManagerChannel.ts', (): void => {
  it('registers no function: each of the channel’s stays registered in convex/work.ts', (): void => {
    expect(registeredIn(workManagerChannelModule)).toEqual([]);
  });

  it('sits below convex/work.ts, which imports it and which no chain of its imports reaches', (): void => {
    const graph = convexRuntimeImports();
    expect(graph.get('work')).toContain('workManagerChannel');
    expect(reachedFrom(graph, 'workManagerChannel').has('work')).toBe(false);
  });
});

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
    ).rejects.toThrow('This work item is not yours.');
  });

  it('refuses a caller with no identity before it reads the batch, an empty one included (12-G)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(
      harness.mutation(api.work.approveActionsBatch, { members: [] }),
    ).rejects.toMatchObject(await guardRefusal());
  });

  async function batchOnChannel(harness: Harness): Promise<{
    agentId: Id<'agents'>;
    surfaceId: Id<'surfaces'>;
    first: { workItemId: Id<'workItems'>; runId: Id<'events'> };
    second: { workItemId: Id<'workItems'>; runId: Id<'events'> };
  }> {
    const ids = await seed(harness, 'executing', undefined, { withSlack: true });
    await harness.mutation(internal.workRuns.setActionsPending, {
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
    expect(kept.map((row) => [row.workItemId, row.kind, row.text, row.origin]).sort()).toEqual(
      [
        [first.workItemId, 'rejection', 'not this week', 'channel'],
        [second.workItemId, 'rejection', 'not this week', 'channel'],
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
    await harness.mutation(internal.workRuns.setActionsPending, {
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

    await harness.withIdentity(OWNER).mutation(api.planApproval.approvePlan, { workItemId });
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
    ).rejects.toThrow('This work item is not yours.');
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

    await harness.withIdentity(OWNER).mutation(api.planApproval.approvePlan, { workItemId });
    // Re-pinned for M10 (12-M): the decided request's thread is read for the notice's hour too.
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toEqual({
      requests: [],
      batches: [],
      noticeOwed: true,
      threads: ['1787770700.000100'],
    });
    vi.setSystemTime(Date.UTC(2026, 8, 28, 10, 1));
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toMatchObject({
      noticeOwed: false,
    });
    expect(
      (await harness.query(internal.work.openDecisions, { surfaceId })).threads,
    ).toBeUndefined();
    vi.useRealTimers();
  });

  it('lists the threads of Day0’s other messages in the DM within the notice window: a replaced request and a note (M10)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(Date.UTC(2026, 8, 28, 9, 0));
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
      withSlack: true,
    });
    const surfaceId = await slackSurfaceId(harness, agentId);
    const channel = await harness.run(
      async (ctx) => (await ctx.db.get(surfaceId))!.managerDmChannelId!,
    );
    await harness.run(async (ctx): Promise<void> => {
      const base = {
        agentId,
        workItemId,
        kind: 'plan' as const,
        surfaceSlug: 'slack',
        channel,
        requestText: 'the request',
      };
      await ctx.db.insert('replacedDecisionRequests', {
        ...base,
        decisionId: 'ab3xyz',
        ts: '1787770600.000100',
        replacedAt: Date.UTC(2026, 8, 28, 8, 30),
        editClaimedAt: Date.UTC(2026, 8, 28, 8, 30),
        editedAt: Date.UTC(2026, 8, 28, 8, 30),
      });
      // Replaced, and its message edited, over an hour ago: its thread is no longer read.
      await ctx.db.insert('replacedDecisionRequests', {
        ...base,
        decisionId: 'cd4wvu',
        ts: '1787770500.000100',
        replacedAt: Date.UTC(2026, 8, 28, 7, 0),
        editClaimedAt: Date.UTC(2026, 8, 28, 7, 0),
        editedAt: Date.UTC(2026, 8, 28, 7, 0),
      });
      await ctx.db.insert('managerNotes', {
        agentId,
        workItemId,
        kind: 'landed',
        text: 'Done.',
        createdAt: Date.UTC(2026, 8, 28, 8, 45),
        claimedAt: Date.UTC(2026, 8, 28, 8, 45),
        providerTs: '1787770650.000100',
      });
    });
    // More replaced messages edited in the window than one poll reads: the newest are kept.
    await harness.run(async (ctx): Promise<void> => {
      for (let index = 0; index < 12; index += 1) {
        await ctx.db.insert('replacedDecisionRequests', {
          agentId,
          workItemId,
          kind: 'plan',
          surfaceSlug: 'slack',
          channel,
          decisionId: `old${String(index).padStart(3, '0')}`,
          ts: `1787770${String(100 + index)}.000100`,
          replacedAt: Date.UTC(2026, 8, 28, 8, 10) + index,
          editClaimedAt: Date.UTC(2026, 8, 28, 8, 10) + index,
          editedAt: Date.UTC(2026, 8, 28, 8, 10) + index,
        });
      }
    });
    const open = await harness.query(internal.work.openDecisions, { surfaceId });
    expect(open.threads?.slice(0, 2)).toEqual(['1787770650.000100', '1787770600.000100']);
    expect(open.threads).toHaveLength(10);
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

  it('re-sends a request stranded on the same DM with its own failure, never saying the DM changed (the second pass)', async (): Promise<void> => {
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
          channel: 'D0MANAGER',
          surfaceSlug: 'slack',
          surfaceName: 'Slack',
          ts: '1787770700.000100',
          requestFailedAt: 2,
          requestFailure: THREAD_NOT_FOUND_REASON,
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
      { workItemId, decisionId: 'ab3xyz', kind: 'plan', reason: THREAD_NOT_FOUND_REASON },
    ]);
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
      harness.withIdentity(OWNER).mutation(api.planApproval.approvePlan, { workItemId }),
    ).rejects.toThrow('expected plan-pending');
  });

  it('says, while a pause holds the approved step, that it runs at the resume, not now (W12-R15)', async (): Promise<void> => {
    useSurfaceMode('real');
    const noticeAfter = async (hold: 'employee' | 'deployment'): Promise<string | undefined> => {
      const harness = convexTest(schema, allConvexModules());
      const { agentId, workItemId } = await seed(harness, 'plan-pending', undefined, {
        withSlack: true,
      });
      const surfaceId = await chatSurfaceId(harness, agentId);
      await harness.mutation(internal.work.prepareDecisionRequest, {
        workItemId,
        kind: 'plan',
        decisionId: 'pz4qrs',
      });
      if (hold === 'employee') {
        await harness.run(async (ctx) => await ctx.db.patch(agentId, { pausedAt: 1 }));
      } else {
        vi.stubEnv('DAY0_CRONS_PAUSED', 'maintenance');
      }
      await harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1.200',
        reply: { verb: 'approve', id: 'pz4qrs' },
      });
      vi.unstubAllEnvs();
      const notice = await harness.run(
        async (ctx) =>
          await ctx.db
            .query('managerDecisionNotices')
            .withIndex('by_surface_message', (q) =>
              q.eq('surfaceId', surfaceId).eq('messageTs', '1.200'),
            )
            .unique(),
      );
      return notice?.text;
    };
    expect(await noticeAfter('employee')).toBe(
      'Approval pz4qrs received. I’m paused: I’ll start the approved plan when you resume me.',
    );
    expect(await noticeAfter('deployment')).toBe(
      'Approval pz4qrs received. Scheduled work on this deployment is paused: I’ll start the approved plan once it runs again.',
    );
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
      {
        agentId,
        workItemId,
        kind: 'plan-rejection',
        text: 'Use the revised runbook',
        origin: 'channel',
      },
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
    await harness.mutation(internal.workRuns.setActionsPending, {
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
        // Re-pinned for W12V-16: the manager reads "code" everywhere else, never "token".
        text: 'I couldn’t find decision cd4uvw. Check the six-character code and try again.',
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
    await actionsHarness.mutation(internal.workRuns.setActionsPending, {
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
    await harness.mutation(internal.workRuns.setActionsPending, {
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
    await harness.mutation(internal.workRuns.claimApprovedActions, { workItemId });
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

    await owner.mutation(api.planApproval.approvePlan, { workItemId });
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
