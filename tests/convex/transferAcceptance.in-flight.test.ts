import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type schema from '../../convex/schema';
import { HANDOVER_IN_PROGRESS_REASON, HANDOVER_STOP_REASON } from '../../convex/transferInFlight';
import { HANDED_OVER_REQUEST_REASON } from '../../convex/work';
import { HANDOVER_SESSION_FAILURE } from '../../convex/voice';
import { TRANSFER_SETTLE_MS, transferExpiresAt } from '../../src/agent/manager-transfer';
import { STOPPED_PREFIX } from '../../src/work/stop';
import { runThroughBody } from '../fixtures/run-through-charter-2026-09-14';
import { MANAGER_ADDRESS, fixtureAddressOf, managerIdentity } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/*
 * Work in flight at the moment a handover is accepted (the transfer plan, section 6.4, every
 * row of its table; section 14.1 items 5 and 6; U-2). The model and the providers are not
 * involved: each run is seeded in the state the loop would leave it in, and each path out of it
 * is the loop's own mutation.
 */

type Harness = TestConvex<typeof schema>;

/** The asking manager. */
const OWNER = managerIdentity();

/** The account the handover names. */
const COLLEAGUE = managerIdentity('colleague');

/** When the colleague accepts, in every test that fixes the clock. */
const ACCEPTED_AT = Date.UTC(2026, 9, 1, 9, 0);

/** One owner's employee with a handover asked of the colleague. */
interface Handover {
  readonly harness: Harness;
  readonly maya: Id<'agents'>;
  readonly skillId: Id<'skills'>;
  readonly transferId: Id<'managerTransfers'>;
}

/** A harness whose modules resolved the surface mode the enclosing block's `beforeEach` set. */
async function modeHarness(): Promise<Harness> {
  const [{ default: modeSchema }, { allConvexModules }] = await Promise.all([
    import('../../convex/schema'),
    import('./all-modules'),
  ]);
  return convexTest(modeSchema, allConvexModules());
}

/**
 * Seed Maya, the owner's employee, with an approved charter (unless the state says she has
 * none), a registered skill and a handover asked of the colleague.
 */
async function seedHandover(
  state: Doc<'agents'>['state'] = 'active',
  agentFields: Partial<Doc<'agents'>> = {},
): Promise<Handover> {
  const harness = await modeHarness();
  const seeded = await harness.run(async (ctx) => {
    const maya = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Maya',
      userId: 'owner',
      state,
      createdAt: 1,
      ...agentFields,
    });
    if (state === 'active') {
      await ctx.db.insert('charters', {
        agentId: maya,
        version: '0.1',
        body: runThroughBody(),
        approved: true,
        approvedAt: 2,
        createdAt: 2,
      });
    }
    const skillId = await ctx.db.insert('skills', {
      agentId: maya,
      name: 'close-linear-ticket',
      description: 'Close a Linear ticket.',
      body: 'Close the ticket with a comment.',
      sourceType: 'agent-authored',
      state: 'registered',
      createdAt: 1,
      registeredAt: 2,
    });
    const transferId = await ctx.db.insert('managerTransfers', {
      agentId: maya,
      agentName: 'Maya',
      fromOwnerKey: 'owner',
      fromAddress: MANAGER_ADDRESS,
      toAddress: fixtureAddressOf('colleague'),
      state: 'asked',
      requestedAt: Date.now(),
      expiresAt: transferExpiresAt(Date.now()),
    });
    return { maya, skillId, transferId };
  });
  return { harness, ...seeded };
}

/** Seed one work item of Maya's in a state, with the fields that state carries. */
async function seedItem(
  handover: Handover,
  externalId: string,
  state: Doc<'workItems'>['state'],
  fields: Partial<Doc<'workItems'>> = {},
): Promise<Id<'workItems'>> {
  return await handover.harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId: handover.maya,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId,
        externalClaimKey: `linear:${externalId}`,
        title: `Close ${externalId}`,
        contentSummary: `Close ${externalId}`,
        contentRefs: [],
        observedAt: 1,
        createdAt: 1,
        state,
        ...fields,
      }),
  );
}

/** A run's claim event, as `claimForExecution` writes it: the run id the loop fences on. */
async function seedRunClaim(
  handover: Handover,
  workItemId: Id<'workItems'>,
): Promise<Id<'events'>> {
  return await handover.harness.run(
    async (ctx) =>
      await ctx.db.insert('events', {
        agentId: handover.maya,
        type: 'work.execution-claimed',
        payload: { workItemId, skillId: handover.skillId },
        createdAt: Date.now(),
      }),
  );
}

/** Seed an item whose skill is running: `executing`, holding its run. */
async function seedExecuting(
  handover: Handover,
  externalId: string,
): Promise<{ readonly workItemId: Id<'workItems'>; readonly runId: Id<'events'> }> {
  const workItemId = await seedItem(handover, externalId, 'executing', {
    plan: { steps: ['Close it'] },
    skillId: handover.skillId,
  });
  const runId = await seedRunClaim(handover, workItemId);
  await handover.harness.run(async (ctx) => {
    await ctx.db.patch(workItemId, { executionRunId: runId });
  });
  return { workItemId, runId };
}

/** The held write a run parked for the manager. */
const HELD_OUTPUT = {
  draft: 'Closed.',
  notes: '',
  actions: [
    { tool: 'ticket.update', args: { slug: 'ticket-1', status: 'done', comment: 'Done.' } },
  ],
};

/** Seed an item whose run parked one action for the manager's approval. */
async function seedHeld(
  handover: Handover,
  externalId: string,
): Promise<{ readonly workItemId: Id<'workItems'>; readonly pendingRunId: Id<'events'> }> {
  const workItemId = await seedItem(handover, externalId, 'actions-pending', {
    skillId: handover.skillId,
    output: HELD_OUTPUT,
    actionVerdicts: [{ disposition: 'held', reason: 'held for the manager' }],
  });
  const pendingRunId = await seedRunClaim(handover, workItemId);
  await handover.harness.run(async (ctx) => {
    await ctx.db.patch(workItemId, { executionRunId: pendingRunId, pendingRunId });
  });
  return { workItemId, pendingRunId };
}

/** Accept the handover as the colleague. */
async function accept(
  handover: Handover,
  args: { zone?: string } = {},
): Promise<{ agentId: Id<'agents'>; state: 'accepted' | 'accepting' }> {
  return await handover.harness
    .withIdentity(COLLEAGUE)
    .mutation(api.transferAcceptance.accept, { transferId: handover.transferId, ...args });
}

/** Run every job the test's mutations scheduled, to the end. */
async function drain(harness: Harness): Promise<void> {
  await harness.finishAllScheduledFunctions(vi.runAllTimers);
}

/** Read one row back. */
async function read<Table extends 'agents' | 'managerTransfers' | 'workItems' | 'voiceSessions'>(
  harness: Harness,
  id: Id<Table>,
): Promise<Doc<Table>> {
  const row = await harness.run(async (ctx) => (await ctx.db.get(id)) as Doc<Table> | null);
  if (row === null) throw new Error(`row ${id} is gone`);
  return row;
}

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

describe('accept with a run in flight: the request waits in accepting (transfer plan 6.4, D18)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('mock');
    vi.useFakeTimers();
    vi.setSystemTime(ACCEPTED_AT);
  });

  it('enters accepting with the stamp, the deadline and the acceptor’s choices, and moves nothing yet', async (): Promise<void> => {
    const handover = await seedHandover();
    await seedExecuting(handover, 'REVOPS-1');

    const answer = await accept(handover, { zone: 'Asia/Singapore' });

    expect(answer).toEqual({ agentId: handover.maya, state: 'accepting' });
    expect(await read(handover.harness, handover.transferId)).toMatchObject({
      state: 'accepting',
      decidedAt: ACCEPTED_AT,
      toOwnerKey: 'colleague',
      toZone: 'Asia/Singapore',
      toExcludedDocSourceIds: [],
      settleBy: ACCEPTED_AT + TRANSFER_SETTLE_MS,
    });
    expect((await read(handover.harness, handover.transferId)).outcome).toBeUndefined();
    expect(await read(handover.harness, handover.maya)).toMatchObject({ userId: 'owner' });
  });

  it('moves at once, in the acceptance, when nothing is executing', async (): Promise<void> => {
    const handover = await seedHandover();

    const answer = await accept(handover);

    expect(answer).toEqual({ agentId: handover.maya, state: 'accepted' });
    expect(await read(handover.harness, handover.maya)).toMatchObject({ userId: 'colleague' });
  });

  it('starts no new run while accepting: the claim refuses and the plan stays approved', async (): Promise<void> => {
    const handover = await seedHandover();
    await seedExecuting(handover, 'REVOPS-1');
    const approved = await seedItem(handover, 'REVOPS-2', 'plan-approved', {
      plan: { steps: ['Close it'] },
    });
    await accept(handover);

    const claim = await handover.harness.mutation(internal.work.claimForExecution, {
      workItemId: approved,
      skillId: handover.skillId,
    });

    expect(claim).toEqual({ claimed: false, reason: HANDOVER_IN_PROGRESS_REASON });
    expect(await read(handover.harness, approved)).toMatchObject({ state: 'plan-approved' });
  });

  it('keeps an approval given during accepting from starting its apply', async (): Promise<void> => {
    const handover = await seedHandover();
    await seedExecuting(handover, 'REVOPS-1');
    const { workItemId, pendingRunId } = await seedHeld(handover, 'REVOPS-2');
    await accept(handover);
    await handover.harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId,
      approvedIndexes: [0],
    });

    const claim = await handover.harness.mutation(internal.work.claimApprovedActions, {
      workItemId,
    });

    expect(claim).toEqual({ claimed: false, reason: HANDOVER_IN_PROGRESS_REASON });
    expect(await read(handover.harness, workItemId)).toMatchObject({
      state: 'actions-pending',
      approvedIndexes: [0],
    });
  });

  it('lets the auto phase of a run already executing apply: the run is in flight, not new', async (): Promise<void> => {
    const handover = await seedHandover();
    const { workItemId, runId } = await seedExecuting(handover, 'REVOPS-1');
    await handover.harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        output: HELD_OUTPUT,
        pendingRunId: runId,
        approvedIndexes: [0],
        applyPhase: 'auto',
        actionVerdicts: [{ disposition: 'auto' }],
      });
    });
    await accept(handover);

    const claim = await handover.harness.mutation(internal.work.claimApprovedActions, {
      workItemId,
    });

    expect(claim).toMatchObject({ claimed: true, phase: 'auto' });
  });

  it('moves the employee when its last run fails, keeping the acceptance’s stamp (14.1 item 5)', async (): Promise<void> => {
    const handover = await seedHandover();
    const { workItemId, runId } = await seedExecuting(handover, 'REVOPS-1');
    await accept(handover);
    vi.setSystemTime(ACCEPTED_AT + 4 * 60_000);

    await handover.harness.mutation(internal.work.setFailed, {
      workItemId,
      runId,
      reason: 'the provider refused',
    });
    await drain(handover.harness);

    expect(await read(handover.harness, handover.transferId)).toMatchObject({
      state: 'accepted',
      decidedAt: ACCEPTED_AT,
      toOwnerKey: 'colleague',
      outcome: { runsStopped: 0 },
    });
    expect(await read(handover.harness, handover.maya)).toMatchObject({ userId: 'colleague' });
  });

  it('moves the employee when its last run completes', async (): Promise<void> => {
    const handover = await seedHandover();
    const { workItemId, runId } = await seedExecuting(handover, 'REVOPS-1');
    await accept(handover);

    await handover.harness.mutation(internal.work.setCompleted, {
      workItemId,
      runId,
      output: { applied: [{ tool: 'ticket.update', ok: true }] },
    });
    await drain(handover.harness);

    expect(await read(handover.harness, handover.transferId)).toMatchObject({ state: 'accepted' });
    expect(await read(handover.harness, handover.maya)).toMatchObject({ userId: 'colleague' });
  });

  it('moves the employee when its last run parks its actions for the manager, and holds them for the new one', async (): Promise<void> => {
    const handover = await seedHandover();
    const { workItemId, runId } = await seedExecuting(handover, 'REVOPS-1');
    await accept(handover);

    await handover.harness.mutation(internal.work.setActionsPending, {
      workItemId,
      runId,
      output: HELD_OUTPUT,
    });
    await drain(handover.harness);

    expect(await read(handover.harness, handover.maya)).toMatchObject({ userId: 'colleague' });
    expect(await read(handover.harness, workItemId)).toMatchObject({ state: 'actions-pending' });
    expect((await read(handover.harness, workItemId)).approvedIndexes).toBeUndefined();
  });

  it('waits while another run is still executing, then moves when that one ends too', async (): Promise<void> => {
    const handover = await seedHandover();
    const first = await seedExecuting(handover, 'REVOPS-1');
    const second = await seedExecuting(handover, 'REVOPS-2');
    await accept(handover);

    await handover.harness.mutation(internal.work.setFailed, {
      workItemId: first.workItemId,
      runId: first.runId,
      reason: 'the provider refused',
    });
    await drain(handover.harness);
    expect(await read(handover.harness, handover.transferId)).toMatchObject({ state: 'accepting' });

    await handover.harness.mutation(internal.work.setFailed, {
      workItemId: second.workItemId,
      runId: second.runId,
      reason: 'the provider refused',
    });
    await drain(handover.harness);
    expect(await read(handover.harness, handover.transferId)).toMatchObject({ state: 'accepted' });
  });

  it('stops a run that outlives the deadline at the sweep, then moves (14.1 item 5)', async (): Promise<void> => {
    const handover = await seedHandover();
    const { workItemId } = await seedExecuting(handover, 'REVOPS-1');
    await accept(handover);
    vi.setSystemTime(ACCEPTED_AT + TRANSFER_SETTLE_MS - 1);
    await handover.harness.mutation(internal.transferAcceptance.settleDue, {});
    await drain(handover.harness);
    expect(await read(handover.harness, handover.transferId)).toMatchObject({ state: 'accepting' });

    vi.setSystemTime(ACCEPTED_AT + TRANSFER_SETTLE_MS);
    await handover.harness.mutation(internal.transferAcceptance.settleDue, {});
    await drain(handover.harness);

    expect(await read(handover.harness, workItemId)).toMatchObject({
      state: 'failed',
      skipReason: `${STOPPED_PREFIX}${HANDOVER_STOP_REASON}`,
    });
    expect((await read(handover.harness, workItemId)).executionRunId).toBeUndefined();
    expect(await read(handover.harness, handover.transferId)).toMatchObject({
      state: 'accepted',
      decidedAt: ACCEPTED_AT,
      outcome: { runsStopped: 1 },
    });
    expect(await read(handover.harness, handover.maya)).toMatchObject({ userId: 'colleague' });
  });

  it('moves a finishing request whose runs ended by a path that scheduled no settle, at the next sweep', async (): Promise<void> => {
    const handover = await seedHandover();
    const { workItemId } = await seedExecuting(handover, 'REVOPS-1');
    await accept(handover);
    // A run returned to its approved plan to be resumed (`resumeExecution`) is no longer in flight.
    await handover.harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, { state: 'plan-approved', executionRunId: undefined });
    });

    await handover.harness.mutation(internal.transferAcceptance.settleDue, {});
    await drain(handover.harness);

    expect(await read(handover.harness, handover.transferId)).toMatchObject({ state: 'accepted' });
    expect(await read(handover.harness, workItemId)).toMatchObject({ state: 'plan-pending' });
  });

  it('ends a finishing request whose employee is gone rather than retrying it at every sweep', async (): Promise<void> => {
    const handover = await seedHandover();
    await seedExecuting(handover, 'REVOPS-1');
    await accept(handover);
    await handover.harness.run(async (ctx) => {
      await ctx.db.delete(handover.maya);
    });

    await handover.harness.mutation(internal.transferAcceptance.settle, {
      transferId: handover.transferId,
    });
    const ended = await read(handover.harness, handover.transferId);
    await handover.harness.mutation(internal.transferAcceptance.settleDue, {});
    await drain(handover.harness);

    expect(ended).toMatchObject({ state: 'cancelled', decidedAt: ACCEPTED_AT });
    expect(ended.outcome).toBeUndefined();
    expect(await read(handover.harness, handover.transferId)).toEqual(ended);
  });

  it('refuses before entering accepting when the move it waits for would be refused', async (): Promise<void> => {
    const handover = await seedHandover('charter-pending');
    await seedExecuting(handover, 'REVOPS-1');
    await handover.harness.run(async (ctx) => {
      for (let version = 0; version <= 100; version += 1) {
        await ctx.db.insert('charters', {
          agentId: handover.maya,
          version: `0.${version}`,
          body: runThroughBody(),
          approved: false,
          createdAt: 2,
        });
      }
    });

    await expect(accept(handover)).rejects.toMatchObject({
      data: 'This employee has more than 100 draft charters, more than one handover can discard.',
    });
    expect(await read(handover.harness, handover.transferId)).toMatchObject({ state: 'asked' });
  });

  it('settles nothing for a request no longer accepting', async (): Promise<void> => {
    const handover = await seedHandover();
    await accept(handover);
    const accepted = await read(handover.harness, handover.transferId);

    await handover.harness.mutation(internal.transferAcceptance.settle, {
      transferId: handover.transferId,
    });

    expect(await read(handover.harness, handover.transferId)).toEqual(accepted);
  });
});

describe('a stopped run’s late writes after the move (U-2)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.setSystemTime(ACCEPTED_AT);
  });

  /** Accept with one run mid-apply, then pass the deadline and let the sweep stop it and move. */
  async function stopMidApply(): Promise<{
    readonly handover: Handover;
    readonly workItemId: Id<'workItems'>;
    readonly runId: Id<'events'>;
    readonly applyAttemptId: Id<'events'>;
  }> {
    const handover = await seedHandover();
    const { workItemId, runId } = await seedExecuting(handover, 'REVOPS-1');
    const applyAttemptId = await handover.harness.run(async (ctx) => {
      const attempt = await ctx.db.insert('events', {
        agentId: handover.maya,
        type: 'work.actions-applying',
        payload: { workItemId, runId, phase: 'auto' },
        createdAt: Date.now(),
      });
      await ctx.db.patch(workItemId, {
        output: HELD_OUTPUT,
        pendingRunId: runId,
        approvedIndexes: [0],
        applyPhase: 'auto',
        actionVerdicts: [{ disposition: 'auto' }],
        applyAttemptId: attempt,
        applyClaimedAt: Date.now(),
      });
      return attempt;
    });
    await accept(handover);
    vi.setSystemTime(ACCEPTED_AT + TRANSFER_SETTLE_MS);
    await handover.harness.mutation(internal.transferAcceptance.settleDue, {});
    await drain(handover.harness);
    return { handover, workItemId, runId, applyAttemptId };
  }

  /** The item and its record, to compare before and after a late write. */
  async function snapshot(
    handover: Handover,
    workItemId: Id<'workItems'>,
  ): Promise<{ item: Doc<'workItems'>; events: number; claims: number }> {
    return await handover.harness.run(async (ctx) => ({
      item: (await ctx.db.get(workItemId)) as Doc<'workItems'>,
      events: (
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', handover.maya))
          .collect()
      ).length,
      claims: (await ctx.db.query('externalClaims').collect()).length,
    }));
  }

  it('stops the apply under way as an interrupted apply, under the new owner', async (): Promise<void> => {
    const { handover, workItemId } = await stopMidApply();

    const item = await read(handover.harness, workItemId);
    expect(item.state).toBe('failed');
    expect(item.skipReason).toContain(HANDOVER_STOP_REASON);
    expect(item.applyAttemptId).toBeUndefined();
    expect(item.executionRunId).toBeUndefined();
    expect(await read(handover.harness, handover.maya)).toMatchObject({ userId: 'colleague' });
  });

  it('writes nothing when the run’s next mutation arrives after the move', async (): Promise<void> => {
    const { handover, workItemId, runId, applyAttemptId } = await stopMidApply();
    const before = await snapshot(handover, workItemId);
    const output = { ...HELD_OUTPUT, applied: [{ tool: 'ticket.update', ok: true }] };

    await expect(
      handover.harness.mutation(internal.work.setCompleted, { workItemId, runId, output }),
    ).rejects.toThrow('execution run changed before completion');
    await expect(
      handover.harness.mutation(internal.work.setAwaitingApproval, {
        workItemId,
        runId,
        applyAttemptId,
        output,
      }),
    ).resolves.toEqual({ parked: false });
    await expect(
      handover.harness.mutation(internal.work.setActionsPending, { workItemId, runId, output }),
    ).resolves.toEqual({ pending: false });
    await expect(
      handover.harness.mutation(internal.work.prepareDependentPhase, {
        workItemId,
        runId,
        applyAttemptId,
        output: { phase: 'dependent-authoring', actions: [], applied: [] },
      }),
    ).resolves.toEqual({ prepared: false });
    await handover.harness.mutation(internal.work.setFailed, {
      workItemId,
      runId,
      reason: 'late failure',
    });
    await expect(
      handover.harness.mutation(internal.work.recoverInterruptedApply, {
        workItemId,
        pendingRunId: runId,
        phase: 'auto',
      }),
    ).resolves.toEqual({ recovered: 'ignored' });
    await drain(handover.harness);

    expect(await snapshot(handover, workItemId)).toEqual(before);
  });
});

describe('what the move does with each kind of work (transfer plan 6.4, the table)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('mock');
    vi.useFakeTimers();
    vi.setSystemTime(ACCEPTED_AT);
  });

  it('returns an approved plan not yet started to plan-pending for the new manager (D13)', async (): Promise<void> => {
    const handover = await seedHandover();
    const approved = await seedItem(handover, 'REVOPS-1', 'plan-approved', {
      plan: { steps: ['Close it'] },
    });

    await accept(handover);

    const item = await read(handover.harness, approved);
    expect(item.state).toBe('plan-pending');
    expect(item.planPendingAt).toBe(ACCEPTED_AT);
    expect(item.decision).toBeUndefined();
    expect((await read(handover.harness, handover.transferId)).outcome).toMatchObject({
      plansReturned: 1,
    });
    const held = await handover.harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', handover.maya))
          .filter((q) => q.eq(q.field('type'), 'work.plan-held'))
          .collect(),
    );
    expect(held.map((event) => event.payload)).toEqual([
      { workItemId: approved, reason: 'approved-by-predecessor' },
    ]);
    await handover.harness
      .withIdentity(COLLEAGUE)
      .mutation(api.work.approvePlan, { workItemId: approved });
    expect(await read(handover.harness, approved)).toMatchObject({ state: 'plan-approved' });
  });

  it('returns a held set approved during accepting, whose apply the gate kept from starting, to held (D13)', async (): Promise<void> => {
    const handover = await seedHandover();
    const run = await seedExecuting(handover, 'REVOPS-1');
    const { workItemId, pendingRunId } = await seedHeld(handover, 'REVOPS-2');
    await accept(handover);
    await handover.harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId,
      approvedIndexes: [0],
    });

    await handover.harness.mutation(internal.work.setFailed, {
      workItemId: run.workItemId,
      runId: run.runId,
      reason: 'the provider refused',
    });
    await drain(handover.harness);

    const item = await read(handover.harness, workItemId);
    expect(item).toMatchObject({ state: 'actions-pending', pendingRunId });
    expect(item.approvedIndexes).toBeUndefined();
    expect(item.applyPhase).toBeUndefined();
    expect(item.decision).toBeUndefined();
    expect((await read(handover.harness, handover.transferId)).outcome).toMatchObject({
      plansReturned: 1,
    });
    await handover.harness.withIdentity(COLLEAGUE).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId,
      approvedIndexes: [0],
    });
    expect(await read(handover.harness, workItemId)).toMatchObject({ approvedIndexes: [0] });
  });

  it('moves a held set as it is, for the new manager to decide', async (): Promise<void> => {
    const handover = await seedHandover();
    const { workItemId, pendingRunId } = await seedHeld(handover, 'REVOPS-1');

    await accept(handover);

    expect(await read(handover.harness, workItemId)).toMatchObject({
      state: 'actions-pending',
      pendingRunId,
    });
    await expect(
      handover.harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId,
        approvedIndexes: [0],
      }),
    ).rejects.toThrow();
  });

  it('moves parked, stopped, claimed and discovered work, and the record, as they are', async (): Promise<void> => {
    const handover = await seedHandover();
    const seeded = await Promise.all(
      (
        [
          [
            'REVOPS-1',
            'deferred',
            { verdict: { decision: 'defer', reason: 'awaiting-permission' } },
          ],
          ['REVOPS-2', 'needs-skill', {}],
          ['REVOPS-3', 'failed', { skipReason: `${STOPPED_PREFIX}nothing landed` }],
          ['REVOPS-4', 'claimed', {}],
          ['REVOPS-5', 'discovered', {}],
          ['REVOPS-6', 'completed', {}],
          ['REVOPS-7', 'cancelled', {}],
          ['REVOPS-8', 'skipped', { skipReason: 'out of scope' }],
          ['REVOPS-9', 'failed', { skipReason: 'rejected by the manager' }],
        ] as const
      ).map(async ([externalId, state, fields]) => ({
        state,
        id: await seedItem(handover, externalId, state, fields),
      })),
    );

    await accept(handover);

    for (const { id, state } of seeded) {
      expect(await read(handover.harness, id)).toMatchObject({ agentId: handover.maya, state });
    }
  });

  it('fails a one-to-one under way with “the manager changed” and sets its words aside', async (): Promise<void> => {
    const handover = await seedHandover('day-one-in-progress');
    const sessionId = await handover.harness.run(
      async (ctx) =>
        await ctx.db.insert('voiceSessions', {
          agentId: handover.maya,
          mode: 'chat',
          state: 'active',
          answers: { role: 'RevOps' },
          turns: [
            {
              id: 'turn-1',
              speaker: 'manager',
              text: 'OWNER-WORDS: Maya closes the RevOps queue.',
              at: 1,
            },
          ],
          replyDraft: 'OWNER-DRAFT',
          startedAt: 1,
        }),
    );

    await accept(handover);

    const session = await read(handover.harness, sessionId);
    expect(session).toMatchObject({
      state: 'failed',
      finalisationError: HANDOVER_SESSION_FAILURE,
      answers: {},
    });
    expect(session.turns).toBeUndefined();
    expect(session.replyDraft).toBeUndefined();
    expect(await read(handover.harness, handover.maya)).toMatchObject({ state: 'deployed' });
    expect((await read(handover.harness, handover.transferId)).outcome).toMatchObject({
      sessionsFailed: 1,
    });
  });

  it('lets the new manager hold their own one-to-one in a new session', async (): Promise<void> => {
    const handover = await seedHandover('day-one-in-progress');
    const old = await handover.harness.run(
      async (ctx) =>
        await ctx.db.insert('voiceSessions', {
          agentId: handover.maya,
          mode: 'chat',
          state: 'active',
          answers: {},
          startedAt: 1,
        }),
    );
    await accept(handover);

    const started = await handover.harness
      .withIdentity(COLLEAGUE)
      .mutation(api.voice.start, { agentId: handover.maya, mode: 'chat' });

    expect(started.sessionId).not.toBe(old);
    expect(started).toMatchObject({ resumed: false, turns: [] });
    expect(await read(handover.harness, started.sessionId)).toMatchObject({ state: 'active' });
  });

  it('discards a draft charter never approved and returns the employee to deployed (D8)', async (): Promise<void> => {
    const handover = await seedHandover('charter-pending');
    const draft = await handover.harness.run(async (ctx) => {
      const charterId = await ctx.db.insert('charters', {
        agentId: handover.maya,
        version: '0.1',
        body: runThroughBody(),
        approved: false,
        createdAt: 2,
      });
      await ctx.db.insert('voiceSessions', {
        agentId: handover.maya,
        mode: 'chat',
        state: 'done',
        answers: { role: 'RevOps' },
        transcriptText: 'OWNER-WORDS: the whole one-to-one.',
        charterId,
        charterVersion: '0.1',
        startedAt: 1,
        endedAt: 2,
      });
      for (const fileName of ['IDENTITY.md', 'TOOLS.md', 'USER.md', 'SOUL.md']) {
        await ctx.db.insert('workspace', {
          agentId: handover.maya,
          fileName,
          content: `# ${fileName}\n\nOWNER-WORDS\n`,
          updatedAt: 2,
        });
      }
      return charterId;
    });

    await accept(handover);

    const left = await handover.harness.run(async (ctx) => ({
      charter: await ctx.db.get(draft),
      files: (
        await ctx.db
          .query('workspace')
          .withIndex('by_agent_file', (q) => q.eq('agentId', handover.maya))
          .collect()
      ).map((file) => file.fileName),
      sessions: await ctx.db
        .query('voiceSessions')
        .withIndex('by_agent', (q) => q.eq('agentId', handover.maya))
        .collect(),
    }));
    expect(left.charter).toBeNull();
    expect(left.files).toEqual(['SOUL.md']);
    expect(left.sessions).toHaveLength(1);
    expect(left.sessions[0]?.transcriptText).toBeUndefined();
    expect(left.sessions[0]?.charterId).toBeUndefined();
    expect(left.sessions[0]?.state).toBe('failed');
    expect(await read(handover.harness, handover.maya)).toMatchObject({ state: 'deployed' });
    expect((await read(handover.harness, handover.transferId)).outcome).toMatchObject({
      charterDiscarded: true,
      sessionsFailed: 0,
    });
    const recorded = await handover.harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', handover.maya))
          .filter((q) => q.eq(q.field('type'), 'manager.transferred'))
          .first(),
    );
    expect(recorded?.payload).toMatchObject({ charterDiscarded: true });
  });

  it('carries an approved charter as it is', async (): Promise<void> => {
    const handover = await seedHandover();

    await accept(handover);

    const charters = await handover.harness.run(
      async (ctx) =>
        await ctx.db
          .query('charters')
          .withIndex('by_agent', (q) => q.eq('agentId', handover.maya))
          .collect(),
    );
    expect(charters).toMatchObject([{ version: '0.1', approved: true }]);
    expect(await read(handover.harness, handover.maya)).toMatchObject({ state: 'active' });
    expect((await read(handover.harness, handover.transferId)).outcome).toMatchObject({
      charterDiscarded: false,
    });
  });

  it('lets a skill authoring run finish under its fence, its approval the new manager’s', async (): Promise<void> => {
    const handover = await seedHandover();
    const authoring = await handover.harness.run(async (ctx) => {
      const runId = await ctx.db.insert('events', {
        agentId: handover.maya,
        type: 'skill.authoring-claimed',
        payload: {},
        createdAt: Date.now(),
      });
      const skillId = await ctx.db.insert('skills', {
        agentId: handover.maya,
        name: 'post-weekly-digest',
        description: 'Post the weekly digest.',
        body: '',
        sourceType: 'agent-authored',
        state: 'proposed',
        authoringRunId: runId,
        authoringClaimedAt: Date.now(),
        createdAt: 1,
      });
      return { skillId, runId };
    });

    await accept(handover);

    expect(
      await handover.harness.run(async (ctx) => await ctx.db.get(authoring.skillId)),
    ).toMatchObject({ state: 'proposed', authoringRunId: authoring.runId });
  });

  it('sets the unsent notes kept for the old manager’s digest aside, and keeps the events they summarise', async (): Promise<void> => {
    const handover = await seedHandover('active', { managerNotifications: 'digest' });
    const workItemId = await seedItem(handover, 'REVOPS-1', 'completed');
    const notes = await handover.harness.run(async (ctx) => {
      const unsent = await ctx.db.insert('managerNotes', {
        agentId: handover.maya,
        workItemId,
        kind: 'landed',
        text: 'Maya closed REVOPS-1.',
        createdAt: 1,
        keptFor: 'digest',
      });
      const sent = await ctx.db.insert('managerNotes', {
        agentId: handover.maya,
        workItemId,
        kind: 'landed',
        text: 'Maya closed REVOPS-0.',
        createdAt: 1,
        claimedAt: 2,
        providerTs: '1.2',
        keptFor: 'digest',
      });
      await ctx.db.insert('events', {
        agentId: handover.maya,
        type: 'work.completed',
        payload: { workItemId },
        createdAt: 1,
      });
      return { unsent, sent };
    });

    await accept(handover);

    const [unsent, sent, candidates] = await handover.harness.run(async (ctx) => [
      await ctx.db.get(notes.unsent),
      await ctx.db.get(notes.sent),
      await ctx.db
        .query('managerNotes')
        .withIndex('by_agent_unsent', (q) =>
          q.eq('agentId', handover.maya).eq('claimedAt', undefined).eq('providerTs', undefined),
        )
        .collect(),
    ]);
    expect(unsent).toMatchObject({ discardedAt: ACCEPTED_AT });
    expect(sent?.discardedAt).toBeUndefined();
    expect(candidates).toEqual([]);
    await expect(
      handover.harness.query(internal.work.digestCandidates, { cursor: null }),
    ).resolves.toMatchObject({ agentIds: [] });
    expect((await read(handover.harness, handover.transferId)).outcome).toMatchObject({
      notesDiscarded: 1,
    });
    const completed = await handover.harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', handover.maya))
          .filter((q) => q.eq(q.field('type'), 'work.completed'))
          .collect(),
    );
    expect(completed).toHaveLength(1);
  });
});

describe('an open decision request by DM at the move (transfer plan 6.4; 14.1 item 6)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.setSystemTime(ACCEPTED_AT);
  });

  /** Maya's Slack surface, connected to the owner's DM, and a plan whose request was delivered there. */
  async function seedDelivered(): Promise<{
    readonly handover: Handover;
    readonly slack: Id<'surfaces'>;
    readonly workItemId: Id<'workItems'>;
  }> {
    const handover = await seedHandover();
    const slack = await handover.harness.run(async (ctx) => {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Slack bot token',
        ciphertext: 'sealed',
        iv: 'iv',
        source: 'entered',
        createdAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId: handover.maya,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        path: 'mcp',
        verdict: 'connected',
        managerApprovedAt: 1,
        credentialId,
        credentialKind: 'value',
        credentialLanded: true,
        providerIdentityId: 'U-BOT',
        managerUserId: 'U-OWNER',
        managerDmChannelId: 'D-OWNER',
        whereFound: [],
        createdAt: 1,
      });
    });
    const workItemId = await seedItem(handover, 'REVOPS-1', 'plan-pending', {
      plan: { steps: ['Close it'] },
      planPendingAt: 1,
      decision: {
        id: 'abc234',
        kind: 'plan',
        requestedAt: 1,
        channel: 'D-OWNER',
        surfaceSlug: 'slack',
        surfaceName: 'Slack',
        ts: '1790000000.000100',
      },
    });
    return { handover, slack, workItemId };
  }

  it('marks the open request failed with the handover’s reason, beside the manager-changed resend', async (): Promise<void> => {
    const { handover, workItemId } = await seedDelivered();

    await accept(handover);

    const item = await read(handover.harness, workItemId);
    expect(item.state).toBe('plan-pending');
    expect(item.decision).toMatchObject({
      id: 'abc234',
      requestFailedAt: ACCEPTED_AT,
      requestFailure: HANDED_OVER_REQUEST_REASON,
    });
    expect(item.decision?.decidedAt).toBeUndefined();
    expect((await read(handover.harness, handover.transferId)).outcome).toMatchObject({
      decisionRequestsVoided: 1,
    });
  });

  it('decides nothing on a reply the old manager sends to it after the move', async (): Promise<void> => {
    const { handover, slack, workItemId } = await seedDelivered();
    await accept(handover);

    const reply = await handover.harness.mutation(internal.work.resolveChannelDecision, {
      surfaceId: slack,
      userId: 'U-OWNER',
      messageTs: String(ACCEPTED_AT / 1_000 + 60),
      reply: { verb: 'approve', id: 'abc234' },
    });

    expect(reply).toMatchObject({ status: 'ignored' });
    const item = await read(handover.harness, workItemId);
    expect(item.state).toBe('plan-pending');
    expect(item.decision?.decidedAt).toBeUndefined();
  });

  it('leaves a request already decided alone', async (): Promise<void> => {
    const { handover, workItemId } = await seedDelivered();
    await handover.harness.run(async (ctx) => {
      const row = await ctx.db.get(workItemId);
      if (!row?.decision) throw new Error('no decision');
      await ctx.db.patch(workItemId, {
        state: 'cancelled',
        decision: { ...row.decision, decidedAt: 5, outcome: 'rejected', decidedVia: 'channel' },
      });
    });

    await accept(handover);

    expect((await read(handover.harness, workItemId)).decision?.requestFailedAt).toBeUndefined();
    expect((await read(handover.harness, handover.transferId)).outcome).toMatchObject({
      decisionRequestsVoided: 0,
    });
  });
});

describe('the stall sweep while a handover is finishing (resumeStalledSteps)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.setSystemTime(ACCEPTED_AT);
  });

  it('resumes nothing for the employee, and still stops its stalled run', async (): Promise<void> => {
    const handover = await seedHandover();
    const stalled = await seedExecuting(handover, 'REVOPS-1');
    await seedItem(handover, 'REVOPS-2', 'plan-approved', { plan: { steps: ['Close it'] } });
    await seedItem(handover, 'REVOPS-3', 'claimed', {});
    await accept(handover);
    vi.setSystemTime(ACCEPTED_AT + 13 * 60_000);

    const swept = await handover.harness.mutation(internal.work.resumeStalledSteps, {});
    await handover.harness.finishInProgressScheduledFunctions();
    vi.runOnlyPendingTimers();
    await handover.harness.finishInProgressScheduledFunctions();

    expect(swept).toEqual({ rescheduled: 1 });
    expect(await read(handover.harness, stalled.workItemId)).toMatchObject({ state: 'failed' });
  });
});
