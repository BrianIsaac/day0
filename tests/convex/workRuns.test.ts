/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import {
  INTERRUPTED_APPLY_REASON,
  OUTCOME_UNKNOWN_AFTER_STOP_REASON,
  OUTCOME_UNKNOWN_REASON,
  providerReconciliationEntries,
  reconciliationOwed,
} from '../../src/work/reconciliation';
import { landedWritesOf, unsentWritesOf } from '../../src/work/landed-writes';
import { STOPPED_PREFIX } from '../../src/work/stop';
import { goneCitesReason } from '../../src/work/plan-cites';
import { stopRunsForHandover } from '../../convex/workRuns';
import type { AppliedAction } from '../../src/surfaces/types';
import {
  HELD_CLOSE_AGAINST_WORDS,
  HELD_NOT_APPROVED,
  HELD_WITH_REPORTED_WRITES,
  HELD_WRITE,
} from '../../src/surfaces/policy';
import { eventTypesIn } from '../../src/events/record-filters';

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
    // Stopped, not interrupted: the reason says which ended the apply (12-W's second pass).
    expect(applied[1]).toMatchObject({ ok: false, reason: OUTCOME_UNKNOWN_AFTER_STOP_REASON });
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

  it('takes back an approval a pause holds: the set is stopped before its apply claims and sends nothing (W12-R14, D-7 (b))', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness);
    await harness.mutation(internal.workRuns.setActionsPending, {
      workItemId,
      runId,
      output: heldOutput,
    });
    await harness.withIdentity(OWNER).mutation(api.agents.pause, { agentId });
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0, 1],
    });
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'actions-pending',
      approvedIndexes: [0, 1],
    });

    await harness
      .withIdentity(OWNER)
      .mutation(api.workRuns.stopRun, { workItemId, reason: 'Not this quarter.' });

    const row = await readItem(harness, workItemId);
    expect(row).toMatchObject({
      state: 'failed',
      skipReason: `${STOPPED_PREFIX}stopped by the manager: Not this quarter.`,
    });
    expect(row.approvedIndexes).toBeUndefined();
    // Nothing was sent, so nothing is owed a check before a retry.
    expect(providerReconciliationEntries(row.output)).toEqual([]);
    // The resume that would have sent the set finds nothing to send.
    await harness.withIdentity(OWNER).mutation(api.agents.resume, { agentId });
    await expect(
      harness.mutation(internal.workRuns.claimApprovedActions, { workItemId }),
    ).resolves.toMatchObject({ claimed: false });
  });

  // Re-pinned by 13-FD (the v0.16.0 redeploy's finding 4): a Stop confirmed after the item moved
  // on was thrown as a `ConvexError`, which the browser's Convex client logs as a server error and
  // the dialog held open; it is an expected outcome, so it is answered as one and changes nothing.
  it('answers a Stop on an item no longer under way as an outcome, and changes nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'plan-pending');
    const before = await readItem(harness, workItemId);
    await expect(
      harness.withIdentity(OWNER).mutation(api.workRuns.stopRun, { workItemId }),
    ).resolves.toEqual({ ok: false, refused: 'moved-on' });
    expect(await readItem(harness, workItemId)).toEqual(before);
  });

  it('refuses another manager’s item', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const working = await seed(harness, 'executing');
    await expect(
      harness
        .withIdentity(managerIdentity('someone-else@example.com'))
        .mutation(api.workRuns.stopRun, { workItemId: working.workItemId }),
    ).rejects.toThrow();
    expect(await readItem(harness, working.workItemId)).toMatchObject({ state: 'executing' });
  });
});

describe('a stop that meets an apply in flight, told in Slack (W12-R12)', (): void => {
  /** Give the employee a manager channel, so a note has somewhere to go. */
  async function withManagerChannel(harness: Harness, agentId: Id<'agents'>): Promise<void> {
    await harness.run(async (ctx) => {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Slack bot token',
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
        credentialLanded: true,
        credentialId,
        managerDmChannelId: 'D0MANAGER',
        managerUserId: 'UMANAGER',
        whereFound: [],
        createdAt: 1,
      });
    });
  }

  const notes = async (harness: Harness): Promise<Doc<'managerNotes'>[]> =>
    await harness.run(async (ctx) => await ctx.db.query('managerNotes').collect());

  it('names the rows whose outcome is unknown when a handover stops the apply', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, applyAttemptId } = await applyInFlight(harness);
    await withManagerChannel(harness, agentId);
    await harness.mutation(internal.workRuns.recordApplyOutcome, {
      workItemId,
      applyAttemptId,
      index: 0,
      row: landedComment,
    });

    await harness.run(async (ctx) => {
      await stopRunsForHandover(ctx, agentId);
    });

    const [note] = await notes(harness);
    expect(note).toMatchObject({ kind: 'landed', workItemId });
    expect(note?.text).toContain('the employee was handed over to a new manager');
    expect(note?.text).toContain('(outcome unknown)');
  });

  it('sends nothing for the manager’s own Stop: they are at the card that lists each row', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await applyInFlight(harness);
    await withManagerChannel(harness, agentId);
    await harness.withIdentity(OWNER).mutation(api.workRuns.stopRun, { workItemId });
    expect(await notes(harness)).toEqual([]);
  });
});

/** An apply stopped after its first write landed: the second write's outcome is unknown. */
async function stoppedMidApply(harness: Harness): Promise<{
  agentId: Id<'agents'>;
  workItemId: Id<'workItems'>;
}> {
  const { agentId, workItemId, applyAttemptId } = await applyInFlight(harness);
  await harness.mutation(internal.workRuns.recordApplyOutcome, {
    workItemId,
    applyAttemptId,
    index: 0,
    row: landedComment,
  });
  await harness.withIdentity(OWNER).mutation(api.workRuns.stopRun, { workItemId });
  return { agentId, workItemId };
}

describe('the reconciliation answered per entry (U17 D1)', (): void => {
  it('refuses a confirmation that leaves a write of unknown outcome unanswered', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await stoppedMidApply(harness);
    await expect(
      harness
        .withIdentity(OWNER)
        .mutation(api.workRuns.reconcileFailed, { workItemId, confirmed: true }),
    ).rejects.toThrow('Say for each write whose outcome is unknown whether it landed');
    expect((await readItem(harness, workItemId)).providerReconciliation).toBeUndefined();
  });

  it('stores only the answers the manager gave: a write Day0 recorded as landed carries none (W12X-3)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await stoppedMidApply(harness);
    await harness.withIdentity(OWNER).mutation(api.workRuns.reconcileFailed, {
      workItemId,
      confirmed: true,
      answers: [{ phase: 'single', actionIndex: 1, answer: 'not-sent' }],
    });
    const recorded = (await readItem(harness, workItemId)).providerReconciliation;
    expect(
      recorded?.entries.map((entry) => [entry.actionIndex, entry.outcome, entry.answer]),
    ).toEqual([
      // Re-pinned for W12X-3: the landed write was stored answered `landed`, and the card said
      // "You said it landed." of a write nobody asked about.
      [0, 'landed', undefined],
      [1, 'outcome-unknown', 'not-sent'],
    ]);
    const event = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .filter((q) => q.eq(q.field('type'), 'work.provider-reconciled'))
          .first(),
    );
    expect(
      (event?.payload as { entries: Array<{ answer?: string }> }).entries.map((e) => e.answer),
    ).toEqual([undefined, 'not-sent']);
  });

  it('owes no answer for a write Day0 recorded as landed, and the retry never sends it again (W12X-3)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'failed');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        skipReason: 'stopped: the closing gate refused the close',
        output: { draft: 'd', notes: '', actions: [comment], applied: [landedComment] },
      });
    });
    await harness.withIdentity(OWNER).mutation(api.workRuns.reconcileFailed, {
      workItemId,
      confirmed: true,
      answers: [],
    });
    const recorded = (await readItem(harness, workItemId)).providerReconciliation;
    expect(recorded?.entries.map((entry) => [entry.outcome, entry.answer])).toEqual([
      ['landed', undefined],
    ]);
    const event = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .filter((q) => q.eq(q.field('type'), 'work.provider-reconciled'))
          .first(),
    );
    expect((event?.payload as { entries: Array<{ answer?: string }> }).entries).toEqual([
      expect.not.objectContaining({ answer: expect.anything() }),
    ]);

    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });
    // What the retried run's executor reads as already on the provider: the comment, carried.
    const carried = (
      (await readItem(harness, workItemId)).output as {
        landedWrites?: Array<{ action: unknown; applied: AppliedAction }>;
      }
    ).landedWrites;
    expect(carried?.map((write) => write.action)).toEqual([comment]);
  });
});

describe('a retry after the reconciliation (P4-1)', (): void => {
  it('carries a write answered landed so the retry never sends it again, and leaves out one not sent', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await stoppedMidApply(harness);
    await harness.withIdentity(OWNER).mutation(api.workRuns.reconcileFailed, {
      workItemId,
      confirmed: true,
      answers: [
        { phase: 'single', actionIndex: 0, answer: 'not-sent' },
        { phase: 'single', actionIndex: 1, answer: 'landed' },
      ],
    });
    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('plan-approved');
    // What the retried run's executor reads as already on the provider (`landedWritesOf`).
    const carried = (
      row.output as { landedWrites?: Array<{ action: unknown; applied: AppliedAction }> }
    ).landedWrites;
    expect(carried?.map((write) => write.action)).toEqual([status]);
    expect(carried?.[0].applied).toMatchObject({ ok: true });
    expect(carried?.[0].applied.outcomeUnknown).toBeUndefined();
  });

  it('never counts landed, in what the retried executor reads, a landed row the manager answered not sent (W12-R4)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await stoppedMidApply(harness);
    await harness.withIdentity(OWNER).mutation(api.workRuns.reconcileFailed, {
      workItemId,
      confirmed: true,
      answers: [
        { phase: 'single', actionIndex: 0, answer: 'not-sent' },
        { phase: 'single', actionIndex: 1, answer: 'landed' },
      ],
    });
    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });

    // The executor reads the row's output with no answers (`convex/workActions.ts`, at its claim).
    const output = (await readItem(harness, workItemId)).output;
    expect(landedWritesOf(output).map((write) => write.action)).toEqual([status]);
    expect(unsentWritesOf(output).map((write) => write.action)).toEqual([comment]);
  });
  it('runs the plan again from its first phase, never a resumed closing set, when a prerequisite write is answered not sent', async (): Promise<void> => {
    useSurfaceMode('real');
    const read = {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-1"}' },
    };
    const retried = async (answer: 'landed' | 'not-sent'): Promise<Doc<'workItems'>> => {
      const harness = convexTest(schema, allConvexModules());
      const { workItemId } = await seed(harness, 'failed');
      // A run whose closing gate refused its set: the prerequisites landed, a resume is on offer.
      await harness.run(async (ctx) => {
        await ctx.db.patch(workItemId, {
          skipReason: 'stopped: the closing gate refused the close',
          output: {
            phase: 'dependent-authoring',
            draft: 'd',
            notes: '',
            actions: [read, comment],
            applied: [{ tool: 'mcp.call', ok: true, idempotencyKey: 'key-read' }, landedComment],
            refusedClosing: {
              actions: [status],
              planStepOutcomes: [],
              draft: '',
              notes: '',
              reason: 'refused',
              at: 1,
            },
          },
        });
      });
      await harness.withIdentity(OWNER).mutation(api.workRuns.reconcileFailed, {
        workItemId,
        confirmed: true,
        answers: [{ phase: 'single', actionIndex: 1, answer }],
      });
      await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });
      return await readItem(harness, workItemId);
    };
    expect((await retried('landed')).output).toMatchObject({ resumedClosing: true });
    const sentAgain = await retried('not-sent');
    expect((sentAgain.output as { resumedClosing?: boolean }).resumedClosing).toBeUndefined();
    expect(unsentWritesOf(sentAgain.output).map((write) => write.action)).toEqual([comment]);
  });
});

describe('a reconciliation recorded before the per-entry answers (W12-R3, D-9 (a))', (): void => {
  /** A stopped run reconciled at v0.15.0: the entries stored whole, with no answer on any. */
  async function reconciledAtV0150(harness: Harness): Promise<Id<'workItems'>> {
    const { workItemId } = await stoppedMidApply(harness);
    await harness.run(async (ctx) => {
      const row = await ctx.db.get(workItemId);
      // The ledger's entries, which carry no answer, stored whole as v0.15.0 stored them.
      const entries = providerReconciliationEntries(row?.output);
      await ctx.db.patch(workItemId, {
        providerReconciliation: { actor: 'owner', confirmedAt: 5, entries },
      });
    });
    return workItemId;
  }

  it('asks again for the write of unknown outcome, and takes the answers', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const workItemId = await reconciledAtV0150(harness);
    const row = await readItem(harness, workItemId);
    expect(reconciliationOwed(row)).toBe(true);
    await expect(
      harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId }),
    ).rejects.toThrow('reconcile the provider first');
    await expect(
      harness.withIdentity(OWNER).mutation(api.workRuns.dismissFailed, { workItemId }),
    ).rejects.toThrow('confirm it against the provider before you dismiss it');

    await harness.withIdentity(OWNER).mutation(api.workRuns.reconcileFailed, {
      workItemId,
      confirmed: true,
      answers: [{ phase: 'single', actionIndex: 1, answer: 'landed' }],
    });
    const answered = await readItem(harness, workItemId);
    // Re-pinned for W12X-3: the landed comment was stored answered `landed`; only the write asked
    // about carries the manager's answer now, and both still ride into the retry as landed.
    expect(answered.providerReconciliation?.entries.map((entry) => entry.answer)).toEqual([
      undefined,
      'landed',
    ]);
    expect(reconciliationOwed(answered)).toBe(false);
    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });
    // Both writes now ride into the retry as landed, so neither is sent again.
    expect(
      landedWritesOf((await readItem(harness, workItemId)).output).map((write) => write.action),
    ).toEqual([comment, status]);
  });

  it('carries into the retry, as landed, the writes of a v0.15.0 reconciliation that named only landed writes (W12X-3)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'failed');
    await harness.run(async (ctx) => {
      const output = { draft: 'd', notes: '', actions: [comment], applied: [landedComment] };
      // Confirmed whole at v0.15.0: the entries stored with no answer on any.
      await ctx.db.patch(workItemId, {
        skipReason: 'stopped: the closing gate refused the close',
        output,
        providerReconciliation: {
          actor: 'owner',
          confirmedAt: 5,
          entries: providerReconciliationEntries(output),
        },
      });
    });
    expect(reconciliationOwed(await readItem(harness, workItemId))).toBe(false);
    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });
    // The behaviour this release changes for such a row, named: the landed comment is now carried
    // explicitly, as it is for every reconciliation this release writes; before, nothing was.
    const carried = (
      (await readItem(harness, workItemId)).output as {
        landedWrites?: Array<{ action: unknown; applied: AppliedAction }>;
      }
    ).landedWrites;
    expect(carried?.map((write) => write.action)).toEqual([comment]);
  });

  it('still refuses a confirmation that leaves the unknown write unanswered', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const workItemId = await reconciledAtV0150(harness);
    await expect(
      harness
        .withIdentity(OWNER)
        .mutation(api.workRuns.reconcileFailed, { workItemId, confirmed: true }),
    ).rejects.toThrow('Say for each write whose outcome is unknown whether it landed');
  });
});

describe('a Retry that re-drafts a declined plan (12-M’s replaced request, carried with the move)', (): void => {
  it('answers the old code of a plan rejected and re-drafted by Retry as replaced, never as unknown (W12V-16)', async (): Promise<void> => {
    // The walk on real Slack: REVOPS-1's plan request 5z73m6 rejected by the button, Retry drafted
    // 6yrhhe, and "approve 5z73m6" was answered "I couldn’t find decision 5z73m6. Check the
    // six-character token and try again."
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'cancelled');
    const surfaceId = await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        decision: {
          id: '5z73m6',
          kind: 'plan',
          requestedAt: 1,
          channel: 'D0MANAGER',
          surfaceSlug: 'slack',
          surfaceName: 'Slack',
          ts: '1791149181.056859',
          requestText: 'Priya needs your decision.',
          decidedAt: 2,
          outcome: 'rejected',
          decidedVia: 'channel',
        },
      });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        endpoint: 'https://slack.com/api/',
        path: 'documented-api',
        toolAllowlist: ['chat.postMessage', 'conversations.history'],
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        managerDmChannelId: 'D0MANAGER',
        managerUserId: 'UMANAGER',
        whereFound: [],
        createdAt: 1,
      });
    });

    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });
    const answered = await harness.mutation(internal.work.resolveChannelDecision, {
      surfaceId,
      userId: 'UMANAGER',
      messageTs: '1791152146.122269',
      reply: { verb: 'approve', id: '5z73m6' },
    });

    expect(answered).toMatchObject({ status: 'replaced', notified: true });
    const notices = await harness.run(
      async (ctx) => await ctx.db.query('managerDecisionNotices').collect(),
    );
    // Re-pinned for 13-FS (W12V-16): the replaced request keeps the decision it had, so the answer
    // says it was rejected as well as replaced.
    expect(notices.map((notice) => notice.text)).toEqual([
      'That request (5z73m6) was rejected, then replaced, and no longer decides anything. Day0 asks again in a new message when the work is ready for your decision.',
    ]);
    const remembered = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('replacedDecisionRequests')
          .withIndex('by_agent_decision', (q) =>
            q.eq('agentId', agentId).eq('decisionId', '5z73m6'),
          )
          .unique(),
    );
    expect(remembered).toMatchObject({ outcome: 'rejected', decidedAt: 2, decidedVia: 'channel' });
    // Its message already says how it was decided, so it is not edited again.
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(scheduled.map((job) => job.name)).not.toContain(
      'managerChannelActions:markRequestReplaced',
    );
  });

  it('remembers the undecided request the re-draft takes back, so its code stays answerable', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'cancelled');
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        decision: {
          id: 'abc234',
          kind: 'actions',
          requestedAt: 1,
          channel: 'D0MANAGER',
          surfaceSlug: 'slack',
          surfaceName: 'Slack',
          ts: '1787768400.000100',
          requestText: 'Priya needs your decision.',
        },
      });
    });

    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });

    expect((await readItem(harness, workItemId)).decision).toBeUndefined();
    const remembered = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('replacedDecisionRequests')
          .withIndex('by_agent_decision', (q) =>
            q.eq('agentId', agentId).eq('decisionId', 'abc234'),
          )
          .unique(),
    );
    expect(remembered).toMatchObject({
      workItemId,
      decisionId: 'abc234',
      kind: 'actions',
      channel: 'D0MANAGER',
      ts: '1787768400.000100',
      requestText: 'Priya needs your decision.',
    });
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(scheduled.map((job) => job.name)).toContain('managerChannelActions:markRequestReplaced');
  });
});

describe('Close without retry (E-8)', (): void => {
  /** An apply interrupted after its claim whose approved rows were all refused before sending. */
  async function interruptedWithNothingToReconcile(harness: Harness): Promise<{
    agentId: Id<'agents'>;
    workItemId: Id<'workItems'>;
  }> {
    const { agentId, workItemId } = await seed(harness, 'failed');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        skipReason: INTERRUPTED_APPLY_REASON,
        output: {
          ...heldOutput,
          applied: [
            { tool: 'mcp.call', ok: false, reason: 'refused: not granted', idempotencyKey: 'k0' },
            { tool: 'mcp.call', ok: false, reason: 'refused: not granted', idempotencyKey: 'k1' },
          ],
        },
      });
    });
    return { agentId, workItemId };
  }

  it('closes a row whose ledger names nothing to reconcile, which Dismiss and Retry refuse', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await interruptedWithNothingToReconcile(harness);
    const inbox = async (): Promise<string[]> =>
      (await harness.withIdentity(OWNER).query(api.work.needsYouForAgent, { agentId })).entries.map(
        (entry) => entry.kind,
      );
    expect(await inbox()).toEqual(['stopped']);
    await expect(
      harness.withIdentity(OWNER).mutation(api.workRuns.dismissFailed, { workItemId }),
    ).rejects.toThrow();
    await expect(
      harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId }),
    ).rejects.toThrow();

    await harness.withIdentity(OWNER).mutation(api.workRuns.closeWithoutRetry, { workItemId });
    await harness.withIdentity(OWNER).mutation(api.workRuns.closeWithoutRetry, { workItemId });

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(row.dismissedAt).toEqual(expect.any(Number));
    expect(await inbox()).toEqual([]);
    const closed = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .filter((q) => q.eq(q.field('type'), 'work.closed-without-retry'))
          .collect(),
    );
    expect(closed.map((event) => event.payload)).toEqual([{ workItemId, actor: 'owner' }]);
  });

  it('closes a stopped row with nothing to reconcile, and keeps Retry on it', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'plan-approved');
    await harness.withIdentity(OWNER).mutation(api.workRuns.stopRun, { workItemId });
    await harness.withIdentity(OWNER).mutation(api.workRuns.closeWithoutRetry, { workItemId });
    expect((await readItem(harness, workItemId)).dismissedAt).toEqual(expect.any(Number));
    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });
    expect(await readItem(harness, workItemId)).toMatchObject({ state: 'plan-approved' });
  });

  it('refuses a row with a write to reconcile, and a row that is not failed', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await stoppedMidApply(harness);
    await expect(
      harness.withIdentity(OWNER).mutation(api.workRuns.closeWithoutRetry, { workItemId }),
    ).rejects.toThrow('A write on this item may have landed');
    const working = await seed(harness, 'executing');
    await expect(
      harness
        .withIdentity(OWNER)
        .mutation(api.workRuns.closeWithoutRetry, { workItemId: working.workItemId }),
    ).rejects.toThrow('Only a stopped or failed item can be closed');
  });
});

describe('waitingSince (H D11, D12)', (): void => {
  it('is stamped as a run parks for the manager and again as it stops, and the inbox dates the wait by it', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 4, 9));
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness);
    vi.setSystemTime(Date.UTC(2026, 9, 4, 9, 5));
    await harness.mutation(internal.workRuns.setActionsPending, {
      workItemId,
      runId,
      output: heldOutput,
    });
    expect((await readItem(harness, workItemId)).waitingSince).toBe(Date.UTC(2026, 9, 4, 9, 5));

    // The wait as the inbox reads it: the stamp, not the event.
    await harness.run(async (ctx) => {
      for (const event of await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .collect()) {
        await ctx.db.delete(event._id);
      }
    });
    const entries = async () =>
      (await harness.withIdentity(OWNER).query(api.work.needsYouForAgent, { agentId })).entries;
    expect((await entries()).map((entry) => [entry.kind, entry.waitingSince])).toEqual([
      ['held', Date.UTC(2026, 9, 4, 9, 5)],
    ]);

    vi.setSystemTime(Date.UTC(2026, 9, 4, 9, 30));
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, {
      workItemId,
      pendingRunId: runId,
      reason: 'Not now.',
    });
    expect((await readItem(harness, workItemId)).waitingSince).toBe(Date.UTC(2026, 9, 4, 9, 30));
  });

  it('is stamped as a run is stopped', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 4, 10));
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness);
    await harness.withIdentity(OWNER).mutation(api.workRuns.stopRun, { workItemId });
    expect((await readItem(harness, workItemId)).waitingSince).toBe(Date.UTC(2026, 9, 4, 10));
  });
});

describe('a completion that withheld writes (the wave 6 review’s D4)', (): void => {
  it('records the withheld rows as their own event, which the record files under refused and withheld', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness);
    await harness.mutation(internal.workRuns.setCompleted, {
      workItemId,
      runId,
      output: {
        ...heldOutput,
        applied: [
          landedComment,
          {
            tool: 'mcp.call',
            ok: true,
            held: true,
            reason: HELD_NOT_APPROVED,
            effect: 'set REVOPS-1 to Done',
            idempotencyKey: 'key-1',
          },
        ],
      },
    });
    const withheld = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .filter((q) => q.eq(q.field('type'), 'work.actions-withheld'))
          .collect(),
    );
    expect(withheld.map((event) => event.payload)).toEqual([
      {
        workItemId,
        runId,
        withheld: [
          {
            phase: 'single',
            index: 1,
            tool: 'mcp.call',
            reason: HELD_NOT_APPROVED,
            effect: 'set REVOPS-1 to Done',
          },
        ],
      },
    ]);
    expect(eventTypesIn('refused')).toContain('work.actions-withheld');
  });

  it('names the phase of each withheld row of a two-phase run', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness);
    const held = {
      tool: 'mcp.call',
      ok: true,
      held: true,
      reason: HELD_NOT_APPROVED,
      idempotencyKey: 'held',
    };
    await harness.mutation(internal.workRuns.setCompleted, {
      workItemId,
      runId,
      output: {
        ...heldOutput,
        initial: { actions: [comment, status], applied: [landedComment, held] },
        applied: [held, { ...landedComment, idempotencyKey: 'closing-1' }],
      },
    });
    const withheld = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .filter((q) => q.eq(q.field('type'), 'work.actions-withheld'))
          .first(),
    );
    expect(
      (withheld?.payload as { withheld: Array<{ phase: string; index: number }> }).withheld.map(
        (row) => [row.phase, row.index],
      ),
    ).toEqual([
      ['prerequisite', 1],
      ['closing', 0],
    ]);
  });

  it('writes no such event for a completion that withheld nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness);
    await harness.mutation(internal.workRuns.setCompleted, {
      workItemId,
      runId,
      output: {
        ...heldOutput,
        applied: [landedComment, { ...landedComment, idempotencyKey: 'k1' }],
      },
    });
    const types = (
      await harness.run(
        async (ctx) =>
          await ctx.db
            .query('events')
            .withIndex('by_agent', (q) => q.eq('agentId', agentId))
            .collect(),
      )
    ).map((event) => event.type);
    expect(types).not.toContain('work.actions-withheld');
  });
});

describe('a close the tripwire sent to the manager (12-D, decision D-1 (b))', (): void => {
  const tripped = {
    ...heldOutput,
    workDone: 'done',
    workDoneWhy: 'The audit note is posted.',
    closeAgainstWords: 'I could not find the close summary.',
  };

  it('holds the Done for the manager even with autonomous actions on, while the comment applies on its own (real mode)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { autonomousActions: true });
    });
    await harness.mutation(internal.workRuns.setActionsPending, {
      workItemId,
      runId,
      output: tripped,
    });
    expect((await readItem(harness, workItemId)).actionVerdicts).toEqual([
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_CLOSE_AGAINST_WORDS },
    ]);
  });

  it('lands the same set on its own under the switch when the run answered done without tripping it', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, runId } = await seed(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { autonomousActions: true });
    });
    const clean: Partial<typeof tripped> = { ...tripped };
    delete clean.closeAgainstWords;
    await harness.mutation(internal.workRuns.setActionsPending, {
      workItemId,
      runId,
      output: clean,
    });
    expect((await readItem(harness, workItemId)).actionVerdicts).toEqual([
      { disposition: 'auto' },
      { disposition: 'auto' },
    ]);
  });

  it('gives the mock ticket close its own reason, beside every other write held as always (mock mode)', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, runId } = await seed(harness);
    await harness.mutation(internal.workRuns.setActionsPending, {
      workItemId,
      runId,
      output: {
        ...tripped,
        actions: [
          { tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'Posted.' } },
          {
            tool: 'ticket.update',
            args: { slug: 'REVOPS-1', status: 'done', comment: 'Posted the audit note.' },
          },
        ],
      },
    });
    expect((await readItem(harness, workItemId)).actionVerdicts).toEqual([
      { disposition: 'held', reason: HELD_WRITE },
      { disposition: 'held', reason: HELD_CLOSE_AGAINST_WORDS },
    ]);
  });
});

describe('a manager DM that reports a held write of its set (W12X-2, W12V-8)', (): void => {
  /** Slack beside Linear, with the manager DM channel and the grants a DM applies on its own under. */
  async function withSlack(harness: Harness, agentId: Id<'agents'>): Promise<void> {
    await harness.run(async (ctx) => {
      for (const scope of ['slack:read', 'slack:write']) {
        await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
      }
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        endpoint: 'https://slack.com/api/',
        path: 'documented-api',
        toolAllowlist: ['chat.postMessage'],
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        managerDmChannelId: 'D0MANAGER',
        whereFound: [],
        createdAt: 1,
      });
    });
  }

  const dm = (text: string) => ({
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'POST',
      path: 'chat.postMessage',
      body: JSON.stringify({ channel: 'D0MANAGER', text }),
    },
  });

  it('holds the DM with the comment it reports, so neither goes before the manager decides', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const ids = await seed(harness);
    await withSlack(harness, ids.agentId);
    await harness.mutation(internal.workRuns.setActionsPending, {
      workItemId: ids.workItemId,
      runId: ids.runId,
      output: {
        draft: 'Commented on REVOPS-1.',
        notes: '',
        actions: [comment, dm('Commented the audit note on REVOPS-1.')],
      },
    });
    const row = await readItem(harness, ids.workItemId);
    expect(row.state).toBe('actions-pending');
    expect(row.actionVerdicts?.[1]).toEqual({
      disposition: 'held',
      reason: HELD_WITH_REPORTED_WRITES,
    });
  });

  it('counts the held DM in the finished note once the manager approved it with the comment it reports (W13V-6)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const ids = await seed(harness);
    await withSlack(harness, ids.agentId);
    // A note goes through a channel that holds its credential and knows the manager.
    await harness.run(async (ctx) => {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Slack bot token',
        source: 'entered',
        createdAt: 1,
      });
      const slack = await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', ids.agentId))
        .filter((q) => q.eq(q.field('slug'), 'slack'))
        .first();
      if (slack === null) throw new Error('no Slack card');
      await ctx.db.patch(slack._id, { credentialId, managerUserId: 'UMANAGER' });
    });
    const output = {
      draft: 'Commented on REVOPS-1.',
      notes: '',
      actions: [comment, dm('Commented the audit note on REVOPS-1.')],
    };
    await harness.mutation(internal.workRuns.setActionsPending, {
      workItemId: ids.workItemId,
      runId: ids.runId,
      output,
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

    await harness.mutation(internal.workRuns.setCompleted, {
      workItemId: ids.workItemId,
      output: {
        ...output,
        applied: [
          { tool: 'mcp.call', ok: true, effect: 'comment on REVOPS-1' },
          { tool: 'http.request', ok: true, effect: 'message in D0MANAGER' },
        ],
      },
    });

    const notes = await harness.run(async (ctx) => await ctx.db.query('managerNotes').collect());
    const landed = notes.find((note) => note.kind === 'landed');
    expect(landed?.text).toContain(': 2 changes landed.');
    expect(landed?.text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
  });

  it('leaves out a manager DM the gate applied on its own, on a row with no verdicts, as before (W13V-6)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const ids = await seed(harness);
    await withSlack(harness, ids.agentId);
    // A note goes through a channel that holds its credential and knows the manager.
    await harness.run(async (ctx) => {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Slack bot token',
        source: 'entered',
        createdAt: 1,
      });
      const slack = await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', ids.agentId))
        .filter((q) => q.eq(q.field('slug'), 'slack'))
        .first();
      if (slack === null) throw new Error('no Slack card');
      await ctx.db.patch(slack._id, { credentialId, managerUserId: 'UMANAGER' });
    });
    const actions = [comment, dm('Commented the audit note on REVOPS-1.')];
    // The run's own output on the row, as a run that applied its set with no hold leaves it.
    await harness.run(async (ctx) => {
      await ctx.db.patch(ids.workItemId, { output: { draft: '', notes: '', actions } });
    });
    await harness.mutation(internal.workRuns.setCompleted, {
      workItemId: ids.workItemId,
      output: {
        draft: 'Commented on REVOPS-1.',
        notes: '',
        actions: [comment, dm('Commented the audit note on REVOPS-1.')],
        applied: [
          { tool: 'mcp.call', ok: true, effect: 'comment on REVOPS-1' },
          { tool: 'http.request', ok: true, effect: 'message in D0MANAGER' },
        ],
      },
    });

    const notes = await harness.run(async (ctx) => await ctx.db.query('managerNotes').collect());
    expect(notes.find((note) => note.kind === 'landed')?.text).toContain(': 1 change landed.');
  });

  it('lets a DM that reports nothing of the set go on its own, as before', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const ids = await seed(harness);
    await withSlack(harness, ids.agentId);
    await harness.mutation(internal.workRuns.setActionsPending, {
      workItemId: ids.workItemId,
      runId: ids.runId,
      output: {
        draft: 'Asked the manager.',
        notes: '',
        actions: [comment, dm('Which project should the audit note name?')],
      },
    });
    const row = await readItem(harness, ids.workItemId);
    expect(row.actionVerdicts?.[1]).toEqual({ disposition: 'auto' });
  });
});

describe('a Retry after the documentation a plan cited changed (14-R’s gone cite, ruled 8 October)', (): void => {
  const goneReason = goneCitesReason(['Handbook/runbook.md#Runbook > Closing']);

  /** A failed real-mode item the evaluation claimed, its plan's cite gone, stopped or failed as given. */
  async function goneCiteItem(
    harness: Harness,
    skipReason: string,
    output?: unknown,
  ): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
    const { agentId, workItemId } = await seed(harness, 'failed');
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        verdict: { decision: 'claim', reason: 'Linear work in scope.' },
        skipReason,
        ...(output === undefined ? {} : { output }),
      });
    });
    return { agentId, workItemId };
  }

  it('sends an item stopped before its first write back to drafting with its own event, never to the same plan', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await goneCiteItem(harness, `${STOPPED_PREFIX}${goneReason}`);

    const answer = await harness
      .withIdentity(OWNER)
      .mutation(api.workRuns.retryFailed, { workItemId });

    expect(answer).toEqual({ ok: true, resumeState: 'claimed' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('claimed');
    expect(row.plan).toBeUndefined();
    expect(row.skipReason).toBeUndefined();
    const redrafts = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .filter((q) => q.eq(q.field('type'), 'work.plan-redraft'))
          .collect(),
    );
    expect(redrafts.map((event) => event.payload)).toEqual([{ workItemId, reason: goneReason }]);
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(scheduled.map((job) => job.name)).toContain('workActions:draftPlanInternal');
    expect(scheduled.map((job) => job.name)).not.toContain(
      'workActions:executeApprovedPlanInternal',
    );
  });

  it('redrafts an item whose closing check failed and keeps the writes its first phase landed', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await goneCiteItem(harness, goneReason, {
      draft: 'Commented on REVOPS-1.',
      notes: '',
      actions: [comment],
      applied: [landedComment],
    });
    // A run that landed a write is confirmed on the provider before any Retry (U17 D1).
    await harness
      .withIdentity(OWNER)
      .mutation(api.workRuns.reconcileFailed, { workItemId, confirmed: true });

    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('claimed');
    expect(row.plan).toBeUndefined();
    expect(landedWritesOf(row.output).map((write) => write.applied.providerId)).toEqual([
      'comment-1',
    ]);
  });

  it('leaves no closing resume of the old plan on the row it redrafts, only the writes that landed (second pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    // A resumed closing phase met the changed cite: its output still names the old plan's closing.
    const failedOutput = {
      phase: 'dependent-authoring',
      resumedClosing: true,
      draft: '',
      notes: '',
      initial: {
        draft: 'Commented on REVOPS-1.',
        notes: '',
        actions: [comment],
        applied: [landedComment],
      },
    };
    expect(landedWritesOf(failedOutput).map((write) => write.applied.providerId)).toEqual([
      'comment-1',
    ]);
    const { workItemId } = await goneCiteItem(harness, goneReason, failedOutput);
    await harness
      .withIdentity(OWNER)
      .mutation(api.workRuns.reconcileFailed, { workItemId, confirmed: true });

    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('claimed');
    const output = row.output as Record<string, unknown>;
    expect(output.resumedClosing).toBeUndefined();
    expect(output.phase).toBeUndefined();
    expect(output.initial).toBeUndefined();
    expect(landedWritesOf(row.output).map((write) => write.applied.providerId)).toEqual([
      'comment-1',
    ]);
  });

  it('still retries any other failure on the plan the manager approved', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await goneCiteItem(harness, 'the Linear MCP timed out');

    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('plan-approved');
    expect(row.plan).toBeDefined();
    const types = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect()
      ).map((event) => event.type),
    );
    expect(types).not.toContain('work.plan-redraft');
  });
});
