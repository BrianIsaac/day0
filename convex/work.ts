import { closingResume } from '../src/work/closing-resume';
import type { ExecutionPlan, PlanStepOutcome } from '../src/work/types';
import { v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsWorkItem, getCallerOrThrow } from './ownership';
import { answerQuestionInTransaction, askOpenQuestionsAtPlan } from './managerQuestions';
import { keepCorrectionInTransaction, markCorrectionsAppliedInTransaction } from './corrections';
import {
  claimLoopStepInTransaction,
  EXECUTION_STALL_MS,
  OPEN_WORK_STATES,
  openSlotCount,
  resumeStalledStepsInTransaction,
  scheduleNextStep,
  type StepClaim,
} from './workLoop';
import { actionIdempotencyKey } from '../src/work/idempotency';
import {
  HELD_NOT_APPROVED,
  HELD_WRITE,
  normaliseActionVerdict,
  reviewActions,
  type ActionVerdict,
} from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import { verdictFor } from '../src/surfaces/verdict';
import type { AppliedAction } from '../src/surfaces/types';
import { autonomousActionsOn } from '../src/work/autonomy';
import { transitionWithheld } from '../src/work/obligations';
import { transitionDirectedByNote } from '../src/work/transition-direction';
import { replyTargetFor } from '../src/work/reply-target';
import {
  AUTONOMOUS_WIP_LIMIT,
  COLD_START_WIP_LIMIT,
  type MockAction,
  type ReplyTarget,
  OUT_OF_SCOPE_SKIP_PREFIX,
  QUALITY_FIT_SKIP_PREFIX,
} from '../src/work/types';
import {
  batchDecisionNoticeText,
  DECISION_REQUEST_RECOVERY_MS,
  type DecisionKind,
  undeliveredDecisionReason,
} from '../src/work/manager-channel';
import {
  browserComponentRefusal,
  withBrowserComponentState,
} from '../src/surfaces/browser';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { missingSurfaceResolvedBy } from '../src/surfaces/identity';
import {
  INTERRUPTED_APPLY_REASON,
  OUTCOME_UNKNOWN_REASON,
  providerReconciliationEntries,
  retryRequiresProviderReconciliation,
} from '../src/work/reconciliation';
import { landedWork, stopDetail, stoppedReason } from '../src/work/stop';
import {
  digestText,
  landedNoteText,
  managerNotificationMode,
  stoppedNoteText,
  type ManagerNoteKind,
} from '../src/work/manager-notes';

export const APPLY_RECOVERY_MS = 6 * 60 * 1000;
/** Parked rows examined per state in one re-evaluation call; the rest continue by schedule. */
export const REEVALUATION_BATCH = 100;
/** The longest rejection reason kept in full for the retry to read. */
export const MANAGER_FEEDBACK_MAX_CHARS = 1000;

/** The manager's words as kept: whitespace collapsed and capped at `MANAGER_FEEDBACK_MAX_CHARS`. */
function managerText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MANAGER_FEEDBACK_MAX_CHARS);
}
export { INTERRUPTED_APPLY_REASON };

/**
 * A connected chat surface the manager can be asked through and answered from.
 *
 * The DM channel alone is not enough: intake reads replies only from a
 * surface whose probe also recorded the manager's provider user id, so a
 * request sent without it would ask for a reply nobody reads.
 */
function isManagerChannel(surface: Doc<'surfaces'>): boolean {
  return (
    surface.class === 'chat' &&
    surface.verdict === 'connected' &&
    surface.credentialLanded &&
    !!surface.credentialId &&
    !!surface.managerDmChannelId &&
    !!surface.managerUserId
  );
}

/** Avoid scheduling an outbound action when no connected manager channel can claim it. */
async function scheduleDecisionRequest(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  kind: DecisionKind,
): Promise<void> {
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
    .collect();
  const available = surfaces.some(isManagerChannel);
  if (available) {
    await ctx.scheduler.runAfter(0, internal.managerChannelActions.requestDecision, {
      workItemId: row._id,
      kind,
    });
  }
}

/**
 * Read the authority and connection state used at the provider boundary.
 *
 * The agent, grants and one surface are read in one transaction so an action
 * cannot combine a switch value from one revision with grants or a connection
 * from another.
 */
export const transportAuthority = internalQuery({
  args: { agentId: v.id('agents'), surfaceSlug: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { agentExists: false }
    | {
        agentExists: true;
        autonomousActions: boolean;
        grants: string[];
        /** Scopes the manager revoked that no later grant restored. */
        revokedScopes?: string[];
        surface?: ReturnType<typeof toSurfaceRecord>;
      }
  > => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) return { agentExists: false };
    const [surface, grants] = await Promise.all([
      ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) =>
          q.eq('agentId', args.agentId).eq('slug', args.surfaceSlug),
        )
        .first(),
      ctx.db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', args.agentId))
        .collect(),
    ]);
    const active = new Set(grants.filter((grant) => !grant.revokedAt).map((grant) => grant.scope));
    const revoked = [
      ...new Set(
        grants
          .filter((grant) => grant.revokedAt !== undefined && !active.has(grant.scope))
          .map((grant) => grant.scope),
      ),
    ];
    return {
      agentExists: true,
      autonomousActions: autonomousActionsOn(agent),
      grants: [...active],
      revokedScopes: revoked,
      ...(surface ? { surface: toSurfaceRecord(surface) } : {}),
    };
  },
});

/**
 * Work items CRUD + state transitions. Public surfaces enforce
 * per-account ownership; internal transitions called by actions/scheduler
 * skip the check.
 *
 * State machine:
 *   discovered → claimed → plan-pending → plan-approved → executing
 *                                                       ↓
 *                                                   completed | failed
 *
 *   discovered → skipped | deferred | needs-skill
 *   plan-pending → cancelled
 *
 * Day0 adds the exact-action gate between the skill run and apply:
 *   executing → actions-pending → (approve) executing → completed | failed
 *                               → (reject)  failed
 * The run id minted by `claimForExecution` is kept on the row through the
 * gate, so approval applies with the same idempotency keys the run would have
 * used had it not paused.
 *
 * In real mode the gate runs in two phases over the same claim and apply path. Rows it
 * classifies `auto` (reads and the manager DM; every non-refused row once
 * the manager has turned autonomous actions on) are applied straight from
 * the hold while the row is still `executing` (`applyPhase: 'auto'`); when
 * the run also has `held` rows it then parks at `actions-pending` with the
 * auto rows already in the ledger, and the manager's approval runs the
 * second phase (`applyPhase: 'approved'`). A run with no held row never
 * enters `actions-pending`; a run with no auto row parks at once. In mock
 * comparison mode every proposed mock write parks and uses the same approved
 * apply path, so the control arm can be graded against the same ledger.
 */

/**
 * A skill id may only be attached to a work item belonging to the same agent.
 * The public actions derive the agent from the work item, so a mismatch here
 * means an internal caller has crossed two agents' contexts, not that a boss
 * pressed the wrong button.
 */
async function assertSameAgent(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  skillId: Id<'skills'>,
): Promise<{ item: Doc<'workItems'>; skill: Doc<'skills'> }> {
  const item = await ctx.db.get(workItemId);
  if (!item) throw new Error('workItem not found');
  const skill = await ctx.db.get(skillId);
  if (!skill) throw new Error('skill not found');
  if (skill.agentId !== item.agentId) {
    throw new Error('skill and work item belong to different agents');
  }
  return { item, skill };
}

export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'workItems'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .collect();
  },
});

export const get = query({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => {
    return await assertOwnsWorkItem(ctx, args.workItemId);
  },
});

/** Internal owner-free read for scheduler continuations already fenced by the work state. */
export const getInternal = internalQuery({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => await ctx.db.get(args.workItemId),
});

export const workItemSeedFields = {
  sourceCategory: v.string(),
  sourceSystem: v.string(),
  externalId: v.string(),
  title: v.string(),
  contentSummary: v.string(),
  contentRefs: v.array(v.string()),
  priority: v.optional(v.string()),
  requesterLabel: v.optional(v.string()),
  owner: v.optional(v.string()),
  requester: v.optional(v.string()),
  replyTarget: v.optional(
    v.object({
      channel: v.string(),
      channelName: v.optional(v.string()),
      threadTs: v.optional(v.string()),
    }),
  ),
} as const;

export interface WorkItemSeedInput {
  agentId: Id<'agents'>;
  sourceCategory: string;
  sourceSystem: string;
  externalId: string;
  title: string;
  contentSummary: string;
  contentRefs: string[];
  priority?: string;
  requesterLabel?: string;
  owner?: string;
  requester?: string;
  replyTarget?: { channel: string; channelName?: string; threadTs?: string };
}

/** Share intake's idempotency boundary with fixed evaluation task batches. */
export async function seedItemInTransaction(
  ctx: MutationCtx,
  args: WorkItemSeedInput,
): Promise<Id<'workItems'>> {
  const existing = await ctx.db
    .query('workItems')
    .withIndex('by_extId', (q) =>
      q.eq('sourceSystem', args.sourceSystem).eq('externalId', args.externalId),
    )
    .filter((q) => q.eq(q.field('agentId'), args.agentId))
    .first();
  if (existing) return existing._id;
  const id = await ctx.db.insert('workItems', {
    ...args,
    state: 'discovered',
    observedAt: Date.now(),
    createdAt: Date.now(),
  });
  await ctx.db.insert('events', {
    agentId: args.agentId,
    type: 'work.discovered',
    payload: { workItemId: id, title: args.title },
    createdAt: Date.now(),
  });
  await scheduleNextStep(ctx, {
    _id: id,
    agentId: args.agentId,
    state: 'discovered',
    sourceSystem: args.sourceSystem,
    externalId: args.externalId,
  });
  return id;
}

export const seedItem = internalMutation({
  args: { agentId: v.id('agents'), ...workItemSeedFields },
  handler: async (ctx, args): Promise<Id<'workItems'>> =>
    await seedItemInTransaction(ctx, args),
});

/** What changed, for a re-evaluation of the work parked under the old policy. */
export type ReevaluationTrigger = 'charter' | 'documentation' | 'surface';

const reevaluationTriggerValidator = v.union(
  v.literal('charter'),
  v.literal('documentation'),
  v.literal('surface'),
);

export interface ReevaluatePendingArgs {
  agentId: Id<'agents'>;
  trigger: ReevaluationTrigger;
  /** One value per policy change; the same key never re-admits a row twice. */
  key: string;
  /** The surface that connected, for the `surface` trigger. */
  surfaceId?: Id<'surfaces'>;
  /** Creation-time watermarks a continuation resumes from, per state. */
  after?: { skipped?: number; deferred?: number };
  now?: number;
}

export interface ReevaluatePendingResult {
  readmitted: number;
  examined: number;
  /** True when a batch filled and the rest was scheduled. */
  continued: boolean;
}

type ParkedVerdict = {
  decision?: string;
  reason?: string;
  missingSurface?: string;
  missingPermissions?: string[];
};

interface SurfaceTrigger {
  surface: Doc<'surfaces'>;
  siblings: Doc<'surfaces'>[];
}

/**
 * Whether a parked row's verdict can change under this trigger.
 *
 * An out-of-scope skip reads the charter, the documented systems and the
 * connected surfaces, so any of the three sends it back. A quality-fit skip
 * reads the charter's role. A deferral waits on one surface or one grant and
 * returns when that surface connects. A low-value or already-claimed skip
 * reads none of these and stays where it is.
 */
function verdictReturnsOn(
  row: Doc<'workItems'>,
  trigger: ReevaluationTrigger,
  surface: SurfaceTrigger | undefined,
): boolean {
  const verdict = (row.verdict ?? {}) as ParkedVerdict;
  const reason = typeof verdict.reason === 'string' ? verdict.reason : (row.skipReason ?? '');
  if (row.state === 'skipped') {
    if (reason.startsWith(OUT_OF_SCOPE_SKIP_PREFIX)) return true;
    if (reason.startsWith(QUALITY_FIT_SKIP_PREFIX)) return trigger === 'charter';
    return false;
  }
  if (row.state !== 'deferred' || trigger !== 'surface' || !surface) return false;
  if (reason === 'awaiting-connection' && verdict.missingSurface !== undefined) {
    return missingSurfaceResolvedBy(verdict.missingSurface, surface.surface, surface.siblings);
  }
  if (reason === 'awaiting-permission') {
    return (verdict.missingPermissions ?? []).includes(`${surface.surface.slug}:read`);
  }
  return false;
}

/**
 * Send the work parked under the old policy back for a fresh evaluation.
 *
 * Skipped and deferred rows whose verdict read the thing that changed return
 * to `discovered` with the verdict cleared; the row identity, its waivers and
 * its history stay. Each row is stamped with the trigger key, so the same
 * change firing twice re-admits nothing the second time. A batch of
 * `REEVALUATION_BATCH` rows per state is examined here; when a batch fills,
 * the rest is scheduled as a continuation carrying only ids and watermarks.
 *
 * Args:
 *   ctx: Mutation context.
 *   args: The trigger, its key and, for a surface, which one connected.
 *
 * Returns:
 *   How many rows were re-admitted and examined, and whether a continuation was scheduled.
 */
export async function reevaluatePendingInTransaction(
  ctx: MutationCtx,
  args: ReevaluatePendingArgs,
): Promise<ReevaluatePendingResult> {
  const now = args.now ?? Date.now();
  let surface: SurfaceTrigger | undefined;
  if (args.trigger === 'surface') {
    const row = args.surfaceId ? await ctx.db.get(args.surfaceId) : null;
    if (!row || row.agentId !== args.agentId) {
      throw new Error('a surface trigger names a surface of the agent');
    }
    const siblings = await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (index) => index.eq('agentId', args.agentId))
      .collect();
    surface = { surface: row, siblings };
  }

  const after: { skipped?: number; deferred?: number } = { ...args.after };
  let readmitted = 0;
  let examined = 0;
  let continued = false;
  for (const state of ['skipped', 'deferred'] as const) {
    const watermark = after[state];
    const rows = await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (index) => {
        const range = index.eq('agentId', args.agentId).eq('state', state);
        return watermark === undefined ? range : range.gt('_creationTime', watermark);
      })
      .take(REEVALUATION_BATCH);
    for (const row of rows) {
      examined += 1;
      if (row.reevaluation?.key === args.key) continue;
      if (!verdictReturnsOn(row, args.trigger, surface)) continue;
      const previous = (row.verdict ?? {}) as ParkedVerdict;
      await ctx.db.patch(row._id, {
        state: 'discovered',
        verdict: undefined,
        skipReason: undefined,
        reevaluation: { trigger: args.trigger, key: args.key, at: now },
      });
      await ctx.db.insert('events', {
        agentId: args.agentId,
        type: 'work.requeued',
        payload: {
          workItemId: row._id,
          trigger: args.trigger,
          key: args.key,
          previousState: row.state,
          ...(surface ? { surfaceId: surface.surface._id, slug: surface.surface.slug } : {}),
          ...(previous.missingSurface ? { previousMissingSurface: previous.missingSurface } : {}),
        },
        createdAt: now,
      });
      await scheduleNextStep(ctx, { ...row, state: 'discovered', verdict: undefined });
      readmitted += 1;
    }
    if (rows.length === REEVALUATION_BATCH) {
      after[state] = rows[rows.length - 1]._creationTime;
      continued = true;
    } else {
      delete after[state];
    }
  }
  if (continued) {
    await ctx.scheduler.runAfter(0, internal.work.reevaluatePending, {
      agentId: args.agentId,
      trigger: args.trigger,
      key: args.key,
      ...(args.surfaceId ? { surfaceId: args.surfaceId } : {}),
      after,
    });
  }
  if (readmitted > 0) {
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'work.reevaluation',
      payload: { trigger: args.trigger, key: args.key, readmitted, examined },
      createdAt: now,
    });
  }
  return { readmitted, examined, continued };
}

/**
 * The one entry point for a policy change: the charter pane on an amendment,
 * documentation sync on a changed page, and (in the connecting write itself)
 * a surface that connects.
 */
export const reevaluatePending = internalMutation({
  args: {
    agentId: v.id('agents'),
    trigger: reevaluationTriggerValidator,
    key: v.string(),
    surfaceId: v.optional(v.id('surfaces')),
    after: v.optional(v.object({ skipped: v.optional(v.number()), deferred: v.optional(v.number()) })),
  },
  handler: async (ctx, args): Promise<ReevaluatePendingResult> =>
    await reevaluatePendingInTransaction(ctx, args),
});

/**
 * Record an evaluation verdict and move the row to where it puts it.
 *
 * A plain helper rather than only a mutation, because `skills.completeRegistration`
 * has to requeue the work item that asked for a skill inside the same
 * transaction that registers the skill — a registered, callable skill whose
 * originating work item is still parked at `needs-skill` is a state nothing in
 * the product knows how to leave.
 */
export async function applyVerdict(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  verdict: unknown,
): Promise<{ decision: string; [key: string]: unknown }> {
  const row = await ctx.db.get(workItemId);
  if (!row) throw new Error('workItem not found');
  const proposed = verdict as { decision: string; [key: string]: unknown };

  // Late-arriving verdict guard: a verdict is the entry transition from
  // `discovered` (initial evaluation) or `needs-skill` (pending-reevaluation
  // after a skill registers). If the row has already advanced past these —
  // claimed, plan-pending, plan-approved, executing, completed, etc. — a stale
  // verdict must NOT stomp the row's state, which would wipe a drafted plan or
  // running execution. Ignore silently.
  if (row.state !== 'discovered' && row.state !== 'needs-skill') {
    return proposed;
  }

  let effective = proposed;
  if (proposed.decision === 'claim') {
    const agent = await ctx.db.get(row.agentId);
    if (!agent) throw new Error('agent not found');
    const autonomous = autonomousActionsOn(agent);
    const wipCap = autonomous ? AUTONOMOUS_WIP_LIMIT : COLD_START_WIP_LIMIT;
    const openClaims = await openSlotCount(ctx, row.agentId, wipCap);
    if (openClaims >= wipCap) {
      const posture = autonomous ? 'autonomous concurrency' : 'supervised cold-start';
      effective = {
        decision: 'queue',
        reason: `WIP cap reached: ${posture} limit is ${wipCap}`,
        openClaims,
      };
    }
  }

  const decision = effective.decision;
  let nextState: Doc<'workItems'>['state'] = 'discovered';
  let skipReason: string | undefined;
  if (decision === 'claim') nextState = 'claimed';
  else if (decision === 'skip') {
    nextState = 'skipped';
    skipReason = effective.reason as string | undefined;
  } else if (decision === 'queue') nextState = 'discovered';
  else if (decision === 'defer') nextState = 'deferred';
  else if (decision === 'needs-skill') nextState = 'needs-skill';
  await ctx.db.patch(workItemId, {
    verdict: effective,
    state: nextState,
    ...(skipReason ? { skipReason } : {}),
    // The verdict ends the evaluation step; a row queued at the cap must be
    // evaluable again the moment a slot frees.
    ...(row.evaluationClaimedAt !== undefined ? { evaluationClaimedAt: undefined } : {}),
  });
  await ctx.db.insert('events', {
    agentId: row.agentId,
    type: 'work.evaluated',
    payload: { workItemId, decision, verdict: effective },
    createdAt: Date.now(),
  });
  await scheduleNextStep(ctx, { ...row, state: nextState, verdict: effective });
  return effective;
}

export const setVerdict = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    verdict: v.any(),
  },
  handler: async (ctx, args) => {
    return await applyVerdict(ctx, args.workItemId, args.verdict);
  },
});

/**
 * Store a drafted plan, if the row is still waiting for one.
 *
 * Same shape as `claimForExecution`: two callers can both read `claimed`
 * before either writes, and the second would otherwise replace a plan the boss
 * may already be reading — with a second plan-drafted event to match. The
 * state check and the write share one transaction, so the second caller is
 * told its draft was not needed.
 */
/**
 * Record the one read that grounds a plan, before it is made, so the run id
 * the adapters key their idempotency on exists and the read is on the
 * timeline whatever happens next.
 */
export const beginPlanGroundingRead = internalMutation({
  args: { workItemId: v.id('workItems'), action: v.any() },
  handler: async (ctx, args): Promise<Id<'events'>> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    return await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.plan-grounding-read',
      payload: { workItemId: args.workItemId, action: args.action },
      createdAt: Date.now(),
    });
  },
});

/** Attach the ledger row to the grounding read's event. */
export const finishPlanGroundingRead = internalMutation({
  args: { eventId: v.id('events'), applied: v.any() },
  handler: async (ctx, args): Promise<void> => {
    const event = await ctx.db.get(args.eventId);
    if (!event) return;
    await ctx.db.patch(args.eventId, {
      payload: { ...(event.payload as Record<string, unknown>), applied: args.applied },
    });
  },
});

/**
 * The plan as stored: a plan may say it applied only this employee's own
 * active corrections, so any other id is dropped, and each one kept lists
 * the work item it was applied to. A plan that names none is stored as
 * drafted.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item whose plan is being stored.
 *   drafted: The plan the planner returned.
 *
 * Returns:
 *   The plan to store and the corrections it applied.
 */
async function withAppliedCorrections(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  drafted: unknown,
): Promise<{ plan: ExecutionPlan; applied: Id<'corrections'>[] }> {
  const plan = drafted as ExecutionPlan;
  if (!plan || typeof plan !== 'object' || plan.appliedCorrections === undefined) {
    return { plan, applied: [] };
  }
  const { appliedCorrections, ...rest } = plan;
  const applied = await markCorrectionsAppliedInTransaction(ctx, row, appliedCorrections);
  return { plan: applied.length > 0 ? { ...rest, appliedCorrections: applied } : rest, applied };
}

export const setPlan = internalMutation({
  args: { workItemId: v.id('workItems'), plan: v.any() },
  handler: async (ctx, args): Promise<{ stored: boolean }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (row.state !== 'claimed') return { stored: false };
    const { plan, applied } = await withAppliedCorrections(ctx, row, args.plan);
    await ctx.db.patch(args.workItemId, {
      plan,
      state: 'plan-pending',
      ...(SURFACE_MODE === 'real' ? { planPendingAt: Date.now() } : {}),
      ...(row.draftClaimedAt !== undefined ? { draftClaimedAt: undefined } : {}),
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.plan-drafted',
      payload: { workItemId: args.workItemId, plan },
      createdAt: Date.now(),
    });
    if (applied.length > 0) {
      await ctx.db.insert('events', {
        agentId: row.agentId,
        type: 'work.corrections-applied',
        payload: {
          workItemId: args.workItemId,
          correctionIds: applied,
          ...(plan.correctionsRedaction ? { redaction: plan.correctionsRedaction } : {}),
        },
        createdAt: Date.now(),
      });
    }
    // The charter's open questions this plan touches are asked here, before
    // execution, and once per question for the agent.
    await askOpenQuestionsAtPlan(ctx, row, plan);
    return { stored: true };
  },
});

/**
 * Decide whether a freshly drafted plan should continue without a click.
 *
 * This is deliberately separate from `setPlan`. The plan is always persisted
 * in `plan-pending` first, then this transaction re-reads the agent's switch at
 * the actual decision boundary. A switch change while the model was drafting
 * therefore affects this run; a stale value captured before the draft does not.
 */
export const decidePlan = internalMutation({
  args: { workItemId: v.id('workItems'), recovery: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ approved: boolean }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (row.state !== 'plan-pending') return { approved: false };
    const agent = await ctx.db.get(row.agentId);
    if (!agent || !autonomousActionsOn(agent)) {
      await scheduleDecisionRequest(ctx, row, 'plan');
      return { approved: false };
    }
    await ctx.db.patch(args.workItemId, { state: 'plan-approved' });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.plan-approved',
      payload: { workItemId: args.workItemId, by: 'autonomous' },
      createdAt: Date.now(),
    });
    if (args.recovery) await scheduleNextStep(ctx, { ...row, state: 'plan-approved' });
    return { approved: true };
  },
});

/** Claim the only outbound message for one parked decision state. */
export const prepareDecisionRequest = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    kind: v.union(v.literal('plan'), v.literal('actions')),
    decisionId: v.string(),
    /** The undelivered request this one replaces; a delivered code is never replaced. */
    supersedes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    const expectedState = args.kind === 'plan' ? 'plan-pending' : 'actions-pending';
    if (row.state !== expectedState) {
      return { prepared: false as const, reason: `work item is ${row.state}` };
    }
    const live = row.decision?.kind === args.kind && !row.decision.decidedAt ? row.decision : undefined;
    if (live && (live.ts || live.id !== args.supersedes)) {
      return { prepared: false as const, reason: 'decision request already claimed' };
    }
    if (!/^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/.test(args.decisionId)) {
      throw new Error('decision id is not a six-character random token');
    }
    const collision = await ctx.db
      .query('workItems')
      .withIndex('by_agent_decision', (q) =>
        q.eq('agentId', row.agentId).eq('decision.id', args.decisionId),
      )
      .first();
    if (collision && collision._id !== row._id) {
      return { prepared: false as const, reason: 'decision id collision' };
    }
    const agent = await ctx.db.get(row.agentId);
    if (!agent) return { prepared: false as const, reason: 'agent not found' };
    const surfaceRows = await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
      .collect();
    const chat = surfaceRows
      .filter(isManagerChannel)
      .sort(
        (left, right) =>
          (left.waterfallPosition ?? Number.MAX_SAFE_INTEGER) -
            (right.waterfallPosition ?? Number.MAX_SAFE_INTEGER) ||
          left.createdAt - right.createdAt,
      )[0];
    if (!chat?.managerDmChannelId) {
      return { prepared: false as const, reason: 'no connected manager chat channel' };
    }
    const grants = await ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', row.agentId))
      .collect();
    const actions = actionsOf(row.output);
    const heldIndexes =
      args.kind === 'actions'
        ? indexesWith(verdictList(row.actionVerdicts, actions.length), 'held')
        : [];
    if (args.kind === 'actions' && heldIndexes.length === 0) {
      return { prepared: false as const, reason: 'no held actions need a decision' };
    }
    // The other held action sets already asked on this channel, so the
    // request can offer one code for all of them.
    const openActionDecisions =
      args.kind === 'actions'
        ? (
            await ctx.db
              .query('workItems')
              .withIndex('by_agent_state', (q) =>
                q.eq('agentId', row.agentId).eq('state', 'actions-pending'),
              )
              .collect()
          ).flatMap((other) => {
            const decision = other.decision;
            if (
              other._id === row._id ||
              !decision ||
              decision.kind !== 'actions' ||
              !decision.ts ||
              decision.decidedAt ||
              decision.surfaceSlug !== chat.slug ||
              decision.channel !== chat.managerDmChannelId ||
              !other.pendingRunId ||
              other.approvedIndexes !== undefined
            ) {
              return [];
            }
            return [
              {
                workItemId: other._id,
                decisionId: decision.id,
                pendingRunId: other.pendingRunId,
                title: other.title,
              },
            ];
          })
        : [];
    const requestRunId = await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.decision-requesting',
      payload: {
        workItemId: row._id,
        decisionId: args.decisionId,
        kind: args.kind,
        ...(live ? { supersedes: live.id } : {}),
      },
      createdAt: Date.now(),
    });
    const decision = {
      id: args.decisionId,
      kind: args.kind as DecisionKind,
      requestedAt: Date.now(),
      channel: chat.managerDmChannelId,
      surfaceSlug: chat.slug,
      surfaceName: chat.displayName,
    };
    await ctx.db.patch(row._id, { decision });
    // The claim's dead-man's switch, in the same transaction as the claim.
    await ctx.scheduler.runAfter(
      DECISION_REQUEST_RECOVERY_MS,
      internal.work.recoverUndeliveredDecisionRequest,
      { workItemId: row._id, decisionId: args.decisionId },
    );
    return {
      prepared: true as const,
      agentId: row.agentId,
      agentName: agent.name,
      title: row.title,
      plan: row.plan,
      output: row.output,
      heldIndexes,
      decisionId: args.decisionId,
      requestRunId,
      surface: toSurfaceRecord(chat),
      surfaces: surfaceRows.map(toSurfaceRecord),
      grants: grants.filter((grant) => !grant.revokedAt).map((grant) => grant.scope),
      pendingRunId: row.pendingRunId,
      openActionDecisions,
    };
  },
});

/**
 * Mark an undelivered request failed and send a fresh one in its place.
 *
 * The old code stays on the row, marked failed, until the resend claims a
 * new one; a duplicate resend is refused by the claim because the id it
 * names is no longer the live one.
 */
async function supersedeDecisionRequest(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  decision: NonNullable<Doc<'workItems'>['decision']>,
  reason: string,
): Promise<void> {
  const now = Date.now();
  if (!decision.requestFailedAt) {
    await ctx.db.patch(row._id, {
      decision: { ...decision, requestFailedAt: now, requestFailure: reason },
    });
  }
  await ctx.db.insert('events', {
    agentId: row.agentId,
    type: 'work.decision-request-resent',
    payload: { workItemId: row._id, decisionId: decision.id, kind: decision.kind, reason },
    createdAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.managerChannelActions.requestDecision, {
    workItemId: row._id,
    kind: decision.kind,
    supersedes: decision.id,
  });
}

/**
 * The request path's dead-man's switch, armed with every claim.
 *
 * Fires after the recovery bound. A claim that still has neither a provider
 * ts nor a recorded failure belongs to a send that died between the claim and
 * the record; it is resent once. Anything else is somebody else's: a delivered
 * request, a decided one, a claim already replaced, a failure already audited.
 */
export const recoverUndeliveredDecisionRequest = internalMutation({
  args: { workItemId: v.id('workItems'), decisionId: v.string() },
  handler: async (ctx, args): Promise<{ recovered: 'resent' | 'ignored' }> => {
    const row = await ctx.db.get(args.workItemId);
    const decision = row?.decision;
    if (!row || !decision || decision.id !== args.decisionId) return { recovered: 'ignored' };
    const expectedState = decision.kind === 'plan' ? 'plan-pending' : 'actions-pending';
    if (row.state !== expectedState) return { recovered: 'ignored' };
    if (decision.ts || decision.decidedAt || decision.requestFailedAt) {
      return { recovered: 'ignored' };
    }
    await supersedeDecisionRequest(ctx, row, decision, 'request not delivered');
    return { recovered: 'resent' };
  },
});

/**
 * The decision requests intake must still read replies under.
 *
 * A request is open once it landed (it has a provider ts, so there is a
 * message to have a thread) and until the decision is made or the row
 * leaves its parked state. Scoped to one chat surface so a reply in
 * another manager channel is never read against it.
 */
export const openDecisionRequests = internalQuery({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<Array<{ workItemId: Id<'workItems'>; ts: string }>> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface || surface.class !== 'chat') return [];
    const parked = await Promise.all(
      (['plan-pending', 'actions-pending'] as const).map(
        async (state) =>
          await ctx.db
            .query('workItems')
            .withIndex('by_agent_state', (q) => q.eq('agentId', surface.agentId).eq('state', state))
            .collect(),
      ),
    );
    return parked.flat().flatMap((row) => {
      const decision = row.decision;
      if (!decision?.ts || decision.decidedAt || decision.surfaceSlug !== surface.slug) return [];
      const expectedState = decision.kind === 'plan' ? 'plan-pending' : 'actions-pending';
      if (row.state !== expectedState) return [];
      return [{ workItemId: row._id, ts: decision.ts }];
    });
  },
});

/**
 * Record the outcome of one manager-reply poll.
 *
 * A success advances the checkpoint monotonically, so a slower overlapping run
 * cannot move it backwards, and clears the row's failure. A failure records
 * why and deliberately leaves the checkpoint alone: the window it could not
 * read must be re-read, and the operator must be able to see on the surface
 * card that manager approvals have stopped arriving.
 */
export const recordDecisionPoll = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    polledAt: v.optional(v.number()),
    failure: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface || surface.class !== 'chat') return false;
    if (args.failure !== undefined) {
      await ctx.db.patch(surface._id, { lastDecisionError: args.failure.slice(0, 240) });
      return true;
    }
    await ctx.db.patch(surface._id, {
      lastDecisionError: undefined,
      lastDecisionPolledAt: Math.max(surface.lastDecisionPolledAt ?? 0, args.polledAt ?? 0),
    });
    return true;
  },
});

/** Attach provider evidence, or a bounded failure, to the claimed request. */
export const recordDecisionRequest = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    decisionId: v.string(),
    ts: v.optional(v.string()),
    failure: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row?.decision || row.decision.id !== args.decisionId) return false;
    const failure = args.failure?.slice(0, 240);
    await ctx.db.patch(row._id, {
      decision: {
        ...row.decision,
        ...(args.ts ? { ts: args.ts } : {}),
        ...(failure ? { requestFailedAt: Date.now(), requestFailure: failure } : {}),
      },
    });
    // The request is single-use whether or not it landed, so the feed must say why
    // no channel reply is coming; the dashboard still decides the parked row.
    if (failure) {
      await ctx.db.insert('events', {
        agentId: row.agentId,
        type: 'work.decision-request-failed',
        payload: {
          workItemId: row._id,
          decisionId: row.decision.id,
          kind: row.decision.kind,
          reason: failure,
        },
        createdAt: Date.now(),
      });
    }
    return true;
  },
});

/** Claim the one acknowledgement for late or duplicate manager replies. */
export const prepareDecisionNotice = internalMutation({
  args: { workItemId: v.id('workItems'), decisionId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (
      !row?.decision ||
      row.decision.id !== args.decisionId ||
      !row.decision.duplicateNotifiedAt ||
      row.decision.duplicateNoticeClaimedAt
    ) {
      return { prepared: false as const };
    }
    const [agent, surfaceRows, grants] = await Promise.all([
      ctx.db.get(row.agentId),
      ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
        .collect(),
      ctx.db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', row.agentId))
        .collect(),
    ]);
    const surface = surfaceRows.find(
      (candidate) =>
        candidate.slug === row.decision?.surfaceSlug &&
        candidate.class === 'chat' &&
        candidate.verdict === 'connected' &&
        candidate.managerDmChannelId === row.decision?.channel,
    );
    if (!agent || !surface) return { prepared: false as const };
    const requestRunId = await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.decision-notifying',
      payload: { workItemId: row._id, decisionId: row.decision.id },
      createdAt: Date.now(),
    });
    await ctx.db.patch(row._id, {
      decision: { ...row.decision, duplicateNoticeClaimedAt: Date.now() },
    });
    const origin =
      row.decision.decidedVia === 'channel' ? row.decision.surfaceName : 'the day0 dashboard';
    return {
      prepared: true as const,
      agentId: row.agentId,
      agentName: agent.name,
      requestRunId,
      surface: toSurfaceRecord(surface),
      surfaces: surfaceRows.map(toSurfaceRecord),
      grants: grants.filter((grant) => !grant.revokedAt).map((grant) => grant.scope),
      text: `Decision ${row.decision.id} was already ${row.decision.outcome ?? 'decided'} from ${origin}.`,
    };
  },
});

/** Store delivery evidence for the single duplicate-reply acknowledgement. */
export const recordDecisionNotice = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    decisionId: v.string(),
    ts: v.optional(v.string()),
    failure: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row?.decision || row.decision.id !== args.decisionId) return false;
    await ctx.db.patch(row._id, {
      decision: {
        ...row.decision,
        ...(args.ts ? { duplicateNoticeTs: args.ts } : {}),
        ...(args.failure ? { duplicateNoticeFailure: args.failure.slice(0, 240) } : {}),
      },
    });
    return true;
  },
});

/** Claim one manager-reply acknowledgement before its provider call. */
export const prepareManagerReplyNotice = internalMutation({
  args: { noticeId: v.id('managerDecisionNotices') },
  handler: async (ctx, args) => {
    const notice = await ctx.db.get(args.noticeId);
    if (!notice || notice.claimedAt) return { prepared: false as const };
    const [workItem, agent, surfaceRows, grants] = await Promise.all([
      ctx.db.get(notice.workItemId),
      ctx.db.get(notice.agentId),
      ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', notice.agentId))
        .collect(),
      ctx.db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', notice.agentId))
        .collect(),
    ]);
    const surface = surfaceRows.find(
      (candidate) =>
        candidate._id === notice.surfaceId &&
        candidate.class === 'chat' &&
        candidate.verdict === 'connected' &&
        !!candidate.managerDmChannelId,
    );
    if (!workItem || !agent || !surface) return { prepared: false as const };
    const requestRunId = await ctx.db.insert('events', {
      agentId: notice.agentId,
      type: 'work.decision-acknowledging',
      payload: {
        workItemId: notice.workItemId,
        decisionId: notice.decisionId,
        messageTs: notice.messageTs,
        kind: notice.kind,
      },
      createdAt: Date.now(),
    });
    await ctx.db.patch(notice._id, { claimedAt: Date.now() });
    return {
      prepared: true as const,
      workItemId: notice.workItemId,
      agentId: notice.agentId,
      agentName: agent.name,
      requestRunId,
      surface: toSurfaceRecord(surface),
      surfaces: surfaceRows.map(toSurfaceRecord),
      grants: grants.filter((grant) => !grant.revokedAt).map((grant) => grant.scope),
      text: notice.text,
    };
  },
});

/** Store provider evidence for one manager-reply acknowledgement. */
export const recordManagerReplyNotice = internalMutation({
  args: {
    noticeId: v.id('managerDecisionNotices'),
    providerTs: v.optional(v.string()),
    failure: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const notice = await ctx.db.get(args.noticeId);
    if (!notice) return false;
    await ctx.db.patch(notice._id, {
      ...(args.providerTs ? { providerTs: args.providerTs } : {}),
      ...(args.failure ? { failure: args.failure.slice(0, 240) } : {}),
    });
    return true;
  },
});

/**
 * Decide every member of a batch that is still exactly as it was sent.
 *
 * A member counts as open only while its own code is undecided, its item is
 * still parked and its pending run is the one whose payloads the request
 * showed; anything else is left as it is and named in the acknowledgement.
 * Each open member goes through the same transaction as a single reply, so
 * its apply keeps its own idempotency keys.
 */
async function resolveChannelBatch(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  batch: Doc<'decisionBatches'>,
  args: { userId: string; messageTs: string; reply: { verb: 'approve' | 'reject'; id: string; reason?: string } },
) {
  if (batch.surfaceSlug !== surface.slug || batch.channel !== surface.managerDmChannelId) {
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'work.decision-ignored',
      payload: {
        surfaceId: surface._id,
        messageTs: args.messageTs,
        userId: args.userId,
        reason: 'batch belongs to another manager channel',
      },
      createdAt: Date.now(),
    });
    return { status: 'ignored' as const, reason: 'batch belongs to another manager channel' };
  }
  const anchor = batch.members[0]?.workItemId;
  if (batch.decidedAt) {
    if (batch.decidedTs === args.messageTs) return { status: 'already-decided' as const, notified: false };
    const notified = anchor
      ? await queueManagerReplyNotice(ctx, {
          surfaceId: surface._id,
          workItemId: anchor,
          decisionId: batch.id,
          messageTs: args.messageTs,
          kind: 'received',
          text: `Batch ${batch.id} was already ${batch.outcome ?? 'decided'}.`,
        })
      : false;
    return { status: 'already-decided' as const, notified };
  }
  const decided: string[] = [];
  const skipped: Array<{ decisionId: string; reason: string }> = [];
  for (const member of batch.members) {
    const item = await ctx.db.get(member.workItemId);
    const decision = item?.decision;
    if (!item || !decision || decision.id !== member.decisionId) {
      skipped.push({ decisionId: member.decisionId, reason: 'no longer open' });
      continue;
    }
    if (decision.decidedAt) {
      skipped.push({ decisionId: member.decisionId, reason: `already ${decision.outcome ?? 'decided'}` });
      continue;
    }
    if (
      item.state !== 'actions-pending' ||
      item.pendingRunId !== member.pendingRunId ||
      item.approvedIndexes !== undefined
    ) {
      skipped.push({ decisionId: member.decisionId, reason: 'the run moved on' });
      continue;
    }
    if (args.reply.verb === 'approve') {
      const actionCount = actionsOf(item.output).length;
      const heldIndexes = indexesWith(verdictList(item.actionVerdicts, actionCount), 'held');
      await approveActionsInTransaction(
        ctx,
        item,
        { workItemId: item._id, pendingRunId: member.pendingRunId, approvedIndexes: heldIndexes },
        'channel',
        args.messageTs,
      );
    } else {
      await rejectActionsInTransaction(
        ctx,
        item,
        { workItemId: item._id, pendingRunId: member.pendingRunId, reason: args.reply.reason ?? '' },
        'channel',
        args.messageTs,
      );
    }
    decided.push(member.decisionId);
  }
  const outcome = args.reply.verb === 'approve' ? 'approved' : 'rejected';
  await ctx.db.patch(batch._id, { decidedAt: Date.now(), outcome, decidedTs: args.messageTs });
  await ctx.db.insert('events', {
    agentId: surface.agentId,
    type: 'work.decision-batch-decided',
    payload: { batchId: batch.id, outcome, decided, skipped, messageTs: args.messageTs },
    createdAt: Date.now(),
  });
  if (anchor) {
    await queueManagerReplyNotice(ctx, {
      surfaceId: surface._id,
      workItemId: anchor,
      decisionId: batch.id,
      messageTs: args.messageTs,
      kind: 'received',
      text: batchDecisionNoticeText({ id: batch.id, verb: args.reply.verb, decided, skipped }),
    });
  }
  return { status: 'decided' as const, outcome: args.reply.verb, decided, skipped };
}

async function queueManagerReplyNotice(
  ctx: MutationCtx,
  args: {
    surfaceId: Id<'surfaces'>;
    workItemId: Id<'workItems'>;
    decisionId: string;
    messageTs: string;
    kind: 'received' | 'unknown';
    text: string;
  },
): Promise<boolean> {
  const existing = await ctx.db
    .query('managerDecisionNotices')
    .withIndex('by_surface_message', (q) =>
      q.eq('surfaceId', args.surfaceId).eq('messageTs', args.messageTs),
    )
    .unique();
  if (existing) return false;
  const workItem = await ctx.db.get(args.workItemId);
  if (!workItem) return false;
  const noticeId = await ctx.db.insert('managerDecisionNotices', {
    agentId: workItem.agentId,
    ...args,
    createdAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.managerChannelActions.sendManagerReplyNotice, {
    noticeId,
  });
  return true;
}

/** Find a decision on this DM to anchor an unknown-token notice safely. */
async function managerReplyNoticeAnchor(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
): Promise<Doc<'workItems'> | undefined> {
  return (
    (await ctx.db
      .query('workItems')
      .withIndex('by_agent_decision_surface_channel', (q) =>
        q
          .eq('agentId', surface.agentId)
          .eq('decision.surfaceSlug', surface.slug)
          .eq('decision.channel', surface.managerDmChannelId),
      )
      .order('desc')
      .first()) ?? undefined
  );
}

type DecisionVia = 'dashboard' | 'channel';

function decidedPatch(
  row: Doc<'workItems'>,
  kind: DecisionKind,
  via: DecisionVia,
  outcome: 'approved' | 'rejected',
  messageTs?: string,
): { decision?: NonNullable<Doc<'workItems'>['decision']> } {
  if (!row.decision || row.decision.kind !== kind || row.decision.decidedAt) return {};
  return {
    decision: {
      ...row.decision,
      decidedAt: Date.now(),
      outcome,
      decidedVia: via,
      ...(via === 'channel' && messageTs ? { decidedTs: messageTs } : {}),
    },
  };
}

/** One answer the manager gave with plan approval, as the row carries it. */
type ManagerAnswerRow = NonNullable<Doc<'workItems'>['managerAnswers']>[number];

/**
 * Record the manager's answers given with the approval, in the same
 * transaction as the approval.
 *
 * An answer to one of the charter's open questions goes through the
 * question's own record, which amends the charter when the question is
 * still open there; the note answers the planner's own risk notes and goes
 * nowhere but this run. Every answer reaches the executor as approved
 * evidence. A question asked on another work item is refused: the manager
 * answers what this plan raised.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The plan-pending work item.
 *   answers: The answers to the charter's questions asked on this item.
 *   note: The manager's answer to the planner's note, if any.
 *
 * Returns:
 *   The rows to keep on the work item, empty when nothing was answered.
 */
async function answerPlanQuestions(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  answers: ReadonlyArray<{ questionId: Id<'managerQuestions'>; text: string }>,
  note: string | undefined,
): Promise<ManagerAnswerRow[]> {
  const now = Date.now();
  const kept: ManagerAnswerRow[] = [];
  for (const entry of answers) {
    const record = await ctx.db.get(entry.questionId);
    if (!record || record.workItemId !== row._id) {
      throw new Error('that question was not asked on this work item');
    }
    await answerQuestionInTransaction(ctx, record, entry.text, 'plan-approval');
    kept.push({
      question: record.question,
      answer: entry.text.replace(/\s+/g, ' ').trim(),
      answeredAt: now,
      questionId: record._id,
    });
  }
  const trimmedNote = note?.replace(/\s+/g, ' ').trim().slice(0, MANAGER_FEEDBACK_MAX_CHARS);
  if (trimmedNote) {
    const plan = row.plan as { riskNotes?: string } | undefined;
    const riskNotes = plan?.riskNotes?.trim();
    kept.push({
      question: riskNotes ? riskNotes : "the planner's note",
      answer: trimmedNote,
      answeredAt: now,
    });
  }
  return kept;
}

async function approvePlanInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  via: DecisionVia,
  messageTs?: string,
  answers: ManagerAnswerRow[] = [],
): Promise<void> {
  if (row.state !== 'plan-pending') {
    throw new Error(`workItem state is ${row.state}; expected plan-pending`);
  }
  await ctx.db.patch(row._id, {
    state: 'plan-approved',
    ...(answers.length > 0 ? { managerAnswers: answers } : {}),
    ...decidedPatch(row, 'plan', via, 'approved', messageTs),
  });
  await ctx.db.insert('events', {
    agentId: row.agentId,
    type: 'work.plan-approved',
    payload: {
      workItemId: row._id,
      decidedVia: via,
      ...(answers.length > 0
        ? { answered: answers.map((entry) => ({ question: entry.question, questionId: entry.questionId })) }
        : {}),
    },
    createdAt: Date.now(),
  });
  // Whichever way the manager approved, the server runs the plan; the page no
  // longer has to be open for it.
  await scheduleNextStep(ctx, { ...row, state: 'plan-approved' });
}

export const approvePlan = mutation({
  args: {
    workItemId: v.id('workItems'),
    /** Answers to the charter's open questions asked on this plan; each amends the charter. */
    answers: v.optional(
      v.array(v.object({ questionId: v.id('managerQuestions'), text: v.string() })),
    ),
    /** The manager's answer to the planner's own note, for this run. */
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (row.state !== 'plan-pending') {
      throw new Error(`workItem state is ${row.state}; expected plan-pending`);
    }
    // Approve-with-answer is one decision: the answers land, the charter is
    // amended where a question is still open there, and the plan is approved
    // in the same transaction, or none of it happens.
    const answers = await answerPlanQuestions(ctx, row, args.answers ?? [], args.note);
    await approvePlanInTransaction(ctx, row, 'dashboard', undefined, answers);
    return { ok: true };
  },
});

/**
 * Resend, from the card, the decision request it shows as not delivered.
 *
 * Accepts a recorded failure or a silent request past the recovery bound.
 * Refuses a request still in flight, so a slow send is not doubled, and a
 * delivered one, so the code the manager holds keeps working.
 */
export const resendDecisionRequest = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    const decision = row.decision;
    const expectedState = decision?.kind === 'plan' ? 'plan-pending' : 'actions-pending';
    if (!decision || decision.decidedAt || row.state !== expectedState) {
      throw new Error('There is no open decision request to resend.');
    }
    if (decision.ts) throw new Error('The request was delivered; the manager holds its code.');
    if (!undeliveredDecisionReason(decision, Date.now())) {
      throw new Error('The request is still being delivered.');
    }
    await supersedeDecisionRequest(ctx, row, decision, 'resend requested from the dashboard');
    return { ok: true };
  },
});

export const retryFailed = mutation({
  args: { workItemId: v.id('workItems'), feedback: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    // A note given with Retry is the manager's answer to what the last run
    // asked, or a direction for the next one; it reaches the retried run the
    // way a rejection reason does.
    const feedback = managerText(args.feedback);
    const recoverable = ['failed', 'skipped', 'cancelled', 'completed'];
    if (!recoverable.includes(row.state)) {
      throw new Error(`workItem state is ${row.state}; expected one of ${recoverable.join(', ')}`);
    }
    // Finished work is sent back only with a direction: a retry that changes
    // nothing would repeat what already landed.
    if (row.state === 'completed' && !feedback) {
      throw new Error('a completed item is sent back with a note saying what to change');
    }
    if (
      retryRequiresProviderReconciliation(row.output, row.skipReason) &&
      !row.providerReconciliation
    ) {
      throw new Error(
        'retry refused because an external effect may already have landed; reconcile the provider first',
      );
    }
    const verdict = row.verdict as { decision?: string; reason?: unknown } | undefined;
    // A cancelled plan is one the manager turned down: Retry drafts a new plan
    // that goes back to them, and never runs the rejected one.
    const redraft = row.state === 'cancelled' && row.plan !== undefined;
    const next: Doc<'workItems'>['state'] = row.plan && !redraft
      ? 'plan-approved'
      : verdict?.decision === 'claim'
        ? 'claimed'
        : 'discovered';
    // Retrying a skip is the manager overruling the agent's judgement: a
    // quality-fit skip says the work is worth doing, an out-of-scope skip says
    // the work is theirs to give. The re-evaluation leaves that one rule out.
    const skipReason =
      row.state === 'skipped' && typeof verdict?.reason === 'string' ? verdict.reason : '';
    const waived: 'quality-fit' | 'scope' | undefined = skipReason.startsWith(
      QUALITY_FIT_SKIP_PREFIX,
    )
      ? 'quality-fit'
      : skipReason.startsWith(OUT_OF_SCOPE_SKIP_PREFIX)
        ? 'scope'
        : undefined;
    const resume = SURFACE_MODE === 'real' && row.state === 'failed' && row.plan
      ? closingResume(row.output, row.plan as ExecutionPlan, row.skipReason && stopDetail(row.skipReason), (await ctx.db
          .query('surfaces').withIndex('by_agent', q => q.eq('agentId', row.agentId)).take(100))
          .map(toSurfaceRecord)
          .filter((surface) => verdictFor(surface, Date.now()) === 'connected'))
      : undefined;
    await ctx.db.patch(args.workItemId, {
      state: next,
      ...(resume ? { output: resume } : {}),
      ...(redraft
        ? { plan: undefined, decision: undefined, planPendingAt: undefined, managerAnswers: undefined }
        : {}),
      skipReason: undefined,
      executionRunId: undefined,
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
      providerReconciliation: undefined,
      ...(waived === 'quality-fit' ? { qualityFitWaivedAt: Date.now() } : {}),
      ...(waived === 'scope' ? { scopeWaivedAt: Date.now() } : {}),
      ...(feedback
        ? { managerFeedback: { reason: feedback, at: Date.now(), kind: 'retry-note' as const } }
        : {}),
      // A retry starts every step afresh; no claim from an earlier attempt holds it back.
      ...(row.evaluationClaimedAt !== undefined ? { evaluationClaimedAt: undefined } : {}),
      ...(row.draftClaimedAt !== undefined ? { draftClaimedAt: undefined } : {}),
    });
    // The note is also kept for the employee's later work of the same kind.
    if (feedback) await keepCorrectionInTransaction(ctx, row, 'retry-note', feedback);
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.retry',
      payload: {
        workItemId: args.workItemId,
        resumeState: next,
        fromState: row.state,
        ...(waived ? { waived } : {}),
        ...(feedback ? { feedback } : {}),
      },
      createdAt: Date.now(),
    });
    await scheduleNextStep(ctx, { ...row, state: next, ...(redraft ? { plan: undefined } : {}) });
    return { ok: true, resumeState: next };
  },
});

export const reconcileFailed = mutation({
  args: { workItemId: v.id('workItems'), confirmed: v.boolean() },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (row.state !== 'failed' && row.state !== 'completed') {
      throw new Error(`workItem state is ${row.state}; expected failed or completed`);
    }
    if (!args.confirmed) throw new Error('explicit provider verification is required');
    if (row.providerReconciliation) {
      return { ok: true, reconciledEntries: row.providerReconciliation.entries.length };
    }
    const entries = providerReconciliationEntries(row.output);
    if (!retryRequiresProviderReconciliation(row.output, row.skipReason)) {
      throw new Error('no provider effects require reconciliation');
    }
    if (entries.length === 0) {
      throw new Error('the applied ledger does not identify provider effects to reconcile');
    }
    const identity = await getCallerOrThrow(ctx);
    const confirmedAt = Date.now();
    const providerReconciliation = { actor: identity.subject, confirmedAt, entries };
    await ctx.db.patch(args.workItemId, { providerReconciliation });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.provider-reconciled',
      payload: {
        workItemId: args.workItemId,
        actor: identity.subject,
        confirmedAt,
        entries,
      },
      createdAt: confirmedAt,
    });
    return { ok: true, reconciledEntries: entries.length };
  },
});

/** Why a work item is `cancelled` after the manager turned its plan down. */
export const PLAN_CANCELLED_REASON = 'plan cancelled by the manager';

function planCancelledReason(reason: string): string {
  const detail = reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  return detail ? `${PLAN_CANCELLED_REASON}: ${detail}` : PLAN_CANCELLED_REASON;
}

async function cancelPlanInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  via: DecisionVia,
  reason: string,
  messageTs?: string,
): Promise<void> {
  if (row.state !== 'plan-pending') {
    throw new Error(`workItem state is ${row.state}; expected plan-pending`);
  }
  const skipReason = planCancelledReason(reason);
  const feedback = managerText(reason);
  if (feedback) await keepCorrectionInTransaction(ctx, row, 'plan-rejection', feedback);
  await ctx.db.patch(row._id, {
    state: 'cancelled',
    skipReason,
    // Kept in full, as a rejection reason is, for the plan Retry drafts next.
    ...(feedback
      ? { managerFeedback: { reason: feedback, at: Date.now(), kind: 'plan-rejection' as const } }
      : {}),
    ...decidedPatch(row, 'plan', via, 'rejected', messageTs),
  });
  await ctx.db.insert('events', {
    agentId: row.agentId,
    type: 'work.cancelled',
    payload: { workItemId: row._id, reason: skipReason, decidedVia: via },
    createdAt: Date.now(),
  });
  await scheduleNextStep(ctx, { ...row, state: 'cancelled' });
}

/**
 * Why a work item is `cancelled` after the skill proposed for it was rejected.
 *
 * Args:
 *   skillName: The rejected skill's name.
 *
 * Returns:
 *   The reason the card shows in place of the pre-cancel verdict.
 */
export function skillRejectedReason(skillName: string): string {
  return `skill proposal "${skillName}" rejected by the manager`;
}

export const cancelPlan = mutation({
  args: { workItemId: v.id('workItems'), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    await cancelPlanInTransaction(ctx, row, 'dashboard', args.reason ?? '');
    return { ok: true };
  },
});

/**
 * Claim the evaluation or the draft of one row for the run about to make its
 * model call, in real mode; see `claimLoopStepInTransaction`.
 */
export const claimLoopStep = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    step: v.union(v.literal('evaluation'), v.literal('draft')),
  },
  handler: async (ctx, args): Promise<StepClaim> =>
    await claimLoopStepInTransaction(ctx, args.workItemId, args.step, Date.now()),
});

/**
 * The stalled-step sweep, run with the five-minute intake poll; see
 * `resumeStalledStepsInTransaction`. Real mode only.
 */
export const resumeStalledSteps = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ rescheduled: number }> =>
    await resumeStalledStepsInTransaction(ctx, Date.now()),
});

/**
 * Take exclusive ownership of an approved work item, or report that somebody
 * else already has it.
 *
 * This is the whole of the concurrency control for execution. A mutation is a
 * transaction, so the state check and the move to `executing` cannot be split
 * by a second caller; an action that reads `plan-approved` and writes
 * `executing` as two calls can be, and both callers then run the skill and
 * apply every action. React Strict Mode plus the dashboard's auto-progress
 * effect supplies that second caller for free in development.
 *
 * The winner gets a `runId` — the id of the claim event, which is durable,
 * unique per claim and derived from nothing the caller controls. Adapter
 * calls key their idempotency off it, so an external effect can be recognised
 * as already-applied if the run is interrupted before its completion lands.
 */
export const claimForExecution = internalMutation({
  args: { workItemId: v.id('workItems'), skillId: v.id('skills') },
  handler: async (
    ctx,
    args,
  ): Promise<{ claimed: true; runId: Id<'events'> } | { claimed: false; reason: string }> => {
    const { item } = await assertSameAgent(ctx, args.workItemId, args.skillId);
    if (item.state !== 'plan-approved') {
      return {
        claimed: false,
        reason:
          item.state === 'executing'
            ? 'another execution already claimed this work item'
            : `workItem state is ${item.state}; expected plan-approved`,
      };
    }
    const runId = await ctx.db.insert('events', {
      agentId: item.agentId,
      type: 'work.execution-claimed',
      payload: { workItemId: args.workItemId, skillId: args.skillId },
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.workItemId, {
      state: 'executing',
      skillId: args.skillId,
      executionRunId: runId,
      pendingRunId: undefined,
      approvedIndexes: undefined,
      actionVerdicts: undefined,
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    return { claimed: true, runId };
  },
});

/** Atomically claim one discovered comparison task for the ordinary-agent arm. */
export const claimForBaseline = internalMutation({
  args: { workItemId: v.id('workItems') },
  handler: async (
    ctx,
    args,
  ): Promise<
    { claimed: true; runId: Id<'events'> } | { claimed: false; reason: string }
  > => {
    const item = await ctx.db.get(args.workItemId);
    if (!item) throw new Error('workItem not found');
    const agent = await ctx.db.get(item.agentId);
    if (!agent) throw new Error('agent not found');
    if (agent.arm !== 'baseline') {
      return { claimed: false, reason: 'work item does not belong to the baseline arm' };
    }
    if (item.state !== 'discovered') {
      return {
        claimed: false,
        reason:
          item.state === 'executing'
            ? 'another baseline execution already claimed this work item'
            : `workItem state is ${item.state}; expected discovered`,
      };
    }
    const runId = await ctx.db.insert('events', {
      agentId: item.agentId,
      type: 'work.execution-claimed',
      payload: { workItemId: args.workItemId, arm: 'baseline' },
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.workItemId, {
      state: 'executing',
      executionRunId: runId,
      pendingRunId: undefined,
      approvedIndexes: undefined,
      actionVerdicts: undefined,
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    return { claimed: true, runId };
  },
});

/** Persist the prerequisite ledger before spending the run's one dependent model turn. */
export const prepareDependentPhase = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    runId: v.id('events'),
    applyAttemptId: v.optional(v.id('events')),
    output: v.any(),
  },
  handler: async (ctx, args): Promise<{ prepared: boolean }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (
      row.state !== 'executing' ||
      row.executionRunId !== args.runId ||
      (args.applyAttemptId !== undefined
        ? row.applyAttemptId !== args.applyAttemptId
        : row.applyAttemptId !== undefined || row.pendingRunId !== undefined)
    ) {
      return { prepared: false };
    }
    const output = args.output as {
      phase?: unknown;
      actions?: unknown[];
      applied?: unknown[];
    };
    if (
      output.phase !== 'dependent-authoring' ||
      !Array.isArray(output.actions) ||
      !Array.isArray(output.applied)
    ) {
      throw new Error('dependent phase needs the persisted prerequisite actions and ledger');
    }
    await ctx.db.patch(args.workItemId, {
      output: args.output,
      pendingRunId: undefined,
      approvedIndexes: undefined,
      actionVerdicts: undefined,
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.dependent-authoring',
      payload: {
        workItemId: args.workItemId,
        runId: args.runId,
        prerequisiteActionCount: output.actions.length,
      },
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.workActions.authorDependentActions, {
      workItemId: args.workItemId,
      runId: args.runId,
    });
    return { prepared: true };
  },
});

/** Claim the single result-dependent authoring turn without claiming a provider apply. */
export const claimDependentAuthoring = internalMutation({
  args: { workItemId: v.id('workItems'), runId: v.id('events') },
  handler: async (
    ctx,
    args,
  ): Promise<
    { claimed: true; authoringAttemptId: Id<'events'> } | { claimed: false; reason: string }
  > => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    const output = (row.output ?? {}) as { phase?: unknown };
    if (
      row.state !== 'executing' ||
      row.executionRunId !== args.runId ||
      output.phase !== 'dependent-authoring'
    ) {
      return { claimed: false, reason: 'dependent phase is not awaiting authoring' };
    }
    if (row.applyAttemptId !== undefined) {
      return { claimed: false, reason: 'another dependent authoring turn already claimed the run' };
    }
    const authoringAttemptId = await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.dependent-authoring-claimed',
      payload: { workItemId: args.workItemId, runId: args.runId },
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.workItemId, {
      applyAttemptId: authoringAttemptId,
      applyClaimedAt: Date.now(),
    });
    return { claimed: true, authoringAttemptId };
  },
});

/**
 * Mark a run done, and refuse to when nothing is behind it.
 *
 * The rule — every action the run emitted changed the work environment — was
 * enforced by the caller that happens to run the skill today. That leaves it
 * one caller away from being lost, and it reads as satisfied by a run that
 * emitted no actions at all: vacuously, every action succeeded. `completed`
 * then means "the model finished a turn", which is precisely the state a
 * person cannot tell apart from work that happened.
 *
 * So the rule lives with the write instead. An empty ledger is a bug in the
 * caller rather than an outcome of the work, hence a throw: the action's own
 * error path turns it into a visible `failed` row rather than a silent one.
 */
export const setCompleted = internalMutation({
  args: { workItemId: v.id('workItems'), runId: v.optional(v.id('events')), output: v.any() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (
      row.state !== 'executing' ||
      (args.runId !== undefined && row.executionRunId !== args.runId)
    ) {
      throw new Error('execution run changed before completion');
    }
    const applied = (
      (args.output ?? {}) as { applied?: Array<{ tool: string; ok: boolean; held?: boolean }> }
    ).applied;
    if (!applied || applied.length === 0) {
      throw new Error(
        'cannot complete a work item whose run applied nothing to the work environment',
      );
    }
    // A held row is accounted for: the manager chose not to send it, or the
    // gate held a public post for them, and the ledger says so. It is neither
    // a landed change nor a failure.
    const failed = applied.filter((a) => !a.ok && !a.held);
    if (failed.length > 0) {
      throw new Error(
        `cannot complete a work item with ${failed.length} action(s) that did not change the work environment`,
      );
    }
    await ctx.db.patch(args.workItemId, {
      state: 'completed',
      output: args.output,
      pendingRunId: undefined,
      approvedIndexes: undefined,
      actionVerdicts: undefined,
      applyPhase: undefined,
      executionRunId: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
      // The feedback this run answered stays on the item as its record; the
      // mark keeps a later run from reading it as a live direction.
      ...(row.managerFeedback && row.managerFeedback.addressedAt === undefined
        ? { managerFeedback: { ...row.managerFeedback, addressedAt: Date.now() } }
        : {}),
      managerAnswers: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.completed',
      payload: { workItemId: args.workItemId, output: args.output },
      createdAt: Date.now(),
    });
    await scheduleNextStep(ctx, { ...row, state: 'completed' });
    const surfaces = (
      await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
        .collect()
    ).map(toSurfaceRecord);
    const landed = landedWork(args.output, surfaces);
    if (landed.length > 0) {
      await queueManagerNote(ctx, row, 'landed', (agentName) =>
        landedNoteText({ agentName, title: row.title, landed, outcome: 'completed' }),
      );
    }
  },
});

export const setFailed = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    reason: v.string(),
    // Kept when the skill produced a draft the run then failed to apply, so
    // the boss can read what was written before deciding whether to retry.
    output: v.optional(v.any()),
    runId: v.optional(v.id('events')),
    /**
     * Whether the run stopped: nothing landed and nothing is left to decide.
     * Read from the ledger when absent; the comparison arm passes false, since
     * it has no gate and no manager loop for a stop to mean anything to.
     */
    stopped: v.optional(v.boolean()),
    onlyIfStalled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (args.runId && row.executionRunId !== args.runId) return;
    // A pre-claim failure (such as no matching skill) cannot stop a run
    // another scheduled caller claimed after the failing caller read the row.
    if (!args.runId && row.executionRunId) return;
    if (args.onlyIfStalled) {
      if (row.state !== 'executing' || !args.runId || row.pendingRunId ||
          row.applyAttemptId || row.applyClaimedAt || row.applyPhase) return;
      const claim = await ctx.db.get(args.runId);
      if (!claim || Date.now() - claim.createdAt < EXECUTION_STALL_MS) return;
    }
    // A row that already reached an end state keeps it. Nothing legitimately
    // fails a completed run, and a losing caller must not add a second failure
    // record for a failure the winner already wrote.
    const terminal = ['completed', 'failed', 'cancelled', 'skipped'];
    if (terminal.includes(row.state)) return;
    // A run that landed nothing and left nothing to decide stopped: the
    // record says so, Retry stands, and nothing pages the manager for it.
    const surfaces = (
      await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
        .collect()
    ).map(toSurfaceRecord);
    const landed = landedWork(args.output, surfaces);
    const stopped = args.stopped ?? landed.length === 0;
    const reason = stopped ? stoppedReason(args.reason) : args.reason;
    await ctx.db.patch(args.workItemId, {
      state: 'failed',
      skipReason: reason,
      pendingRunId: undefined,
      approvedIndexes: undefined,
      actionVerdicts: undefined,
      applyPhase: undefined,
      executionRunId: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
      ...(args.output !== undefined ? { output: args.output } : {}),
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.failed',
      payload: {
        workItemId: args.workItemId,
        reason,
        ...(stopped ? { stopped: true } : {}),
        ...(args.output !== undefined ? { output: args.output } : {}),
      },
      createdAt: Date.now(),
    });
    await scheduleNextStep(ctx, { ...row, state: 'failed' });
    if (args.stopped === false) return;
    if (stopped) {
      await queueManagerNote(ctx, row, 'stopped', (agentName) =>
        stoppedNoteText({ agentName, title: row.title, reason: stopDetail(reason) }),
      );
    } else {
      await queueManagerNote(ctx, row, 'landed', (agentName) =>
        landedNoteText({ agentName, title: row.title, landed, outcome: 'failed', reason }),
      );
    }
  },
});

/**
 * Keep a note for the manager about a finished run, and send it when the
 * mode says so.
 *
 * Per run, a landed note is sent at once and a stop is not kept at all:
 * nothing needs deciding, and the card and the ledger already say so. In
 * digest mode both are kept for the hourly send. Without a manager channel
 * there is nowhere to send, so nothing is kept.
 */
async function queueManagerNote(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  kind: ManagerNoteKind,
  text: (agentName: string) => string,
): Promise<void> {
  const agent = await ctx.db.get(row.agentId);
  if (!agent) return;
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
    .collect();
  if (!surfaces.some(isManagerChannel)) return;
  const mode = managerNotificationMode(agent);
  if (kind === 'stopped' && mode === 'per-run') return;
  const noteId = await ctx.db.insert('managerNotes', {
    agentId: row.agentId,
    workItemId: row._id,
    kind,
    text: text(agent.name),
    createdAt: Date.now(),
  });
  if (mode === 'per-run') {
    await ctx.scheduler.runAfter(0, internal.managerChannelActions.sendManagerNote, { noteId });
  }
}

/** The delivery fields every manager message needs, for one agent's manager channel. */
async function managerDelivery(ctx: MutationCtx, agentId: Id<'agents'>) {
  const [agent, surfaceRows, grants] = await Promise.all([
    ctx.db.get(agentId),
    ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .collect(),
    ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', agentId))
      .collect(),
  ]);
  const chat = surfaceRows
    .filter(isManagerChannel)
    .sort(
      (left, right) =>
        (left.waterfallPosition ?? Number.MAX_SAFE_INTEGER) -
          (right.waterfallPosition ?? Number.MAX_SAFE_INTEGER) || left.createdAt - right.createdAt,
    )[0];
  if (!agent || !chat) return undefined;
  return {
    agentId,
    agentName: agent.name,
    surface: toSurfaceRecord(chat),
    surfaces: surfaceRows.map(toSurfaceRecord),
    grants: grants.filter((grant) => !grant.revokedAt).map((grant) => grant.scope),
  };
}

/** Claim one per-run note for sending. */
export const prepareManagerNote = internalMutation({
  args: { noteId: v.id('managerNotes') },
  handler: async (ctx, args) => {
    const note = await ctx.db.get(args.noteId);
    if (!note || note.claimedAt !== undefined || note.providerTs !== undefined) {
      return { prepared: false as const };
    }
    const delivery = await managerDelivery(ctx, note.agentId);
    if (!delivery) return { prepared: false as const };
    const requestRunId = await ctx.db.insert('events', {
      agentId: note.agentId,
      type: 'work.manager-note-sending',
      payload: { workItemId: note.workItemId, noteId: note._id, kind: note.kind },
      createdAt: Date.now(),
    });
    await ctx.db.patch(note._id, { claimedAt: Date.now() });
    return {
      prepared: true as const,
      ...delivery,
      requestRunId,
      workItemId: note.workItemId,
      text: note.text,
    };
  },
});

export const recordManagerNote = internalMutation({
  args: {
    noteId: v.id('managerNotes'),
    ts: v.optional(v.string()),
    failure: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const note = await ctx.db.get(args.noteId);
    if (!note) return;
    const failure = args.failure?.slice(0, 240);
    await ctx.db.patch(note._id, {
      ...(args.ts ? { providerTs: args.ts } : {}),
      ...(failure ? { failure } : {}),
    });
    if (failure) {
      await ctx.db.insert('events', {
        agentId: note.agentId,
        type: 'work.manager-note-failed',
        payload: { workItemId: note.workItemId, noteId: note._id, kind: note.kind, reason: failure },
        createdAt: Date.now(),
      });
    }
  },
});

/** The agents whose kept notes are due in a digest. */
export const digestCandidates = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<'agents'>[]> => {
    const agents = await ctx.db.query('agents').collect();
    const due: Id<'agents'>[] = [];
    for (const agent of agents) {
      if (managerNotificationMode(agent) !== 'digest') continue;
      const notes = await ctx.db
        .query('managerNotes')
        .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
        .collect();
      if (notes.some((note) => note.claimedAt === undefined && note.providerTs === undefined)) {
        due.push(agent._id);
      }
    }
    return due;
  },
});

/** Claim every kept note of one agent for a single digest send. */
export const prepareManagerDigest = internalMutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent || managerNotificationMode(agent) !== 'digest') return { prepared: false as const };
    const notes = (
      await ctx.db
        .query('managerNotes')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
        .collect()
    )
      .filter((note) => note.claimedAt === undefined && note.providerTs === undefined)
      .sort((left, right) => left.createdAt - right.createdAt);
    if (notes.length === 0) return { prepared: false as const };
    const delivery = await managerDelivery(ctx, args.agentId);
    if (!delivery) return { prepared: false as const };
    const digestId = await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'work.manager-digest-sending',
      payload: { noteIds: notes.map((note) => note._id), count: notes.length },
      createdAt: Date.now(),
    });
    for (const note of notes) {
      await ctx.db.patch(note._id, { claimedAt: Date.now(), digestId });
    }
    return {
      prepared: true as const,
      ...delivery,
      requestRunId: digestId,
      workItemId: notes[0].workItemId,
      noteIds: notes.map((note) => note._id),
      text: digestText({ agentName: agent.name, notes }),
    };
  },
});

export const recordManagerDigest = internalMutation({
  args: {
    agentId: v.id('agents'),
    noteIds: v.array(v.id('managerNotes')),
    ts: v.optional(v.string()),
    failure: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const failure = args.failure?.slice(0, 240);
    for (const noteId of args.noteIds) {
      const note = await ctx.db.get(noteId);
      if (!note) continue;
      // A digest that did not land releases its notes for the next one.
      await ctx.db.patch(noteId, {
        ...(args.ts ? { providerTs: args.ts } : { claimedAt: undefined, digestId: undefined }),
        ...(failure ? { failure } : {}),
      });
    }
    if (failure) {
      await ctx.db.insert('events', {
        agentId: args.agentId,
        type: 'work.manager-digest-failed',
        payload: { noteIds: args.noteIds, reason: failure },
        createdAt: Date.now(),
      });
    }
  },
});

/**
 * Decide, inside the hold transaction, what the gate will do with each action.
 *
 * The surfaces, grants and the agent's autonomous-actions toggle are read in
 * the same transaction that holds the run, so the verdicts describe the run
 * the manager is about to review (or that is about to apply on its own) and
 * a row refused here is refused at approval rather than failing at apply.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item being held.
 *   actions: The actions the skill emitted.
 *
 * Returns:
 *   The verdicts, one per action, and the toggle they were decided under.
 */
async function reviewHeldActions(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  actions: MockAction[],
  planStepOutcomes: readonly PlanStepOutcome[] | undefined,
): Promise<{ verdicts: ActionVerdict[]; autonomousActions: boolean; transitionDirectedByNote: boolean }> {
  const [agent, surfaceRows, grantRows] = await Promise.all([
    ctx.db.get(row.agentId),
    ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
      .collect(),
    ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', row.agentId))
      .collect(),
  ]);
  if (!agent) throw new Error('agent not found');
  if (SURFACE_MODE === 'mock') {
    return {
      verdicts: actions.map(() => ({ disposition: 'held', reason: HELD_WRITE })),
      autonomousActions: false,
      transitionDirectedByNote: false,
    };
  }
  const grants = new Set(grantRows.filter((grant) => !grant.revokedAt).map((grant) => grant.scope));
  const autonomousActions = autonomousActionsOn(agent);
  const browserRefusal = browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL);
  const plan = row.plan as ExecutionPlan | undefined;
  // A retry note that directs the state change in so many words is the
  // manager's decision already given; the hold then reads as any other write.
  const directed = plan
    ? transitionDirectedByNote({ plan, planStepOutcomes, feedback: row.managerFeedback, actions })
    : false;
  return {
    verdicts: reviewActions(
      actions,
      surfaceRows.map((surface) =>
        toSurfaceRecord(withBrowserComponentState(surface, browserRefusal)),
      ),
      grants,
      Date.now(),
      {
        autonomousActions,
        replyTarget: replyTargetFor(row),
        transitionWithheld: plan ? transitionWithheld(plan) && !directed : false,
      },
    ),
    autonomousActions,
    transitionDirectedByNote: directed,
  };
}

/**
 * The persisted verdicts in the current shape, by action index.
 *
 * Args:
 *   verdicts: The verdicts persisted when the run was held.
 *
 * Returns:
 *   One verdict per index; an index without one reads as `held`.
 */
export function verdictList(
  verdicts: Doc<'workItems'>['actionVerdicts'] | undefined,
  count: number,
): ActionVerdict[] {
  return Array.from({ length: count }, (_, index) =>
    normaliseActionVerdict(verdicts?.[index] ?? {}),
  );
}

function indexesWith(
  verdicts: readonly ActionVerdict[],
  disposition: ActionVerdict['disposition'],
): number[] {
  return verdicts.flatMap((verdict, index) => (verdict.disposition === disposition ? [index] : []));
}

/**
 * The hold-time reasons of a run's refused rows, keyed by action index.
 *
 * Args:
 *   verdicts: The verdicts persisted when the run was held.
 *   count: How many actions the run holds.
 *
 * Returns:
 *   `[index, reason]` pairs for every refused row.
 */
function refusedReasonEntries(
  verdicts: Doc<'workItems'>['actionVerdicts'] | undefined,
  count: number,
): Array<[number, string]> {
  return verdictList(verdicts, count).flatMap(
    (verdict, index): Array<[number, string]> =>
      verdict.disposition === 'refused' ? [[index, verdict.reason]] : [],
  );
}

function actionsOf(output: unknown): unknown[] {
  return ((output ?? {}) as { actions?: unknown[] }).actions ?? [];
}

interface LedgerPhase {
  actions: MockAction[];
  applied: Array<{ ok?: boolean; held?: boolean; outcomeUnknown?: boolean }>;
}

/** Every action list and ledger a run's output carries, prerequisite phase first. */
export function ledgerPhases(output: unknown): LedgerPhase[] {
  const phases: LedgerPhase[] = [];
  const top = (output ?? {}) as {
    actions?: MockAction[];
    applied?: LedgerPhase['applied'];
    initial?: { actions?: MockAction[]; applied?: LedgerPhase['applied'] };
  };
  if (top.initial && (top.initial.actions || top.initial.applied)) {
    phases.push({ actions: top.initial.actions ?? [], applied: top.initial.applied ?? [] });
  }
  phases.push({ actions: top.actions ?? [], applied: top.applied ?? [] });
  return phases;
}

function ledgerOf(output: unknown): Array<AppliedAction | undefined> {
  return ((output ?? {}) as { applied?: Array<AppliedAction | undefined> }).applied ?? [];
}

/**
 * Schedule the apply for the row's current approved set, with its recovery timer.
 *
 * Args:
 *   ctx: Mutation context.
 *   workItemId: The work item.
 *   pendingRunId: The run the approval belongs to.
 */
async function scheduleApply(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  pendingRunId: Id<'events'>,
  phase: 'auto' | 'approved',
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.workActions.applyApprovedActions, { workItemId });
  await ctx.scheduler.runAfter(APPLY_RECOVERY_MS, internal.work.recoverInterruptedApply, {
    workItemId,
    pendingRunId,
    phase,
  });
}

/**
 * Hold an executing run at the exact-action gate and apply what the gate allows.
 *
 * Called by the action that ran the day0 skill instead of applying anything
 * itself. The draft, notes and literal `actions` are persisted with
 * the run id and one verdict per row. Rows the gate classifies `auto` are
 * approved here and applied by the same scheduled path a manager's approval
 * uses, while the row stays `executing`; when nothing is `auto` the row moves
 * to `actions-pending` at once. The hold event records whether autonomous
 * actions were on, so the audit trail shows the mode the verdicts were
 * decided under. Guarded on `executing` so a late caller cannot reopen a run
 * the manager has already decided.
 */
export const setActionsPending = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    runId: v.id('events'),
    output: v.any(),
    authoringAttemptId: v.optional(v.id('events')),
  },
  handler: async (ctx, args): Promise<{ pending: boolean; phase?: 'auto' | 'manager' }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (row.state !== 'executing') return { pending: false };
    if (row.executionRunId !== args.runId || row.pendingRunId !== undefined) {
      return { pending: false };
    }
    const dependent = args.authoringAttemptId !== undefined;
    // A closing set must not accept a delayed approval of phase one's indexes.
    const pendingId = args.authoringAttemptId ?? args.runId;
    if (
      dependent
        ? row.applyAttemptId !== args.authoringAttemptId ||
          (args.output as { phase?: unknown }).phase !== 'dependent'
        : row.applyAttemptId !== undefined
    ) {
      return { pending: false };
    }
    const actions = (args.output as { actions?: unknown[] }).actions;
    if (!Array.isArray(actions)) throw new Error('output.actions must be a list');
    const { verdicts: actionVerdicts, autonomousActions, transitionDirectedByNote } = await reviewHeldActions(
      ctx,
      row,
      actions as MockAction[],
      (args.output as { planStepOutcomes?: PlanStepOutcome[] }).planStepOutcomes,
    );
    const autoIndexes = indexesWith(actionVerdicts, 'auto');
    const heldIndexes = indexesWith(actionVerdicts, 'held');
    const refusedIndexes = indexesWith(actionVerdicts, 'refused');
    const refusals = refusedReasonEntries(actionVerdicts, actions.length).map(
      ([index, reason]) => ({ index, reason }),
    );
    const payload = {
      workItemId: args.workItemId,
      runId: args.runId,
      actionCount: actions.length,
      autoIndexes,
      heldIndexes,
      refusedIndexes,
      ...(refusals.length > 0 ? { refusals } : {}),
      autonomousActions,
      ...(dependent ? { dependentPhase: true } : {}),
      ...(transitionDirectedByNote ? { transitionDirectedByNote: true } : {}),
    };
    if (autoIndexes.length > 0) {
      await ctx.db.patch(args.workItemId, {
        output: args.output,
        pendingRunId: pendingId,
        approvedIndexes: autoIndexes,
        applyPhase: 'auto',
        actionVerdicts,
        applyAttemptId: undefined,
        applyClaimedAt: undefined,
      });
      await ctx.db.insert('events', {
        agentId: row.agentId,
        type: 'work.actions-auto-applying',
        payload,
        createdAt: Date.now(),
      });
      await scheduleApply(ctx, args.workItemId, pendingId, 'auto');
      return { pending: true, phase: 'auto' };
    }
    await ctx.db.patch(args.workItemId, {
      state: 'actions-pending',
      output: args.output,
      pendingRunId: pendingId,
      approvedIndexes: undefined,
      applyPhase: undefined,
      actionVerdicts,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-pending',
      payload,
      createdAt: Date.now(),
    });
    await scheduleDecisionRequest(ctx, row, 'actions');
    return { pending: true, phase: 'manager' };
  },
});

/**
 * Park a run whose auto rows have landed until the manager decides the rest.
 *
 * Called by the apply action after the auto phase when held rows remain. The
 * ledger it hands over carries the auto rows as applied and the held rows as
 * awaiting approval; the manager's approval replaces the placeholders. Fenced
 * on the run and on the apply attempt, so a late caller cannot park a run
 * that has moved on.
 */
export const setAwaitingApproval = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    runId: v.id('events'),
    applyAttemptId: v.id('events'),
    output: v.any(),
  },
  handler: async (ctx, args): Promise<{ parked: boolean }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (
      row.state !== 'executing' ||
      row.executionRunId !== args.runId ||
      row.applyAttemptId !== args.applyAttemptId ||
      row.applyPhase !== 'auto'
    ) {
      return { parked: false };
    }
    const actions = actionsOf(args.output);
    const verdicts = verdictList(row.actionVerdicts, actions.length);
    const refusals = refusedReasonEntries(verdicts, actions.length).map(([index, reason]) => ({
      index,
      reason,
    }));
    await ctx.db.patch(args.workItemId, {
      state: 'actions-pending',
      output: args.output,
      approvedIndexes: undefined,
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-pending',
      payload: {
        workItemId: args.workItemId,
        runId: args.runId,
        actionCount: actions.length,
        autoIndexes: indexesWith(verdicts, 'auto'),
        heldIndexes: indexesWith(verdicts, 'held'),
        refusedIndexes: indexesWith(verdicts, 'refused'),
        ...(refusals.length > 0 ? { refusals } : {}),
        autoApplied: true,
      },
      createdAt: Date.now(),
    });
    await scheduleDecisionRequest(ctx, row, 'actions');
    return { parked: true };
  },
});

/**
 * Approve some or all of the held actions and schedule their application.
 *
 * The indexes are validated against the persisted list and its verdicts,
 * deduplicated and sorted; an index outside the list is refused rather than
 * ignored, because a stale card must not silently approve a different action
 * than it showed. Only `held` rows can be approved: an `auto` row was applied
 * before the manager saw the card and a `refused` row can never be applied.
 * Approving nothing is allowed and lands nothing: every held row is then
 * recorded as not approved.
 */
export const approveActions = mutation({
  args: {
    workItemId: v.id('workItems'),
    pendingRunId: v.id('events'),
    approvedIndexes: v.array(v.number()),
  },
  handler: async (ctx, args): Promise<{ ok: true; approvedIndexes: number[] }> => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    return await approveActionsInTransaction(ctx, row, args, 'dashboard');
  },
});

/**
 * Approve held actions across several items in one transaction.
 *
 * Each member is the same exact approval the single-item control sends: the
 * run whose literal payloads were shown fences it, and the indexes name the
 * rows. The batch is all or nothing, so a member whose run moved on refuses
 * the whole batch and the manager decides again from a fresh list; every
 * member's apply keeps its own idempotency keys, keyed by its item and run.
 */
export const approveActionsBatch = mutation({
  args: {
    members: v.array(
      v.object({
        workItemId: v.id('workItems'),
        pendingRunId: v.id('events'),
        approvedIndexes: v.array(v.number()),
      }),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; approved: Array<{ workItemId: Id<'workItems'>; approvedIndexes: number[] }> }> => {
    if (args.members.length === 0) throw new Error('a batch approves at least one item');
    const seen = new Set<string>();
    const approved: Array<{ workItemId: Id<'workItems'>; approvedIndexes: number[] }> = [];
    for (const member of args.members) {
      if (seen.has(member.workItemId)) throw new Error('an item appears twice in the batch');
      seen.add(member.workItemId);
      const row = await assertOwnsWorkItem(ctx, member.workItemId);
      const result = await approveActionsInTransaction(ctx, row, member, 'dashboard');
      approved.push({ workItemId: member.workItemId, approvedIndexes: result.approvedIndexes });
    }
    return { ok: true, approved };
  },
});

/** Record one batch code over the open action decisions it was issued for. */
export const prepareDecisionBatch = internalMutation({
  args: {
    agentId: v.id('agents'),
    batchId: v.string(),
    surfaceSlug: v.string(),
    channel: v.string(),
    members: v.array(
      v.object({
        workItemId: v.id('workItems'),
        decisionId: v.string(),
        pendingRunId: v.id('events'),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ prepared: boolean; reason?: string }> => {
    if (!/^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/.test(args.batchId)) {
      throw new Error('batch id is not a six-character random token');
    }
    if (args.members.length < 2) return { prepared: false, reason: 'a batch names at least two decisions' };
    const [itemCollision, batchCollision] = await Promise.all([
      ctx.db
        .query('workItems')
        .withIndex('by_agent_decision', (q) => q.eq('agentId', args.agentId).eq('decision.id', args.batchId))
        .first(),
      ctx.db
        .query('decisionBatches')
        .withIndex('by_agent_id', (q) => q.eq('agentId', args.agentId).eq('id', args.batchId))
        .first(),
    ]);
    if (itemCollision || batchCollision) return { prepared: false, reason: 'batch id collision' };
    await ctx.db.insert('decisionBatches', {
      agentId: args.agentId,
      id: args.batchId,
      surfaceSlug: args.surfaceSlug,
      channel: args.channel,
      members: args.members,
      requestedAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'work.decision-batch-issued',
      payload: { batchId: args.batchId, members: args.members },
      createdAt: Date.now(),
    });
    return { prepared: true };
  },
});

async function approveActionsInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  args: {
    workItemId: Id<'workItems'>;
    pendingRunId: Id<'events'>;
    approvedIndexes: number[];
  },
  via: DecisionVia,
  messageTs?: string,
): Promise<{ ok: true; approvedIndexes: number[] }> {
  if (row.state !== 'actions-pending') {
    throw new Error(`workItem state is ${row.state}; expected actions-pending`);
  }
  if (!row.pendingRunId) throw new Error('workItem has no pending run');
  if (row.pendingRunId !== args.pendingRunId) {
    throw new Error('pending run changed; refresh the action list');
  }
  if (row.approvedIndexes !== undefined) {
    throw new Error('actions have already been approved');
  }
  const actions = actionsOf(row.output);
  const verdicts = verdictList(row.actionVerdicts, actions.length);
  const approvedIndexes = [...new Set(args.approvedIndexes)].sort((a, b) => a - b);
  for (const index of approvedIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= actions.length) {
      throw new Error(`action index ${index} is outside the pending list`);
    }
    const verdict = verdicts[index];
    if (verdict.disposition === 'refused') {
      throw new Error(
        `action ${index + 1} is refused (${verdict.reason}); approve the others by selection`,
      );
    }
    if (verdict.disposition === 'auto') {
      throw new Error(`action ${index + 1} was applied automatically and cannot be approved again`);
    }
  }
  const heldIndexes = indexesWith(verdicts, 'held');
  const rejectedIndexes = heldIndexes.filter((index) => !approvedIndexes.includes(index));
  await ctx.db.patch(args.workItemId, {
    approvedIndexes,
    applyPhase: 'approved',
    ...decidedPatch(row, 'actions', via, 'approved', messageTs),
  });
  await ctx.db.insert('events', {
    agentId: row.agentId,
    type: 'work.actions-approved',
    payload: {
      workItemId: args.workItemId,
      runId: row.pendingRunId,
      approvedIndexes,
      rejectedIndexes,
      refusedIndexes: indexesWith(verdicts, 'refused'),
      autoIndexes: indexesWith(verdicts, 'auto'),
      decidedVia: via,
    },
    createdAt: Date.now(),
  });
  await scheduleApply(ctx, args.workItemId, row.pendingRunId, 'approved');
  return { ok: true, approvedIndexes };
}

/**
 * Refuse the held actions. The row fails with the manager's reason and the
 * draft is kept. Rows the auto phase already applied stay in the ledger, so
 * Retry is fenced by them; a run nothing landed for resumes from
 * `plan-approved` and runs the skill again.
 */
export const rejectActions = mutation({
  args: { workItemId: v.id('workItems'), pendingRunId: v.id('events'), reason: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    return await rejectActionsInTransaction(ctx, row, args, 'dashboard');
  },
});

async function rejectActionsInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  args: { workItemId: Id<'workItems'>; pendingRunId: Id<'events'>; reason: string },
  via: DecisionVia,
  messageTs?: string,
): Promise<{ ok: true }> {
  if (row.state !== 'actions-pending') {
    throw new Error(`workItem state is ${row.state}; expected actions-pending`);
  }
  if (row.approvedIndexes !== undefined) {
    throw new Error('actions have already been approved');
  }
  if (!row.pendingRunId) throw new Error('workItem has no pending run');
  if (row.pendingRunId !== args.pendingRunId) {
    throw new Error('pending run changed; refresh the action list');
  }
  const feedback = managerText(args.reason);
  const reason = feedback.slice(0, 200);
  const skipReason = reason ? `rejected by the manager: ${reason}` : 'rejected by the manager';
  const applied = ledgerOf(row.output);
  const output =
    applied.length > 0
      ? {
          ...(row.output as Record<string, unknown>),
          applied: applied.map((entry) =>
            entry?.awaitingApproval
              ? { ...entry, awaitingApproval: undefined, reason: skipReason }
              : entry,
          ),
        }
      : undefined;
  await ctx.db.patch(args.workItemId, {
    state: 'failed',
    skipReason,
    ...(output !== undefined ? { output } : {}),
    ...(feedback
      ? {
          managerFeedback: {
            reason: feedback,
            at: Date.now(),
            runId: args.pendingRunId,
            kind: 'rejection' as const,
          },
        }
      : {}),
    pendingRunId: undefined,
    approvedIndexes: undefined,
    actionVerdicts: undefined,
    applyPhase: undefined,
    executionRunId: undefined,
    applyAttemptId: undefined,
    applyClaimedAt: undefined,
    ...decidedPatch(row, 'actions', via, 'rejected', messageTs),
  });
  if (feedback) await keepCorrectionInTransaction(ctx, row, 'rejection', feedback, args.pendingRunId);
  await ctx.db.insert('events', {
    agentId: row.agentId,
    type: 'work.actions-rejected',
    payload: { workItemId: args.workItemId, reason: skipReason, decidedVia: via },
    createdAt: Date.now(),
  });
  await scheduleNextStep(ctx, { ...row, state: 'failed' });
  return { ok: true };
}

/** Resolve one parsed manager reply inside the same transaction as the dashboard controls. */
/**
 * Read a chat provider's message timestamp as epoch milliseconds.
 *
 * Slack and the Slack-shaped MCP tools give `seconds.fraction`; a generic
 * history tool may give an ISO date. Anything else reads as unknown, so a
 * provider with an unfamiliar clock keeps today's behaviour rather than
 * having its replies dropped.
 *
 * Args:
 *   ts: The provider's message timestamp as received.
 *
 * Returns:
 *   Epoch milliseconds, or null when the string is not a timestamp.
 */
export function providerTsToMs(ts: string): number | null {
  if (/^\d+(\.\d+)?$/.test(ts)) return Number(ts) * 1_000;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? null : parsed;
}

export const resolveChannelDecision = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    userId: v.string(),
    messageTs: v.string(),
    reply: v.object({
      verb: v.union(v.literal('approve'), v.literal('reject')),
      id: v.string(),
      reason: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface || surface.class !== 'chat') {
      return { status: 'ignored' as const, reason: 'not a chat surface' };
    }
    // The first poll of a manager DM has no checkpoint and reads the channel's
    // history, which on a reused workspace holds the codes of every earlier
    // agent. A reply written before this agent was deployed cannot answer one
    // of its requests, so it is neither logged nor answered.
    const agent = await ctx.db.get(surface.agentId);
    const messageAt = providerTsToMs(args.messageTs);
    if (agent && messageAt !== null && messageAt < agent.createdAt) {
      return { status: 'ignored' as const, reason: 'predates the agent' };
    }
    const ignored = async (reason: string) => {
      await ctx.db.insert('events', {
        agentId: surface.agentId,
        type: 'work.decision-ignored',
        payload: {
          surfaceId: surface._id,
          messageTs: args.messageTs,
          userId: args.userId,
          reason,
        },
        createdAt: Date.now(),
      });
      return { status: 'ignored' as const, reason };
    };
    if (args.userId === surface.providerIdentityId) return await ignored('bot message');
    if (!surface.managerUserId || args.userId !== surface.managerUserId) {
      return await ignored('manager identity mismatch');
    }
    const unknown = async (reason: string) => {
      const anchor = await managerReplyNoticeAnchor(ctx, surface);
      const notified = anchor
        ? await queueManagerReplyNotice(ctx, {
            surfaceId: surface._id,
            workItemId: anchor._id,
            decisionId: args.reply.id,
            messageTs: args.messageTs,
            kind: 'unknown',
            text: `I couldn’t find decision ${args.reply.id}. Check the six-character token and try again.`,
          })
        : false;
      return { ...(await ignored(reason)), notified };
    };
    const row = await ctx.db
      .query('workItems')
      .withIndex('by_agent_decision', (q) =>
        q.eq('agentId', surface.agentId).eq('decision.id', args.reply.id),
      )
      .first();
    if (!row?.decision) {
      const batch = await ctx.db
        .query('decisionBatches')
        .withIndex('by_agent_id', (q) => q.eq('agentId', surface.agentId).eq('id', args.reply.id))
        .first();
      if (!batch) return await unknown('unknown decision id');
      return await resolveChannelBatch(ctx, surface, batch, args);
    }
    if (
      row.decision.surfaceSlug !== surface.slug ||
      row.decision.channel !== surface.managerDmChannelId
    ) {
      return await unknown('decision belongs to another manager channel');
    }

    const expectedState = row.decision.kind === 'plan' ? 'plan-pending' : 'actions-pending';
    if (row.decision.decidedAt || row.state !== expectedState) {
      // The intake reads its checkpoint boundary inclusively and re-reads anything that
      // arrived during a sweep, so the very message that decided comes back on a later
      // poll. That is the manager's one reply, not a duplicate: nothing to say.
      if (row.decision.decidedTs === args.messageTs) {
        return { status: 'already-decided' as const, notified: false };
      }
      if (!row.decision.duplicateNotifiedAt) {
        await ctx.db.patch(row._id, {
          decision: { ...row.decision, duplicateNotifiedAt: Date.now() },
        });
        await ctx.db.insert('events', {
          agentId: row.agentId,
          type: 'work.decision-duplicate',
          payload: {
            workItemId: row._id,
            decisionId: row.decision.id,
            messageTs: args.messageTs,
          },
          createdAt: Date.now(),
        });
        await ctx.scheduler.runAfter(0, internal.managerChannelActions.sendDecisionNotice, {
          workItemId: row._id,
          decisionId: row.decision.id,
        });
        return { status: 'already-decided' as const, notified: true };
      }
      return { status: 'already-decided' as const, notified: false };
    }

    if (row.decision.kind === 'plan') {
      if (args.reply.verb === 'approve') {
        await approvePlanInTransaction(ctx, row, 'channel', args.messageTs);
      } else {
        await cancelPlanInTransaction(ctx, row, 'channel', args.reply.reason ?? '', args.messageTs);
      }
    } else {
      if (!row.pendingRunId) return await ignored('actions decision has no pending run');
      if (args.reply.verb === 'approve') {
        const actionCount = actionsOf(row.output).length;
        const heldIndexes = indexesWith(verdictList(row.actionVerdicts, actionCount), 'held');
        await approveActionsInTransaction(
          ctx,
          row,
          {
            workItemId: row._id,
            pendingRunId: row.pendingRunId,
            approvedIndexes: heldIndexes,
          },
          'channel',
          args.messageTs,
        );
      } else {
        await rejectActionsInTransaction(
          ctx,
          {
            ...row,
          },
          {
            workItemId: row._id,
            pendingRunId: row.pendingRunId,
            reason: args.reply.reason ?? '',
          },
          'channel',
          args.messageTs,
        );
      }
    }
    const noun = args.reply.verb === 'approve' ? 'Approval' : 'Rejection';
    const text =
      args.reply.verb === 'approve'
        ? row.decision.kind === 'plan'
          ? `${noun} ${row.decision.id} received. I’m starting the approved plan now.`
          : `${noun} ${row.decision.id} received. I’m applying the approved actions now.`
        : `${noun} ${row.decision.id} received. I won’t apply it.`;
    await queueManagerReplyNotice(ctx, {
      surfaceId: surface._id,
      workItemId: row._id,
      decisionId: row.decision.id,
      messageTs: args.messageTs,
      kind: 'received',
      text,
    });
    return { status: 'decided' as const, outcome: args.reply.verb };
  },
});

/**
 * Take the approved actions for application, exactly once.
 *
 * The apply action is scheduled by `setActionsPending` (the auto phase) and
 * by `approveActions` (the manager's), and may be scheduled again after a
 * restart; whichever caller records the apply attempt on the row is the one
 * that applies. In the auto phase the row is still `executing` and the fence
 * is the absent attempt id; in the approved phase it moves the row from
 * `actions-pending` back to `executing`. The caller gets everything it needs
 * from the row so it never re-reads state that may have moved. The toggle is
 * read here, in the claim's transaction, so the apply backstop sees the
 * manager's latest word rather than the one the hold was decided under.
 */
export const claimApprovedActions = internalMutation({
  args: { workItemId: v.id('workItems') },
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        claimed: true;
        agentId: Id<'agents'>;
        runId: Id<'events'>;
        pendingRunId: Id<'events'>;
        applyAttemptId: Id<'events'>;
        phase: 'auto' | 'approved';
        approvedIndexes: number[];
        heldIndexes: number[];
        heldReasons: Array<[number, string]>;
        autonomousActions: boolean;
        replyTarget?: ReplyTarget;
        output: unknown;
      }
    | { claimed: false; reason: string }
  > => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    const autoPhase =
      row.state === 'executing' && row.applyPhase === 'auto' && row.applyAttemptId === undefined;
    if (row.state !== 'actions-pending' && !autoPhase) {
      return { claimed: false, reason: `workItem state is ${row.state}; expected actions-pending` };
    }
    if (!row.pendingRunId) return { claimed: false, reason: 'workItem has no pending run' };
    if (!row.approvedIndexes) return { claimed: false, reason: 'no actions have been approved' };
    // A missing agent row is the apply action's failure to report (it fences
    // the run as outcome-unknown); the claim only needs the switch's value.
    const agent = await ctx.db.get(row.agentId);
    const applyAttemptId = await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-applying',
      payload: {
        workItemId: args.workItemId,
        runId: row.executionRunId ?? row.pendingRunId,
        phase: autoPhase ? 'auto' : 'approved',
      },
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.workItemId, {
      state: 'executing',
      applyAttemptId,
      applyClaimedAt: Date.now(),
    });
    const count = actionsOf(row.output).length;
    return {
      claimed: true,
      agentId: row.agentId,
      runId: row.executionRunId ?? row.pendingRunId,
      pendingRunId: row.pendingRunId,
      applyAttemptId,
      phase: autoPhase ? 'auto' : 'approved',
      approvedIndexes: row.approvedIndexes,
      heldIndexes: indexesWith(verdictList(row.actionVerdicts, count), 'held'),
      heldReasons: refusedReasonEntries(row.actionVerdicts, count),
      autonomousActions: agent ? autonomousActionsOn(agent) : false,
      replyTarget: replyTargetFor(row),
      output: row.output,
    };
  },
});

/**
 * Recover an apply action that disappeared across a backend interruption.
 *
 * An unclaimed approved set - the manager's, or the gate's auto rows - is
 * safe to reschedule. Once an apply claim exists, the provider may already
 * have accepted a request, so recovery records every outcome of this phase
 * as unknown, keeps what an earlier phase already recorded, and refuses
 * automatic replay.
 */
export const recoverInterruptedApply = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    pendingRunId: v.id('events'),
    phase: v.union(v.literal('auto'), v.literal('approved')),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ recovered: 'ignored' | 'rescheduled' | 'outcome-unknown' }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row || row.pendingRunId !== args.pendingRunId || row.applyPhase !== args.phase) {
      return { recovered: 'ignored' };
    }
    const unclaimedAuto =
      row.state === 'executing' && row.applyPhase === 'auto' && row.applyAttemptId === undefined;
    if ((row.state === 'actions-pending' && row.approvedIndexes !== undefined) || unclaimedAuto) {
      await scheduleApply(ctx, args.workItemId, args.pendingRunId, args.phase);
      return { recovered: 'rescheduled' };
    }
    if (row.state !== 'executing' || !row.applyAttemptId || !row.applyClaimedAt) {
      return { recovered: 'ignored' };
    }
    const output = (row.output ?? {}) as {
      actions?: Array<{ tool?: unknown }>;
      actionIndexOffset?: unknown;
      [key: string]: unknown;
    };
    const approved = new Set(row.approvedIndexes ?? []);
    const count = output.actions?.length ?? 0;
    const verdicts = verdictList(row.actionVerdicts, count);
    const prior = ledgerOf(row.output);
    const actionIndexOffset =
      typeof output.actionIndexOffset === 'number' &&
      Number.isInteger(output.actionIndexOffset) &&
      output.actionIndexOffset >= 0
        ? output.actionIndexOffset
        : 0;
    // In the auto phase a held row was never offered to the manager, so it
    // keeps the reason the gate held it for; in the approved phase an
    // unapproved held row is one the manager left out.
    const heldReasonFor = (index: number): string => {
      const verdict = verdicts[index];
      if (verdict.disposition === 'refused') return verdict.reason;
      if (verdict.disposition === 'held' && row.applyPhase === 'auto') return verdict.reason;
      return HELD_NOT_APPROVED;
    };
    const applied = (output.actions ?? []).map((action, index) => {
      const earlier = prior[index];
      if (earlier && !earlier.awaitingApproval && !approved.has(index)) return earlier;
      return {
        tool: typeof action.tool === 'string' ? action.tool : 'unknown',
        ok: !approved.has(index),
        ...(approved.has(index)
          ? { reason: OUTCOME_UNKNOWN_REASON }
          : { held: true, reason: heldReasonFor(index) }),
        idempotencyKey: actionIdempotencyKey({
          workItemId: args.workItemId,
          runId: row.executionRunId ?? args.pendingRunId,
          actionIndex: index + actionIndexOffset,
        }),
      };
    });
    await ctx.db.patch(args.workItemId, {
      state: 'failed',
      skipReason: INTERRUPTED_APPLY_REASON,
      output: { ...output, applied },
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-interrupted',
      payload: {
        workItemId: args.workItemId,
        runId: row.executionRunId ?? args.pendingRunId,
        applyAttemptId: row.applyAttemptId,
      },
      createdAt: Date.now(),
    });
    await scheduleNextStep(ctx, { ...row, state: 'failed' });
    return { recovered: 'outcome-unknown' };
  },
});

export const setProposedSkill = internalMutation({
  args: { workItemId: v.id('workItems'), skillId: v.id('skills') },
  handler: async (ctx, args) => {
    await assertSameAgent(ctx, args.workItemId, args.skillId);
    await ctx.db.patch(args.workItemId, { proposedSkillId: args.skillId });
  },
});

const OPEN_CLAIM_STATES = new Set<string>(OPEN_WORK_STATES);

async function countOpenForAgentImpl(ctx: QueryCtx, agentId: Id<'agents'>): Promise<number> {
  const open = await ctx.db
    .query('workItems')
    .withIndex('by_agent_state', (q) => q.eq('agentId', agentId))
    .collect();
  return open.filter((w) => OPEN_CLAIM_STATES.has(w.state)).length;
}

async function findExistingClaimImpl(
  ctx: QueryCtx,
  args: { agentId: Id<'agents'>; sourceSystem: string; externalId: string },
): Promise<{ state: Doc<'workItems'>['state'] } | null> {
  const row = await ctx.db
    .query('workItems')
    .withIndex('by_extId', (q) =>
      q.eq('sourceSystem', args.sourceSystem).eq('externalId', args.externalId),
    )
    .filter((q) => q.eq(q.field('agentId'), args.agentId))
    .first();
  if (!row) return null;
  if (!OPEN_CLAIM_STATES.has(row.state)) return null;
  return { state: row.state };
}

export const countOpenForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<number> => {
    await assertOwnsAgent(ctx, args.agentId);
    return await countOpenForAgentImpl(ctx, args.agentId);
  },
});

/** The same count for a scheduled work-loop step, which has no caller to check. */
export const countOpenForAgentInternal = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<number> => await countOpenForAgentImpl(ctx, args.agentId),
});

const existingClaimArgs = {
  agentId: v.id('agents'),
  sourceSystem: v.string(),
  externalId: v.string(),
};

export const findExistingClaim = query({
  args: existingClaimArgs,
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await findExistingClaimImpl(ctx, args);
  },
});

/** The same lookup for a scheduled work-loop step, which has no caller to check. */
export const findExistingClaimInternal = internalQuery({
  args: existingClaimArgs,
  handler: async (ctx, args) => await findExistingClaimImpl(ctx, args),
});
