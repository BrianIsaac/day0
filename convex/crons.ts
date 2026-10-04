import { cronJobs } from 'convex/server';
import type { FunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, type ActionCtx } from './_generated/server';
import { cronsPauseReason } from '../src/lib/crons-pause';
import { log } from '../src/lib/logger';
import { DIGEST_SCHEDULE } from '../src/work/manager-notes';

const intakeInternal = internal as unknown as {
  intakeActions: {
    pollAll: FunctionReference<'action', 'internal', Record<string, never>, unknown>;
    pollDecisions: FunctionReference<'action', 'internal', Record<string, never>, unknown>;
  };
};

/**
 * Every job the deployment schedules for itself, by the function it runs.
 *
 * Each one reads or writes something outside a single request: the intake and
 * decision polls read the connected workspaces, the digests post to them, the
 * sweeps and the sync start work that does both. So every one of them runs
 * through `runScheduledJob`, and a paused deployment starts none of them.
 */
const SCHEDULED_JOBS = {
  'voice:sweepStalledFinalisations': async (ctx: ActionCtx): Promise<unknown> =>
    await ctx.runMutation(internal.voice.sweepStalledFinalisations, {}),
  'docSyncActions:syncAll': async (ctx: ActionCtx): Promise<unknown> =>
    await ctx.runAction(internal.docSyncActions.syncAll, {}),
  'surfaceActions:reprobeAll': async (ctx: ActionCtx): Promise<unknown> =>
    await ctx.runAction(internal.surfaceActions.reprobeAll, {}),
  'intakeActions:pollAll': async (ctx: ActionCtx): Promise<unknown> =>
    await ctx.runAction(intakeInternal.intakeActions.pollAll, {}),
  'work:resumeStalledSteps': async (ctx: ActionCtx): Promise<unknown> =>
    await ctx.runMutation(internal.work.resumeStalledSteps, {}),
  'workLoop:settleLapsedClaims': async (ctx: ActionCtx): Promise<unknown> =>
    await ctx.runMutation(internal.workLoop.settleLapsedClaims, {}),
  'intakeActions:pollDecisions': async (ctx: ActionCtx): Promise<unknown> =>
    await ctx.runAction(intakeInternal.intakeActions.pollDecisions, {}),
  'managerChannelActions:sendManagerDigests': async (ctx: ActionCtx): Promise<unknown> =>
    await ctx.runAction(internal.managerChannelActions.sendManagerDigests, {}),
  'managerTransfers:expireDue': async (ctx: ActionCtx): Promise<unknown> =>
    await ctx.runMutation(internal.managerTransfers.expireDue, {}),
  'transferAcceptance:settleDue': async (ctx: ActionCtx): Promise<unknown> =>
    await ctx.runMutation(internal.transferAcceptance.settleDue, {}),
  'sourceRevocation:expireOverdue': async (ctx: ActionCtx): Promise<unknown> =>
    await ctx.runMutation(internal.sourceRevocation.expireOverdue, {}),
} as const;

/** A job `runScheduledJob` knows, named by the function it runs. */
type ScheduledJob = keyof typeof SCHEDULED_JOBS;

const scheduledJobNames = Object.keys(SCHEDULED_JOBS) as ScheduledJob[];

/**
 * Run one scheduled job, unless the deployment's jobs are paused.
 *
 * Internal: only the cron table below calls it. Paused (`DAY0_CRONS_PAUSED`
 * set, by `./setup.sh pause` or an upgrade), it logs one line and returns
 * before the job reads or writes anything, so the polls' cursors stay where
 * they were and the next run after the pause picks up from them. A work-loop
 * step a job queued before the pause is held too (12-P): every step reads the
 * same switch at its claim (`stepMayRun`), so a queued evaluation, draft,
 * execution or apply starts nothing and its row waits, ready, for the stalled-
 * step sweep's first run after the pause. A step that had already claimed runs
 * to its next claim. The documentation sync's own chain reads it too, at each
 * batch (`docSyncActions.syncBatch`), and goes on from its cursor after.
 */
export const runScheduledJob = internalAction({
  args: { job: v.union(...scheduledJobNames.map((job) => v.literal(job))) },
  handler: async (ctx, { job }): Promise<unknown> => {
    const reason = cronsPauseReason();
    if (reason !== undefined) {
      log.info('scheduled job skipped: crons paused', { job, reason });
      return { paused: reason };
    }
    return await SCHEDULED_JOBS[job](ctx);
  },
});

/**
 * Scheduled maintenance the deployment owes itself.
 *
 * A failed voice finalisation schedules its own retry in the transaction that
 * releases the session, so this is not the ordinary recovery path. It exists
 * for the failure that transaction cannot cover: a finisher whose process died
 * before it could release anything, leaving a claim nobody will ever come back
 * to clear. The interval is well under the lease it is looking for expired
 * claims past.
 */
const crons = cronJobs();

const gate = internal.crons.runScheduledJob;

crons.interval('recover stalled voice finalisations', { minutes: 5 }, gate, {
  job: 'voice:sweepStalledFinalisations',
});

crons.interval('sync documentation sources', { minutes: 15 }, gate, {
  job: 'docSyncActions:syncAll',
});

// Phase 2 Lane B surface maintenance.
crons.interval('re-probe connected surfaces', { hours: 1 }, gate, {
  job: 'surfaceActions:reprobeAll',
});

crons.interval('poll connected surfaces for work', { minutes: 5 }, gate, {
  job: 'intakeActions:pollAll',
});

// With the intake poll: the server-driven work loop's recovery for a step
// that died (real mode only; the mutation returns at once in mock mode).
crons.interval('resume stalled work steps', { minutes: 5 }, gate, {
  job: 'work:resumeStalledSteps',
});

// The lease on the manager channel's sends and edits (N-3, either mode): a claim an action died
// holding is settled as its own failure would have settled it.
crons.interval('settle lapsed manager-channel claims', { minutes: 5 }, gate, {
  job: 'workLoop:settleLapsedClaims',
});

crons.interval('poll manager decision replies', { seconds: 60 }, gate, {
  job: 'intakeActions:pollDecisions',
});

// Every quarter hour on the clock; each agent's digest goes at the top of its
// own zone's hour (`digestDue`), and notes stranded by a switch to per run go
// at the next run.
crons.cron('send manager digests', DIGEST_SCHEDULE, gate, {
  job: 'managerChannelActions:sendManagerDigests',
});

// A handover unanswered for fourteen days expires (D4); a quarter hour is the
// most an expired request waits for the sweep, and every reader already
// treats it as expired from its expiry on.
crons.interval('expire unanswered handovers', { minutes: 15 }, gate, {
  job: 'managerTransfers:expireDue',
});

// An accepted handover waits at most fifteen minutes for its runs (D18); each minute the sweep
// settles the ones past that deadline, and any whose runs ended by a path that asked for no
// settle.
crons.interval('settle finishing handovers', { minutes: 1 }, gate, {
  job: 'transferAcceptance:settleDue',
});

// A credential held for its revocation at the vendor keeps its ciphertext 24 hours at most (F19):
// its last attempt schedules the purge at that bound, and this hourly sweep closes any whose
// scheduled purge was lost.
crons.interval('close revocations past their 24 hours', { hours: 1 }, gate, {
  job: 'sourceRevocation:expireOverdue',
});

export default crons;
