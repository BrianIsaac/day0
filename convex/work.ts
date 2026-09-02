import { v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsWorkItem, getCallerOrThrow } from './ownership';
import { actionIdempotencyKey } from '../src/work/idempotency';
import {
  HELD_NOT_APPROVED,
  HELD_WRITE,
  normaliseActionVerdict,
  reviewActions,
  type ActionVerdict,
} from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import type { AppliedAction } from '../src/surfaces/types';
import { autonomousActionsOn } from '../src/work/autonomy';
import { replyTargetFor } from '../src/work/reply-target';
import {
  AUTONOMOUS_WIP_LIMIT,
  COLD_START_WIP_LIMIT,
  type MockAction,
  type ReplyTarget,
} from '../src/work/types';
import type { DecisionKind } from '../src/work/manager-channel';
import {
  browserComponentRefusal,
  withBrowserComponentState,
} from '../src/surfaces/browser';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import {
  INTERRUPTED_APPLY_REASON,
  OUTCOME_UNKNOWN_REASON,
  providerReconciliationEntries,
  retryRequiresProviderReconciliation,
} from '../src/work/reconciliation';

export const APPLY_RECOVERY_MS = 6 * 60 * 1000;
/** The longest rejection reason kept in full for the retry to read. */
export const MANAGER_FEEDBACK_MAX_CHARS = 1000;
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
  return id;
}

export const seedItem = internalMutation({
  args: { agentId: v.id('agents'), ...workItemSeedFields },
  handler: async (ctx, args): Promise<Id<'workItems'>> =>
    await seedItemInTransaction(ctx, args),
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
    const openStates = [
      'claimed',
      'plan-pending',
      'plan-approved',
      'executing',
      'actions-pending',
    ] as const;
    let openClaims = 0;
    for (const state of openStates) {
      const remaining = wipCap - openClaims;
      if (remaining <= 0) break;
      openClaims += (
        await ctx.db
          .query('workItems')
          .withIndex('by_agent_state', (q) => q.eq('agentId', row.agentId).eq('state', state))
          .take(remaining)
      ).length;
    }
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
  });
  await ctx.db.insert('events', {
    agentId: row.agentId,
    type: 'work.evaluated',
    payload: { workItemId, decision, verdict: effective },
    createdAt: Date.now(),
  });
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
export const setPlan = internalMutation({
  args: { workItemId: v.id('workItems'), plan: v.any() },
  handler: async (ctx, args): Promise<{ stored: boolean }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (row.state !== 'claimed') return { stored: false };
    await ctx.db.patch(args.workItemId, { plan: args.plan, state: 'plan-pending' });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.plan-drafted',
      payload: { workItemId: args.workItemId, plan: args.plan },
      createdAt: Date.now(),
    });
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
  args: { workItemId: v.id('workItems') },
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
    return { approved: true };
  },
});

/** Claim the only outbound message for one parked decision state. */
export const prepareDecisionRequest = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    kind: v.union(v.literal('plan'), v.literal('actions')),
    decisionId: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    const expectedState = args.kind === 'plan' ? 'plan-pending' : 'actions-pending';
    if (row.state !== expectedState) {
      return { prepared: false as const, reason: `work item is ${row.state}` };
    }
    if (row.decision?.kind === args.kind && !row.decision.decidedAt) {
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
    const requestRunId = await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.decision-requesting',
      payload: { workItemId: row._id, decisionId: args.decisionId, kind: args.kind },
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
    };
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

async function approvePlanInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  via: DecisionVia,
  messageTs?: string,
): Promise<void> {
  if (row.state !== 'plan-pending') {
    throw new Error(`workItem state is ${row.state}; expected plan-pending`);
  }
  await ctx.db.patch(row._id, {
    state: 'plan-approved',
    ...decidedPatch(row, 'plan', via, 'approved', messageTs),
  });
  await ctx.db.insert('events', {
    agentId: row.agentId,
    type: 'work.plan-approved',
    payload: { workItemId: row._id, decidedVia: via },
    createdAt: Date.now(),
  });
  if (via === 'channel') {
    await ctx.scheduler.runAfter(0, internal.workActions.executeApprovedPlanInternal, {
      workItemId: row._id,
    });
  }
}

export const approvePlan = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    await approvePlanInTransaction(ctx, row, 'dashboard');
    return { ok: true };
  },
});

export const retryFailed = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    const recoverable = ['failed', 'skipped', 'cancelled'];
    if (!recoverable.includes(row.state)) {
      throw new Error(`workItem state is ${row.state}; expected one of ${recoverable.join(', ')}`);
    }
    if (
      retryRequiresProviderReconciliation(row.output, row.skipReason) &&
      !row.providerReconciliation
    ) {
      throw new Error(
        'retry refused because an external effect may already have landed; reconcile the provider first',
      );
    }
    const next: Doc<'workItems'>['state'] = row.plan
      ? 'plan-approved'
      : (row.verdict as { decision?: string } | undefined)?.decision === 'claim'
        ? 'claimed'
        : 'discovered';
    await ctx.db.patch(args.workItemId, {
      state: next,
      skipReason: undefined,
      executionRunId: undefined,
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
      providerReconciliation: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.retry',
      payload: { workItemId: args.workItemId, resumeState: next, fromState: row.state },
      createdAt: Date.now(),
    });
    return { ok: true, resumeState: next };
  },
});

export const reconcileFailed = mutation({
  args: { workItemId: v.id('workItems'), confirmed: v.boolean() },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (row.state !== 'failed') {
      throw new Error(`workItem state is ${row.state}; expected failed`);
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
  await ctx.db.patch(row._id, {
    state: 'cancelled',
    skipReason,
    ...decidedPatch(row, 'plan', via, 'rejected', messageTs),
  });
  await ctx.db.insert('events', {
    agentId: row.agentId,
    type: 'work.cancelled',
    payload: { workItemId: row._id, reason: skipReason, decidedVia: via },
    createdAt: Date.now(),
  });
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
      managerFeedback: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.completed',
      payload: { workItemId: args.workItemId, output: args.output },
      createdAt: Date.now(),
    });
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
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (args.runId && row.executionRunId !== args.runId) return;
    // A row that already reached an end state keeps it. Nothing legitimately
    // fails a completed run, and a losing caller must not add a second failure
    // record for a failure the winner already wrote.
    const terminal = ['completed', 'failed', 'cancelled', 'skipped'];
    if (terminal.includes(row.state)) return;
    await ctx.db.patch(args.workItemId, {
      state: 'failed',
      skipReason: args.reason,
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
        reason: args.reason,
        ...(args.output !== undefined ? { output: args.output } : {}),
      },
      createdAt: Date.now(),
    });
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
): Promise<{ verdicts: ActionVerdict[]; autonomousActions: boolean }> {
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
    };
  }
  const grants = new Set(grantRows.filter((grant) => !grant.revokedAt).map((grant) => grant.scope));
  const autonomousActions = autonomousActionsOn(agent);
  const browserRefusal = browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL);
  return {
    verdicts: reviewActions(
      actions,
      surfaceRows.map((surface) =>
        toSurfaceRecord(withBrowserComponentState(surface, browserRefusal)),
      ),
      grants,
      Date.now(),
      { autonomousActions, replyTarget: replyTargetFor(row) },
    ),
    autonomousActions,
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
    const { verdicts: actionVerdicts, autonomousActions } = await reviewHeldActions(
      ctx,
      row,
      actions as MockAction[],
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
    };
    if (autoIndexes.length > 0) {
      await ctx.db.patch(args.workItemId, {
        output: args.output,
        pendingRunId: args.runId,
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
      await scheduleApply(ctx, args.workItemId, args.runId, 'auto');
      return { pending: true, phase: 'auto' };
    }
    await ctx.db.patch(args.workItemId, {
      state: 'actions-pending',
      output: args.output,
      pendingRunId: args.runId,
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
  const feedback = args.reason.replace(/\s+/g, ' ').trim().slice(0, MANAGER_FEEDBACK_MAX_CHARS);
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
      ? { managerFeedback: { reason: feedback, at: Date.now(), runId: args.pendingRunId } }
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
  await ctx.db.insert('events', {
    agentId: row.agentId,
    type: 'work.actions-rejected',
    payload: { workItemId: args.workItemId, reason: skipReason, decidedVia: via },
    createdAt: Date.now(),
  });
  return { ok: true };
}

/** Resolve one parsed manager reply inside the same transaction as the dashboard controls. */
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
    if (!row?.decision) return await unknown('unknown decision id');
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
        runId: row.pendingRunId,
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
      runId: row.pendingRunId,
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
    if (!row || row.executionRunId !== args.pendingRunId || row.applyPhase !== args.phase) {
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
          runId: args.pendingRunId,
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
        runId: args.pendingRunId,
        applyAttemptId: row.applyAttemptId,
      },
      createdAt: Date.now(),
    });
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

export const countOpenForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<number> => {
    await assertOwnsAgent(ctx, args.agentId);
    const open = await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId))
      .collect();
    const openStates = new Set([
      'claimed',
      'plan-pending',
      'plan-approved',
      'executing',
      'actions-pending',
    ]);
    return open.filter((w) => openStates.has(w.state)).length;
  },
});

export const findExistingClaim = query({
  args: {
    agentId: v.id('agents'),
    sourceSystem: v.string(),
    externalId: v.string(),
  },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    const row = await ctx.db
      .query('workItems')
      .withIndex('by_extId', (q) =>
        q.eq('sourceSystem', args.sourceSystem).eq('externalId', args.externalId),
      )
      .filter((q) => q.eq(q.field('agentId'), args.agentId))
      .first();
    if (!row) return null;
    const claimedStates = [
      'claimed',
      'plan-pending',
      'plan-approved',
      'executing',
      'actions-pending',
    ];
    if (!claimedStates.includes(row.state)) return null;
    return { state: row.state };
  },
});
