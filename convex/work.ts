import { closingResume } from '../src/work/closing-resume';
import type { ExecutionPlan, PlanStepOutcome } from '../src/work/types';
import { ConvexError, v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { ticketSnapshotValidator } from './schema';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsWorkItem, getCallerOrThrow } from './ownership';
import { answerQuestionInTransaction, askOpenQuestionsAtPlan } from './managerQuestions';
import {
  firstTicketRejection,
  keepCorrectionInTransaction,
  markCorrectionsAppliedInTransaction,
} from './corrections';
import {
  AWAITING_CHARTER,
  claimLoopStepInTransaction,
  EVALUATION_ATTEMPTS_SPENT,
  EXECUTION_STALL_MS,
  isManagerChannel,
  OPEN_WORK_STATES,
  openSlotCount,
  resumeStalledStepsInTransaction,
  scheduleNextStep,
  STEP_LEASE_MS,
  type StepClaim,
} from './workLoop';
import { actionIdempotencyKey } from '../src/work/idempotency';
import {
  HELD_NOT_APPROVED,
  HELD_WRITE,
  isAuditComment,
  normaliseActionVerdict,
  parseSurfaceAction,
  reviewActions,
  type ActionVerdict,
} from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import { verdictFor } from '../src/surfaces/verdict';
import type { AppliedAction } from '../src/surfaces/types';
import { autonomousActionsOn } from '../src/work/autonomy';
import { isOpenQuestionStop, transitionWithheld } from '../src/work/obligations';
import { transitionDirectedByNote } from '../src/work/transition-direction';
import { replyTargetFor } from '../src/work/reply-target';
import type { TicketSnapshot } from '../src/work/ticket-ownership';
import {
  AUTONOMOUS_WIP_LIMIT,
  CLAIMED_BY_COLLEAGUE_SKIP_PREFIX,
  COLD_START_WIP_LIMIT,
  type MockAction,
  type ReplyTarget,
  OUT_OF_SCOPE_SKIP_PREFIX,
  QUALITY_FIT_SKIP_PREFIX,
  SCOPE_JUDGEMENT_UNAVAILABLE,
} from '../src/work/types';
import {
  HELD_ELSEWHERE_LIMIT,
  browserFieldId,
  providerItemKey,
  writeTargetIds,
  type ClaimHolder,
  type HeldExternalItem,
  type WriteClaimHolder,
} from '../src/work/claim-key';
import { landedWritesOf } from '../src/work/landed-writes';
import { isRevocationTrialRow } from './revocationEvaluation';
import {
  askedFor,
  batchDecisionNoticeText,
  DECISION_NOTICE_WINDOW_MS,
  DECISION_REQUEST_RECOVERY_MS,
  type DecisionKind,
  MANAGER_FEEDBACK_MAX_CHARS,
  NOTHING_OPEN,
  type OpenDecisionBatch,
  type OpenDecisionRequest,
  type OpenDecisions,
  undeliveredDecisionReason,
} from '../src/work/manager-channel';
import { browserComponentRefusal, withBrowserComponentState } from '../src/surfaces/browser';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { skillBodyHash } from '../src/work/skill-body';
import { missingSurfaceResolvedBy } from '../src/surfaces/identity';
import {
  INTERRUPTED_APPLY_REASON,
  OUTCOME_UNKNOWN_REASON,
  providerReconciliationEntries,
  retryRequiresProviderReconciliation,
} from '../src/work/reconciliation';
import { isStopped, landedNoteRows, landedWork, stopDetail, stoppedReason } from '../src/work/stop';
import {
  digestDue,
  digestText,
  landedNoteText,
  managerNotificationMode,
  stoppedNoteText,
  type ManagerNoteKind,
} from '../src/work/manager-notes';
import { agentZone } from '../src/lib/zone';
import { accessEnded, accessEndedReason } from '../src/work/surface-access';
import { appendEvent } from './eventLog';
import { retiredClaimOn, retiredHolderName } from './retirements';
import type { WorkActionsAutoApplyingPayload } from '../src/events/contract';

export const APPLY_RECOVERY_MS = 6 * 60 * 1000;
/**
 * How long a closing phase's authoring may hold its claim before its switch
 * fails the row. The backend kills a Node action after ten minutes; this is
 * the execution stall bound, so a live authoring is never failed under it.
 */
export const DEPENDENT_AUTHORING_RECOVERY_MS = EXECUTION_STALL_MS;
/** Why a closing phase whose authoring died is failed; Retry resumes it. */
export const DEPENDENT_AUTHORING_INTERRUPTED_REASON =
  'the closing phase was interrupted before its actions were written; the prerequisites stand and Retry resumes the closing phase';
/** Why a phase-one run with nothing held for the manager stops instead of parking. */
export const NOTHING_TO_DECIDE_REASON = 'the run held nothing for a decision';
/** Parked rows examined per state in one re-evaluation call; the rest continue by schedule. */
export const REEVALUATION_BATCH = 100;
export { MANAGER_FEEDBACK_MAX_CHARS };

/** The manager's words as kept: whitespace collapsed and capped at `MANAGER_FEEDBACK_MAX_CHARS`. */
function managerText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MANAGER_FEEDBACK_MAX_CHARS);
}
export { INTERRUPTED_APPLY_REASON };

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
  const available = surfaces.some(askableChannel);
  if (available) {
    await ctx.scheduler.runAfter(0, internal.managerChannelActions.requestDecision, {
      workItemId: row._id,
      kind,
    });
  }
}

/**
 * A manager chat channel the manager can be asked through now: connected
 * with the manager's ids (`isManagerChannel`), and its access end date not
 * passed, whatever the row says until the hourly sweep ends it (Q5, M21).
 *
 * @param surface - A surface row of the agent.
 * @returns True when a request or a note may be sent through it.
 */
function askableChannel(surface: Doc<'surfaces'>): boolean {
  return isManagerChannel(surface) && !accessEnded(surface, Date.now());
}

/**
 * Read the authority and connection state used at the provider boundary.
 *
 * The agent, grants and one surface are read in one transaction so an action
 * cannot combine a switch value from one revision with grants or a connection
 * from another. A surface whose access end date has passed is named as ended,
 * so the last boundary before a send refuses it whatever its row still says.
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
        /**
         * Why the surface is not connected though its row still says so: its
         * access end date passed before the hourly sweep ended it (Q5, M21).
         */
        accessEnded?: string;
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
      ...(surface?.expiresAt !== undefined && accessEnded(surface, Date.now())
        ? { accessEnded: accessEndedReason(surface.expiresAt, agentZone(agent)) }
        : {}),
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
  externalAlias: v.optional(v.string()),
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
  /** When the ask was made, by the provider's clock (a Linear `createdAt`), when intake read it. */
  askedAt: v.optional(v.number()),
  /** When intake read the item: the poll's start, the ask time when the provider gives none. */
  observedAt: v.optional(v.number()),
} as const;

export interface WorkItemSeedInput {
  agentId: Id<'agents'>;
  sourceCategory: string;
  sourceSystem: string;
  externalId: string;
  /** The item's other name, when the provider prints two. */
  externalAlias?: string;
  title: string;
  contentSummary: string;
  contentRefs: string[];
  priority?: string;
  requesterLabel?: string;
  owner?: string;
  requester?: string;
  replyTarget?: { channel: string; channelName?: string; threadTs?: string };
  /** When the ask was made, by the provider's clock, when intake read it. */
  askedAt?: number;
  /** When intake read the item: the poll's start. */
  observedAt?: number;
}

/**
 * When an item was asked for: the provider's time intake passed, else the
 * `ts` a Slack message's id carries (`<channel id>:<ts>`), else when intake
 * read it, else now. Cycle time (A9) starts here, so a chat ask seen on a
 * later poll still counts from the message.
 */
function askedAtOf(
  args: Pick<WorkItemSeedInput, 'askedAt' | 'externalId' | 'observedAt'>,
  now: number,
): number {
  if (args.askedAt !== undefined) return args.askedAt;
  const ts = /^[CDG][A-Z0-9]{6,}:(\d{9,10}\.\d{1,6})$/.exec(args.externalId)?.[1];
  const fromTs = ts === undefined ? null : providerTsToMs(ts);
  return fromTs === null ? (args.observedAt ?? now) : Math.round(fromTs);
}

/**
 * Give a row seeded before its item's other name was stored that name, on the
 * poll that next reads the item, and its live claim with it.
 *
 * Args:
 *   ctx: Mutation context of the seed.
 *   existing: The row the item already has.
 *   externalAlias: The other name this poll read, if the provider printed one.
 *   externalClaimAlias: The claim key of that name.
 */
async function rememberExternalAlias(
  ctx: MutationCtx,
  existing: Doc<'workItems'>,
  externalAlias: string | undefined,
  externalClaimAlias: string | undefined,
): Promise<void> {
  if (
    externalAlias === undefined ||
    !externalClaimAlias ||
    existing.externalClaimAlias !== undefined
  )
    return;
  if (existing.externalClaimKey === externalClaimAlias) return;
  await ctx.db.patch(existing._id, { externalAlias, externalClaimAlias });
  const held = await ctx.db
    .query('externalClaims')
    .withIndex('by_work_item', (q) => q.eq('workItemId', existing._id))
    .filter((q) => q.eq(q.field('releasedAt'), undefined))
    .collect();
  for (const claim of held) {
    if (claim.writeTarget === undefined && !claim.aliases?.includes(externalClaimAlias)) {
      await ctx.db.patch(claim._id, { aliases: [...(claim.aliases ?? []), externalClaimAlias] });
    }
  }
}

/** The ticket as a listing showed it, for the re-read before apply to compare with. */
const trackerSnapshot = ticketSnapshotValidator;

/** The event that keeps each listing's snapshot of a ticket in the live feed. */
export const WORK_LISTED_EVENT = 'work.listed';

/** A listing as it was kept: the ticket, and why intake refused it on that poll, if it did. */
interface KeptListing {
  readonly tracker: TicketSnapshot;
  readonly refused?: string;
  readonly listedAt: number;
}

/** A work item as the listing reads need it. */
type ListedItem = Pick<Doc<'workItems'>, '_id' | 'agentId' | '_creationTime'>;

/**
 * How many of an agent's discoveries at or after an item's creation the
 * first-listing read looks through. The discovery is written in the same
 * transaction as the row, so it is among the first few.
 */
const DISCOVERY_SCAN = 16;

/**
 * Keep one listing of a ticket in `ticketListings`, unless the same moment
 * is already kept for the item, so a copy made twice keeps one row.
 *
 * @returns Whether a row was written.
 */
export async function keepTicketListing(
  ctx: MutationCtx,
  row: Pick<Doc<'workItems'>, '_id' | 'agentId'>,
  listing: { tracker: TicketSnapshot; refused?: string; listedAt: number },
): Promise<boolean> {
  const kept = await ctx.db
    .query('ticketListings')
    .withIndex('by_work_item_listed_at', (q) =>
      q.eq('workItemId', row._id).eq('listedAt', listing.listedAt),
    )
    .first();
  if (kept !== null) return false;
  await ctx.db.insert('ticketListings', {
    agentId: row.agentId,
    workItemId: row._id,
    tracker: listing.tracker,
    listedAt: listing.listedAt,
    ...(listing.refused !== undefined ? { refused: listing.refused } : {}),
  });
  return true;
}

/**
 * The listing an item's discovery kept. Every ticket's first listing rides on
 * its `work.discovered` event, which is written with the row, so it is read
 * from the agent's discoveries at or after the row's creation.
 */
async function discoveryListing(ctx: QueryCtx, row: ListedItem): Promise<KeptListing | undefined> {
  const discoveries = await ctx.db
    .query('events')
    .withIndex('by_agent_type', (q) =>
      q
        .eq('agentId', row.agentId)
        .eq('type', 'work.discovered')
        .gte('_creationTime', row._creationTime),
    )
    .take(DISCOVERY_SCAN);
  const discovery = discoveries.find(
    (event) => (event.payload as { workItemId?: unknown } | undefined)?.workItemId === row._id,
  );
  const tracker = (discovery?.payload as { tracker?: TicketSnapshot } | undefined)?.tracker;
  return discovery && tracker ? { tracker, listedAt: discovery.createdAt } : undefined;
}

/**
 * The latest listing kept for an item, at or before a time.
 *
 * A later listing is a `ticketListings` row, read by the item's own index;
 * the first rides on the discovery, and a refused ticket is never discovered.
 * A listing kept only as a `work.listed` event before the table existed is
 * found once the `ticket-listings` migration has copied it.
 *
 * @param row - The item and its agent.
 * @param before - The latest listing time that counts.
 * @param acceptedOnly - Whether to pass over a listing intake refused.
 * @returns The listing, or undefined when the item was never listed by then.
 */
async function keptListingAt(
  ctx: QueryCtx,
  row: ListedItem,
  before: number,
  acceptedOnly: boolean,
): Promise<KeptListing | undefined> {
  const later = acceptedOnly
    ? await ctx.db
        .query('ticketListings')
        .withIndex('by_work_item_refused_listed_at', (q) =>
          q.eq('workItemId', row._id).eq('refused', undefined).lte('listedAt', before),
        )
        .order('desc')
        .first()
    : await ctx.db
        .query('ticketListings')
        .withIndex('by_work_item_listed_at', (q) =>
          q.eq('workItemId', row._id).lte('listedAt', before),
        )
        .order('desc')
        .first();
  if (later !== null) {
    return {
      tracker: later.tracker,
      listedAt: later.listedAt,
      ...(later.refused !== undefined ? { refused: later.refused } : {}),
    };
  }
  const first = await discoveryListing(ctx, row);
  return first !== undefined && first.listedAt <= before ? first : undefined;
}

/**
 * The latest snapshot a listing intake took the ticket on kept for an item,
 * at or before a time. A listing intake refused is never a baseline (review
 * B1): the refusal is a change the re-read must find, not the ticket the plan
 * was made for.
 *
 * @param row - The item and its agent.
 * @param before - The latest listing time that counts.
 * @returns The snapshot, or undefined when no accepted listing was kept by then.
 */
async function listedSnapshotAt(
  ctx: QueryCtx,
  row: ListedItem,
  before: number,
): Promise<TicketSnapshot | undefined> {
  return (await keptListingAt(ctx, row, before, true))?.tracker;
}

/** The snapshot fields, in one order, so two snapshots compare by value. */
const SNAPSHOT_FIELDS = [
  'assigned',
  'assigneeId',
  'assigneeEmail',
  'state',
  'stateType',
  'doNotAutomate',
] as const;

/** Whether two snapshots say the same about a ticket, whatever order their fields were stored in. */
function sameSnapshot(left: TicketSnapshot, right: TicketSnapshot): boolean {
  return SNAPSHOT_FIELDS.every((field) => left[field] === right[field]);
}

/**
 * Keep the ticket as this listing showed it, when it differs from the last
 * listing kept or intake's refusal of it changed, so the re-read before
 * apply can tell what changed since the plan was made. The listing goes to
 * `ticketListings` and, as before, to the live feed as `work.listed`. The
 * first listing is kept on the discovery event, so the feed gains a row only
 * when a ticket changes.
 *
 * @param refused - Why intake refused the ticket on this poll, when it did.
 */
async function recordListing(
  ctx: MutationCtx,
  row: ListedItem,
  tracker: TicketSnapshot | undefined,
  refused?: string,
): Promise<void> {
  if (tracker === undefined) return;
  const now = Date.now();
  const last = await keptListingAt(ctx, row, now, false);
  if (
    last !== undefined &&
    sameSnapshot(last.tracker, tracker) &&
    (last.refused === undefined) === (refused === undefined)
  ) {
    return;
  }
  await keepTicketListing(ctx, row, {
    tracker,
    listedAt: now,
    ...(refused !== undefined ? { refused } : {}),
  });
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: WORK_LISTED_EVENT,
    payload: { workItemId: row._id, tracker, ...(refused !== undefined ? { refused } : {}) },
    createdAt: now,
  });
}

/**
 * How many of an agent's Retries since a plan the acknowledged-listing read
 * looks through. A Retry of this item further back than that reads as no
 * Retry, so the re-read compares with the planned listing alone, the stricter
 * of the two.
 */
const RETRY_SCAN = 200;

/** How far `_creationTime` may sit before an event's own `createdAt` stamp. */
const CREATION_TIME_SLACK_MS = 1_000;

/**
 * The ticket as the listing a plan was made under showed it (the latest
 * listing intake took it on, at or before the given time), and as the
 * latest such listing showed it when the manager last pressed Retry after
 * that time, which the manager has seen. A listing intake refused is
 * neither. Internal; read by the apply.
 */
export const listedSnapshot = internalQuery({
  args: { workItemId: v.id('workItems'), before: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ planned: TicketSnapshot | null; acknowledged: TicketSnapshot | null }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) return { planned: null, acknowledged: null };
    const retries = await ctx.db
      .query('events')
      .withIndex('by_agent_type', (q) =>
        q
          .eq('agentId', row.agentId)
          .eq('type', 'work.retry')
          .gt('_creationTime', args.before - CREATION_TIME_SLACK_MS),
      )
      .order('desc')
      .take(RETRY_SCAN);
    const retry = retries.find(
      (event) =>
        (event.payload as { workItemId?: unknown } | undefined)?.workItemId === args.workItemId &&
        event.createdAt > args.before,
    );
    return {
      planned: (await listedSnapshotAt(ctx, row, args.before)) ?? null,
      acknowledged:
        retry === undefined ? null : ((await listedSnapshotAt(ctx, row, retry.createdAt)) ?? null),
    };
  },
});

/** How many of an item's runs the run numbering reads, oldest first. */
const RUN_SCAN_LIMIT = 200;

/**
 * An item's runs, oldest first, so a reused ledger row can name the run
 * that sent what it reuses ("reused from run 2"). Internal; read by the apply.
 */
export const executionRunIds = internalQuery({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<Array<Id<'events'>>> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) return [];
    const claims = await ctx.db
      .query('events')
      .withIndex('by_agent_type', (q) =>
        q.eq('agentId', row.agentId).eq('type', 'work.execution-claimed'),
      )
      .filter((q) => q.eq(q.field('payload.workItemId'), args.workItemId))
      .take(RUN_SCAN_LIMIT);
    return claims.map((claim) => claim._id);
  },
});

/** How a row intake withdrew says so on the card; its return is found by the same words. */
export const WITHDRAWN_FROM_QUEUE_PREFIX = 'withdrawn from the queue on the tracker: ';

/**
 * The states a withdrawal moves to `cancelled`: work that is only waiting,
 * and a `claimed` row whose plan is still being drafted, so the window
 * closes at intake (review B1): `setPlan` stores a plan only on a `claimed`
 * row, so none is stored for a ticket that left the queue. A row with a
 * plan, a decision or a run in flight is left to the re-read before apply,
 * which withholds its first write; a finished row stays as it finished.
 */
const WITHDRAWABLE_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set([
  'discovered',
  'deferred',
  'needs-skill',
  'claimed',
]);

/** The states whose row no longer follows the tracker: the work is done or given up. */
const SETTLED_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set(['completed', 'cancelled']);

/** The fields a re-listing brings up to date, as the tracker now shows them. */
const LISTED_FIELDS = [
  'title',
  'contentSummary',
  'contentRefs',
  'priority',
  'requesterLabel',
  'owner',
  'requester',
] as const;

/**
 * Bring an existing row up to what the tracker lists now (Q11): the fields
 * that changed are patched on a row still being worked or waiting, and a
 * row intake withdrew is cancelled with the reason, or returned to
 * `discovered` when its ticket is back in the queue.
 *
 * @param existing - The row the ticket already has.
 * @param args - The ticket as this poll listed it.
 * @param leftQueue - Why the ticket left the queue, when this poll refused it.
 */
async function refreshListedItem(
  ctx: MutationCtx,
  existing: Doc<'workItems'>,
  args: WorkItemSeedInput,
  leftQueue: string | undefined,
): Promise<void> {
  const withdrawn =
    existing.state === 'cancelled' && existing.skipReason?.startsWith(WITHDRAWN_FROM_QUEUE_PREFIX);
  if (SETTLED_STATES.has(existing.state) && !withdrawn) return;
  const changed = Object.fromEntries(
    LISTED_FIELDS.flatMap((field) =>
      JSON.stringify(existing[field]) === JSON.stringify(args[field]) ? [] : [[field, args[field]]],
    ),
  ) as Partial<Pick<Doc<'workItems'>, (typeof LISTED_FIELDS)[number]>>;
  const now = Date.now();
  if (leftQueue !== undefined && WITHDRAWABLE_STATES.has(existing.state)) {
    const skipReason = `${WITHDRAWN_FROM_QUEUE_PREFIX}${leftQueue}`;
    await ctx.db.patch(existing._id, { ...changed, state: 'cancelled', skipReason });
    await releaseExternalClaim(ctx, existing._id, now);
    await appendEvent(ctx, {
      agentId: existing.agentId,
      type: 'work.withdrawn',
      payload: { workItemId: existing._id, reason: skipReason, fromState: existing.state },
      createdAt: now,
    });
    await scheduleNextStep(ctx, { ...existing, state: 'cancelled' });
    return;
  }
  if (leftQueue !== undefined && withdrawn) {
    const skipReason = `${WITHDRAWN_FROM_QUEUE_PREFIX}${leftQueue}`;
    await ctx.db.patch(existing._id, { ...changed, skipReason });
    return;
  }
  if (leftQueue === undefined && withdrawn) {
    await ctx.db.patch(existing._id, {
      ...changed,
      state: 'discovered',
      skipReason: undefined,
      evaluationClaimedAt: undefined,
    });
    await appendEvent(ctx, {
      agentId: existing.agentId,
      type: 'work.returned',
      payload: { workItemId: existing._id, title: args.title },
      createdAt: now,
    });
    await scheduleNextStep(ctx, { ...existing, state: 'discovered' });
    return;
  }
  if (Object.keys(changed).length > 0) await ctx.db.patch(existing._id, changed);
}

/** The row an agent already holds for a listed item, if any. */
async function listedRow(
  ctx: MutationCtx,
  args: Pick<WorkItemSeedInput, 'agentId' | 'sourceSystem' | 'externalId'>,
): Promise<Doc<'workItems'> | null> {
  return await ctx.db
    .query('workItems')
    .withIndex('by_agent_extId', (q) =>
      q
        .eq('agentId', args.agentId)
        .eq('sourceSystem', args.sourceSystem)
        .eq('externalId', args.externalId),
    )
    .first();
}

/**
 * Seed one listed item, or bring its existing row up to the listing.
 * Shares intake's idempotency boundary with fixed evaluation task batches.
 */
export async function seedItemInTransaction(
  ctx: MutationCtx,
  { tracker, ...args }: WorkItemSeedInput & { tracker?: TicketSnapshot },
): Promise<Id<'workItems'>> {
  const existing = await listedRow(ctx, args);
  if (existing) {
    await refreshListedItem(ctx, existing, args, undefined);
    await recordListing(ctx, existing, tracker);
  }
  // An existing row is read again for its other name only while it still lacks it.
  if (existing && (args.externalAlias === undefined || existing.externalClaimAlias !== undefined)) {
    return existing._id;
  }
  let externalClaimKey: string | undefined;
  let externalClaimAlias: string | undefined;
  if (SURFACE_MODE === 'real') {
    const surface = await ctx.db
      .query('surfaces')
      .withIndex('by_agent_slug', (q) =>
        q.eq('agentId', args.agentId).eq('slug', args.sourceSystem),
      )
      .first();
    if (surface) {
      externalClaimKey = providerItemKey(surface, args, SURFACE_MODE);
      if (args.externalAlias !== undefined) {
        externalClaimAlias = providerItemKey(
          surface,
          { sourceSystem: args.sourceSystem, externalId: args.externalAlias },
          SURFACE_MODE,
        );
      }
    }
  }
  if (existing) {
    await rememberExternalAlias(ctx, existing, args.externalAlias, externalClaimAlias);
    return existing._id;
  }
  const { externalAlias, askedAt, observedAt, ...seed } = args;
  const id = await ctx.db.insert('workItems', {
    ...seed,
    ...(externalClaimKey ? { externalClaimKey } : {}),
    ...(externalAlias !== undefined && externalClaimAlias
      ? { externalAlias, externalClaimAlias }
      : {}),
    state: 'discovered',
    observedAt: askedAtOf({ askedAt, externalId: args.externalId, observedAt }, Date.now()),
    createdAt: Date.now(),
  });
  await appendEvent(ctx, {
    agentId: args.agentId,
    type: 'work.discovered',
    payload: { workItemId: id, title: args.title, ...(tracker ? { tracker } : {}) },
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

/** Seed one listed item or bring its row up to the listing. Internal; called by intake. */
export const seedItem = internalMutation({
  args: { agentId: v.id('agents'), ...workItemSeedFields, tracker: v.optional(trackerSnapshot) },
  handler: async (ctx, args): Promise<Id<'workItems'>> => await seedItemInTransaction(ctx, args),
});

/**
 * Bring the row of a ticket intake refused on this poll up to the listing
 * and withdraw it when it is only waiting. Internal; called by intake. A
 * ticket with no row gets none.
 *
 * @returns The ticket's row, or null when it never had one.
 */
export const withdrawListedItem = internalMutation({
  args: {
    agentId: v.id('agents'),
    ...workItemSeedFields,
    leftQueue: v.string(),
    tracker: v.optional(trackerSnapshot),
  },
  handler: async (ctx, { leftQueue, tracker, ...listed }): Promise<Id<'workItems'> | null> => {
    const existing = await listedRow(ctx, listed);
    if (!existing) return null;
    await refreshListedItem(ctx, existing, listed, leftQueue);
    await recordListing(ctx, existing, tracker, leftQueue);
    return existing._id;
  },
});

/**
 * What changed, for a re-evaluation of the work parked under the old policy.
 * `claim-released` is a colleague letting go of an item this employee was
 * refused; its key is the released claim's id.
 */
export type ReevaluationTrigger = 'charter' | 'documentation' | 'surface' | 'claim-released';

const reevaluationTriggerValidator = v.union(
  v.literal('charter'),
  v.literal('documentation'),
  v.literal('surface'),
  v.literal('claim-released'),
);

/**
 * The most re-admission keys a row remembers. Four kinds of change stamp a
 * row (a policy change, a connecting surface, the verdict write and Check for
 * new work, a registered skill); a row that has been sent back more often
 * than this forgets its oldest key, and that change could buy it one more
 * evaluation, never a loop.
 */
export const SPENT_REEVALUATION_KEYS = 16;

/**
 * Whether a change has already sent a row back for a fresh evaluation.
 *
 * Args:
 *   row: The work item.
 *   key: The idempotency key of the change.
 *
 * Returns:
 *   True when the key is among those the row has spent.
 */
function reevaluationSpent(row: Pick<Doc<'workItems'>, 'reevaluation'>, key: string): boolean {
  const stamp = row.reevaluation;
  return stamp !== undefined && (stamp.key === key || (stamp.spent ?? []).includes(key));
}

/**
 * The stamp of a re-admission, carrying the keys the row spent before it.
 *
 * Each of the four stampers has a once-per-change bound keyed on the row.
 * One key would let a re-admission of another kind between two visits reset
 * that bound, so the stamp keeps them all, newest last and bounded.
 *
 * Args:
 *   row: The work item as it stands.
 *   trigger: What sent it back.
 *   key: The idempotency key of the change.
 *   at: When.
 *
 * Returns:
 *   The `reevaluation` record to store.
 */
function reevaluationStamp(
  row: Pick<Doc<'workItems'>, 'reevaluation'>,
  trigger: string,
  key: string,
  at: number,
): NonNullable<Doc<'workItems'>['reevaluation']> {
  const before = row.reevaluation ? (row.reevaluation.spent ?? [row.reevaluation.key]) : [];
  const spent = [...before.filter((entry) => entry !== key), key].slice(-SPENT_REEVALUATION_KEYS);
  return { trigger, key, at, spent };
}

const scopeAdmissionValidator = v.object({
  basis: v.string(),
  namedBy: v.optional(v.string()),
  overruled: v.optional(v.array(v.string())),
});

/**
 * Keep the charter judgement that placed a row in scope, on the row.
 *
 * Written by the evaluation step before its verdict, real mode only. A later
 * evaluation under the same charter holds it instead of asking again, so a
 * re-evaluation a skill registration caused cannot change the row's mind
 * about scope; `reevaluatePendingInTransaction` clears it from a skip a
 * policy change sends back. The skip readings the judgement set aside go on
 * the timeline as well, so a manager reading the card later can see the
 * model said otherwise and why that did not stand.
 */
export const recordScopeAdmission = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    charterId: v.id('charters'),
    admission: scopeAdmissionValidator,
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row || row.state !== 'discovered') return;
    const at = Date.now();
    await ctx.db.patch(args.workItemId, {
      scopeAdmission: { charterId: args.charterId, at, ...args.admission },
    });
    if (!args.admission.overruled?.length) return;
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.scope-skip-overruled',
      payload: { workItemId: args.workItemId, ...args.admission },
      createdAt: at,
    });
  },
});

/**
 * Record that an evaluation of a row could not get a scope judgement (E-70):
 * the `work.scope-judgement-unavailable` event and, on a row still waiting
 * under the claim that evaluation took, the moment, so a row parked after its
 * attempts is parked as unavailable and the charter trigger and Check for new
 * work re-admit it. A late answer from an attempt whose claim lapsed marks
 * nothing, so it cannot speak for a later attempt. Internal; the evaluation
 * stage's, real mode.
 */
export const recordScopeJudgementUnavailable = internalMutation({
  args: { workItemId: v.id('workItems'), cause: v.string(), claimedAt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) return;
    const at = Date.now();
    if (
      row.state === 'discovered' &&
      args.claimedAt !== undefined &&
      row.evaluationClaimedAt === args.claimedAt
    ) {
      await ctx.db.patch(row._id, { evaluationUnavailableAt: at });
    }
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.scope-judgement-unavailable',
      payload: { workItemId: row._id, cause: args.cause },
      createdAt: at,
    });
  },
});

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
  claimedBy?: { claimId?: string };
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
 * returns when that surface connects. A skip refused at the claim returns
 * only when the claim that refused it is released, whatever else changes. A
 * low-value or already-claimed skip reads none of these and stays where it is.
 */
function verdictReturnsOn(
  row: Doc<'workItems'>,
  trigger: ReevaluationTrigger,
  key: string,
  surface: SurfaceTrigger | undefined,
): boolean {
  const verdict = (row.verdict ?? {}) as ParkedVerdict;
  const reason = typeof verdict.reason === 'string' ? verdict.reason : (row.skipReason ?? '');
  if (row.state === 'skipped') {
    if (trigger === 'claim-released') return verdict.claimedBy?.claimId === key;
    if (reason.startsWith(OUT_OF_SCOPE_SKIP_PREFIX)) return true;
    if (reason.startsWith(QUALITY_FIT_SKIP_PREFIX)) return trigger === 'charter';
    return false;
  }
  if (row.state === 'deferred' && reason === AWAITING_CHARTER) return trigger === 'charter';
  // An evaluation the scope judgement could not answer was parked after its
  // attempts; a charter change asks the judgement again (E-70 D2).
  if (row.state === 'deferred' && reason === SCOPE_JUDGEMENT_UNAVAILABLE) {
    return trigger === 'charter';
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
      if (reevaluationSpent(row, args.key)) continue;
      if (!verdictReturnsOn(row, args.trigger, args.key, surface)) continue;
      const previous = (row.verdict ?? {}) as ParkedVerdict;
      await ctx.db.patch(row._id, {
        state: 'discovered',
        verdict: undefined,
        skipReason: undefined,
        // A skip that returns is judged afresh, whatever the row was told
        // before it; a deferral that returns waited on a connection, which
        // the scope judgement never read, and keeps its in-scope verdict.
        ...(row.state === 'skipped' ? { scopeAdmission: undefined } : {}),
        reevaluation: reevaluationStamp(row, args.trigger, args.key, now),
        evaluationAttempts: undefined,
        evaluationUnavailableAt: undefined,
      });
      await appendEvent(ctx, {
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
    await appendEvent(ctx, {
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
    after: v.optional(
      v.object({ skipped: v.optional(v.number()), deferred: v.optional(v.number()) }),
    ),
  },
  handler: async (ctx, args): Promise<ReevaluatePendingResult> =>
    await reevaluatePendingInTransaction(ctx, args),
});

/** A holder in one of these states no longer holds its item. */
const RELEASED_HOLDER_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set([
  'cancelled',
  'skipped',
]);

/**
 * A row in one of these states that never claimed its item will not write it:
 * a failed row that took no claim failed before there was anything to land.
 */
const NEVER_CLAIMED_DEAD_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set([
  'cancelled',
  'skipped',
  'failed',
]);

/** The most work items read for one provider item: one per employee that discovered it. */
const DISCOVERED_FROM_LIMIT = 32;

/** Why an execution is not claimed with a skill a Revise has cleared. */
const SKILL_UNDER_REVISION_REASON = 'the skill is being revised; it runs once it registers again';

/** The verdicts that park a row until a skill or a connection arrives; they check the claim and take none. */
const PARKING_DECISIONS: ReadonlySet<string> = new Set(['needs-skill', 'defer']);

/**
 * The owner and key a row's provider item is claimed under, if it is claimed at all.
 *
 * Real mode only; a revocation trial row and an agent with no owner claim
 * nothing. A key captured with the item at intake survives later card edits;
 * older rows without one use their current surface as a fallback.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item.
 *
 * Returns:
 *   The owner and key, or undefined when the row takes no claim.
 */
async function externalClaimScope(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
): Promise<{ userId: string; key: string } | undefined> {
  if (SURFACE_MODE !== 'real' || isRevocationTrialRow(row)) return undefined;
  const agent = await ctx.db.get(row.agentId);
  if (!agent?.userId) return undefined;
  const surface = row.externalClaimKey
    ? undefined
    : await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) =>
          q.eq('agentId', row.agentId).eq('slug', row.sourceSystem),
        )
        .first();
  const key = row.externalClaimKey ?? providerItemKey(surface ?? undefined, row, SURFACE_MODE);
  return key === undefined ? undefined : { userId: agent.userId, key };
}

/** Another work item holding a row's provider item, and the state it is in. */
interface HeldElsewhere {
  readonly holder: ClaimHolder;
  readonly state: string;
}

/**
 * Read the live claims on a row's provider item: the row's own, another work
 * item's, or none. A live claim whose holder is gone, cancelled or skipped
 * is released here, with what it refused, so a release some path missed
 * cannot keep the item from the company for good.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item asking.
 *   scope: The owner and key the row's item is claimed under.
 *   now: The time of the read.
 *
 * Returns:
 *   'own' when the row holds the claim, the holder when another work item
 *   does, undefined when nobody does.
 */
async function liveClaimOn(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  scope: { userId: string; key: string },
  now: number,
): Promise<'own' | HeldElsewhere | undefined> {
  const live = await ctx.db
    .query('externalClaims')
    .withIndex('by_user_key', (q) => q.eq('userId', scope.userId).eq('key', scope.key))
    .filter((q) => q.eq(q.field('releasedAt'), undefined))
    .collect();
  for (const claim of live) {
    if (claim.workItemId === row._id) return 'own';
    const holding = await ctx.db.get(claim.workItemId);
    if (!holding || RELEASED_HOLDER_STATES.has(holding.state)) {
      await releaseClaim(ctx, claim, now);
      continue;
    }
    const agent = await ctx.db.get(claim.agentId);
    return {
      holder: {
        claimId: claim._id,
        agentId: claim.agentId,
        workItemId: claim.workItemId,
        name: agent?.name ?? 'another employee',
        title: holding.title,
      },
      state: holding.state,
    };
  }
  // A retired employee's claim on an item it may already have written is
  // never released: the item stays its, whoever asks (review M14).
  const retired = await retiredClaimOn(ctx, scope.userId, scope.key);
  if (!retired) return undefined;
  return {
    holder: {
      claimId: retired.claim.claimId,
      agentId: retired.retirement.agentId,
      workItemId: retired.claim.workItemId,
      name: retiredHolderName(retired.retirement),
      title: retired.claim.title,
    },
    state: retired.claim.state,
  };
}

/**
 * Take the owner-wide claim on a row's provider item, or name who holds it.
 *
 * The read of the live claims and the insert share the claiming
 * transaction, and Convex serialises transactions that touch the same index
 * range, so of two verdicts on one item exactly one inserts.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item about to be claimed.
 *   now: The claim time.
 *
 * Returns:
 *   Undefined when the row takes no claim; otherwise the key, and the holder
 *   and its state when another work item holds it.
 */
async function takeExternalClaim(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  now: number,
): Promise<{ key: string; heldBy?: HeldElsewhere } | undefined> {
  const scope = await externalClaimScope(ctx, row);
  if (!scope) return undefined;
  const live = await liveClaimOn(ctx, row, scope, now);
  if (live === 'own') return { key: scope.key };
  if (live) return { key: scope.key, heldBy: live };
  await ctx.db.insert('externalClaims', {
    userId: scope.userId,
    key: scope.key,
    agentId: row.agentId,
    workItemId: row._id,
    ...(row.externalClaimAlias ? { aliases: [row.externalClaimAlias] } : {}),
    claimedAt: now,
  });
  return { key: scope.key };
}

/**
 * The other work item holding a row's provider item, without taking a claim.
 *
 * What a row that is not about to work the item asks: one whose evaluation
 * has not begun, so a colleague's hold costs no model call (P8-2), and one
 * parked for a skill or a connection, so its manager is never asked to
 * approve a skill for an item a colleague already works. A parked row takes
 * no claim of its own, so a colleague who can do the work still can.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item asking.
 *   now: The time of the read.
 *
 * Returns:
 *   The key and the holder, or undefined when the row takes no claim or
 *   nobody else holds the item.
 */
async function externalClaimHeldElsewhere(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  now: number,
): Promise<{ key: string; heldBy: HeldElsewhere } | undefined> {
  const scope = await externalClaimScope(ctx, row);
  if (!scope) return undefined;
  const live = await liveClaimOn(ctx, row, scope, now);
  return live === undefined || live === 'own' ? undefined : { key: scope.key, heldBy: live };
}

/**
 * Record that a row was refused the item another work item holds.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The refused work item.
 *   refused: The claim key and who holds it.
 */
async function logClaimRefused(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  refused: { key: string; holder: ClaimHolder },
): Promise<void> {
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.claim-refused',
    payload: { workItemId: row._id, key: refused.key, holder: refused.holder },
    createdAt: Date.now(),
  });
}

/**
 * Hold the item again for a row resuming past evaluation, or refuse.
 *
 * A retry resumes a cancelled row that has a plan past evaluation, so no
 * verdict takes the claim on the way; a colleague may have taken the item
 * since the cancel released it. A failed or completed row still holds its
 * claim and takes nothing new, except a row whose held actions were rejected,
 * which released it.
 *
 * Args:
 *   ctx: Mutation context of the retry.
 *   row: The row being retried.
 *
 * Raises:
 *   Error: When another work item holds the item.
 */
async function retakeExternalClaim(ctx: MutationCtx, row: Doc<'workItems'>): Promise<void> {
  const taken = await takeExternalClaim(ctx, row, Date.now());
  if (!taken?.heldBy) return;
  const { holder } = taken.heldBy;
  throw new Error(
    holder.agentId === row.agentId
      ? `this employee already holds this item on another work item (${holder.title})`
      : `another employee holds this: ${holder.name} (${holder.title})`,
  );
}

/**
 * The skip a claim verdict becomes when another work item holds the item.
 *
 * Args:
 *   row: The refused work item.
 *   holder: Who holds the item.
 *   holderState: The holding work item's state.
 *
 * Returns:
 *   The skip verdict, naming the holder for the card.
 */
function claimRefusedVerdict(
  row: Doc<'workItems'>,
  holder: ClaimHolder,
  holderState: string,
): { decision: string; reason: string; claimedBy: ClaimHolder } {
  const reason =
    holder.agentId === row.agentId
      ? `already-claimed: state=${holderState}`
      : `${CLAIMED_BY_COLLEAGUE_SKIP_PREFIX}${holder.name} holds it (${holder.title})`;
  return { decision: 'skip', reason, claimedBy: holder };
}

/**
 * The last comment a holder landed on the item it holds, by provider id.
 *
 * Args:
 *   holding: The holding work item.
 *
 * Returns:
 *   The comment's provider id, or undefined when the holder landed none.
 */
function landedCommentOn(holding: Doc<'workItems'>): string | undefined {
  const held = new Set(
    [holding.externalId, holding.externalAlias]
      .filter((name): name is string => name !== undefined)
      .map((name) => name.toUpperCase()),
  );
  return landedWritesOf(holding.output)
    .filter((write) => {
      const parsed = parseSurfaceAction(write.action);
      return (
        parsed.ok &&
        isAuditComment(parsed.action) &&
        writeTargetIds(parsed.action, { class: 'kanban' }).some((target) =>
          held.has(target.toUpperCase()),
        )
      );
    })
    .map((write) => write.applied.providerId)
    .filter((id): id is string => typeof id === 'string')
    .at(-1);
}

/**
 * The other work item that holds an external item a write addresses, if one does.
 *
 * `takeExternalClaim` guards the item a row was discovered from; this is the
 * same claim read from the other side, for the items a plan writes. On 19
 * September an ask about FIN-1 and FIN-1's own item both posted the status
 * note on it and both moved it to Done, under two different claims. The
 * apply path asks here before a write is sent, across every employee of the
 * owner. A completed or failed holder still holds; a cancelled or skipped
 * one does not, whether or not its claim was stamped released.
 *
 * A claim is not the whole of it. In that run the ask was approved at
 * 03:03:42 and wrote FIN-1; FIN-1's own item took its claim at 03:03:59, so
 * for seventeen seconds nobody held the key. The item a live work item was
 * discovered from is that work item's to write from the moment it is
 * discovered, claimed or not, so whichever of the two reaches its apply
 * first, one of them writes. A row that never claimed and is skipped,
 * cancelled or failed will not write it and holds nothing. The writer is
 * never withheld from the item it was itself discovered from. Nothing is
 * released here: this is a read.
 *
 * Args:
 *   workItemId: The work item about to write.
 *   surfaceSlug: The writer's surface the write goes through.
 *   targets: The external ids the write addresses (`writeTargetIds`).
 *
 * Returns:
 *   The holder, or null when the writer itself or nobody holds the targets.
 */
export const writeClaimHolder = internalQuery({
  args: { workItemId: v.id('workItems'), surfaceSlug: v.string(), targets: v.array(v.string()) },
  handler: async (ctx, args): Promise<WriteClaimHolder | null> => {
    const row = await ctx.db.get(args.workItemId);
    if (SURFACE_MODE !== 'real' || !row || isRevocationTrialRow(row)) return null;
    const writer = await ctx.db.get(row.agentId);
    const userId = writer?.userId;
    if (!userId) return null;
    const surface = await ctx.db
      .query('surfaces')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', row.agentId).eq('slug', args.surfaceSlug))
      .first();
    if (!surface) return null;
    const holderOf = async (
      target: string,
      holding: Doc<'workItems'>,
      unclaimed: boolean,
    ): Promise<WriteClaimHolder> => {
      const holder = await ctx.db.get(holding.agentId);
      const landedComment = landedCommentOn(holding);
      return {
        target,
        holderName: holder?.name ?? 'another employee',
        sameEmployee: holding.agentId === row.agentId,
        title: holding.title,
        state: holding.state,
        ...(landedComment ? { landedComment } : {}),
        ...(unclaimed ? { unclaimed: true } : {}),
      };
    };
    for (const target of args.targets) {
      const key = providerItemKey(
        surface,
        { sourceSystem: surface.slug, externalId: target },
        SURFACE_MODE,
      );
      if (key === undefined || row.externalClaimKey === key || row.externalClaimAlias === key)
        continue;
      const live = await ctx.db
        .query('externalClaims')
        .withIndex('by_user_key', (q) => q.eq('userId', userId).eq('key', key))
        .filter((q) => q.eq(q.field('releasedAt'), undefined))
        .collect();
      const retired = await retiredClaimOn(ctx, userId, key);
      const own = live.find((claim) => claim.workItemId === row._id);
      // The row's own claim holds unless a retired employee's claim on the
      // item came first and still holds against it.
      if (own && !(retired && retired.claim.claimedAt < own.claimedAt)) continue;
      for (const claim of live) {
        if (claim.workItemId === row._id) continue;
        const holding = await ctx.db.get(claim.workItemId);
        if (!holding || RELEASED_HOLDER_STATES.has(holding.state)) continue;
        if (!holdsAgainst(claim, row)) continue;
        return await holderOf(target, holding, false);
      }
      if (retired && holdsAgainst(retired.claim, row)) {
        return {
          target,
          holderName: retiredHolderName(retired.retirement),
          sameEmployee: false,
          title: retired.claim.title,
          state: retired.claim.state,
        };
      }
      // The work items discovered from the item under either of its names:
      // one that holds a claim keyed by the other name, then one that has
      // not claimed yet.
      const named = [
        ...(await ctx.db
          .query('workItems')
          .withIndex('by_claim_key', (q) => q.eq('externalClaimKey', key))
          .take(DISCOVERED_FROM_LIMIT)),
        ...(await ctx.db
          .query('workItems')
          .withIndex('by_claim_alias', (q) => q.eq('externalClaimAlias', key))
          .take(DISCOVERED_FROM_LIMIT)),
      ];
      let waiting: Doc<'workItems'> | undefined;
      for (const holding of named) {
        if (holding._id === row._id || isRevocationTrialRow(holding)) continue;
        const employee = await ctx.db.get(holding.agentId);
        if (employee?.userId !== userId) continue;
        const claimed = await ctx.db
          .query('externalClaims')
          .withIndex('by_work_item', (q) => q.eq('workItemId', holding._id))
          .filter((q) => q.eq(q.field('releasedAt'), undefined))
          .first();
        if (claimed) {
          if (!RELEASED_HOLDER_STATES.has(holding.state))
            return await holderOf(target, holding, false);
        } else if (!NEVER_CLAIMED_DEAD_STATES.has(holding.state)) {
          waiting ??= holding;
        }
      }
      if (waiting) return await holderOf(target, waiting, true);
    }
    return null;
  },
});

/**
 * Whether a live claim holds against a work item.
 *
 * A claim on the item a row was discovered from holds against everything. A
 * write-target claim whose holder has finished holds only against work that
 * already existed then: the four items of 19 September all wanted the one
 * refresh, and the three that did not make it must not repeat it, while a
 * ticket raised next week for a new figure is new work on the same field.
 *
 * Args:
 *   claim: The live claim.
 *   row: The work item asking.
 *
 * Returns:
 *   False only for a settled write-target claim and a row created after it settled.
 */
function holdsAgainst(
  claim: Pick<Doc<'externalClaims'>, 'writeTarget' | 'settledAt'>,
  row: Doc<'workItems'>,
): boolean {
  return (
    claim.writeTarget === undefined ||
    claim.settledAt === undefined ||
    row._creationTime < claim.settledAt
  );
}

/** The most write targets one work item takes; a surface documents a handful of fields. */
const WRITE_TARGET_CLAIMS = 8;

/**
 * Take the owner-wide claim on the documented page fields a work item's
 * approved plan writes, before it authors.
 *
 * A page field of a browser-driven surface has no intake row, so
 * `takeExternalClaim` never reaches it. The key is the one a ticket on an
 * unrecognised provider gets, the surface's origin and the item, with the
 * documented field as the item: two employees whose cards name the dashboard
 * differently still meet on it. The first work item to ask holds the field;
 * a later one is not refused anything here. It is told in its prompt
 * (`itemsHeldElsewhere`) and its fill and Save are withheld at the apply
 * (`writeClaimHolder`), so it reads the page instead. A holder that is gone,
 * cancelled or skipped is released, and a finished one gives way to work
 * created after it finished.
 *
 * Args:
 *   workItemId: The work item about to author.
 *   targets: The documented fields (`plannedWriteTargets`).
 *
 * Returns:
 *   The keys this work item holds after the call.
 */
export const takeWriteTargetClaims = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    targets: v.array(v.object({ surfaceSlug: v.string(), field: v.string() })),
  },
  handler: async (ctx, args): Promise<string[]> => {
    const row = await ctx.db.get(args.workItemId);
    if (SURFACE_MODE !== 'real' || !row || isRevocationTrialRow(row)) return [];
    const agent = await ctx.db.get(row.agentId);
    const userId = agent?.userId;
    if (!userId) return [];
    const now = Date.now();
    const held: string[] = [];
    for (const target of args.targets.slice(0, WRITE_TARGET_CLAIMS)) {
      const surface = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) =>
          q.eq('agentId', row.agentId).eq('slug', target.surfaceSlug),
        )
        .first();
      if (!surface || surface.path !== 'browser-driven') continue;
      const key = providerItemKey(
        surface,
        { sourceSystem: surface.slug, externalId: browserFieldId(target.field) },
        SURFACE_MODE,
      );
      if (key === undefined) continue;
      const live = await ctx.db
        .query('externalClaims')
        .withIndex('by_user_key', (q) => q.eq('userId', userId).eq('key', key))
        .filter((q) => q.eq(q.field('releasedAt'), undefined))
        .collect();
      let taken = false;
      for (const claim of live) {
        if (claim.workItemId === row._id) {
          if (claim.settledAt !== undefined)
            await ctx.db.patch(claim._id, { settledAt: undefined });
          held.push(key);
          taken = true;
          continue;
        }
        const holding = await ctx.db.get(claim.workItemId);
        if (!holding || RELEASED_HOLDER_STATES.has(holding.state) || !holdsAgainst(claim, row)) {
          await releaseClaim(ctx, claim, now);
          continue;
        }
        taken = true;
      }
      if (taken) continue;
      // A retired employee's claim on the field still holds against work that
      // existed when it settled (review M14).
      const retired = await retiredClaimOn(ctx, userId, key);
      if (retired && holdsAgainst(retired.claim, row)) continue;
      await ctx.db.insert('externalClaims', {
        userId,
        key,
        agentId: row.agentId,
        workItemId: row._id,
        writeTarget: { surface: surface.slug, field: target.field },
        claimedAt: now,
      });
      held.push(key);
    }
    return held;
  },
});

/**
 * Stamp a finished work item's write-target claims settled.
 *
 * Called where a row completes or fails. The claims stay live, so the work
 * that ran beside the holder still reads the page instead of writing it.
 *
 * Args:
 *   ctx: Mutation context of the transition.
 *   workItemId: The work item that finished.
 *   now: The time it finished.
 */
async function settleWriteTargetClaims(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  now: number,
): Promise<void> {
  if (SURFACE_MODE !== 'real') return;
  const held = await ctx.db
    .query('externalClaims')
    .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
    .filter((q) => q.eq(q.field('releasedAt'), undefined))
    .collect();
  for (const claim of held) {
    if (claim.writeTarget !== undefined) await ctx.db.patch(claim._id, { settledAt: now });
  }
}

/**
 * The states read for the executor's list of items held elsewhere, work in
 * flight first and finished work last, so a bounded list keeps what is about
 * to write ahead of what already has.
 */
const HELD_ELSEWHERE_STATES: ReadonlyArray<Doc<'workItems'>['state']> = [
  'executing',
  'actions-pending',
  'plan-approved',
  'plan-pending',
  'claimed',
  'discovered',
  'deferred',
  'needs-skill',
  'completed',
  'failed',
];
/** States a row can hold a write-target claim in: it is taken when execution begins. */
const WRITE_TARGET_HOLDER_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set([
  'executing',
  'actions-pending',
  'completed',
  'failed',
]);
/** States in which a row has not taken its claim yet. */
const UNCLAIMED_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set([
  'discovered',
  'deferred',
  'needs-skill',
]);
/** The most employees of one owner read for the list, the asking one first. */
const HELD_ELSEWHERE_EMPLOYEES = 16;

/**
 * The external items other work items of the company hold, for the executor's grounding.
 *
 * `writeClaimHolder` withholds a write at the apply; a reply authored in the
 * same phase as the write is written before that and cannot know. This is
 * the same rule read ahead of authoring: every live work item of the owner's
 * employees that was discovered from an external item, other than the asking
 * one, with the last comment it landed there. Live as the guard reads it: a
 * cancelled or skipped row holds nothing, and a failed one only if it took
 * its claim. Bounded by `HELD_ELSEWHERE_LIMIT`: each read asks for no more
 * rows than the list still has room for, newest first, and the reads stop
 * once it is full. Real mode only; the caller scrubs the owner's values.
 *
 * Args:
 *   workItemId: The work item about to be authored.
 *
 * Returns:
 *   The held items, work in flight first; empty in mock mode.
 */
export const itemsHeldElsewhere = internalQuery({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<HeldExternalItem[]> => {
    const row = await ctx.db.get(args.workItemId);
    if (SURFACE_MODE !== 'real' || !row || isRevocationTrialRow(row)) return [];
    const asking = await ctx.db.get(row.agentId);
    const userId = asking?.userId;
    if (!asking || !userId) return [];
    const colleagues = await ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .take(HELD_ELSEWHERE_EMPLOYEES);
    const employees = [asking, ...colleagues.filter((employee) => employee._id !== asking._id)];
    const own = new Set([row.externalClaimKey, row.externalClaimAlias]);
    const held: HeldExternalItem[] = [];
    for (const state of HELD_ELSEWHERE_STATES) {
      for (const employee of employees) {
        if (held.length >= HELD_ELSEWHERE_LIMIT) return held;
        const rows = await ctx.db
          .query('workItems')
          .withIndex('by_agent_state', (q) => q.eq('agentId', employee._id).eq('state', state))
          .order('desc')
          .take(HELD_ELSEWHERE_LIMIT - held.length);
        for (const holding of rows) {
          if (held.length >= HELD_ELSEWHERE_LIMIT) break;
          if (holding._id === row._id) continue;
          if (WRITE_TARGET_HOLDER_STATES.has(state) && !isRevocationTrialRow(holding)) {
            const fields = await ctx.db
              .query('externalClaims')
              .withIndex('by_work_item', (q) => q.eq('workItemId', holding._id))
              .filter((q) => q.eq(q.field('releasedAt'), undefined))
              .take(WRITE_TARGET_CLAIMS + 1);
            for (const claim of fields) {
              if (claim.writeTarget === undefined || !holdsAgainst(claim, row)) continue;
              if (held.length >= HELD_ELSEWHERE_LIMIT) break;
              held.push({
                externalId: claim.writeTarget.field,
                sourceSystem: claim.writeTarget.surface,
                holderName: employee.name,
                sameEmployee: employee._id === row.agentId,
                title: holding.title,
                state: holding.state,
                pageField: true,
              });
            }
            if (held.length >= HELD_ELSEWHERE_LIMIT) break;
          }
          if (holding.externalClaimKey === undefined) continue;
          if (own.has(holding.externalClaimKey) || isRevocationTrialRow(holding)) continue;
          if (state === 'failed') {
            const claimed = await ctx.db
              .query('externalClaims')
              .withIndex('by_work_item', (q) => q.eq('workItemId', holding._id))
              .filter((q) => q.eq(q.field('releasedAt'), undefined))
              .first();
            if (!claimed) continue;
          }
          const landedComment = landedCommentOn(holding);
          held.push({
            externalId: holding.externalId,
            ...(holding.externalAlias ? { externalAlias: holding.externalAlias } : {}),
            sourceSystem: holding.sourceSystem,
            holderName: employee.name,
            sameEmployee: employee._id === row.agentId,
            title: holding.title,
            state: holding.state,
            ...(landedComment ? { landedComment } : {}),
            ...(UNCLAIMED_STATES.has(holding.state) ? { unclaimed: true } : {}),
          });
        }
      }
    }
    return held;
  },
});

/**
 * Stamp one claim released and send back what it refused.
 *
 * Every employee of the owner is re-evaluated for the rows this claim
 * refused, keyed by the claim's id, so each returns to `discovered` once and
 * the next verdict takes the item or names its new holder.
 *
 * Args:
 *   ctx: Mutation context of the transition.
 *   claim: The live claim.
 *   now: The release time.
 */
async function releaseClaim(
  ctx: MutationCtx,
  claim: Doc<'externalClaims'>,
  now: number,
): Promise<void> {
  await ctx.db.patch(claim._id, { releasedAt: now });
  const employees = await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', claim.userId))
    .collect();
  for (const employee of employees) {
    await reevaluatePendingInTransaction(ctx, {
      agentId: employee._id,
      trigger: 'claim-released',
      key: claim._id,
      now,
    });
  }
}

/**
 * Release the claim a work item holds, with what it refused.
 *
 * A row that holds no live claim releases nothing. Called where a holder is
 * cancelled; completed and failed rows keep their claim, except a row whose
 * held actions the manager rejected (`releaseItemClaim`).
 *
 * Args:
 *   ctx: Mutation context of the transition.
 *   workItemId: The work item letting go of its item.
 *   now: The release time.
 */
export async function releaseExternalClaim(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  now: number,
): Promise<void> {
  const held = await ctx.db
    .query('externalClaims')
    .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
    .filter((q) => q.eq(q.field('releasedAt'), undefined))
    .collect();
  for (const claim of held) await releaseClaim(ctx, claim, now);
}

/** What a parked verdict waits on, as the evaluator and the skill pane write it. */
type WaitingVerdict = ParkedVerdict & { suggestedSkillName?: string };

/** What the owner of the registration race did with a row. */
type RegisteredSkillOutcome = 'requeued' | 'skipped' | 'left';

/** A re-admission decided where a verdict is written, linked or checked, not by a policy change. */
type SatisfiedTrigger = 'verdict-write' | 'check' | 'skill-registered';

/**
 * Whether what a waiting verdict names is present now, and under which key.
 *
 * An evaluation reads the surfaces and the grants, judges scope with a model
 * call, and writes its verdict seconds later; the connection or the grant can
 * land in between, and the write that landed it re-admits only rows already
 * parked. The key names the state of the thing waited on: a connection's is
 * the one `recordConnected` stamps, so one connection buys a row one
 * re-evaluation whichever path gives it.
 *
 * A `needs-skill` verdict naming a skill that registered meanwhile is not
 * answered here. That race belongs to `requeueBehindRegisteredSkill`, which
 * the proposal step reaches in every mode, so the race has one owner and one
 * key whatever the mode. (Two readers with a key each once overwrote one
 * another on the row's single `reevaluation` key and re-admitted the row in
 * turn for ever; the row now keeps every key it has spent.)
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: The employee.
 *   verdict: The defer verdict.
 *   now: The instant to judge surface liveness against.
 *
 * Returns:
 *   The key of what satisfies the verdict and what landed, in words for the
 *   card, or undefined while it still waits.
 */
async function waitSatisfiedBy(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  verdict: WaitingVerdict,
  now: number,
): Promise<{ key: string; landed: string } | undefined> {
  if (verdict.decision === 'defer' && verdict.reason === 'awaiting-connection') {
    const missing = verdict.missingSurface;
    if (typeof missing !== 'string') return undefined;
    // The surfaces as the evaluation reads them: a browser-driven surface this
    // deployment cannot drive is not connected, whatever its last probe said.
    const refusal = browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL);
    const surfaces = (
      await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (index) => index.eq('agentId', agentId))
        .collect()
    ).map((surface) => withBrowserComponentState(surface, refusal));
    const live = surfaces.find(
      (surface) =>
        verdictFor(surface, now) === 'connected' &&
        missingSurfaceResolvedBy(missing, surface, surfaces),
    );
    return live
      ? { key: `surface:${live._id}:${live.lastVerifiedAt}`, landed: `${live.slug} connected` }
      : undefined;
  }
  if (verdict.decision === 'defer' && verdict.reason === SCOPE_JUDGEMENT_UNAVAILABLE) {
    // Check for new work asks the judgement again, once per lease window, so
    // an outage that outlasted the attempts ends at the manager's check.
    return {
      key: `scope-retry:${Math.floor(now / STEP_LEASE_MS)}`,
      landed: 'the scope judgement is asked again',
    };
  }
  if (verdict.decision === 'defer' && verdict.reason === 'awaiting-permission') {
    // The verdict arrives as `v.any()`: a shape the evaluator never writes
    // parks as written rather than failing the write that ends the step.
    const named = Array.isArray(verdict.missingPermissions) ? verdict.missingPermissions : [];
    const scopes = [...new Set(named)]
      .filter((scope): scope is string => typeof scope === 'string')
      .sort();
    if (scopes.length === 0 || scopes.length !== new Set(named).size) return undefined;
    const grants: string[] = [];
    for (const scope of scopes) {
      const grant = (
        await ctx.db
          .query('permissionGrants')
          .withIndex('by_agent_scope', (index) => index.eq('agentId', agentId).eq('scope', scope))
          .collect()
      ).find((row) => row.revokedAt === undefined);
      if (!grant) return undefined;
      grants.push(grant._id);
    }
    return { key: `grants:${grants.join(',')}`, landed: `${scopes.join(', ')} granted` };
  }
  return undefined;
}

/**
 * The registered skill a `needs-skill` verdict names, if there is one.
 *
 * Only the evaluator writes `suggestedSkillName`; the verdicts `convex/skills.ts`
 * applies after a failed or unverified authoring run name none.
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: The employee.
 *   verdict: The verdict on the row.
 *
 * Returns:
 *   The registered skill of that name, or undefined.
 */
async function registeredSkillNamedBy(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  verdict: WaitingVerdict,
): Promise<Doc<'skills'> | undefined> {
  const name = verdict.suggestedSkillName;
  if (verdict.decision !== 'needs-skill' || typeof name !== 'string' || name === '') {
    return undefined;
  }
  return (
    await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (index) => index.eq('agentId', agentId).eq('name', name))
      .collect()
  ).find((row) => row.state === 'registered');
}

/** One registration of one skill: a revision clears `registeredAt`, so the next is a new key. */
function skillRegistrationKey(skill: Doc<'skills'>): string {
  return `skill-registered:${skill._id}:${skill.registeredAt ?? 0}`;
}

/**
 * Re-queue a row whose `needs-skill` verdict names a skill that has registered.
 *
 * The one owner of "the skill registered while this item was being
 * evaluated". An evaluation reads the skill list, spends its time in a model,
 * and writes its verdict afterwards. A registration that lands in between has
 * already re-queued the rows waiting then, so this row arrives at a callable
 * skill with nobody left to move it. The verdict write parks it as written;
 * the proposal step that follows (`skills.propose`) calls this, in every
 * mode, and Check for new work calls it for a row whose proposal step never
 * ran. The row is sent back once per registration, keyed among the keys its
 * `reevaluation` record has spent, so no other kind of re-admission in
 * between buys the registration a second turn. A second `needs-skill` naming the same registration
 * was decided with the skill on the list, so the skill does not cover the
 * row: it is skipped with that reason, which leaves it a Retry on its card,
 * rather than evaluated for ever or parked where nothing moves it.
 *
 * Args:
 *   ctx: Mutation context.
 *   skill: The registered skill the verdict names.
 *   workItemId: The row the verdict was written on.
 *   via: Who reached the row, for the `work.requeued` event: the proposal
 *     step, or Check for new work.
 *
 * Returns:
 *   Whether the row was re-queued, skipped, or was not waiting and left alone.
 */
export async function requeueBehindRegisteredSkill(
  ctx: MutationCtx,
  skill: Doc<'skills'>,
  workItemId: Id<'workItems'>,
  via: 'skill-registered' | 'check' = 'skill-registered',
): Promise<RegisteredSkillOutcome> {
  const item = await ctx.db.get(workItemId);
  if (!item || item.state !== 'needs-skill' || item.agentId !== skill.agentId) return 'left';
  const key = skillRegistrationKey(skill);
  if (reevaluationSpent(item, key)) {
    await applyVerdict(ctx, workItemId, {
      decision: 'skip',
      reason: `registered skill "${skill.name}" was tried and does not cover this item`,
    });
    return 'skipped';
  }
  const at = Date.now();
  await ctx.db.patch(workItemId, {
    proposedSkillId: skill._id,
    reevaluation: reevaluationStamp(item, 'skill-registered', key, at),
  });
  await applyVerdict(ctx, workItemId, {
    decision: 'pending-reevaluation',
    reason: 'skill registered, ready to retry',
  });
  await logSatisfiedRequeue(ctx, item, via, key, (item.verdict ?? {}) as WaitingVerdict, at);
  return 'requeued';
}

/** The employee to check and the creation-time watermarks a continuation resumes from. */
interface ReadmitSatisfiedArgs {
  agentId: Id<'agents'>;
  after?: { deferred?: number; needsSkill?: number };
}

/** The `work.requeued` event of a row re-admitted because its wait is over. */
async function logSatisfiedRequeue(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  trigger: SatisfiedTrigger,
  key: string,
  waited: WaitingVerdict,
  now: number,
): Promise<void> {
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.requeued',
    payload: {
      workItemId: row._id,
      trigger,
      key,
      previousState: row.state,
      ...(waited.missingSurface ? { previousMissingSurface: waited.missingSurface } : {}),
    },
    createdAt: now,
  });
}

/**
 * Re-admit the parked rows whose wait is already over.
 *
 * A row deferred on a surface that has since connected, or on grants that
 * are all live, goes back to `discovered` for a fresh evaluation. Each row
 * returns once per key of the thing it waited on, so a row the evaluator
 * parks again for the same connection stays parked until the connection
 * changes. A row parked at `needs-skill` naming a skill that is registered is
 * handed to `requeueBehindRegisteredSkill`: back once per registration, then
 * skipped with the reason. A batch of
 * `REEVALUATION_BATCH` rows per state is examined; when a batch fills, the
 * rest is scheduled as a continuation carrying creation-time watermarks.
 *
 * Args:
 *   ctx: Mutation context.
 *   args: The employee and, for a continuation, where to resume.
 *   now: The instant to judge liveness against and to stamp.
 *
 * Returns:
 *   How many rows were re-admitted and examined, and whether a continuation was scheduled.
 */
async function readmitSatisfiedInTransaction(
  ctx: MutationCtx,
  args: ReadmitSatisfiedArgs,
  now: number,
): Promise<{ readmitted: number; examined: number; continued: boolean }> {
  const after: ReadmitSatisfiedArgs['after'] = { ...args.after };
  let readmitted = 0;
  let examined = 0;
  let continued = false;
  for (const [state, mark] of [
    ['deferred', 'deferred'],
    ['needs-skill', 'needsSkill'],
  ] as const) {
    const watermark = after[mark];
    const rows = await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (index) => {
        const range = index.eq('agentId', args.agentId).eq('state', state);
        return watermark === undefined ? range : range.gt('_creationTime', watermark);
      })
      .take(REEVALUATION_BATCH);
    for (const row of rows) {
      examined += 1;
      if (isRevocationTrialRow(row)) continue;
      const waited = (row.verdict ?? {}) as WaitingVerdict;
      // A row behind a registered skill goes to that race's one owner, under
      // its key and its once-then-skip rule, so the check and the proposal
      // step cannot each give the row a turn.
      const skill = await registeredSkillNamedBy(ctx, args.agentId, waited);
      if (skill) {
        const outcome = await requeueBehindRegisteredSkill(ctx, skill, row._id, 'check');
        if (outcome === 'requeued') readmitted += 1;
        continue;
      }
      const satisfied = await waitSatisfiedBy(ctx, args.agentId, waited, now);
      if (!satisfied || reevaluationSpent(row, satisfied.key)) continue;
      await ctx.db.patch(row._id, {
        state: 'discovered',
        verdict: undefined,
        reevaluation: reevaluationStamp(row, 'check', satisfied.key, now),
        evaluationAttempts: undefined,
        evaluationUnavailableAt: undefined,
      });
      await logSatisfiedRequeue(ctx, row, 'check', satisfied.key, waited, now);
      await scheduleNextStep(ctx, { ...row, state: 'discovered', verdict: undefined });
      readmitted += 1;
    }
    if (rows.length === REEVALUATION_BATCH) {
      after[mark] = rows[rows.length - 1]._creationTime;
      continued = true;
    } else {
      delete after[mark];
    }
  }
  if (continued) {
    await ctx.scheduler.runAfter(0, internal.work.readmitSatisfiedDeferrals, {
      agentId: args.agentId,
      after,
    });
  }
  return { readmitted, examined, continued };
}

const readmitSatisfiedAfter = v.object({
  deferred: v.optional(v.number()),
  needsSkill: v.optional(v.number()),
});

/**
 * The dashboard's Check for new work, for the work already here: a parked row
 * whose reason is no longer true gets its way out. Real mode only, like the
 * check that schedules it.
 */
export const readmitSatisfiedDeferrals = internalMutation({
  args: { agentId: v.id('agents'), after: v.optional(readmitSatisfiedAfter) },
  handler: async (
    ctx,
    args,
  ): Promise<{ readmitted: number; examined: number; continued: boolean }> => {
    if (SURFACE_MODE !== 'real') return { readmitted: 0, examined: 0, continued: false };
    return await readmitSatisfiedInTransaction(ctx, args, Date.now());
  },
});

/**
 * The charter a verdict names: the one the evaluation read, when it is this
 * employee's, else the newest approved charter. A draft awaiting approval
 * decides nothing, so no verdict names one.
 *
 * @param ctx - The verdict's mutation context.
 * @param agentId - The employee.
 * @param evaluatedCharterId - The charter the evaluation read, when it said.
 * @returns The charter row, or undefined when the employee has no approved one.
 */
async function verdictCharter(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  evaluatedCharterId: Id<'charters'> | undefined,
): Promise<Doc<'charters'> | undefined> {
  const evaluated = evaluatedCharterId ? await ctx.db.get(evaluatedCharterId) : null;
  if (evaluated?.agentId === agentId && evaluated.approved) return evaluated;
  const recent = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc')
    .take(VERDICT_CHARTER_READ);
  return recent.find((charter) => charter.approved);
}

/**
 * The newest charter rows a verdict looks through for an approved one: drafts
 * sent back and redrafted stack above it only a few deep.
 */
const VERDICT_CHARTER_READ = 20;

/**
 * Record an evaluation verdict and move the row to where it puts it.
 *
 * A plain helper rather than only a mutation, because `skills.completeRegistration`
 * has to requeue every work item waiting for a skill inside the same
 * transaction that registers the skill - a registered, callable skill with a
 * work item still parked at `needs-skill` behind it is a state nothing in the
 * product knows how to leave.
 *
 * The `work.evaluated` event names `evaluatedCharterId` when the caller read
 * one (the evaluation stage), else the newest approved charter.
 */
export async function applyVerdict(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  verdict: unknown,
  evaluatedCharterId?: Id<'charters'>,
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

  // One work item holds each provider item across the owner's employees: the
  // claim is taken here, in the claiming transaction, or the verdict becomes
  // a skip naming who holds it. A verdict that parks the row for a skill or a
  // connection takes nothing, but a colleague's hold still skips it.
  let refused: { key: string; holder: ClaimHolder } | undefined;
  const claimRead =
    effective.decision === 'claim'
      ? await takeExternalClaim(ctx, row, Date.now())
      : PARKING_DECISIONS.has(effective.decision)
        ? await externalClaimHeldElsewhere(ctx, row, Date.now())
        : undefined;
  if (claimRead?.heldBy) {
    effective = claimRefusedVerdict(row, claimRead.heldBy.holder, claimRead.heldBy.state);
    refused = { key: claimRead.key, holder: claimRead.heldBy.holder };
  }

  // A verdict that waits on a surface or a grant was computed from reads taken
  // before the model call. When what it names is present by now, parking the
  // row would strand it: the write that landed it has already looked for
  // parked rows and found this one still `discovered`. The row goes back for
  // a fresh evaluation instead, once per key, so an evaluator that keeps
  // disagreeing with this read parks on its second verdict. A `needs-skill`
  // naming a skill that registered meanwhile parks as written: the proposal
  // step that follows hands it to `requeueBehindRegisteredSkill`.
  let readmission: { key: string; waited: WaitingVerdict; at: number } | undefined;
  if (SURFACE_MODE === 'real' && !isRevocationTrialRow(row)) {
    const at = Date.now();
    const waited = effective as WaitingVerdict;
    const satisfied = await waitSatisfiedBy(ctx, row.agentId, waited, at);
    if (satisfied && !reevaluationSpent(row, satisfied.key)) {
      readmission = { key: satisfied.key, waited, at };
      effective = {
        decision: 'pending-reevaluation',
        reason: `${satisfied.landed} while this was being evaluated`,
        superseded: effective,
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
    // evaluable again the moment a slot frees, and counts no attempt.
    ...(row.evaluationClaimedAt !== undefined ? { evaluationClaimedAt: undefined } : {}),
    evaluationAttempts: undefined,
    evaluationUnavailableAt: undefined,
    ...(readmission
      ? { reevaluation: reevaluationStamp(row, 'verdict-write', readmission.key, readmission.at) }
      : {}),
  });
  // The verdict names the charter it was reached under, so the trail says
  // which rules decided (Q14): the one the evaluation read, else the newest
  // approved one, never a draft above it (review M17).
  const charter = await verdictCharter(ctx, row.agentId, evaluatedCharterId);
  const evaluatedId = await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.evaluated',
    payload: {
      workItemId,
      decision,
      verdict: effective,
      ...(charter ? { charterId: charter._id, charterVersion: charter.version } : {}),
    },
    createdAt: Date.now(),
  });
  // The proposal is written by the evaluating action after this commit; if it
  // throws, nothing else ever moves the row (P5-2).
  if (nextState === 'needs-skill' && SURFACE_MODE === 'real') {
    await ctx.scheduler.runAfter(STEP_LEASE_MS, internal.work.recoverUnproposedSkill, {
      workItemId,
      evaluatedId,
    });
  }
  if (nextState === 'skipped') {
    // A skip ends the item: its terminal event, as every terminal transition writes one.
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.skipped',
      payload: { workItemId, ...(skipReason ? { reason: skipReason } : {}) },
      createdAt: Date.now(),
    });
  }
  if (readmission) {
    await logSatisfiedRequeue(
      ctx,
      row,
      'verdict-write',
      readmission.key,
      readmission.waited,
      readmission.at,
    );
  }
  if (refused) await logClaimRefused(ctx, row, refused);
  await scheduleNextStep(ctx, { ...row, state: nextState, verdict: effective });
  return effective;
}

/**
 * A `needs-skill` row's switch for the proposal its evaluation promised.
 *
 * Fires a lease after the verdict. A row still parked on that verdict (no
 * later evaluation) with no proposal recorded had its proposal throw after the
 * verdict committed, and would say "needs a skill" with nothing to approve and
 * no control. It is stopped with the skill it needed named, so Retry
 * evaluates it again. Internal.
 */
export const recoverUnproposedSkill = internalMutation({
  args: { workItemId: v.id('workItems'), evaluatedId: v.id('events') },
  handler: async (ctx, args): Promise<{ recovered: 'failed' | 'ignored' }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row || row.state !== 'needs-skill' || row.proposedSkillId !== undefined) {
      return { recovered: 'ignored' };
    }
    const latest = (
      await ctx.db
        .query('events')
        .withIndex('by_agent_type', (q) =>
          q.eq('agentId', row.agentId).eq('type', 'work.evaluated'),
        )
        .order('desc')
        .take(REEVALUATION_BATCH)
    ).find((event) => (event.payload as { workItemId?: unknown }).workItemId === row._id);
    if (latest?._id !== args.evaluatedId) return { recovered: 'ignored' };
    const name = (row.verdict as { suggestedSkillName?: unknown } | undefined)?.suggestedSkillName;
    const skill = typeof name === 'string' && name ? `the skill "${name}"` : 'a skill';
    await failInTransaction(ctx, row, {
      reason: `evaluation found this item needs ${skill}, but its proposal was never recorded; Retry evaluates the item again`,
      stopped: true,
    });
    return { recovered: 'failed' };
  },
});

/**
 * Record an evaluation's verdict. Internal; the evaluation stage's, which
 * passes the charter it read before its model call, so the verdict names
 * that charter even when an amendment landed during the call (review M17).
 */
export const setVerdict = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    verdict: v.any(),
    charterId: v.optional(v.id('charters')),
  },
  handler: async (ctx, args) => {
    return await applyVerdict(ctx, args.workItemId, args.verdict, args.charterId);
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
    return await appendEvent(ctx, {
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

/** The most events `planGroundingReads` walks back through before it gives up. */
const GROUNDING_READ_SCAN_LIMIT = 2_000;

/**
 * The current plan-grounding read of a work item: the most recent one whose
 * ledger row was attached, as the event stored it (already redacted). The
 * executor's evidence check reads it as what the item says; an earlier
 * reading is superseded, and another item's is never returned.
 */
export const planGroundingReads = internalQuery({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<Array<{ action: unknown; applied: unknown }>> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) return [];
    // Newest first and stopped at the first match, within a bound: the
    // events table is indexed by agent alone, and an item with no read in
    // reach simply has none to cite.
    const newestFirst = ctx.db
      .query('events')
      .withIndex('by_agent', (q) =>
        q.eq('agentId', row.agentId).gt('_creationTime', row._creationTime),
      )
      .order('desc');
    let scanned = 0;
    for await (const event of newestFirst) {
      scanned += 1;
      if (scanned > GROUNDING_READ_SCAN_LIMIT) break;
      if (event.type !== 'work.plan-grounding-read') continue;
      const { workItemId, action, applied } = event.payload as {
        workItemId?: string;
        action?: unknown;
        applied?: unknown;
      };
      if (workItemId === args.workItemId && action !== undefined && applied != null)
        return [{ action, applied }];
    }
    return [];
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
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.plan-drafted',
      payload: { workItemId: args.workItemId, plan },
      createdAt: Date.now(),
    });
    if (applied.length > 0) {
      await appendEvent(ctx, {
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
 * Why a stored plan's obligations judgement failed open, if it did.
 *
 * Either shape the settlement leaves: the planner's own fields standing
 * unchecked (`obligations.failedOpen`), or no fields at all
 * (`obligationsFailedOpen`).
 *
 * @param plan - The work item's stored plan.
 * @returns The recorded reason, or undefined when the judgement answered.
 */
function obligationsFailedOpen(plan: unknown): string | undefined {
  if (typeof plan !== 'object' || plan === null) return undefined;
  const { obligations, obligationsFailedOpen: none } = plan as Partial<ExecutionPlan>;
  return obligations?.failedOpen ?? none;
}

/**
 * Decide whether a freshly drafted plan should continue without a click.
 *
 * This is deliberately separate from `setPlan`. The plan is always persisted
 * in `plan-pending` first, then this transaction re-reads the agent's switch at
 * the actual decision boundary. A switch change while the model was drafting
 * therefore affects this run; a stale value captured before the draft does not.
 *
 * A plan for a provider item on which the manager rejected any employee's
 * plan waits for the manager whatever the switch says (decision N3), and the
 * first time it is held for that reason a `work.plan-held` event names the
 * first rejection. So does the plan of an item the manager took anyway after
 * the agent skipped it (`reason: 'skip-overruled'`): the card promised that
 * plan comes back to them. So does a plan whose obligations judgement failed
 * open (`reason: 'obligations-failed-open'`): its declared reads and writes
 * stand unchecked, and the gates the switch trusts read exactly those
 * (E-70 D4). Internal; called by the drafting action and the stalled-step
 * sweep.
 */
export const decidePlan = internalMutation({
  args: { workItemId: v.id('workItems'), recovery: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ approved: boolean }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (row.state !== 'plan-pending') return { approved: false };
    const agent = await ctx.db.get(row.agentId);
    if (!agent || !autonomousActionsOn(agent) || row.planRejectedAt !== undefined) {
      await scheduleDecisionRequest(ctx, row, 'plan');
      return { approved: false };
    }
    // "Take it anyway" overruled the agent's own skip and promised the manager
    // the plan comes back to them; the switch does not speak for that decision.
    const waived =
      row.scopeWaivedAt !== undefined
        ? 'scope'
        : row.qualityFitWaivedAt !== undefined
          ? 'quality-fit'
          : undefined;
    if (waived) {
      if (!args.recovery) {
        await appendEvent(ctx, {
          agentId: row.agentId,
          type: 'work.plan-held',
          payload: { workItemId: args.workItemId, reason: 'skip-overruled', waived },
          createdAt: Date.now(),
        });
      }
      await scheduleDecisionRequest(ctx, row, 'plan');
      return { approved: false };
    }
    // A plan whose obligations judgement failed open carries reads and writes
    // nobody checked; the switch trusts the gates, and the gates trust those.
    const unchecked = obligationsFailedOpen(row.plan);
    if (unchecked !== undefined) {
      if (!args.recovery) {
        await appendEvent(ctx, {
          agentId: row.agentId,
          type: 'work.plan-held',
          payload: {
            workItemId: args.workItemId,
            reason: 'obligations-failed-open',
            failure: unchecked,
          },
          createdAt: Date.now(),
        });
      }
      await scheduleDecisionRequest(ctx, row, 'plan');
      return { approved: false };
    }
    const rejection = await firstTicketRejection(ctx, row);
    if (rejection) {
      // The sweep re-runs this for an undecided row every lease; the drafting
      // call is the one that records why the plan waits.
      if (!args.recovery) {
        await appendEvent(ctx, {
          agentId: row.agentId,
          type: 'work.plan-held',
          payload: {
            workItemId: args.workItemId,
            reason: 'plan-rejected-for-this-item',
            rejectedWorkItemId: rejection.workItemId,
            rejectedAgentId: rejection.agentId,
            rejectedAt: rejection.rejectedAt,
            ...(rejection.correction ? { rejection: rejection.correction.text } : {}),
          },
          createdAt: Date.now(),
        });
      }
      await scheduleDecisionRequest(ctx, row, 'plan');
      return { approved: false };
    }
    await ctx.db.patch(args.workItemId, { state: 'plan-approved' });
    await appendEvent(ctx, {
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
    const live =
      row.decision?.kind === args.kind && !row.decision.decidedAt ? row.decision : undefined;
    // A delivered code is replaced only once it was marked failed, which only
    // a change of manager does to a delivered request: the old one went to a
    // DM nobody reads for this agent any more.
    if (live && (live.id !== args.supersedes || (live.ts && !live.requestFailedAt))) {
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
      .filter(askableChannel)
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
    const requestRunId = await appendEvent(ctx, {
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
  await appendEvent(ctx, {
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

/** What the manager's note says ended a run whose apply was interrupted. */
const INTERRUPTED_NOTE_REASON =
  'the apply was interrupted, so what it sent is not known; check each change marked below';

/** Why a request delivered to the previous manager is sent again. */
export const MANAGER_CHANGED_RESEND_REASON =
  'the manager changed; the request went to the previous one';

/**
 * Send the open decision requests delivered to a previous manager again.
 *
 * A probe that resolves the manager's DM finds the manager it has now. A
 * request delivered on this surface to any other DM, the previous manager's,
 * holds a code nobody here will answer: the old manager is refused and the
 * new one never saw it. That is so whether the previous manager is still on
 * the row or a failed lookup wiped them first. Each such request is marked
 * failed and re-sent on the new DM with a fresh code, like an undelivered one;
 * so is a delivered request already marked failed whose re-send never claimed
 * its replacement.
 *
 * @param currentChannel - The DM channel the probe just resolved.
 * @returns How many requests were re-sent.
 */
export async function resendDecisionsAfterManagerChange(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  currentChannel: string | undefined,
): Promise<number> {
  if (surface.class !== 'chat' || currentChannel === undefined) return 0;
  const parked = await Promise.all(
    (['plan-pending', 'actions-pending'] as const).map(
      async (state) =>
        await ctx.db
          .query('workItems')
          .withIndex('by_agent_state', (q) => q.eq('agentId', surface.agentId).eq('state', state))
          .collect(),
    ),
  );
  // A delivered request marked failed and never replaced (its re-send died
  // before it claimed a new code) is stranded the same way (wave 3 review M7).
  const stale = parked.flat().flatMap((row) => {
    const decision = row.decision;
    const open =
      !!decision?.ts &&
      askedFor(decision, row.state) &&
      decision.surfaceSlug === surface.slug &&
      (decision.requestFailedAt !== undefined || decision.channel !== currentChannel);
    return open && decision ? [{ row, decision }] : [];
  });
  for (const { row, decision } of stale) {
    await supersedeDecisionRequest(ctx, row, decision, MANAGER_CHANGED_RESEND_REASON);
  }
  return stale.length;
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

/** A parked row and the open request it carries. */
interface OpenRequest {
  readonly row: Doc<'workItems'>;
  readonly decision: NonNullable<Doc<'workItems'>['decision']>;
}

/**
 * The requests open on a manager chat channel: claimed or delivered on its
 * current DM, undecided, not marked failed, for the state the row is parked in.
 *
 * @param surface - The chat surface.
 * @returns The rows and their requests.
 */
async function openRequestsOn(ctx: QueryCtx, surface: Doc<'surfaces'>): Promise<OpenRequest[]> {
  const channel = surface.managerDmChannelId;
  if (surface.class !== 'chat' || channel === undefined) return [];
  const parked = await Promise.all(
    (['plan-pending', 'actions-pending'] as const).map(
      async (state) =>
        await ctx.db
          .query('workItems')
          .withIndex('by_agent_state', (q) => q.eq('agentId', surface.agentId).eq('state', state))
          .collect(),
    ),
  );
  return parked.flat().flatMap((row): OpenRequest[] => {
    const decision = row.decision;
    if (
      !decision ||
      !askedFor(decision, row.state) ||
      decision.requestFailedAt !== undefined ||
      decision.surfaceSlug !== surface.slug ||
      decision.channel !== channel
    ) {
      return [];
    }
    return [{ row, decision }];
  });
}

/** Newest rows asked on one channel read for a recent decision there. */
const NOTICE_WINDOW_SCAN = 50;

/** Undecided batches of one agent read for the ones with open members. */
const OPEN_BATCH_SCAN = 200;

/**
 * What one manager chat channel has open, for the decision poll (Q13).
 *
 * Internal; intake's. A request is open from its claim until it is decided,
 * marked failed, or the row leaves the parked state it asks about, and only
 * on the DM it was sent to: a request delivered to a previous manager's DM,
 * or marked failed and not replaced yet, is not read on this one (wave 3
 * review M7). A batch is open while one of its members is. A notice is owed
 * for `DECISION_NOTICE_WINDOW_MS` after a decision on the channel. With
 * nothing open and no notice owed, the poll leaves the DM unread.
 */
export const openDecisions = internalQuery({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<OpenDecisions> => {
    const surface = await ctx.db.get(args.surfaceId);
    const channel = surface?.managerDmChannelId;
    if (!surface || surface.class !== 'chat' || channel === undefined) return NOTHING_OPEN;
    const requests = (await openRequestsOn(ctx, surface)).map(
      ({ decision }): OpenDecisionRequest => ({
        decisionId: decision.id,
        ...(decision.ts ? { ts: decision.ts } : {}),
      }),
    );
    const openIds = new Set(requests.map((request) => request.decisionId));
    const batches = (
      await ctx.db
        .query('decisionBatches')
        .withIndex('by_agent_id', (q) => q.eq('agentId', surface.agentId))
        .filter((q) =>
          q.and(
            q.eq(q.field('decidedAt'), undefined),
            q.eq(q.field('surfaceSlug'), surface.slug),
            q.eq(q.field('channel'), channel),
          ),
        )
        .take(OPEN_BATCH_SCAN)
    ).flatMap((batch): OpenDecisionBatch[] => {
      const decisionIds = batch.members
        .map((member) => member.decisionId)
        .filter((id) => openIds.has(id));
      return decisionIds.length > 0 ? [{ batchId: batch.id, decisionIds }] : [];
    });
    const since = Date.now() - DECISION_NOTICE_WINDOW_MS;
    const recent = await ctx.db
      .query('workItems')
      .withIndex('by_agent_decision_surface_channel', (q) =>
        q
          .eq('agentId', surface.agentId)
          .eq('decision.surfaceSlug', surface.slug)
          .eq('decision.channel', channel),
      )
      .order('desc')
      .take(NOTICE_WINDOW_SCAN);
    const noticeOwed = recent.some(
      (row) => row.decision?.decidedAt !== undefined && row.decision.decidedAt >= since,
    );
    return { requests, batches, noticeOwed };
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
      await appendEvent(ctx, {
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
    const requestRunId = await appendEvent(ctx, {
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
    const requestRunId = await appendEvent(ctx, {
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
  args: {
    userId: string;
    messageTs: string;
    reply: { verb: 'approve' | 'reject'; id: string; reason?: string };
  },
) {
  if (batch.surfaceSlug !== surface.slug || batch.channel !== surface.managerDmChannelId) {
    await appendEvent(ctx, {
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
    if (batch.decidedTs === args.messageTs)
      return { status: 'already-decided' as const, notified: false };
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
      skipped.push({
        decisionId: member.decisionId,
        reason: `already ${decision.outcome ?? 'decided'}`,
      });
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
        {
          workItemId: item._id,
          pendingRunId: member.pendingRunId,
          reason: args.reply.reason ?? '',
        },
        'channel',
        args.messageTs,
      );
    }
    decided.push(member.decisionId);
  }
  const outcome = args.reply.verb === 'approve' ? 'approved' : 'rejected';
  await ctx.db.patch(batch._id, { decidedAt: Date.now(), outcome, decidedTs: args.messageTs });
  await appendEvent(ctx, {
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
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.plan-approved',
    payload: {
      workItemId: row._id,
      decidedVia: via,
      ...(answers.length > 0
        ? {
            answered: answers.map((entry) => ({
              question: entry.question,
              questionId: entry.questionId,
            })),
          }
        : {}),
    },
    createdAt: Date.now(),
  });
  // Whichever way the manager approved, the server runs the plan; the page no
  // longer has to be open for it.
  await scheduleNextStep(ctx, { ...row, state: 'plan-approved' });
}

/** The longest manual estimate the plan card takes: a working month. */
const MANUAL_ESTIMATE_MAX_MINUTES = 10_000;

export const approvePlan = mutation({
  args: {
    workItemId: v.id('workItems'),
    /** Answers to the charter's open questions asked on this plan; each amends the charter. */
    answers: v.optional(
      v.array(v.object({ questionId: v.id('managerQuestions'), text: v.string() })),
    ),
    /** The manager's answer to the planner's own note, for this run. */
    note: v.optional(v.string()),
    /** N11: "this would have taken me about N minutes", optional; hours saved sums it. */
    manualEstimateMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (row.state !== 'plan-pending') {
      throw new Error(`workItem state is ${row.state}; expected plan-pending`);
    }
    const estimate = args.manualEstimateMinutes;
    if (
      estimate !== undefined &&
      (!Number.isInteger(estimate) || estimate < 1 || estimate > MANUAL_ESTIMATE_MAX_MINUTES)
    ) {
      throw new ConvexError(
        `The estimate is a whole number of minutes from 1 to ${MANUAL_ESTIMATE_MAX_MINUTES}.`,
      );
    }
    if (estimate !== undefined) await ctx.db.patch(row._id, { manualEstimateMinutes: estimate });
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
/**
 * Ask the manager on the chat surface again, from the card.
 *
 * Public, owner-guarded. An undelivered request is superseded with a fresh
 * code. A parked row that was never asked, because it parked while no manager
 * channel was connected, is asked now once one is (P7-18). A delivered request
 * is never replaced: the manager holds its code.
 */
export const resendDecisionRequest = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    const decision = askedFor(row.decision, row.state) ? row.decision : undefined;
    const neverAsked =
      !decision &&
      (row.state === 'plan-pending' ||
        (row.state === 'actions-pending' && row.approvedIndexes === undefined));
    if (neverAsked) {
      const surfaces = await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
        .collect();
      if (!surfaces.some(askableChannel)) {
        throw new ConvexError(
          'No manager chat channel is connected, so there is nowhere to ask; decide here instead.',
        );
      }
      const kind: DecisionKind = row.state === 'plan-pending' ? 'plan' : 'actions';
      await appendEvent(ctx, {
        agentId: row.agentId,
        type: 'work.decision-request-asked',
        payload: { workItemId: row._id, kind },
        createdAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.managerChannelActions.requestDecision, {
        workItemId: row._id,
        kind,
      });
      return { ok: true };
    }
    const expectedState = decision?.kind === 'plan' ? 'plan-pending' : 'actions-pending';
    if (!decision || decision.decidedAt || row.state !== expectedState) {
      throw new ConvexError('There is no open decision request to resend.');
    }
    if (decision.ts) {
      throw new ConvexError('The request was delivered; the manager holds its code.');
    }
    if (!undeliveredDecisionReason(decision, Date.now())) {
      throw new ConvexError('The request is still being delivered.');
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
    // A row parked because its evaluations kept dying waits for this Retry.
    const spentEvaluation =
      row.state === 'deferred' &&
      (row.verdict as { reason?: unknown } | undefined)?.reason === EVALUATION_ATTEMPTS_SPENT;
    if (!recoverable.includes(row.state) && !spentEvaluation) {
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
    const next: Doc<'workItems'>['state'] =
      row.plan && !redraft
        ? 'plan-approved'
        : verdict?.decision === 'claim'
          ? 'claimed'
          : 'discovered';
    if (next !== 'discovered') await retakeExternalClaim(ctx, row);
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
    const resume =
      SURFACE_MODE === 'real' && row.state === 'failed' && row.plan
        ? closingResume(
            row.output,
            row.plan as ExecutionPlan,
            row.skipReason && stopDetail(row.skipReason),
            (
              await ctx.db
                .query('surfaces')
                .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
                .take(100)
            )
              .map(toSurfaceRecord)
              .filter((surface) => verdictFor(surface, Date.now()) === 'connected'),
          )
        : undefined;
    await ctx.db.patch(args.workItemId, {
      state: next,
      ...(resume ? { output: resume } : {}),
      ...(redraft
        ? {
            plan: undefined,
            decision: undefined,
            planPendingAt: undefined,
            managerAnswers: undefined,
          }
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
        ? {
            managerFeedback: {
              reason: feedback,
              at: Date.now(),
              kind: 'retry-note' as const,
              // Only a note on a question stop answers the question (review D2).
              ...(row.state === 'failed' &&
              row.skipReason !== undefined &&
              isOpenQuestionStop(stopDetail(row.skipReason))
                ? { answersQuestion: true }
                : {}),
            },
          }
        : {}),
      // A retry starts every step afresh; no claim from an earlier attempt holds it back.
      ...(row.evaluationClaimedAt !== undefined ? { evaluationClaimedAt: undefined } : {}),
      ...(row.draftClaimedAt !== undefined ? { draftClaimedAt: undefined } : {}),
      evaluationAttempts: undefined,
      evaluationUnavailableAt: undefined,
    });
    // The note is also kept for the employee's later work of the same kind.
    if (feedback) await keepCorrectionInTransaction(ctx, row, 'retry-note', feedback);
    await appendEvent(ctx, {
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
    await appendEvent(ctx, {
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
  const now = Date.now();
  await ctx.db.patch(row._id, {
    state: 'cancelled',
    skipReason,
    ...(SURFACE_MODE === 'real'
      ? { planRejectedAt: now, rejectedAt: row.rejectedAt ?? row.planRejectedAt ?? now }
      : {}),
    // Kept in full, as a rejection reason is, for the plan Retry drafts next.
    ...(feedback
      ? { managerFeedback: { reason: feedback, at: Date.now(), kind: 'plan-rejection' as const } }
      : {}),
    ...decidedPatch(row, 'plan', via, 'rejected', messageTs),
  });
  await releaseExternalClaim(ctx, row._id, Date.now());
  await appendEvent(ctx, {
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
 * model call, in real mode; see `claimLoopStepInTransaction`. Internal. An
 * evaluation whose item a colleague already holds is not claimed: the row is
 * skipped naming the holder, with a `work.claim-refused` event, and no model
 * call is made.
 */
export const claimLoopStep = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    step: v.union(v.literal('evaluation'), v.literal('draft')),
  },
  handler: async (ctx, args): Promise<StepClaim> => {
    const now = Date.now();
    if (args.step === 'evaluation') {
      const row = await ctx.db.get(args.workItemId);
      const held =
        row?.state === 'discovered' ? await externalClaimHeldElsewhere(ctx, row, now) : undefined;
      if (row && held) {
        // Two employees on one project each paid a scope call for an item one
        // of them already held (P8-2); the skip is written without one.
        const skip = claimRefusedVerdict(row, held.heldBy.holder, held.heldBy.state);
        await applyVerdict(ctx, row._id, skip);
        await logClaimRefused(ctx, row, { key: held.key, holder: held.heldBy.holder });
        return { claimed: false, reason: 'held-elsewhere' };
      }
    }
    return await claimLoopStepInTransaction(ctx, args.workItemId, args.step, now);
  },
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
 * The event records the skill's registration time and the hash of its body,
 * so the ledger says which body the run used; a skill sent back for revision
 * is refused.
 */
export const claimForExecution = internalMutation({
  args: { workItemId: v.id('workItems'), skillId: v.id('skills') },
  handler: async (
    ctx,
    args,
  ): Promise<{ claimed: true; runId: Id<'events'> } | { claimed: false; reason: string }> => {
    const { item, skill } = await assertSameAgent(ctx, args.workItemId, args.skillId);
    if (item.state !== 'plan-approved') {
      return {
        claimed: false,
        reason:
          item.state === 'executing'
            ? 'another execution already claimed this work item'
            : `workItem state is ${item.state}; expected plan-approved`,
      };
    }
    // The executor picked from the registered list before this transaction;
    // a Revise in between cleared the body the run would otherwise use (P8-8).
    if (skill.state !== 'registered' || skill.body === '') {
      return { claimed: false, reason: SKILL_UNDER_REVISION_REASON };
    }
    const runId = await appendEvent(ctx, {
      agentId: item.agentId,
      type: 'work.execution-claimed',
      payload: {
        workItemId: args.workItemId,
        skillId: args.skillId,
        ...(skill.registeredAt !== undefined ? { skillRegisteredAt: skill.registeredAt } : {}),
        skillBodyHash: skillBodyHash(skill.body),
        // The item the skill was made for: a run for any other item is a reuse (A9).
        ...(skill.proposedFor !== undefined ? { proposedFor: skill.proposedFor } : {}),
      },
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
  ): Promise<{ claimed: true; runId: Id<'events'> } | { claimed: false; reason: string }> => {
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
    const runId = await appendEvent(ctx, {
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
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.dependent-authoring',
      payload: {
        workItemId: args.workItemId,
        runId: args.runId,
        prerequisiteActionCount: output.actions.length,
        // Phase one's ledger rides on the event, so the trail keeps what
        // landed however the closing set that follows ends (P9-9).
        output: args.output,
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
    const authoringAttemptId = await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.dependent-authoring-claimed',
      payload: { workItemId: args.workItemId, runId: args.runId },
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.workItemId, {
      applyAttemptId: authoringAttemptId,
      applyClaimedAt: Date.now(),
    });
    // The claim's dead-man's switch, in the same transaction as the claim
    // (P5-1): nothing else recovers an `executing` row that holds one.
    await ctx.scheduler.runAfter(
      DEPENDENT_AUTHORING_RECOVERY_MS,
      internal.work.recoverDependentAuthoring,
      { workItemId: args.workItemId, runId: args.runId, authoringAttemptId },
    );
    return { claimed: true, authoringAttemptId };
  },
});

/**
 * The closing phase's dead-man's switch.
 *
 * Armed when the authoring claims the run (with the attempt); the stalled-step
 * sweep calls it without one for a phase whose authoring never claimed the
 * run. A row still awaiting authoring for this run is failed with its landed
 * prerequisites kept, so the card shows them and Retry resumes the closing
 * phase: unclaimed, or holding this attempt's claim past the bound. Anything
 * else has moved on. Internal.
 */
export const recoverDependentAuthoring = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    runId: v.id('events'),
    authoringAttemptId: v.optional(v.id('events')),
  },
  handler: async (ctx, args): Promise<{ recovered: 'failed' | 'ignored' }> => {
    const row = await ctx.db.get(args.workItemId);
    if (
      !row ||
      row.state !== 'executing' ||
      row.executionRunId !== args.runId ||
      (row.output as { phase?: unknown } | undefined)?.phase !== 'dependent-authoring'
    ) {
      return { recovered: 'ignored' };
    }
    if (args.authoringAttemptId === undefined) {
      if (row.applyAttemptId !== undefined) return { recovered: 'ignored' };
    } else if (
      row.applyAttemptId !== args.authoringAttemptId ||
      row.applyClaimedAt === undefined ||
      Date.now() - row.applyClaimedAt < DEPENDENT_AUTHORING_RECOVERY_MS
    ) {
      return { recovered: 'ignored' };
    }
    await failInTransaction(ctx, row, {
      reason: DEPENDENT_AUTHORING_INTERRUPTED_REASON,
      output: row.output,
    });
    return { recovered: 'failed' };
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
    await settleWriteTargetClaims(ctx, args.workItemId, Date.now());
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
    await appendEvent(ctx, {
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
        landedNoteText({
          agentName,
          title: row.title,
          rows: landedNoteRows(args.output, surfaces, replyTargetFor(row)),
          outcome: 'completed',
        }),
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
      if (
        row.state !== 'executing' ||
        !args.runId ||
        row.pendingRunId ||
        row.applyAttemptId ||
        row.applyClaimedAt ||
        row.applyPhase
      )
        return;
      const claim = await ctx.db.get(args.runId);
      if (!claim || Date.now() - claim.createdAt < EXECUTION_STALL_MS) return;
    }
    // A row that already reached an end state keeps it. Nothing legitimately
    // fails a completed run, and a losing caller must not add a second failure
    // record for a failure the winner already wrote.
    const terminal = ['completed', 'failed', 'cancelled', 'skipped'];
    if (terminal.includes(row.state)) return;
    await failInTransaction(ctx, row, args);
  },
});

/**
 * Fail one row that is not in an end state, in the caller's transaction.
 *
 * A run that landed nothing and left nothing to decide stopped: the record
 * says so, Retry stands, and nothing pages the manager for it. `setFailed`
 * and the recoveries that end a row whose step died share it.
 */
async function failInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  args: { reason: string; output?: unknown; stopped?: boolean },
): Promise<void> {
  const surfaces = (
    await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
      .collect()
  ).map(toSurfaceRecord);
  const landed = landedWork(args.output, surfaces);
  const stopped = args.stopped ?? landed.length === 0;
  const reason = stopped ? stoppedReason(args.reason) : args.reason;
  await settleWriteTargetClaims(ctx, row._id, Date.now());
  await ctx.db.patch(row._id, {
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
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.failed',
    payload: {
      workItemId: row._id,
      reason,
      ...(stopped || isStopped(reason) ? { stopped: true } : {}),
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
      landedNoteText({
        agentName,
        title: row.title,
        rows: landedNoteRows(args.output, surfaces, replyTargetFor(row)),
        outcome: 'failed',
        reason: stopDetail(reason),
      }),
    );
  }
}

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
  if (!surfaces.some(askableChannel)) return;
  const mode = managerNotificationMode(agent);
  if (kind === 'stopped' && mode === 'per-run') return;
  const noteId = await ctx.db.insert('managerNotes', {
    agentId: row.agentId,
    workItemId: row._id,
    kind,
    text: text(agent.name),
    createdAt: Date.now(),
    keptFor: mode,
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
    .filter(askableChannel)
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
    const requestRunId = await appendEvent(ctx, {
      agentId: note.agentId,
      type: 'work.manager-note-sending',
      payload: { workItemId: note.workItemId, noteId: note._id, kind: note.kind },
      createdAt: Date.now(),
    });
    await ctx.db.patch(note._id, { claimedAt: Date.now() });
    // The send's dead-man's switch, in the same transaction as the claim.
    await ctx.scheduler.runAfter(
      DECISION_REQUEST_RECOVERY_MS,
      internal.work.recoverUnsentManagerNote,
      { noteId: note._id },
    );
    return {
      prepared: true as const,
      ...delivery,
      requestRunId,
      workItemId: note.workItemId,
      text: note.text,
    };
  },
});

/** Why a claimed per-run note is recorded as not delivered. */
export const UNSENT_NOTE_REASON =
  'the send stopped before Slack answered; the note was not delivered';

/**
 * A per-run note's dead-man's switch, armed with its claim.
 *
 * A send that died between the claim and the record left the note claimed
 * for good, and nothing said so (P7-18). It is recorded as not delivered,
 * with the event the feed shows; it is not re-sent, because the message may
 * have landed and a second one would be a duplicate the manager has to read.
 */
export const recoverUnsentManagerNote = internalMutation({
  args: { noteId: v.id('managerNotes') },
  handler: async (ctx, args): Promise<{ recovered: 'marked-undelivered' | 'ignored' }> => {
    const note = await ctx.db.get(args.noteId);
    if (
      !note ||
      note.claimedAt === undefined ||
      note.providerTs !== undefined ||
      note.failure !== undefined ||
      note.digestId !== undefined
    ) {
      return { recovered: 'ignored' };
    }
    await ctx.db.patch(note._id, { failure: UNSENT_NOTE_REASON });
    await appendEvent(ctx, {
      agentId: note.agentId,
      type: 'work.manager-note-failed',
      payload: {
        workItemId: note.workItemId,
        noteId: note._id,
        kind: note.kind,
        reason: UNSENT_NOTE_REASON,
      },
      createdAt: Date.now(),
    });
    return { recovered: 'marked-undelivered' };
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
      await appendEvent(ctx, {
        agentId: note.agentId,
        type: 'work.manager-note-failed',
        payload: {
          workItemId: note.workItemId,
          noteId: note._id,
          kind: note.kind,
          reason: failure,
        },
        createdAt: Date.now(),
      });
    }
  },
});

/** The most unsent notes one digest check reads across agents, and one agent's digest takes. */
const DIGEST_NOTE_LIMIT = 500;

/** A digest this soon after the last one waits: at most one per quarter hour, whatever triggered it. */
const DIGEST_MIN_GAP_MS = 15 * 60_000;

/**
 * The agents holding notes not sent yet: digest agents, and agents switched
 * to per run with notes the switch stranded. Reads the unsent notes only;
 * `prepareManagerDigest` decides which agents are due now.
 */
export const digestCandidates = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<'agents'>[]> => {
    const unsent = await ctx.db
      .query('managerNotes')
      .withIndex('by_unsent', (q) => q.eq('claimedAt', undefined).eq('providerTs', undefined))
      .take(DIGEST_NOTE_LIMIT);
    return [...new Set(unsent.map((note) => note.agentId))];
  },
});

/**
 * Whether a note is the digest's to send. A digest agent's notes all are. A
 * per-run agent's own notes go one by one; only those kept in digest mode
 * before the switch are the digest's, by the mode stamped on the note, or
 * for a note from before the stamp, by the time of the last switch.
 */
async function digestNoteFilter(
  ctx: MutationCtx,
  agent: Doc<'agents'>,
): Promise<(note: Doc<'managerNotes'>) => boolean> {
  if (managerNotificationMode(agent) === 'digest') return () => true;
  const lastSwitch = await ctx.db
    .query('events')
    .withIndex('by_agent_type', (q) =>
      q.eq('agentId', agent._id).eq('type', 'agent.notifications-changed'),
    )
    .order('desc')
    .first();
  const keptUntil = lastSwitch?.createdAt ?? Number.NEGATIVE_INFINITY;
  return (note) =>
    note.keptFor !== undefined ? note.keptFor === 'digest' : note.createdAt <= keptUntil;
}

/**
 * Claim every kept note of one agent for a single digest send, when it is
 * due: at the top of the hour in the agent's zone, or at once for notes a
 * switch to per run stranded; never twice in one quarter hour.
 */
export const prepareManagerDigest = internalMutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    const now = Date.now();
    if (!agent || !digestDue(agent, now)) return { prepared: false as const };
    if (managerNotificationMode(agent) === 'digest') {
      const last = await ctx.db
        .query('events')
        .withIndex('by_agent_type', (q) =>
          q.eq('agentId', args.agentId).eq('type', 'work.manager-digest-sending'),
        )
        .order('desc')
        .first();
      if (last && now - last.createdAt < DIGEST_MIN_GAP_MS) return { prepared: false as const };
    }
    const belongs = await digestNoteFilter(ctx, agent);
    const notes = (
      await ctx.db
        .query('managerNotes')
        .withIndex('by_agent_unsent', (q) =>
          q.eq('agentId', args.agentId).eq('claimedAt', undefined).eq('providerTs', undefined),
        )
        .take(DIGEST_NOTE_LIMIT)
    )
      .filter(belongs)
      .sort((left, right) => left.createdAt - right.createdAt);
    if (notes.length === 0) return { prepared: false as const };
    const delivery = await managerDelivery(ctx, args.agentId);
    if (!delivery) return { prepared: false as const };
    const digestId = await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'work.manager-digest-sending',
      payload: { noteIds: notes.map((note) => note._id), count: notes.length },
      createdAt: now,
    });
    for (const note of notes) {
      await ctx.db.patch(note._id, { claimedAt: now, digestId });
    }
    return {
      prepared: true as const,
      ...delivery,
      requestRunId: digestId,
      workItemId: notes[0].workItemId,
      noteIds: notes.map((note) => note._id),
      text: digestText({ agentName: agent.name, zone: agentZone(agent), notes }),
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
      await appendEvent(ctx, {
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
): Promise<{
  verdicts: ActionVerdict[];
  autonomousActions: boolean;
  transitionDirectedByNote: boolean;
}> {
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
 * This timer reschedules an apply that never started. An apply that started
 * is covered by the timer its claim arms (`armApplySwitch`), so a start that
 * comes late is measured from the claim, not from here.
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
  await armApplySwitch(ctx, workItemId, pendingRunId, phase);
}

/**
 * Arm the apply's dead-man switch: `recoverInterruptedApply` after `APPLY_RECOVERY_MS`.
 *
 * Args:
 *   ctx: Mutation context.
 *   workItemId: The work item.
 *   pendingRunId: The run the approval belongs to.
 *   phase: Which apply phase the switch guards.
 */
async function armApplySwitch(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  pendingRunId: Id<'events'>,
  phase: 'auto' | 'approved',
): Promise<void> {
  await ctx.scheduler.runAfter(APPLY_RECOVERY_MS, internal.work.recoverInterruptedApply, {
    workItemId,
    pendingRunId,
    phase,
    fromTimer: true,
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
    const {
      verdicts: actionVerdicts,
      autonomousActions,
      transitionDirectedByNote,
    } = await reviewHeldActions(
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
    const payload: WorkActionsAutoApplyingPayload = {
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
      await appendEvent(ctx, {
        agentId: row.agentId,
        type: 'work.actions-auto-applying',
        payload,
        createdAt: Date.now(),
      });
      await scheduleApply(ctx, args.workItemId, pendingId, 'auto');
      return { pending: true, phase: 'auto' };
    }
    // A phase-one run that holds nothing for the manager (no actions, or every
    // one refused by the gate) has nothing to decide: parked, it would hold
    // the slot with both approve controls disabled and no request sent (P5-3).
    if (!dependent && heldIndexes.length === 0) {
      await appendEvent(ctx, {
        agentId: row.agentId,
        type: 'work.actions-pending',
        payload,
        createdAt: Date.now(),
      });
      await failInTransaction(ctx, row, {
        reason:
          refusals.length > 0
            ? `${NOTHING_TO_DECIDE_REASON}: Day0's gate refused every action (${refusals[0].reason}), so nothing was sent`
            : `${NOTHING_TO_DECIDE_REASON}: it emitted no actions`,
        output: args.output,
      });
      return { pending: false };
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
      // Whatever decision the row carries answered an earlier park (the plan,
      // or phase one's set); this set has not been asked about (review M5).
      decision: undefined,
    });
    await appendEvent(ctx, {
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
      // The held rows of this set have not been asked about (review M5).
      decision: undefined,
    });
    await appendEvent(ctx, {
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
  ): Promise<{
    ok: true;
    approved: Array<{ workItemId: Id<'workItems'>; approvedIndexes: number[] }>;
  }> => {
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
    if (args.members.length < 2)
      return { prepared: false, reason: 'a batch names at least two decisions' };
    const [itemCollision, batchCollision] = await Promise.all([
      ctx.db
        .query('workItems')
        .withIndex('by_agent_decision', (q) =>
          q.eq('agentId', args.agentId).eq('decision.id', args.batchId),
        )
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
    await appendEvent(ctx, {
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
  await appendEvent(ctx, {
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
 * `plan-approved` and runs the skill again. In real mode the rejection is
 * stamped (`rejectedAt`) and the claim on the provider item is released, as
 * a plan rejection releases it: another employee may take the item, and its
 * plan then waits for the manager with this reason (N3). A claim on a page
 * field the run wrote is settled, not released. Retry takes the claim again.
 */
export const rejectActions = mutation({
  args: { workItemId: v.id('workItems'), pendingRunId: v.id('events'), reason: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    return await rejectActionsInTransaction(ctx, row, args, 'dashboard');
  },
});

/**
 * Release the claim a work item holds on the provider item it was discovered
 * from, with what it refused, leaving any claim on a page field it wrote.
 *
 * Args:
 *   ctx: Mutation context of the rejection.
 *   workItemId: The rejected work item.
 *   now: The release time.
 */
async function releaseItemClaim(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  now: number,
): Promise<void> {
  const held = await ctx.db
    .query('externalClaims')
    .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
    .filter((q) => q.eq(q.field('releasedAt'), undefined))
    .collect();
  for (const claim of held) {
    if (claim.writeTarget === undefined) await releaseClaim(ctx, claim, now);
  }
}

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
  const now = Date.now();
  await settleWriteTargetClaims(ctx, args.workItemId, now);
  await ctx.db.patch(args.workItemId, {
    state: 'failed',
    skipReason,
    ...(SURFACE_MODE === 'real' ? { rejectedAt: row.rejectedAt ?? row.planRejectedAt ?? now } : {}),
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
  if (feedback)
    await keepCorrectionInTransaction(ctx, row, 'rejection', feedback, args.pendingRunId);
  await releaseItemClaim(ctx, args.workItemId, now);
  await appendEvent(ctx, {
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
      await appendEvent(ctx, {
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
        await appendEvent(ctx, {
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

/** Why a request whose message the DM no longer holds is sent again. */
export const THREAD_NOT_FOUND_REASON =
  'the request message is no longer in the manager DM (thread_not_found)';

/**
 * Close a delivered request whose thread the provider says does not exist,
 * and send it again with a fresh code.
 *
 * Internal; intake's, when reading the request's thread answers
 * `thread_not_found` (wave 3 review M7). The request is marked failed and
 * re-sent (`work.decision-request-resent`), so the next poll reads the new
 * request and not a thread that is gone.
 *
 * @returns Whether the request was closed; false when it is no longer open on this DM.
 */
export const closeDecisionThread = internalMutation({
  args: { surfaceId: v.id('surfaces'), decisionId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) return false;
    const open = (await openRequestsOn(ctx, surface)).find(
      ({ decision }) => decision.id === args.decisionId && decision.ts !== undefined,
    );
    if (!open) return false;
    await supersedeDecisionRequest(ctx, open.row, open.decision, THREAD_NOT_FOUND_REASON);
    return true;
  },
});

/** Why a manager reply got the unreadable-reply notice, on its ignored event. */
export const UNREADABLE_REPLY_REASON = 'reply not readable as a decision';

/** The most open codes the unreadable-reply notice names. */
const UNREADABLE_NOTICE_CODES = 5;

/**
 * Tell the manager, once, that a reply could not be read as a decision.
 *
 * Internal; intake's, for a manager message in the DM, or in an open
 * request's thread, that the parser does not read as approve or reject. Only
 * a message sent after an open request on this DM is a reply to one; nothing
 * is said while no request is open. Once per message: the notice is keyed by
 * the message's provider ts, so a re-read of the same window says nothing
 * again. Writes `work.decision-ignored` with the reason when it notices.
 *
 * @returns Whether a notice was queued.
 */
export const noticeUnreadableReply = internalMutation({
  args: { surfaceId: v.id('surfaces'), userId: v.string(), messageTs: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface?.managerUserId || args.userId !== surface.managerUserId) return false;
    const messageAt = providerTsToMs(args.messageTs);
    if (messageAt === null) return false;
    const answered = (await openRequestsOn(ctx, surface))
      .filter(({ decision }) => decision.requestedAt <= messageAt)
      .sort((left, right) => right.decision.requestedAt - left.decision.requestedAt);
    const anchor = answered[0];
    if (!anchor) return false;
    const codes = answered.slice(0, UNREADABLE_NOTICE_CODES).map(({ decision }) => decision.id);
    const example = codes[0];
    const text = [
      `I couldn’t read that as a decision. Reply “approve ${example}” or “reject ${example} <reason>”, with the code from the request.`,
      ...(codes.length > 1 ? [`Open decisions: ${codes.join(', ')}.`] : []),
    ].join(' ');
    const queued = await queueManagerReplyNotice(ctx, {
      surfaceId: surface._id,
      workItemId: anchor.row._id,
      decisionId: anchor.decision.id,
      messageTs: args.messageTs,
      kind: 'unknown',
      text,
    });
    if (queued) {
      await appendEvent(ctx, {
        agentId: surface.agentId,
        type: 'work.decision-ignored',
        payload: {
          surfaceId: surface._id,
          messageTs: args.messageTs,
          userId: args.userId,
          reason: UNREADABLE_REPLY_REASON,
        },
        createdAt: Date.now(),
      });
    }
    return queued;
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
    const applyAttemptId = await appendEvent(ctx, {
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
    // The switch counts from the claim: an apply that started late still has
    // its whole window before its outcomes are recorded as unknown (P9-1).
    await armApplySwitch(ctx, args.workItemId, row.pendingRunId, autoPhase ? 'auto' : 'approved');
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
 * automatic replay. A timer that fires on a claim younger than
 * `APPLY_RECOVERY_MS` leaves it alone: that claim armed its own timer. The
 * apply action's own failure calls this without `fromTimer` and is acted on
 * at once.
 */
export const recoverInterruptedApply = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    pendingRunId: v.id('events'),
    phase: v.union(v.literal('auto'), v.literal('approved')),
    fromTimer: v.optional(v.boolean()),
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
    if (args.fromTimer && Date.now() - row.applyClaimedAt < APPLY_RECOVERY_MS) {
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
    await settleWriteTargetClaims(ctx, args.workItemId, Date.now());
    await ctx.db.patch(args.workItemId, {
      state: 'failed',
      skipReason: INTERRUPTED_APPLY_REASON,
      output: { ...output, applied },
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    await appendEvent(ctx, {
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
    // The manager approved these writes and would otherwise hear nothing; the
    // note names every row whose outcome is now theirs to check.
    const surfaces = (
      await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
        .collect()
    ).map(toSurfaceRecord);
    await queueManagerNote(ctx, row, 'landed', (agentName) =>
      landedNoteText({
        agentName,
        title: row.title,
        rows: landedNoteRows({ ...output, applied }, surfaces, replyTargetFor(row)),
        outcome: 'failed',
        reason: INTERRUPTED_NOTE_REASON,
      }),
    );
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

/**
 * The employee's rows holding a slot, counted up to the largest cap.
 *
 * Read state by state through the index, so the employee's closed rows and
 * their outputs are never read: every caller compares the count with a cap
 * no larger than `AUTONOMOUS_WIP_LIMIT` (P9-1).
 */
async function countOpenForAgentImpl(ctx: QueryCtx, agentId: Id<'agents'>): Promise<number> {
  return await openSlotCount(ctx, agentId, Math.max(AUTONOMOUS_WIP_LIMIT, COLD_START_WIP_LIMIT));
}

async function findExistingClaimImpl(
  ctx: QueryCtx,
  args: { agentId: Id<'agents'>; sourceSystem: string; externalId: string },
): Promise<{ state: Doc<'workItems'>['state'] } | null> {
  const row = await ctx.db
    .query('workItems')
    .withIndex('by_agent_extId', (q) =>
      q
        .eq('agentId', args.agentId)
        .eq('sourceSystem', args.sourceSystem)
        .eq('externalId', args.externalId),
    )
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
