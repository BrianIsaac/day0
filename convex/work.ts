import type { ExecutionPlan, PlanStepOutcome } from '../src/work/types';
import { ConvexError, v, type Infer, type ObjectType } from 'convex/values';
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
import {
  assertOwnsAgent,
  assertOwnsWorkItem,
  employeeOwnerScope,
  getCallerOrThrow,
} from './ownership';
import { confirmedPersonOf } from './itemPeople';
import { resolvePerson } from './people';

import { isEvaluationAgent } from './metrics';
import { openTicketsForDraftedWork } from './mock';
import { incomingTransfersOf, type IncomingTransfer } from './managerTransfers';
import { settleHandoverAfterRun } from './transferInFlight';
import {
  oneToOneWaitsOnManager,
  skillWaitsOnManager,
  stoppedRowNeedsManager,
} from '../src/work/needs-manager';
import { firstTicketRejection } from './corrections';
import {
  APPLY_RECOVERY_MS,
  AWAITING_CHARTER,
  claimLoopStepInTransaction,
  EXECUTION_STALL_MS,
  OPEN_WORK_STATES,
  openSlotCount,
  queueStep,
  resumeStalledStepsInTransaction,
  scheduleApply,
  scheduleNextStep,
  stepHoldOf,
  stepMayRun,
  type StepClaim,
} from './workLoop';
import { EVALUATION_ATTEMPTS_SPENT } from '../src/work/queue-order';
import { actionIdempotencyKey } from '../src/work/idempotency';
import {
  HELD_CLOSE_AGAINST_WORDS,
  HELD_NOT_APPROVED,
  HELD_WRITE,
  isSurfaceTool,
  parseSurfaceAction,
  reviewActions,
  type ActionVerdict,
} from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import { closeAgainstWordsOf, closingChanges } from '../src/work/work-done';
import {
  awaitingIndexes,
  leftForCardOf,
  wholeSetApproval,
  withoutLeftForCard,
} from '../src/work/held-close';
import {
  accessRequestReason,
  organisationSystemOf,
  servedByIssuer,
} from '../src/surfaces/access-request';
import { verdictFor } from '../src/surfaces/verdict';
import type { AppliedAction } from '../src/surfaces/types';
import { autonomousActionsOn } from '../src/work/autonomy';
import { transitionWithheld } from '../src/work/obligations';
import { transitionDirectedByNote } from '../src/work/transition-direction';
import { replyTargetFor } from '../src/work/reply-target';
import { heldWithReportedWrites } from '../src/work/evidence-claims';
import type { TicketSnapshot } from '../src/work/ticket-ownership';
import {
  AUTONOMOUS_WIP_LIMIT,
  COLD_START_WIP_LIMIT,
  type MockAction,
  SCOPE_JUDGEMENT_UNAVAILABLE,
} from '../src/work/types';
import {
  HELD_ELSEWHERE_LIMIT,
  browserFieldId,
  claimKeyItem,
  providerItemKey,
  type HeldExternalItem,
  type WriteClaimHolder,
} from '../src/work/claim-key';

import { reportedRows, withoutApplyProgress } from '../src/work/apply-progress';
import { isRevocationTrialRow } from './revocationEvaluation';
import {
  askedFor,
  batchDecisionNoticeText,
  canEditManagerMessage,
  CLOSE_ONLY_ON_CARD_REASON,
  closeOnCardNoticeText,
  decisionNoticeText,
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

import {
  INTERRUPTED_APPLY_REASON,
  outcomeUnknownReasonFor,
  type ApplyEnd,
} from '../src/work/reconciliation';
import { isStopped, landedNoteRows, landedWork, stopDetail, stoppedReason } from '../src/work/stop';
import {
  digestDue,
  digestText,
  landedNoteText,
  managerNotificationMode,
  stoppedNoteText,
  type ManagerNoteKind,
  type OwedDecision,
} from '../src/work/manager-notes';
import { agentZone } from '../src/lib/zone';
import { accessEnded, accessEndedReason } from '../src/work/surface-access';
import { appendEvent, eventsOfType } from './eventLog';
import { typedCodeReachOf } from './slackMessagesTab';
import { socketBridgeStateOf } from './socketHeartbeats';
import { activeConnectionFor } from './organisationConnectionReads';
import { handedOverSince } from './handoverFence';
import { ownerRetirements, retiredClaimOn, retiredHolderName } from './retirements';
import { isEventOf } from '../src/events/contract';
import { redactTokenShapes } from '../src/surfaces/redact';
import { decisionButtonsFor } from '../src/surfaces/slack-socket';
import { typedCodeReaches } from '../src/surfaces/slack-messages-tab';
import { slackEscaped } from '../src/surfaces/slack-markup';
import {
  slackMentionIds,
  type ListedWorkItem,
  type TicketHolderView,
} from '../src/work/item-display';
import { pressFreeText } from '../src/work/decision-blocks';
import { decisionChannelOf } from '../src/work/decision-channel';
import { providerTsToMs } from '../src/work/provider-ts';
import { actionsOf, indexesWith, ledgerOf, refusedReasonEntries, verdictList } from './workLedger';
import {
  reevaluatePendingInTransaction,
  type ReevaluatePendingResult,
  REEVALUATION_BATCH,
} from './workReevaluation';
import {
  claimRefusedVerdict,
  externalClaimHeldElsewhere,
  holdsAgainst,
  landedCommentOn,
  logClaimRefused,
  releaseClaim,
  RELEASED_HOLDER_STATES,
  settleWriteTargetClaims,
} from './workClaims';
import { keptListingAt, listedSnapshotAt, recordListing } from './ticketListings';
import {
  listedRow,
  LISTING_AFTER_HANDOVER,
  refreshListedItem,
  seedItemInTransaction,
  workItemSeedFields,
} from './workSeeding';
import { applyVerdict, readmitSatisfiedInTransaction } from './workVerdicts';
import {
  acknowledgementUnsent,
  askableChannel,
  nameReplacement,
  OPEN_BATCH_SCAN,
  openRequestsOn,
  RECENT_THREADS_READ,
  recentThreadsOn,
  rememberDecidedUnmarked,
  rememberReplacedRequest,
  requestThreadOf,
  scheduleDecisionRequest,
  settleClosedBatchesOn,
  supersedeDecisionRequest,
} from './decisionRequests';
import {
  approveActionsInTransaction,
  approvePlanInTransaction,
  cancelPlanInTransaction,
  rejectActionsInTransaction,
} from './managerDecisions';

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

export { MANAGER_FEEDBACK_MAX_CHARS };

export { INTERRUPTED_APPLY_REASON };

/**
 * Read the authority and connection state used at the provider boundary.
 *
 * The agent, grants and one surface are read in one transaction so an action
 * cannot combine a switch value from one revision with grants or a connection
 * from another. A surface whose access end date has passed is named as ended,
 * so the last boundary before a send refuses it whatever its row still says.
 */
export const transportAuthority = internalQuery({
  args: {
    agentId: v.id('agents'),
    surfaceSlug: v.string(),
    /** The apply claim the send is made under, when an apply makes it (W12-R11). */
    applyClaim: v.optional(
      v.object({ workItemId: v.id('workItems'), applyAttemptId: v.id('events') }),
    ),
  },
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
        /** Whether the apply still holds the claim it was asked about; absent when none was. */
        applyClaimHeld?: boolean;
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
    const claimed = args.applyClaim ? await ctx.db.get(args.applyClaim.workItemId) : undefined;
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
      ...(args.applyClaim
        ? {
            applyClaimHeld:
              claimed?.state === 'executing' &&
              claimed.applyAttemptId === args.applyClaim.applyAttemptId,
          }
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
export async function assertSameAgent(
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

/** Public, owner-guarded: every work item of one employee. */
export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<ListedWorkItem[]> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const items = await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .collect();
    return await withRequesterNames(ctx, agent, items);
  },
});

/**
 * Each item with the name of the confirmed person its requester resolved to, where it resolved to
 * one still active in the owner's graph (W13V-7: the Work tab named such an ask "A Slack member"),
 * and the confirmed people its text mentions by Slack user id (W13V-7's second half). Each person
 * is read once.
 */
async function withRequesterNames(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  items: readonly Doc<'workItems'>[],
): Promise<ListedWorkItem[]> {
  const scope = employeeOwnerScope(agent);
  if (scope === undefined) return [...items];
  const names = new Map<string, Promise<string | undefined>>();
  const nameOf = (resolution: Doc<'workItems'>['requesterPerson']): Promise<string | undefined> => {
    if (resolution?.kind !== 'person') return Promise.resolve(undefined);
    const known = names.get(resolution.personId);
    if (known !== undefined) return known;
    const read = confirmedPersonOf(ctx, scope, resolution).then((person) => person?.displayName);
    names.set(resolution.personId, read);
    return read;
  };
  const mentioned = new Map<string, Promise<string | undefined>>();
  const mentionedName = (id: string): Promise<string | undefined> => {
    const known = mentioned.get(id);
    if (known !== undefined) return known;
    const read = resolvePerson(ctx, scope, { provider: 'slack', externalId: id })
      .then(async (resolution) => await confirmedPersonOf(ctx, scope, resolution))
      .then((person) => person?.displayName);
    mentioned.set(id, read);
    return read;
  };
  return await Promise.all(
    items.map(async (item): Promise<ListedWorkItem> => {
      const ids = slackMentionIds(`${item.title}\n${item.contentSummary}`);
      const [requesterName, mentionedNames] = await Promise.all([
        nameOf(item.requesterPerson),
        Promise.all(ids.map(async (id) => [id, await mentionedName(id)] as const)),
      ]);
      const mentionNames = Object.fromEntries(
        mentionedNames.flatMap(([id, name]) => (name === undefined ? [] : [[id, name]])),
      );
      return {
        ...item,
        ...(requesterName === undefined ? {} : { requesterName }),
        ...(Object.keys(mentionNames).length === 0 ? {} : { mentionNames }),
      };
    }),
  );
}

/** Public, owner-guarded: one work item. */
export const get = query({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => {
    return await assertOwnsWorkItem(ctx, args.workItemId);
  },
});

/**
 * The newest listing intake kept of an item's ticket, refused or not, for the
 * card's line on where the ticket stands now (K D3). Public, to the item's
 * owner only; writes nothing. The assignee's address is left out, as the
 * export leaves it out: the card names the assignee by id.
 *
 * @returns The listing, or null when intake kept none (a chat ask).
 */
export const latestListing = query({
  args: { workItemId: v.id('workItems') },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tracker: Omit<TicketSnapshot, 'assigneeEmail'>;
    listedAt: number;
    refused?: string;
    holder?: TicketHolderView;
  } | null> => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    const kept = await keptListingAt(ctx, row, Number.MAX_SAFE_INTEGER, false);
    if (kept === undefined) return null;
    const { assigned, assigneeId, state, stateType, doNotAutomate } = kept.tracker;
    const holder =
      assigneeId === undefined ? undefined : await ticketHolderOf(ctx, row, assigneeId);
    return {
      tracker: {
        assigned,
        doNotAutomate,
        ...(assigneeId !== undefined ? { assigneeId } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(stateType !== undefined ? { stateType } : {}),
      },
      listedAt: kept.listedAt,
      ...(kept.refused !== undefined ? { refused: kept.refused } : {}),
      ...(holder === undefined ? {} : { holder }),
    };
  },
});

/** The most of an employee's cards the holder's reading walks. */
const HOLDER_CARDS_READ = 100;

/**
 * Whether a listed ticket's holder is the identity the employee acts as in its tracker: the
 * provider identity its card on the item's source system recorded (W12V-15). Undefined when no
 * such card recorded one, so the page says only that someone holds it.
 */
async function ticketHolderOf(
  ctx: QueryCtx,
  row: Doc<'workItems'>,
  assigneeId: string,
): Promise<TicketHolderView | undefined> {
  const agent = await ctx.db.get(row.agentId);
  if (agent === null) return undefined;
  const cards = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
    .take(HOLDER_CARDS_READ);
  // Only a card that recorded the identity it acts as can say the holder is or is not it.
  const identities = cards
    .filter((card) => card.slug === row.sourceSystem)
    .flatMap((card) => [card.providerIdentityId, card.actsAs?.providerIdentityId])
    .filter((identity): identity is string => identity !== undefined);
  if (identities.length === 0) return undefined;
  return { employeeName: agent.name, holderIsEmployee: identities.includes(assigneeId) };
}

/** How many of an employee's newest plan drafts the earlier-plan read walks. */
const EARLIER_PLAN_READ_LIMIT = 200;

/**
 * The plan an item's current one replaced (round two section 3.7, "plan to approve, attempt
 * two"): the newest plan drafted for the item before the manager last cancelled one, as its
 * `work.plan-drafted` event keeps it. Public, to the item's owner only (`assertOwnsWorkItem`);
 * writes nothing. Bounded: the employee's newest `EARLIER_PLAN_READ_LIMIT` drafts.
 *
 * @returns The plan's summary and steps and when it was drafted, or null for an item no plan of
 *   which was cancelled, or whose earlier plan is past the bound.
 */
export const earlierPlan = query({
  args: { workItemId: v.id('workItems') },
  handler: async (
    ctx,
    args,
  ): Promise<{ summary: string; steps: string[]; draftedAt: number } | null> => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    const cancelledAt = row.planRejectedAt;
    if (cancelledAt === undefined) return null;
    const drafts = await eventsOfType(ctx, row.agentId, 'work.plan-drafted')
      .order('desc')
      .take(EARLIER_PLAN_READ_LIMIT);
    for (const draft of drafts) {
      if (draft._creationTime >= cancelledAt) continue;
      const payload = draft.payload as { workItemId?: unknown; plan?: unknown };
      if (payload.workItemId !== row._id) continue;
      const plan = payload.plan as { summary?: unknown; steps?: unknown } | undefined;
      const steps = Array.isArray(plan?.steps)
        ? plan.steps.filter((step): step is string => typeof step === 'string')
        : [];
      return {
        summary: typeof plan?.summary === 'string' ? plan.summary : '',
        steps,
        draftedAt: draft._creationTime,
      };
    }
    return null;
  },
});

/** Internal owner-free read for scheduler continuations already fenced by the work state. */
export const getInternal = internalQuery({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => await ctx.db.get(args.workItemId),
});

/** The ticket as a listing showed it, for the re-read before apply to compare with. */
const trackerSnapshot = ticketSnapshotValidator;

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
    const retries = await eventsOfType(ctx, row.agentId, 'work.retry', {
      after: args.before - CREATION_TIME_SLACK_MS,
    })
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
    const claims = await eventsOfType(ctx, row.agentId, 'work.execution-claimed')
      .filter((q) => q.eq(q.field('payload.workItemId'), args.workItemId))
      .take(RUN_SCAN_LIMIT);
    return claims.map((claim) => claim._id);
  },
});

/** Seed one listed item or bring its row up to the listing. Internal; called by intake. */
export const seedItem = internalMutation({
  args: { agentId: v.id('agents'), ...workItemSeedFields, tracker: v.optional(trackerSnapshot) },
  handler: async (ctx, args): Promise<Id<'workItems'>> => await seedItemInTransaction(ctx, args),
});

/**
 * Seed every item the mock generator made for an approved charter, the
 * tickets the office opens for them, and the `work.charter-derived` event, in
 * one transaction. Internal; the charter's seeding calls it. All or nothing,
 * so a retry after a failure never adds a second, different batch beside a
 * partial first: the generator is a model call and the seed dedups on
 * external ids only (U9 D4). Every item from the ticket queue names a ticket
 * the office holds once it is seeded (`openTicketsForDraftedWork`, M10).
 *
 * @returns How many items were seeded.
 */
export const seedCharterDerived = internalMutation({
  args: {
    agentId: v.id('agents'),
    role: v.string(),
    items: v.array(v.object(workItemSeedFields)),
  },
  handler: async (ctx, args): Promise<number> => {
    const items = await openTicketsForDraftedWork(ctx, args.agentId, args.items);
    for (const item of items) {
      await seedItemInTransaction(ctx, { agentId: args.agentId, ...item });
    }
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'work.charter-derived',
      payload: { count: args.items.length, role: args.role },
      createdAt: Date.now(),
    });
    return args.items.length;
  },
});

/**
 * Bring the row of a ticket intake refused on this poll up to the listing
 * and withdraw it when it is only waiting, while the employee is still the
 * owner the poll read it under. Internal; called by intake. A ticket with no
 * row gets none. A refused withdraw throws, as a refused seed does, so the
 * sweep holds its checkpoint and the new owner's first poll reads the ticket
 * (the wave 10 review's FR-m4).
 *
 * @returns The ticket's row, or null when it never had one.
 * @throws Error with {@link LISTING_AFTER_HANDOVER} for an employee that is gone or another owner's.
 */
export const withdrawListedItem = internalMutation({
  args: {
    agentId: v.id('agents'),
    ...workItemSeedFields,
    leftQueue: v.string(),
    tracker: v.optional(trackerSnapshot),
    /** The employee's owner key when the sweep read it; null for an employee with none. */
    startedUnder: v.union(v.string(), v.null()),
  },
  handler: async (
    ctx,
    { leftQueue, tracker, startedUnder, ...listed },
  ): Promise<Id<'workItems'> | null> => {
    const agent = await ctx.db.get(listed.agentId);
    if (agent === null || (agent.userId ?? null) !== startedUnder) {
      throw new Error(LISTING_AFTER_HANDOVER);
    }
    const existing = await listedRow(ctx, listed);
    if (!existing) return null;
    await refreshListedItem(ctx, existing, listed, leftQueue);
    await recordListing(ctx, existing, tracker, leftQueue);
    return existing._id;
  },
});

const reevaluationTriggerValidator = v.union(
  v.literal('charter'),
  v.literal('documentation'),
  v.literal('surface'),
  v.literal('claim-released'),
);

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

/** Work items one page of the unavailable-cause backfill reads. */
const UNAVAILABLE_CAUSE_BATCH = 20;

/**
 * The newest `work.scope-judgement-unavailable` events of one agent the
 * backfill walks for a row's own; a row whose event is further back keeps no
 * cause, and its waiting line names none.
 */
const UNAVAILABLE_EVENT_WALK = 200;

/**
 * One page of the `work-evaluation-unavailable-cause` migration (K D2 (b)).
 * A row stamped `evaluationUnavailableAt` before the cause was kept beside it
 * gets the cause its newest `work.scope-judgement-unavailable` event gave, so
 * the card's waiting line reads the row. Run by `migrations:runPending`.
 *
 * @param cursor - Where the previous page stopped, or null for the first.
 * @returns What the page read and changed, and where the next one starts.
 */
export async function backfillUnavailableCausePage(
  ctx: MutationCtx,
  cursor: string | null,
): Promise<{ read: number; changed: number; cursor: string; isDone: boolean }> {
  const page = await ctx.db
    .query('workItems')
    .paginate({ cursor, numItems: UNAVAILABLE_CAUSE_BATCH });
  let changed = 0;
  for (const row of page.page) {
    if (row.evaluationUnavailableAt === undefined || row.evaluationUnavailableCause !== undefined) {
      continue;
    }
    const events = await eventsOfType(ctx, row.agentId, 'work.scope-judgement-unavailable')
      .order('desc')
      .take(UNAVAILABLE_EVENT_WALK);
    for (const event of events) {
      if (
        !isEventOf(event, 'work.scope-judgement-unavailable') ||
        event.payload.workItemId !== row._id
      ) {
        continue;
      }
      await ctx.db.patch(row._id, { evaluationUnavailableCause: event.payload.cause });
      changed += 1;
      break;
    }
  }
  return {
    read: page.page.length,
    changed,
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/**
 * Record that an evaluation of a row could not get a scope judgement (E-70):
 * the `work.scope-judgement-unavailable` event and, on a row still waiting
 * under the claim that evaluation took, the moment and the cause, so the
 * card's waiting line reads them off the row and a row parked after its
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
      await ctx.db.patch(row._id, {
        evaluationUnavailableAt: at,
        evaluationUnavailableCause: args.cause,
      });
    }
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.scope-judgement-unavailable',
      payload: { workItemId: row._id, cause: args.cause },
      createdAt: at,
    });
  },
});

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
export const SKILL_UNDER_REVISION_REASON =
  'the skill is being revised; it runs once it registers again';

/** Why a claim found its skill taken out of use: retired by the manager, or replaced by its revision. */
export const SKILL_OUT_OF_USE_REASONS = {
  retired: 'the skill was retired, so it no longer runs',
  superseded: 'the skill was replaced by its revision, so this run did not start',
} as const;

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
 * Take the tickets a run's landed writes went to, when no work item holds them.
 *
 * Internal; the apply path's, after a phase's writes land. A write to a
 * ticket no work item was discovered from took no claim, so the ticket,
 * re-listed by the write, was claimed unopposed by a colleague's intake,
 * whose executor was told nothing of the comment (P8-2). Each landed ticket
 * write now leaves the writing work item holding the ticket, so the
 * colleague's evaluation meets the claim and its executor lists the item
 * with what landed. The ticket is taken under every spelling the apply's
 * guard reads (`writeTargetIds`), since the listing may print either case. A
 * ticket another work item holds is left to it, the work item's own
 * discovered item is never claimed twice, and a browser page field is
 * claimed before authoring (`takeWriteTargetClaims`), not here. A run that is
 * no longer the item's executing run takes nothing: one stopped at a
 * handover's deadline has moved to its new owner, whose claims it must not
 * write (U-2; fenced by the run id, the wave 9 review's U3-m1).
 *
 * @returns The keys taken.
 */
export const claimLandedTicketWrites = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    /** The run whose phase landed the writes. */
    runId: v.id('events'),
    writes: v.array(v.object({ surfaceSlug: v.string(), targets: v.array(v.string()) })),
  },
  handler: async (ctx, args): Promise<string[]> => {
    const row = await ctx.db.get(args.workItemId);
    if (SURFACE_MODE !== 'real' || !row || isRevocationTrialRow(row)) return [];
    if (row.state !== 'executing' || row.executionRunId !== args.runId) return [];
    const userId = (await ctx.db.get(row.agentId))?.userId;
    if (!userId) return [];
    // Each key with the ticket it names, so the claim is a write target that settles (M9).
    const keys = new Map<string, { surface: string; field: string }>();
    for (const write of args.writes) {
      const surface = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) =>
          q.eq('agentId', row.agentId).eq('slug', write.surfaceSlug),
        )
        .first();
      if (surface?.class !== 'kanban' || surface.path === 'browser-driven') continue;
      for (const target of write.targets) {
        const key = providerItemKey(
          surface,
          { sourceSystem: surface.slug, externalId: target },
          SURFACE_MODE,
        );
        if (
          key !== undefined &&
          key !== row.externalClaimKey &&
          key !== row.externalClaimAlias &&
          !keys.has(key)
        ) {
          keys.set(key, { surface: surface.slug, field: target });
        }
      }
    }
    const now = Date.now();
    const taken: string[] = [];
    for (const [key, writeTarget] of keys) {
      const live = await ctx.db
        .query('externalClaims')
        .withIndex('by_user_key', (q) => q.eq('userId', userId).eq('key', key))
        .filter((q) => q.eq(q.field('releasedAt'), undefined))
        .collect();
      if (live.length > 0 || (await retiredClaimOn(ctx, userId, key))) continue;
      await ctx.db.insert('externalClaims', {
        userId,
        key,
        agentId: row.agentId,
        workItemId: row._id,
        writeTarget,
        claimedAt: now,
      });
      taken.push(key);
    }
    return taken;
  },
});

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
    /** The run about to author: a run the item no longer carries takes nothing (U3-m1). */
    runId: v.id('events'),
    targets: v.array(v.object({ surfaceSlug: v.string(), field: v.string() })),
  },
  handler: async (ctx, args): Promise<string[]> => {
    const row = await ctx.db.get(args.workItemId);
    if (SURFACE_MODE !== 'real' || !row || isRevocationTrialRow(row)) return [];
    // A run stopped at a handover's deadline would otherwise claim a field under the new owner.
    if (row.executionRunId !== args.runId) return [];
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
    // A retired or handed-over employee's kept claims bind its colleagues as a live holder's do
    // (the wave 3.5 review's M3): the executor is told, so it announces no write the guard withholds.
    for (const retirement of await ownerRetirements(ctx, userId)) {
      for (const claim of retirement.claims) {
        if (held.length >= HELD_ELSEWHERE_LIMIT) return held;
        if (own.has(claim.key) || (claim.aliases ?? []).some((alias) => own.has(alias))) continue;
        held.push({
          ...(claim.writeTarget
            ? {
                externalId: claim.writeTarget.field,
                sourceSystem: claim.writeTarget.surface,
                pageField: true,
              }
            : claimKeyItem(claim.key)),
          holderName: retiredHolderName(retirement),
          sameEmployee: false,
          title: claim.title,
          state: claim.state,
        });
      }
    }
    return held;
  },
});

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
      await eventsOfType(ctx, row.agentId, 'work.evaluated').order('desc').take(REEVALUATION_BATCH)
    ).find((event) => (event.payload as { workItemId?: unknown }).workItemId === row._id);
    if (latest?._id !== args.evaluatedId) return { recovered: 'ignored' };
    await stopUnproposedInTransaction(ctx, row);
    return { recovered: 'failed' };
  },
});

/**
 * A `needs-skill` row's stop when the proposal its evaluation promised threw in that same
 * evaluation: at once, rather than a lease later by {@link recoverUnproposedSkill}, and in either
 * surface mode, so the card offers Retry instead of a proposal that was never written (the
 * real-Linear walk, m7). A row that left `needs-skill`, or whose proposal landed, is left alone.
 * Internal; the evaluating action's.
 */
export const stopUnproposedSkill = internalMutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ recovered: 'failed' | 'ignored' }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row || row.state !== 'needs-skill' || row.proposedSkillId !== undefined) {
      return { recovered: 'ignored' };
    }
    await stopUnproposedInTransaction(ctx, row);
    return { recovered: 'failed' };
  },
});

/** Stops a `needs-skill` row with no proposal, naming the skill it needed, so Retry evaluates it. */
async function stopUnproposedInTransaction(ctx: MutationCtx, row: Doc<'workItems'>): Promise<void> {
  const name = (row.verdict as { suggestedSkillName?: unknown } | undefined)?.suggestedSkillName;
  const skill = typeof name === 'string' && name ? `the skill "${name}"` : 'a skill';
  await failInTransaction(ctx, row, {
    reason: `evaluation found this item needs ${skill}, but its proposal was never recorded; Retry evaluates the item again`,
    stopped: true,
  });
}

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
 * Why a grounding read is refused: the draft it grounds began under the owner the employee was
 * handed away from, so its surfaces and its owner's values are that owner's (U3-m2).
 */
export const GROUNDING_READ_AFTER_HANDOVER =
  'the employee was handed over to a new manager while this plan was being drafted';

/**
 * Store a drafted plan, if the row is still waiting for one.
 *
 * Same shape as `claimForExecution`: two callers can both read `claimed`
 * before either writes, and the second would otherwise replace a plan the boss
 * may already be reading - with a second plan-drafted event to match. The
 * state check and the write share one transaction, so the second caller is
 * told its draft was not needed.
 */
/**
 * Record the one read that grounds a plan, before it is made, so the run id
 * the adapters key their idempotency on exists and the read is on the
 * timeline whatever happens next.
 *
 * Internal, for the draft's `readCandidateRecord`. Refused when the employee was handed over
 * since the draft step was claimed (`draftClaimedAt`, which every real-mode draft claims before
 * it reads): the draft read its surfaces and its owner's values under the old owner, and the
 * read would be made with the old owner's connection onto the new owner's record. Writes the
 * `work.plan-grounding-read` event.
 *
 * @throws Error with {@link GROUNDING_READ_AFTER_HANDOVER}; the draft goes on without the record.
 */
export const beginPlanGroundingRead = internalMutation({
  args: { workItemId: v.id('workItems'), action: v.any() },
  handler: async (ctx, args): Promise<Id<'events'>> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (
      row.draftClaimedAt !== undefined &&
      (await handedOverSince(ctx.db, row.agentId, row.draftClaimedAt))
    ) {
      throw new Error(GROUNDING_READ_AFTER_HANDOVER);
    }
    return await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.plan-grounding-read',
      payload: { workItemId: args.workItemId, action: args.action },
      createdAt: Date.now(),
    });
  },
});

/**
 * Attach the ledger row to the grounding read's event.
 *
 * Internal, for the draft's `readCandidateRecord`. Refused when the employee was handed over
 * since the read began (the event's own creation): the row is what the old owner's connection
 * returned, and the record it would land on is the new owner's (U3-m2). The refusal is a throw,
 * not a silent skip, so the caller's catch drafts the plan without the record as well.
 *
 * @throws Error with {@link GROUNDING_READ_AFTER_HANDOVER}.
 */
export const finishPlanGroundingRead = internalMutation({
  args: { eventId: v.id('events'), applied: v.any() },
  handler: async (ctx, args): Promise<void> => {
    const event = await ctx.db.get(args.eventId);
    if (!event) return;
    if (await handedOverSince(ctx.db, event.agentId, event._creationTime)) {
      throw new Error(GROUNDING_READ_AFTER_HANDOVER);
    }
    await ctx.db.patch(args.eventId, {
      payload: { ...(event.payload as Record<string, unknown>), applied: args.applied },
    });
  },
});

/** The most reads of the item's type `planGroundingReads` walks back through before it gives up. */
const GROUNDING_READ_SCAN_LIMIT = 2_000;

/** Whether a grounding read's ledger row says the record was read: landed, not held. */
function groundingReadLanded(applied: unknown): boolean {
  if (typeof applied !== 'object' || applied === null) return false;
  const row = applied as { ok?: unknown; held?: unknown };
  return row.ok === true && row.held !== true;
}

/**
 * The current plan-grounding read of a work item: the most recent one that
 * read the record, as the event stored it (already redacted). The executor's
 * evidence check reads it as what the item says; an earlier reading is
 * superseded, a later read that failed or was held says nothing about the
 * item (P7-18), and another item's is never returned.
 */
export const planGroundingReads = internalQuery({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<Array<{ action: unknown; applied: unknown }>> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) return [];
    const newestFirst = eventsOfType(ctx, row.agentId, 'work.plan-grounding-read', {
      after: row._creationTime,
    }).order('desc');
    let scanned = 0;
    for await (const event of newestFirst) {
      scanned += 1;
      if (scanned > GROUNDING_READ_SCAN_LIMIT) break;
      const { workItemId, action, applied } = event.payload as {
        workItemId?: string;
        action?: unknown;
        applied?: unknown;
      };
      if (workItemId === args.workItemId && action !== undefined && groundingReadLanded(applied))
        return [{ action, applied }];
    }
    return [];
  },
});

/**
 * Plan-pending rows one connection reads for plans to draft again; an
 * employee's parked plans are bounded by its work cap, far below this.
 */
const REDRAFT_SCAN = 200;

/**
 * Send back to drafting every undecided plan drafted while this surface was
 * not connected, now that it is (P7-18): the plan is drafted again from the
 * record it could not read, and its request gives way to the new plan's, as
 * a Retry's re-draft does. A plan whose read failed on a connected system is
 * left to the manager.
 *
 * @param surface - The surface that has just connected.
 * @param now - When it connected.
 */
export async function redraftPlansDraftedWithout(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  now: number,
): Promise<void> {
  const parked = await ctx.db
    .query('workItems')
    .withIndex('by_agent_state', (q) =>
      q.eq('agentId', surface.agentId).eq('state', 'plan-pending'),
    )
    .take(REDRAFT_SCAN);
  for (const row of parked) {
    const without = row.planDraftedWithout;
    if (without?.surfaceSlug !== surface.slug || without.cause !== 'not-connected') continue;
    if (row.decision?.decidedAt !== undefined) continue;
    await sendBackToDrafting(ctx, row, surface, now);
  }
}

/**
 * Send one row back to drafting because the system its plan could not read
 * is connected now, as a Retry's re-draft resets it: no plan, no request, no
 * answers, and the draft scheduled in the same transaction.
 */
export async function sendBackToDrafting(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  surface: Doc<'surfaces'>,
  now: number,
): Promise<void> {
  await rememberReplacedRequest(ctx, row, now);
  await ctx.db.patch(row._id, {
    state: 'claimed',
    plan: undefined,
    planPendingAt: undefined,
    planDraftedWithout: undefined,
    decision: undefined,
    managerAnswers: undefined,
    draftClaimedAt: undefined,
  });
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.plan-redrafting',
    payload: { workItemId: row._id, surfaceId: surface._id, slug: surface.slug },
    createdAt: now,
  });
  await scheduleNextStep(ctx, { ...row, state: 'claimed', plan: undefined });
}

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
 * (E-70 D4). So does a plan drafted without its ticket or thread
 * (`reason: 'drafted-without-record'`, P7-18): nobody read what it acts on.
 * Internal; called by the drafting action and the stalled-step
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
    // Nobody read what a plan drafted without its ticket or thread acts on,
    // so the switch does not run it (P7-18); the manager may.
    const without = row.planDraftedWithout;
    if (without !== undefined) {
      if (!args.recovery) {
        await appendEvent(ctx, {
          agentId: row.agentId,
          type: 'work.plan-held',
          payload: {
            workItemId: args.workItemId,
            reason: 'drafted-without-record',
            surfaceSlug: without.surfaceSlug,
            cause: without.cause,
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
    const chat = decisionChannelOf(surfaceRows.filter(askableChannel));
    if (!chat?.managerDmChannelId) {
      return { prepared: false as const, reason: 'no connected manager chat channel' };
    }
    const grants = await ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', row.agentId))
      .collect();
    const actions = actionsOf(row.output);
    const verdicts = verdictList(row.actionVerdicts, actions.length);
    // An approval in Slack decides every held write still waiting but a close the tripwire held,
    // which the request names apart and leaves for its card (12-H, R-12D-1).
    const approval =
      args.kind === 'actions'
        ? wholeSetApproval(verdicts, ledgerOf(row.output))
        : { approve: [], leftForCard: [] };
    const heldIndexes = [...approval.approve];
    const leftForCard =
      approval.leftForCard.length > 0
        ? {
            indexes: [...approval.leftForCard],
            ...(closeAgainstWordsOf(row.output) !== undefined
              ? { clause: closeAgainstWordsOf(row.output) }
              : {}),
          }
        : undefined;
    const refused =
      args.kind === 'actions'
        ? refusedReasonEntries(row.actionVerdicts, actions.length).map(([index, reason]) => ({
            index,
            reason,
          }))
        : [];
    if (args.kind === 'actions' && heldIndexes.length === 0 && leftForCard === undefined) {
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
            // A set whose only waiting write is a close Day0 held has nothing a code decides.
            const otherApproval = wholeSetApproval(
              verdictList(other.actionVerdicts, actionsOf(other.output).length),
              ledgerOf(other.output),
            );
            if (otherApproval.approve.length === 0) return [];
            return [
              {
                workItemId: other._id,
                decisionId: decision.id,
                pendingRunId: other.pendingRunId,
                title: other.title,
                ...(otherApproval.leftForCard.length > 0 ? { leavesCloseForCard: true } : {}),
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
    await rememberReplacedRequest(ctx, row, decision.requestedAt);
    await ctx.db.patch(row._id, { decision });
    await nameReplacement(ctx, row._id, decision);
    await settleClosedBatchesOn(ctx, {
      agentId: row.agentId,
      surfaceSlug: chat.slug,
      id: chat.managerDmChannelId,
    });
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
      item: {
        sourceCategory: row.sourceCategory,
        externalId: row.externalId,
        ...(row.contentRefs[0] ? { link: row.contentRefs[0] } : {}),
        ...(row.replyTarget ? { replyTarget: row.replyTarget } : {}),
      },
      plan: row.plan,
      ...(args.kind === 'plan' && row.planDraftedWithout
        ? {
            draftedWithout: {
              system:
                surfaceRows.find((surface) => surface.slug === row.planDraftedWithout?.surfaceSlug)
                  ?.displayName ?? row.planDraftedWithout.surfaceSlug,
              subject: row.planDraftedWithout.subject,
              cause: row.planDraftedWithout.cause,
            },
          }
        : {}),
      output: row.output,
      heldIndexes,
      ...(leftForCard !== undefined ? { leftForCard } : {}),
      refused,
      decisionId: args.decisionId,
      requestRunId,
      surface: toSurfaceRecord(chat),
      surfaces: surfaceRows.map(toSurfaceRecord),
      grants: grants.filter((grant) => !grant.revokedAt).map((grant) => grant.scope),
      pendingRunId: row.pendingRunId,
      openActionDecisions,
      // Read where the request is claimed, so the words and the blocks agree (RM3 (a)). A request
      // of a close Day0 held alone asks nothing a press could decide, so it carries no buttons;
      // nor does one sent while the bridge reports no live connection for the app (D-6 (b)).
      withButtons:
        (args.kind === 'plan' || heldIndexes.length > 0) &&
        decisionButtonsFor(chat, await socketBridgeStateOf(ctx, chat, Date.now())).available,
      // Read where the request is claimed too: a typed code is offered only to an app that takes
      // messages (W12V-7).
      typedCode: typedCodeReaches(await typedCodeReachOf(ctx, chat)),
    };
  },
});

/**
 * How many replacements the answer to a replaced code follows to the request that stands: every
 * request named from 0.17.0 points at the newest, so a longer walk is a chain an earlier release
 * left, answered with the item's standing request instead.
 */
const REPLACEMENT_HOPS = 5;

/**
 * What Day0 answers a reply or a press naming a replaced request: the decision it had, when it had
 * one (W12V-16), then the request that replaced it and where that one stands (open, or already
 * decided), following replacements to the request that stands; or that nothing replaced it yet.
 *
 * @param ctx - The decision's transaction.
 * @param replaced - The replaced request the code names.
 * @returns The answer's words, and the code that stands and the DM it went to, when there is one.
 */
async function replacedRequestAnswer(
  ctx: MutationCtx,
  replaced: Doc<'replacedDecisionRequests'>,
): Promise<{
  readonly text: string;
  readonly replacedBy?: string;
  readonly standingChannel?: string;
}> {
  const opening =
    replaced.outcome === undefined
      ? `That request (${replaced.decisionId}) was replaced`
      : `That request (${replaced.decisionId}) was ${replaced.outcome}, then replaced`;
  const answerWith = (
    code: string,
    decision: NonNullable<Doc<'workItems'>['decision']>,
  ): { readonly text: string; readonly replacedBy: string; readonly standingChannel: string } =>
    decision.decidedAt === undefined
      ? {
          text: `${opening} by ${code}. Decide on ${code} instead.`,
          replacedBy: code,
          standingChannel: decision.channel,
        }
      : {
          text: `${opening} by ${code}, which was already ${decision.outcome ?? 'decided'}.`,
          replacedBy: code,
          standingChannel: decision.channel,
        };
  let code = replaced.replacedBy;
  for (let hop = 0; code !== undefined && hop < REPLACEMENT_HOPS; hop += 1) {
    const current = code;
    const standing = await ctx.db
      .query('workItems')
      .withIndex('by_agent_decision', (q) =>
        q.eq('agentId', replaced.agentId).eq('decision.id', current),
      )
      .first();
    if (standing?.decision !== undefined) return answerWith(current, standing.decision);
    const next = await ctx.db
      .query('replacedDecisionRequests')
      .withIndex('by_agent_decision', (q) =>
        q.eq('agentId', replaced.agentId).eq('decisionId', current),
      )
      .first();
    code = next?.replacedBy;
  }
  if (code !== undefined) {
    // A chain longer than the walk: the item's own request of the kind is the one that stands.
    const item = await ctx.db.get(replaced.workItemId);
    if (item?.decision !== undefined && item.decision.kind === replaced.kind) {
      return answerWith(item.decision.id, item.decision);
    }
  }
  return {
    text: `${opening}${replaced.outcome === undefined ? '' : ','} and no longer decides anything. Day0 asks again in a new message when the work is ready for your decision.`,
  };
}

/** What the manager's note says ended a run whose apply was interrupted. */
const INTERRUPTED_NOTE_REASON =
  'the apply was interrupted, so what it sent is not known; check each change marked below';

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
        .withIndex('by_agent_channel_decided', (q) =>
          q
            .eq('agentId', surface.agentId)
            .eq('surfaceSlug', surface.slug)
            .eq('channel', channel)
            .eq('decidedAt', undefined),
        )
        .order('desc')
        .take(OPEN_BATCH_SCAN)
    ).flatMap((batch): OpenDecisionBatch[] => {
      const decisionIds = batch.members
        .map((member) => member.decisionId)
        .filter((id) => openIds.has(id));
      return decisionIds.length > 0 ? [{ batchId: batch.id, decisionIds }] : [];
    });
    const since = Date.now() - DECISION_NOTICE_WINDOW_MS;
    const decidedLately = await ctx.db
      .query('workItems')
      .withIndex('by_agent_decision_channel_decided', (q) =>
        q
          .eq('agentId', surface.agentId)
          .eq('decision.surfaceSlug', surface.slug)
          .eq('decision.channel', channel)
          .gte('decision.decidedAt', since),
      )
      .order('desc')
      .take(RECENT_THREADS_READ);
    const threads = await recentThreadsOn(ctx, surface, channel, since, {
      decided: decidedLately.flatMap((row) => (row.decision?.ts ? [row.decision.ts] : [])),
      open: requests.flatMap((request) => (request.ts ? [request.ts] : [])),
    });
    return {
      requests,
      batches,
      noticeOwed: decidedLately.length > 0,
      ...(threads.length > 0 ? { threads } : {}),
    };
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
    /** The text the request carried, kept for the edit that marks it decided. */
    text: v.optional(v.string()),
    /** The request went out with Approve and Reject buttons, which its edits remove. */
    withButtons: v.optional(v.boolean()),
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
        ...(args.ts && args.text
          ? { requestText: redactTokenShapes(args.text).slice(0, REQUEST_TEXT_KEPT) }
          : {}),
        ...(args.ts && args.withButtons === true ? { withButtons: true } : {}),
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

/**
 * The most of a request's text a decision keeps for the edit that marks it
 * decided; Slack takes 40,000 characters, and a request is a few thousand.
 */
const REQUEST_TEXT_KEPT = 12_000;

/**
 * Claim the one edit that marks a decided request in the manager DM, and say
 * what it writes: the request as it was sent, then how it was decided.
 * Internal; the close action's. Refused when the request was never
 * delivered, is not decided, was claimed already, or its chat card cannot
 * edit a message (no `chat.update` on its allowlist).
 */
export const prepareRequestClose = internalMutation({
  args: { workItemId: v.id('workItems'), decisionId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    const decision = row?.decision;
    if (
      !row ||
      !decision ||
      decision.id !== args.decisionId ||
      !decision.decidedAt ||
      !decision.ts ||
      !decision.requestText ||
      decision.closeClaimedAt
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
        candidate.slug === decision.surfaceSlug &&
        candidate.class === 'chat' &&
        candidate.verdict === 'connected' &&
        candidate.managerDmChannelId === decision.channel &&
        canEditManagerMessage(toSurfaceRecord(candidate)),
    );
    if (!agent || !surface) return { prepared: false as const };
    const requestRunId = await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.decision-request-closing',
      payload: { workItemId: row._id, decisionId: decision.id },
      createdAt: Date.now(),
    });
    const claimedAt = Date.now();
    await ctx.db.patch(row._id, { decision: { ...decision, closeClaimedAt: claimedAt } });
    const where = decision.decidedVia === 'channel' ? 'in this DM' : 'in day0';
    return {
      prepared: true as const,
      claimedAt,
      agentId: row.agentId,
      agentName: agent.name,
      requestRunId,
      surface: toSurfaceRecord(surface),
      surfaces: surfaceRows.map(toSurfaceRecord),
      grants: grants.filter((grant) => !grant.revokedAt).map((grant) => grant.scope),
      channel: decision.channel,
      ts: decision.ts,
      withButtons: decision.withButtons === true,
      text: `${pressFreeText(decision.requestText)}\n\nDecided: ${decision.outcome ?? 'decided'} ${where} (${decision.id}).`,
    };
  },
});

/** The most of a close edit's failure a decision keeps. */
const CLOSE_FAILURE_KEPT = 240;

/** Why a replaced request's message was not edited: no connected card can edit it now. */
const REPLACED_EDIT_UNAVAILABLE =
  "the manager DM's chat card cannot edit this message now (not connected, another DM, or no chat.update)";

/**
 * Claim the one edit that marks a replaced request in the manager DM (wave 12, 12-M; F2 D14), and
 * say what it writes: the request as it was sent, then that it no longer decides anything.
 * Internal; the replaced edit's action. Refused when the message was never delivered or kept no
 * text, or the edit was claimed or settled already; a message no connected card can edit (the
 * DM's card changed, or allows no `chat.update`) is settled with the reason, so nothing reads it
 * as open.
 */
export const prepareReplacedEdit = internalMutation({
  args: { replacedId: v.id('replacedDecisionRequests') },
  handler: async (ctx, args) => {
    const replaced = await ctx.db.get(args.replacedId);
    if (
      replaced === null ||
      replaced.ts === undefined ||
      replaced.requestText === undefined ||
      replaced.editClaimedAt !== undefined ||
      replaced.editedAt !== undefined ||
      replaced.editFailure !== undefined
    ) {
      return { prepared: false as const };
    }
    const [agent, surfaceRows, grants] = await Promise.all([
      ctx.db.get(replaced.agentId),
      ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', replaced.agentId))
        .collect(),
      ctx.db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', replaced.agentId))
        .collect(),
    ]);
    const surface = surfaceRows.find(
      (candidate) =>
        candidate.slug === replaced.surfaceSlug &&
        candidate.class === 'chat' &&
        candidate.verdict === 'connected' &&
        candidate.managerDmChannelId === replaced.channel &&
        canEditManagerMessage(toSurfaceRecord(candidate)),
    );
    if (agent === null || surface === undefined) {
      await ctx.db.patch(replaced._id, { editFailure: REPLACED_EDIT_UNAVAILABLE });
      return { prepared: false as const };
    }
    const claimedAt = Date.now();
    const requestRunId = await appendEvent(ctx, {
      agentId: replaced.agentId,
      type: 'work.decision-request-replacing',
      payload: { workItemId: replaced.workItemId, decisionId: replaced.decisionId },
      createdAt: claimedAt,
    });
    await ctx.db.patch(replaced._id, { editClaimedAt: claimedAt });
    return {
      prepared: true as const,
      claimedAt,
      workItemId: replaced.workItemId,
      agentId: replaced.agentId,
      agentName: agent.name,
      requestRunId,
      surface: toSurfaceRecord(surface),
      surfaces: surfaceRows.map(toSurfaceRecord),
      grants: grants.filter((grant) => !grant.revokedAt).map((grant) => grant.scope),
      channel: replaced.channel,
      ts: replaced.ts,
      withButtons: replaced.withButtons === true,
      // A decided request a park cleared before its own edit ran says how it was decided
      // (`rememberDecidedUnmarked`); no other path keeps a decided request's text.
      text:
        replaced.outcome === undefined
          ? `${pressFreeText(replaced.requestText)}\n\nReplaced (${replaced.decisionId}): this request no longer decides anything. Day0 asks again in a new message.`
          : `${pressFreeText(replaced.requestText)}\n\nDecided: ${replaced.outcome} ${replaced.decidedVia === 'channel' ? 'in this DM' : 'in day0'} (${replaced.decisionId}). The ticket close it held waits on its card, and Day0 asks about it in a new message.`,
    };
  },
});

/**
 * Record the result of a replaced request's one edit (wave 12, 12-M; N-3): when it landed, or why
 * not. Internal; the replaced edit's action, once. Fenced as the close's record is, on the claim
 * the edit was made under and on no result yet: the five-minute sweep (12-W) settles a claim that
 * lapsed with no result under the same fence.
 *
 * @returns Whether the result was written.
 */
export const recordReplacedEdit = internalMutation({
  args: {
    replacedId: v.id('replacedDecisionRequests'),
    claimedAt: v.number(),
    editedAt: v.optional(v.number()),
    failure: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    if ((args.editedAt === undefined) === (args.failure === undefined)) {
      throw new Error('an edit records exactly one of editedAt and failure');
    }
    const replaced = await ctx.db.get(args.replacedId);
    if (
      replaced === null ||
      replaced.editClaimedAt !== args.claimedAt ||
      replaced.editedAt !== undefined ||
      replaced.editFailure !== undefined
    ) {
      return false;
    }
    await ctx.db.patch(
      replaced._id,
      args.editedAt !== undefined
        ? { editedAt: args.editedAt }
        : { editFailure: redactTokenShapes(args.failure ?? '').slice(0, CLOSE_FAILURE_KEPT) },
    );
    return true;
  },
});

/**
 * Record the result of the one edit that marks a decided request: when it landed, or why it did
 * not (wave 12, 12-M; N-3). Internal; the close action's, once, after its provider call. Fenced
 * on the request's code, on the claim the edit was made under and on no result yet: the
 * five-minute sweep (12-W) settles a claim that lapsed with no result by writing
 * `closeFailure` under the same fence, so a result that arrives after it, or after a newer
 * request took the row's `decision`, writes nothing.
 *
 * @returns Whether the result was written.
 */
export const recordRequestClose = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    decisionId: v.string(),
    claimedAt: v.number(),
    closedAt: v.optional(v.number()),
    failure: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    if ((args.closedAt === undefined) === (args.failure === undefined)) {
      throw new Error('a close records exactly one of closedAt and failure');
    }
    const decision = (await ctx.db.get(args.workItemId))?.decision;
    if (
      decision?.id !== args.decisionId ||
      decision.closeClaimedAt !== args.claimedAt ||
      decision.closedAt !== undefined ||
      decision.closeFailure !== undefined
    ) {
      return false;
    }
    await ctx.db.patch(args.workItemId, {
      decision: {
        ...decision,
        ...(args.closedAt !== undefined
          ? { closedAt: args.closedAt }
          : { closeFailure: redactTokenShapes(args.failure ?? '').slice(0, CLOSE_FAILURE_KEPT) }),
      },
    });
    return true;
  },
});

/** Claim the one acknowledgement for late or duplicate manager replies. */
export const prepareDecisionNotice = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    decisionId: v.string(),
    /** Send now, whether or not the acknowledgement it follows was sent (its wait ran out). */
    afterWait: v.optional(v.boolean()),
  },
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
    // The notice says the request was already decided, so it follows the acknowledgement of that
    // decision; two presses a few milliseconds apart otherwise race (W12V-10).
    if (
      args.afterWait !== true &&
      (await acknowledgementUnsent(ctx, row.agentId, args.decisionId))
    ) {
      return { prepared: false as const, waiting: true as const };
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
      text: `Decision ${row.decision.id} was already ${row.decision.outcome ?? 'decided'} from ${slackEscaped(origin)}.`,
      // The notice answers the request, so it goes in the request's thread.
      ...(row.decision.ts ? { threadTs: row.decision.ts } : {}),
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
    const threadTs = await requestThreadOf(ctx, workItem, notice.decisionId);
    return {
      prepared: true as const,
      ...(threadTs ? { threadTs } : {}),
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
  const leftForCard: string[] = [];
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
      // As a single approval in Slack: a close the tripwire held is left for its card (12-H).
      const approval = wholeSetApproval(
        verdictList(item.actionVerdicts, actionsOf(item.output).length),
        ledgerOf(item.output),
      );
      if (approval.approve.length === 0 && approval.leftForCard.length > 0) {
        skipped.push({ decisionId: member.decisionId, reason: CLOSE_ONLY_ON_CARD_REASON });
        continue;
      }
      if (approval.leftForCard.length > 0) leftForCard.push(member.decisionId);
      await approveActionsInTransaction(
        ctx,
        item,
        {
          workItemId: item._id,
          pendingRunId: member.pendingRunId,
          approvedIndexes: [...approval.approve],
        },
        { via: 'channel', messageTs: args.messageTs, scope: 'whole-set' },
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
      text: batchDecisionNoticeText({
        id: batch.id,
        verb: args.reply.verb,
        decided,
        skipped,
        ...(args.reply.verb === 'approve'
          ? { hold: await stepHoldOf(ctx.db, surface.agentId), leftForCard }
          : {}),
      }),
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
    kind: 'received' | 'unknown' | 'replaced';
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
  // The request's thread is read now, while the item still holds the decision: by the time the
  // acknowledgement is sent the item may have moved on and cleared it (W13V-3, reproduced: rows 2
  // and 3 of the walk went needs-skill at once and their acknowledgements landed outside it).
  const threadTs = await requestThreadOf(ctx, workItem, args.decisionId);
  await ctx.scheduler.runAfter(0, internal.managerChannelActions.sendManagerReplyNotice, {
    noticeId,
    ...(threadTs === undefined ? {} : { threadTs }),
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

/** Public, owner-guarded: cancels a pending plan with the manager's reason, kept as a correction. */
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
      // A paused employee writes no verdict either, the held-elsewhere skip included (12-P).
      const permission = row ? await stepMayRun(ctx.db, row.agentId) : { mayRun: true as const };
      if (!permission.mayRun) return { claimed: false, reason: permission.reason };
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
 * How many times a run whose execution failed on the model outside the item
 * (a rate limit, an outage, a timeout) is sent back to execute before it
 * stops for the manager's Retry: the draft's ladder (`MAX_DRAFT_RESUMES`).
 */
export const MAX_EXECUTION_RESUMES = 3;

/** How long a resumed execution waits before it runs again, doubled for each resume. */
export const EXECUTION_RESUME_DELAY_MS = 60_000;

/** Recent resume events read to count a row's resumes since its last Retry. */
const EXECUTION_RESUME_HISTORY = 200;

/**
 * How many times this row's execution was resumed since the manager last
 * retried it.
 *
 * @param row - The executing row.
 * @returns The resumes counted from the row's latest `work.retry`, or all of them.
 */
async function executionResumesSinceRetry(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
): Promise<number> {
  const forRow = async (type: 'work.execution-resumed' | 'work.retry'): Promise<Doc<'events'>[]> =>
    (
      await eventsOfType(ctx, row.agentId, type).order('desc').take(EXECUTION_RESUME_HISTORY)
    ).filter((event) => (event.payload as { workItemId?: unknown }).workItemId === row._id);
  const [resumes, retries] = await Promise.all([
    forRow('work.execution-resumed'),
    forRow('work.retry'),
  ]);
  const since = retries[0]?.createdAt ?? Number.NEGATIVE_INFINITY;
  return resumes.filter((event) => event.createdAt > since).length;
}

/**
 * Send a run whose execution failed on the model back to execute, or stop it
 * once the resumes are spent (P7-18: a model outage made execution final).
 *
 * Internal; the execution action calls it for a failure that is not about the
 * item (`itemBoundModelFailure`). Fenced on the run's claim and on nothing
 * having been held or applied, so only an execution that ended before the
 * gate goes back: the row returns to `plan-approved` with a
 * `work.execution-resumed` event and its execution is scheduled after a
 * doubling wait (the stalled-step sweep may run it sooner). After
 * `MAX_EXECUTION_RESUMES` the row stops with the reason, for Retry.
 *
 * @returns `resumed`, `stopped`, or `moved-on` when the run is no longer the row's.
 */
export const resumeExecution = internalMutation({
  args: { workItemId: v.id('workItems'), runId: v.id('events'), reason: v.string() },
  handler: async (ctx, args): Promise<{ outcome: 'resumed' | 'stopped' | 'moved-on' }> => {
    const row = await ctx.db.get(args.workItemId);
    if (
      !row ||
      row.state !== 'executing' ||
      row.executionRunId !== args.runId ||
      row.pendingRunId !== undefined ||
      row.applyAttemptId !== undefined ||
      row.applyPhase !== undefined
    ) {
      return { outcome: 'moved-on' };
    }
    const attempt = (await executionResumesSinceRetry(ctx, row)) + 1;
    if (attempt > MAX_EXECUTION_RESUMES) {
      await failInTransaction(ctx, row, {
        reason: `the execution failed ${attempt} times on the model (${args.reason}); Retry runs it again`,
        stopped: true,
      });
      return { outcome: 'stopped' };
    }
    const now = Date.now();
    await ctx.db.patch(row._id, { state: 'plan-approved', executionRunId: undefined });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.execution-resumed',
      payload: { workItemId: row._id, runId: args.runId, attempt, reason: args.reason },
      createdAt: now,
    });
    await queueStep(ctx, row._id, 'execute', EXECUTION_RESUME_DELAY_MS * 2 ** (attempt - 1));
    // The run is out of flight until it claims again, which a finishing handover refuses.
    await settleHandoverAfterRun(ctx, row.agentId);
    return { outcome: 'resumed' };
  },
});

/**
 * Fail one row that is not in an end state, in the caller's transaction.
 *
 * A run that landed nothing and left nothing to decide stopped: the record
 * says so, Retry stands, and nothing pages the manager for it. `setFailed`
 * and the recoveries that end a row whose step died share it.
 */
export async function failInTransaction(
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
    waitingSince: Date.now(),
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
  await settleHandoverAfterRun(ctx, row.agentId);
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
        rows: landedNoteRows(args.output, surfaces, replyTargetFor(row), row.actionVerdicts ?? []),
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
export async function queueManagerNote(
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
    // Whether a typed code reaches the app these messages come from (W12V-7).
    typedCode: typedCodeReaches(await typedCodeReachOf(ctx, chat)),
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

/** Internal: marks a manager note as sent, or keeps it for the digest, after the send action returns. */
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

/** The most unsent notes one agent's digest takes. */
const DIGEST_NOTE_LIMIT = 500;

/** A digest this soon after the last one waits: at most one per quarter hour, whatever triggered it. */
const DIGEST_MIN_GAP_MS = 15 * 60_000;

/** The most agents one page of digest candidates reads. */
const DIGEST_AGENT_PAGE = 100;

/**
 * One page of the agents holding notes not sent yet: digest agents, and
 * agents switched to per run with notes the switch stranded. Internal; reads
 * one page of agents and at most one note of each, by the agent's own unsent
 * index, so notes that can never go out (no manager channel, a channel gone)
 * pile up under their agent and never hide another agent's digest (review
 * m18). `prepareManagerDigest` decides which agents are due now.
 *
 * @returns The page's candidates and the cursor of the next page, null after the last.
 */
export const digestCandidates = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ agentIds: Id<'agents'>[]; cursor: string | null }> => {
    const page = await ctx.db
      .query('agents')
      .paginate({ cursor: args.cursor, numItems: DIGEST_AGENT_PAGE });
    const agentIds: Id<'agents'>[] = [];
    for (const agent of page.page) {
      const unsent = await ctx.db
        .query('managerNotes')
        .withIndex('by_agent_unsent', (q) =>
          q.eq('agentId', agent._id).eq('claimedAt', undefined).eq('providerTs', undefined),
        )
        .first();
      if (unsent !== null) agentIds.push(agent._id);
    }
    return { agentIds, cursor: page.isDone ? null : page.continueCursor };
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
  const lastSwitch = await eventsOfType(ctx, agent._id, 'agent.notifications-changed')
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
/**
 * What the manager still has to decide for an agent, oldest first: each
 * parked row's delivered request with its code, or the row alone when no
 * request reached the manager (never asked, or its request failed).
 *
 * @param agentId - The agent.
 * @returns The owed decisions.
 */
async function owedDecisions(ctx: QueryCtx, agentId: Id<'agents'>): Promise<OwedDecision[]> {
  const parked = await Promise.all(
    (['plan-pending', 'actions-pending'] as const).map(
      async (state) =>
        await ctx.db
          .query('workItems')
          .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
          .collect(),
    ),
  );
  return parked
    .flat()
    .filter((row) => row.state === 'plan-pending' || row.approvedIndexes === undefined)
    .filter((row) => !isRevocationTrialRow(row))
    .sort((left, right) => left._creationTime - right._creationTime)
    .map((row): OwedDecision => {
      const decision = row.decision;
      const delivered =
        decision !== undefined &&
        askedFor(decision, row.state) &&
        decision.ts !== undefined &&
        decision.requestFailedAt === undefined;
      return { title: row.title, ...(delivered ? { decisionId: decision.id } : {}) };
    });
}

/** Internal: gathers an employee's kept notes into one digest and claims them for the send. */
export const prepareManagerDigest = internalMutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    const now = Date.now();
    if (!agent || !digestDue(agent, now)) return { prepared: false as const };
    if (managerNotificationMode(agent) === 'digest') {
      const last = await eventsOfType(ctx, args.agentId, 'work.manager-digest-sending')
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
      text: digestText({
        agentName: agent.name,
        zone: agentZone(agent),
        notes,
        owed: await owedDecisions(ctx, args.agentId),
        typedCode: delivery.typedCode,
      }),
    };
  },
});

/** Internal: records the digest as sent or releases its notes back after a failed send. */
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
 *   planStepOutcomes: The closing set's step accounting, for a retry note that directs the state change.
 *   closeAgainstWords: Whether the tripwire sent this set's close to the manager (12-D): its
 *     state change is then held whatever the switch says.
 *
 * Returns:
 *   The verdicts, one per action, and the toggle they were decided under.
 */
export async function reviewHeldActions(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  actions: MockAction[],
  planStepOutcomes: readonly PlanStepOutcome[] | undefined,
  closeAgainstWords = false,
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
    // Every mock write waits for the manager; a close the tripwire sent there says why it does.
    const closes = new Set(
      closeAgainstWords ? closingChanges(actions).map((change) => change.index) : [],
    );
    return {
      verdicts: actions.map((_, index) => ({
        disposition: 'held',
        reason: closes.has(index) ? HELD_CLOSE_AGAINST_WORDS : HELD_WRITE,
      })),
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
    // A message that reports a held write of its own set waits with it (W12X-2).
    verdicts: heldWithReportedWrites(
      actions,
      reviewActions(
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
          closeAgainstWords,
        },
      ),
    ),
    autonomousActions,
    transitionDirectedByNote: directed,
  };
}

/**
 * Park a run whose auto rows have landed until the manager decides the rest.
 *
 * Called by the apply action after the auto phase when held rows remain. The
 * ledger it hands over carries the auto rows as applied and the held rows as
 * awaiting approval; the manager's approval replaces the placeholders. Fenced
 * on the run and on the apply attempt, so a late caller cannot park a run
 * that has moved on.
 *
 * Called too after an approved phase whose approval, from Slack or the Needs
 * you batch, left a close the tripwire held for its card (12-H, R-12D-1): the
 * approved rows have landed and the close waits alone, asked about again on
 * its own. The decided request leaves the row as in the auto phase, so the
 * close reads as not yet asked (review M5): the stall sweep and the card's
 * ask control see it, and the card's head stamps no decision over it.
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
      row.applyPhase === undefined
    ) {
      return { parked: false };
    }
    const afterApproval = row.applyPhase === 'approved';
    const actions = actionsOf(args.output);
    const verdicts = verdictList(row.actionVerdicts, actions.length);
    const refusals = refusedReasonEntries(verdicts, actions.length).map(([index, reason]) => ({
      index,
      reason,
    }));
    if (afterApproval) await rememberDecidedUnmarked(ctx, row, Date.now());
    await ctx.db.patch(args.workItemId, {
      state: 'actions-pending',
      waitingSince: Date.now(),
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
        heldIndexes: afterApproval
          ? awaitingIndexes(verdicts, ledgerOf(args.output))
          : indexesWith(verdicts, 'held'),
        refusedIndexes: indexesWith(verdicts, 'refused'),
        ...(refusals.length > 0 ? { refusals } : {}),
        ...(afterApproval ? { leftForCard: true as const } : { autoApplied: true as const }),
      },
      createdAt: Date.now(),
    });
    await scheduleDecisionRequest(ctx, row, 'actions');
    await settleHandoverAfterRun(ctx, row.agentId);
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
    return await approveActionsInTransaction(ctx, row, args, { via: 'dashboard' });
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
    await getCallerOrThrow(ctx);
    if (args.members.length === 0) throw new Error('a batch approves at least one item');
    const seen = new Set<string>();
    const approved: Array<{ workItemId: Id<'workItems'>; approvedIndexes: number[] }> = [];
    for (const member of args.members) {
      if (seen.has(member.workItemId)) throw new Error('an item appears twice in the batch');
      seen.add(member.workItemId);
      const row = await assertOwnsWorkItem(ctx, member.workItemId);
      // The batch shows no tripped close's sentence: such a close is left for its card (12-H).
      const result = await approveActionsInTransaction(ctx, row, member, {
        via: 'dashboard',
        scope: 'whole-set',
      });
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

/** Resolve one parsed manager reply inside the same transaction as the dashboard controls. */
/** Why a reply naming a replaced request decided nothing, on its ignored event. */
export const REPLACED_DECISION_REASON = 'the request was replaced by a newer one';

/** The arguments of a manager's reply or press, as the channel resolves it. */
const managerReplyArgs = {
  surfaceId: v.id('surfaces'),
  userId: v.string(),
  messageTs: v.string(),
  reply: v.object({
    verb: v.union(v.literal('approve'), v.literal('reject')),
    id: v.string(),
    reason: v.optional(v.string()),
  }),
};

/** A manager's reply in the DM, or a press of a request's button, read as a decision. */
export type ManagerReply = ObjectType<typeof managerReplyArgs>;

/**
 * Apply one manager decision from the chat surface, a typed reply's or a button press's, inside
 * the same transaction as the dashboard's controls: the sender checked against the card's
 * manager, the code against the requests on this DM, a repeat answered once, a replaced code
 * answered with the request that replaced it. A press reaches here exactly as a typed reply does
 * (wave 12, 12-M), its `messageTs` the press's own timestamp.
 *
 * @param ctx - The decision's transaction.
 * @param args - Who replied or pressed, on which card, when, and the decision read from it.
 */
export async function resolveManagerReply(ctx: MutationCtx, args: ManagerReply) {
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
          text: `I couldn’t find decision ${args.reply.id}. Check the six-character code and try again.`,
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
    if (batch) return await resolveChannelBatch(ctx, surface, batch, args);
    const replaced = await ctx.db
      .query('replacedDecisionRequests')
      .withIndex('by_agent_decision', (q) =>
        q.eq('agentId', surface.agentId).eq('decisionId', args.reply.id),
      )
      .first();
    if (!replaced) return await unknown('unknown decision id');
    if (replaced.surfaceSlug !== surface.slug) {
      return await unknown('decision belongs to another manager channel');
    }
    const answer = await replacedRequestAnswer(ctx, replaced);
    // Answered in the DM it was asked in, or in the DM its replacement went to once the manager's
    // DM changed (the employee's new app after a forget, or a new manager): there the old code is
    // the one the manager still has (W13V-4).
    if (
      replaced.channel !== surface.managerDmChannelId &&
      answer.standingChannel !== surface.managerDmChannelId
    ) {
      return await unknown('decision belongs to another manager channel');
    }
    // One "was replaced" notice per replaced request (W12-R19): a further reply or press, or a
    // button left on its message, is recorded and not answered again.
    const notified =
      replaced.answeredAt === undefined &&
      (await queueManagerReplyNotice(ctx, {
        surfaceId: surface._id,
        workItemId: replaced.workItemId,
        decisionId: replaced.decisionId,
        messageTs: args.messageTs,
        kind: 'replaced',
        text: answer.text,
      }));
    if (notified) await ctx.db.patch(replaced._id, { answeredAt: Date.now() });
    await ignored(REPLACED_DECISION_REASON);
    return {
      status: 'replaced' as const,
      ...(answer.replacedBy === undefined ? {} : { replacedBy: answer.replacedBy }),
      notified,
    };
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

  let closesHeld = 0;
  if (row.decision.kind === 'plan') {
    if (args.reply.verb === 'approve') {
      await approvePlanInTransaction(ctx, row, 'channel', args.messageTs);
    } else {
      await cancelPlanInTransaction(ctx, row, 'channel', args.reply.reason ?? '', args.messageTs);
    }
  } else {
    if (!row.pendingRunId) return await ignored('actions decision has no pending run');
    // A Slack approval never shows the sentence a tripped close carries, so it decides every
    // other held write and leaves that close for its card; a rejection takes it too (12-H).
    const approval = wholeSetApproval(
      verdictList(row.actionVerdicts, actionsOf(row.output).length),
      ledgerOf(row.output),
    );
    closesHeld = approval.leftForCard.length;
    if (args.reply.verb === 'approve') {
      if (approval.approve.length === 0 && approval.leftForCard.length > 0) {
        const notified = await queueManagerReplyNotice(ctx, {
          surfaceId: surface._id,
          workItemId: row._id,
          decisionId: row.decision.id,
          messageTs: args.messageTs,
          kind: 'received',
          text: closeOnCardNoticeText(row.decision.id),
        });
        return { ...(await ignored(CLOSE_ONLY_ON_CARD_REASON)), notified };
      }
      await approveActionsInTransaction(
        ctx,
        row,
        {
          workItemId: row._id,
          pendingRunId: row.pendingRunId,
          approvedIndexes: [...approval.approve],
        },
        { via: 'channel', messageTs: args.messageTs, scope: 'whole-set' },
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
  // A pause holds the step the approval queues at its claim: the notice says when it starts (W12-R15).
  const text = decisionNoticeText({
    id: row.decision.id,
    verb: args.reply.verb,
    kind: row.decision.kind,
    hold: args.reply.verb === 'approve' ? await stepHoldOf(ctx.db, row.agentId) : undefined,
    closesHeld,
  });
  await queueManagerReplyNotice(ctx, {
    surfaceId: surface._id,
    workItemId: row._id,
    decisionId: row.decision.id,
    messageTs: args.messageTs,
    kind: 'received',
    text,
  });
  return { status: 'decided' as const, outcome: args.reply.verb };
}

/** Internal: applies a decision the manager replied with in the chat surface to the request's items. */
export const resolveChannelDecision = internalMutation({
  args: managerReplyArgs,
  handler: async (ctx, args) => await resolveManagerReply(ctx, args),
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
 * Whether a surface with each effective verdict waits on its manager to approve or connect it:
 * the states a connection ends, as opposed to a connection that lapsed (`listed-dead`) or a system
 * that is gone (`absent`), which the gate refuses as before. Keyed over every verdict, so one the
 * type gains does not compile until it is placed.
 */
const AWAITING_CONNECTION_VERDICTS: Readonly<Record<ReturnType<typeof verdictFor>, boolean>> = {
  declared: true,
  proposed: true,
  approved: true,
  ungranted: true,
  connected: false,
  'listed-dead': false,
  absent: false,
};

/**
 * The surface an approved write would go through that waits for its connection, if any: the
 * first approved row naming a surface of the employee's whose access has not ended and whose
 * effective verdict is one a connection ends ({@link AWAITING_CONNECTION_VERDICTS}).
 *
 * @param db - The claim's reader.
 * @param row - The work item, its set approved by the manager.
 * @param now - The claim's time.
 * @returns The surface's slug, or undefined when every approved write's surface is connected,
 *   ended or unknown (the gate decides those).
 */
export async function surfaceAwaitingConnection(
  db: QueryCtx['db'],
  row: Doc<'workItems'>,
  now: number,
): Promise<string | undefined> {
  const actions = actionsOf(row.output) as MockAction[];
  const surfaces = await db
    .query('surfaces')
    .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
    .collect();
  for (const index of row.approvedIndexes ?? []) {
    const action = actions[index];
    if (action === undefined || !isSurfaceTool(action.tool)) continue;
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok) continue;
    const surface = surfaces.find((candidate) => candidate.slug === parsed.action.surface);
    if (surface === undefined || accessEnded(surface, now)) continue;
    if (AWAITING_CONNECTION_VERDICTS[verdictFor(toSurfaceRecord(surface), now)]) {
      return surface.slug;
    }
  }
  return undefined;
}

/**
 * Park an approved set on the connection its write needs (U-3 of the transfer plan): the item is
 * `deferred` with the evaluator's own verdict (`awaiting-connection` and the `missingSurface`),
 * so connecting the surface returns it to evaluation (`requeueDeferredWork`); nothing was sent,
 * and the approval goes with the set, since the run is planned again from the item.
 *
 * @param ctx - The apply claim's mutation context.
 * @param row - The work item, `actions-pending` with its set approved.
 * @param missingSurface - The surface the write waits on.
 */
export async function parkOnConnection(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  missingSurface: string,
): Promise<void> {
  const verdict = {
    decision: 'defer' as const,
    reason: 'awaiting-connection' as const,
    missingSurface,
  };
  await ctx.db.patch(row._id, {
    state: 'deferred',
    waitingSince: Date.now(),
    verdict,
    // Returned to evaluation, the item is planned again, as a send-back to drafting plans it.
    plan: undefined,
    planPendingAt: undefined,
    planDraftedWithout: undefined,
    managerAnswers: undefined,
    pendingRunId: undefined,
    approvedIndexes: undefined,
    actionVerdicts: undefined,
    applyPhase: undefined,
    executionRunId: undefined,
    applyAttemptId: undefined,
    applyClaimedAt: undefined,
    decision: undefined,
  });
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.evaluated',
    payload: { workItemId: row._id, decision: verdict.decision, verdict },
    createdAt: Date.now(),
  });
  await scheduleNextStep(ctx, { ...row, state: 'deferred' });
}

/** The output of an apply whose outcome is unknown, with its ledger as recovery records it. */
export interface InterruptedApplyLedger {
  readonly output: {
    actions?: Array<{ tool?: unknown }>;
    actionIndexOffset?: unknown;
    [key: string]: unknown;
  };
  readonly applied: AppliedAction[];
}

/**
 * The ledger of an apply that was claimed and did not finish: a row this phase approved keeps the
 * outcome the apply reported for it before it stopped (P4-2) and is recorded with its outcome
 * unknown when it reported none, a row an earlier phase recorded keeps its entry, and every other
 * row keeps why it was not applied, as the apply's dead-man switch records it.
 *
 * @param row - The work item, `executing` with an apply claimed.
 * @param pendingRunId - The run the approval belongs to.
 * @param end - What ended the apply: an interruption the recovery found, or a stop; the unreported
 *   rows' reason says which (`outcomeUnknownReasonFor`).
 */
export function interruptedApplyLedger(
  row: Doc<'workItems'>,
  pendingRunId: Id<'events'>,
  end: ApplyEnd,
): InterruptedApplyLedger {
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
  // keeps the reason the gate held it for; so does a close an approval left
  // for its card (12-H), which the manager has not decided. In the approved
  // phase any other unapproved held row is one the manager left out.
  const leftForCard = new Set(leftForCardOf(row.output));
  const heldReasonFor = (index: number): string => {
    const verdict = verdicts[index];
    if (verdict.disposition === 'refused') return verdict.reason;
    if (verdict.disposition === 'held' && (row.applyPhase === 'auto' || leftForCard.has(index))) {
      return verdict.reason;
    }
    return HELD_NOT_APPROVED;
  };
  // A row the apply reported before it stopped is kept as it reported (P4-2).
  const reported = row.applyAttemptId
    ? reportedRows(row.output, row.applyAttemptId)
    : new Map<number, AppliedAction>();
  const applied = (output.actions ?? []).map((action, index): AppliedAction => {
    const earlier = prior[index];
    if (earlier && !earlier.awaitingApproval && !approved.has(index)) return earlier;
    const kept = approved.has(index) ? reported.get(index) : undefined;
    if (kept) return kept;
    return {
      tool: typeof action.tool === 'string' ? action.tool : 'unknown',
      ok: !approved.has(index),
      ...(approved.has(index)
        ? { reason: outcomeUnknownReasonFor(end) }
        : { held: true, reason: heldReasonFor(index) }),
      idempotencyKey: actionIdempotencyKey({
        workItemId: row._id,
        runId: row.executionRunId ?? pendingRunId,
        actionIndex: index + actionIndexOffset,
      }),
    };
  });
  return { output: withoutLeftForCard(withoutApplyProgress(output)), applied };
}

/**
 * Recover an apply action that disappeared across a backend interruption.
 *
 * An unclaimed approved set - the manager's, or the gate's auto rows - is
 * safe to reschedule, unless the employee or the deployment is paused, when it
 * is held and the timer's chain ends there (12-P). Once an apply claim exists, the provider may already
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
  ): Promise<{ recovered: 'ignored' | 'rescheduled' | 'held' | 'outcome-unknown' }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row || row.pendingRunId !== args.pendingRunId || row.applyPhase !== args.phase) {
      return { recovered: 'ignored' };
    }
    const unclaimedAuto =
      row.state === 'executing' && row.applyPhase === 'auto' && row.applyAttemptId === undefined;
    if ((row.state === 'actions-pending' && row.approvedIndexes !== undefined) || unclaimedAuto) {
      // A pause schedules nothing, this timer's next round included: the resume's pass, or the
      // sweep's, schedules the held set (12-P).
      return (await scheduleApply(ctx, args.workItemId, args.pendingRunId, args.phase))
        ? { recovered: 'rescheduled' }
        : { recovered: 'held' };
    }
    if (row.state !== 'executing' || !row.applyAttemptId || !row.applyClaimedAt) {
      return { recovered: 'ignored' };
    }
    if (args.fromTimer && Date.now() - row.applyClaimedAt < APPLY_RECOVERY_MS) {
      return { recovered: 'ignored' };
    }
    const { output, applied } = interruptedApplyLedger(row, args.pendingRunId, 'interrupted');
    await settleWriteTargetClaims(ctx, args.workItemId, Date.now());
    await ctx.db.patch(args.workItemId, {
      state: 'failed',
      waitingSince: Date.now(),
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
        rows: landedNoteRows(
          { ...output, applied },
          surfaces,
          replyTargetFor(row),
          row.actionVerdicts ?? [],
        ),
        outcome: 'failed',
        reason: INTERRUPTED_NOTE_REASON,
      }),
    );
    await settleHandoverAfterRun(ctx, row.agentId);
    return { recovered: 'outcome-unknown' };
  },
});

/** Internal: links a work item to the skill it proposed. */
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

/** Public, owner-guarded: how many of an employee's items are open, for the work-in-progress cap. */
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

/** Public, owner-guarded: the live item already holding a provider record, if any. */
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

/*
 * The needs-you inbox (v2 section 7 step 3, decision N7): everything waiting
 * on the manager across every employee, one entry per thing to decide,
 * ordered by how long it has waited.
 */

/** How many of the owner's agent rows the inbox reads to find its employees, as the roster does. */
const NEEDS_YOU_SCAN_LIMIT = 100;

/** The most employees the inbox covers, the roster's twenty. */
const NEEDS_YOU_EMPLOYEE_LIMIT = 20;

/**
 * Bound on each waiting state's read. Plans and held sets are held to the
 * work-in-progress cap, so for them the bound is never reached; parked rows
 * hold no slot, so for them it is the most the inbox lists.
 */
const NEEDS_YOU_STATE_READ_LIMIT = 100;

/**
 * Bound on the stopped-row read, the roster's. Nothing caps the failed rows an
 * employee has, so the newest are read: a failure the manager has not seen yet
 * is never pushed out by old ones.
 */
const NEEDS_YOU_STOPPED_READ_LIMIT = 25;

/** Bound on an employee's surfaces read, newest first, for the ones proposed to the manager. */
const NEEDS_YOU_SURFACE_READ_LIMIT = 100;

/** Bound on the questions read for one plan. */
const NEEDS_YOU_QUESTION_READ_LIMIT = 20;

/**
 * How many of an employee's events of one type the inbox reads back to find
 * when each waiting item entered its state. The rows record no entry time of
 * their own, so the event each transition writes is the source.
 */
const ENTRY_EVENT_SCAN_LIMIT = 100;

/** The most entries the inbox returns; `total` says how many there are. */
const NEEDS_YOU_LIMIT = 50;

/** What every inbox entry carries: whose it is, what it is about and how long it has waited. */
const needsYouBaseFields = {
  key: v.string(),
  agentId: v.id('agents'),
  employeeName: v.string(),
  /** The employee's zone (N12), so a stamp on the entry is in the employee's day. */
  zone: v.string(),
  /** What the entry is about: the item's title, the skill's name, the system's name. */
  subject: v.string(),
  waitingSince: v.number(),
  /** True when the entry lay beyond the bounded read, so it has waited at least since `waitingSince`. */
  waitingAtLeast: v.boolean(),
};

const needsYouEntryValidator = v.union(
  v.object({ kind: v.literal('charter'), ...needsYouBaseFields }),
  /** A deployed employee whose Day-1 one-to-one the manager has not begun. */
  v.object({ kind: v.literal('one-to-one'), ...needsYouBaseFields }),
  v.object({
    kind: v.literal('plan'),
    ...needsYouBaseFields,
    workItemId: v.id('workItems'),
    /** The charter questions the plan raised that are still unanswered. */
    questions: v.number(),
  }),
  v.object({
    kind: v.literal('held'),
    ...needsYouBaseFields,
    workItemId: v.id('workItems'),
    heldWrites: v.number(),
  }),
  v.object({
    kind: v.literal('skill'),
    ...needsYouBaseFields,
    skillId: v.id('skills'),
    /** The items parked until the skill is registered. */
    waitingItems: v.number(),
  }),
  v.object({
    kind: v.literal('parked'),
    ...needsYouBaseFields,
    workItemId: v.id('workItems'),
    reason: v.union(v.literal('connection'), v.literal('permission'), v.literal('evaluation')),
  }),
  v.object({ kind: v.literal('stopped'), ...needsYouBaseFields, workItemId: v.id('workItems') }),
  v.object({
    kind: v.literal('surface'),
    ...needsYouBaseFields,
    surfaceId: v.id('surfaces'),
    /**
     * `connect` for a card whose access request IT has answered (its organisation connection
     * landed): the manager's Connect is the way on. Absent for a system waiting on approval.
     */
    ready: v.optional(v.literal('connect')),
  }),
  /**
   * A handover naming the caller (the transfer plan, section 5.1), read by the
   * caller's verified address rather than through the caller's employees: its
   * `agentId` is an employee the caller does not own yet, so the entry opens
   * the acceptance dialog on the home, never the employee's page.
   */
  v.object({
    kind: v.literal('transfer'),
    ...needsYouBaseFields,
    transferId: v.id('managerTransfers'),
    fromAddress: v.string(),
    expiresAt: v.number(),
  }),
);

const needsYouValidator = v.object({
  entries: v.array(needsYouEntryValidator),
  total: v.number(),
  /** How many entries each employee has, all of them counted, not only the ones returned. */
  waitingByEmployee: v.array(v.object({ agentId: v.id('agents'), waiting: v.number() })),
});

/** One entry of the needs-you inbox: one thing waiting on the manager. */
export type NeedsYouEntry = Infer<typeof needsYouEntryValidator>;

/** The fields every entry shares: a charter entry is nothing else. */
type NeedsYouBase = Omit<Extract<NeedsYouEntry, { kind: 'charter' }>, 'kind'>;

/** The event types whose rows mark an item or a system entering a state that waits on the manager. */
type EntryEventType =
  | 'work.plan-drafted'
  | 'work.actions-pending'
  | 'work.evaluated'
  | 'work.evaluation-parked'
  | 'work.failed'
  | 'work.actions-interrupted'
  | 'surface.proposed';

/** When a waiting row entered its state, and whether that is exact or a bound. */
interface EnteredAt {
  readonly at: number;
  readonly atLeast: boolean;
}

/** A row the inbox dates: its id and when it was inserted. */
interface DatedRow {
  readonly _id: string;
  readonly _creationTime: number;
}

/** The item or system an entering event names. */
function enteredSubject(event: Doc<'events'>): string | undefined {
  const payload: unknown = event.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const named = payload as { workItemId?: unknown; surfaceId?: unknown };
  const id = named.workItemId ?? named.surfaceId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * When each waiting row entered its state: the newest entering event that
 * names it, read newest first, at most `ENTRY_EVENT_SCAN_LIMIT` per type.
 *
 * Where a type had more events than the read took, anything older than the
 * oldest one read is unseen. A row whose newest event found is older than that
 * point, or whose event is not found at all while it is older than that point,
 * may have entered later than it seems, so it is reported as waiting at least
 * since that point. A row with no event that is newer than that point (a
 * seeded or imported row) had none to find and is dated by its insert.
 *
 * @param ctx - Query context.
 * @param agentId - The employee.
 * @param types - The events that mark entry into the rows' state.
 * @param rows - The waiting rows.
 */
async function enteredAtByRow(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  types: readonly EntryEventType[],
  rows: readonly DatedRow[],
): Promise<Map<string, EnteredAt>> {
  if (rows.length === 0) return new Map();
  const wanted = new Set(rows.map((row) => row._id));
  const found = new Map<string, number>();
  let unseenBefore: number | undefined;
  for (const type of types) {
    const seen = new Set<string>();
    // One more than the bound, so a type with exactly the bound's events reads as complete.
    const read = await eventsOfType(ctx, agentId, type)
      .order('desc')
      .take(ENTRY_EVENT_SCAN_LIMIT + 1);
    for (const event of read.slice(0, ENTRY_EVENT_SCAN_LIMIT)) {
      const id = enteredSubject(event);
      if (id === undefined || !wanted.has(id) || seen.has(id)) continue;
      seen.add(id);
      found.set(id, Math.max(found.get(id) ?? 0, event._creationTime));
    }
    const oldestRead = read[ENTRY_EVENT_SCAN_LIMIT - 1];
    if (read.length > ENTRY_EVENT_SCAN_LIMIT && oldestRead && seen.size < wanted.size) {
      unseenBefore = Math.max(unseenBefore ?? 0, oldestRead._creationTime);
    }
  }
  return new Map(
    rows.map((row): [string, EnteredAt] => {
      const at = found.get(row._id) ?? row._creationTime;
      if (unseenBefore !== undefined && at < unseenBefore) {
        return [row._id, { at: unseenBefore, atLeast: true }];
      }
      return [row._id, { at, atLeast: false }];
    }),
  );
}

/**
 * Which manager's move releases a deferred row, or none when approving the
 * charter does (the charter's own entry already asks for that).
 */
function deferralWaitsOn(row: Doc<'workItems'>): 'connection' | 'permission' | 'evaluation' | null {
  const verdict: unknown = row.verdict;
  const reason =
    typeof verdict === 'object' && verdict !== null
      ? (verdict as { reason?: unknown }).reason
      : undefined;
  if (reason === AWAITING_CHARTER) return null;
  if (reason === 'awaiting-connection') return 'connection';
  if (reason === EVALUATION_ATTEMPTS_SPENT || reason === SCOPE_JUDGEMENT_UNAVAILABLE) {
    return 'evaluation';
  }
  return 'permission';
}

/** Everything of one employee's that waits on the manager, read and filtered, before it is dated. */
interface WaitingRows {
  readonly charter: Doc<'charters'> | null;
  readonly plans: readonly Doc<'workItems'>[];
  readonly held: readonly Doc<'workItems'>[];
  readonly parked: ReadonlyArray<{
    readonly row: Doc<'workItems'>;
    readonly reason: 'connection' | 'permission' | 'evaluation';
  }>;
  readonly skills: ReadonlyArray<{ readonly skill: Doc<'skills'>; readonly waitingItems: number }>;
  readonly stopped: readonly Doc<'workItems'>[];
  readonly proposed: readonly Doc<'surfaces'>[];
  /** Cards whose access request IT has answered, each from when its connection landed. */
  readonly connectable: ReadonlyArray<{
    readonly surface: Doc<'surfaces'>;
    readonly since: number;
  }>;
}

/**
 * How many of an employee's newest `surface.connected` events the inbox walks to tell whether a
 * card connected since it asked IT: the hourly re-probe writes one per connected card an hour, so
 * a card's own is among the last few hundred.
 */
const NEEDS_YOU_CONNECTED_READ_LIMIT = 200;

/**
 * Whether a card connected at or after an instant, among its employee's newest
 * {@link NEEDS_YOU_CONNECTED_READ_LIMIT} `surface.connected` events.
 *
 * @param ctx - Query context.
 * @param surface - The card.
 * @param since - The instant, its access request's draft.
 */
async function connectedSince(
  ctx: QueryCtx,
  surface: Doc<'surfaces'>,
  since: number,
): Promise<boolean> {
  const recent = await eventsOfType(ctx, surface.agentId, 'surface.connected')
    .order('desc')
    .take(NEEDS_YOU_CONNECTED_READ_LIMIT);
  return recent.some(
    (event) =>
      isEventOf(event, 'surface.connected') &&
      event.payload.surfaceId === surface._id &&
      event.createdAt >= since,
  );
}

/**
 * The cards whose access request IT has answered (the access plan, section 4.5): approved by the
 * manager, holding no credential, their access not past its end date, a request drafted for IT,
 * their system's organisation connection now active and asking an administrator for nothing more,
 * and not connected since the request (a card that connected and was then disconnected, revoked
 * with its organisation's connection or expired is reconnected or renewed on purpose, from its
 * card), so the manager's Connect is the way on. The approval's own probe leaves such a card
 * `ungranted` for want of a credential, so the verdict is not read. Each is dated from when the
 * connection landed, or from the request when it was drafted after.
 *
 * @param ctx - Query context.
 * @param surfaces - The employee's cards, as the inbox read them.
 * @param now - The instant an end date is judged against.
 */
async function connectReadyCards(
  ctx: QueryCtx,
  surfaces: readonly Doc<'surfaces'>[],
  now: number,
): Promise<WaitingRows['connectable']> {
  const ready = await Promise.all(
    surfaces.map(async (surface) => {
      const request = surface.accessRequest;
      const system = organisationSystemOf(surface);
      if (
        surface.managerApprovedAt === undefined ||
        surface.credentialId !== undefined ||
        accessEnded(surface, now) ||
        request === undefined ||
        system === undefined
      ) {
        return [];
      }
      // A connection no issuer acts through connects no card (11-AC's item 8; D6, by its kind).
      const connection = await activeConnectionFor(ctx, system);
      if (
        connection === null ||
        !servedByIssuer(connection) ||
        accessRequestReason(surface, connection) !== undefined
      ) {
        return [];
      }
      if (await connectedSince(ctx, surface, request.draftedAt)) return [];
      return [{ surface, since: Math.max(connection.createdAt, request.draftedAt) }];
    }),
  );
  return ready.flat();
}

/**
 * Read one employee's rows that wait on the manager.
 *
 * The rows are the roster's (`src/work/needs-manager.ts`), with three
 * differences because the inbox lists decisions rather than counting rows: a
 * held action set the manager already decided is not listed, a skill several
 * items wait on is one entry, and a row parked until the charter is approved
 * is covered by the charter's entry. A system the employee proposed is listed
 * too, since only the manager approves it, and so is a one-to-one not yet
 * begun (`needsYouOfEmployee`), which is not a row.
 *
 * @param ctx - Query context.
 * @param agentId - The employee.
 * @param now - The instant an authoring claim is judged against.
 */
async function waitingRowsOf(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<WaitingRows> {
  const rowsIn = async (
    state: Doc<'workItems'>['state'],
    limit: number = NEEDS_YOU_STATE_READ_LIMIT,
  ): Promise<Doc<'workItems'>[]> =>
    await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
      .order('desc')
      .take(limit);
  const [charter, planRows, heldRows, deferredRows, skillRows, failedRows, surfaces] =
    await Promise.all([
      ctx.db
        .query('charters')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .order('desc')
        .first(),
      rowsIn('plan-pending'),
      rowsIn('actions-pending'),
      rowsIn('deferred'),
      rowsIn('needs-skill'),
      rowsIn('failed', NEEDS_YOU_STOPPED_READ_LIMIT),
      // Newest first: a proposed system is a recent row, and past the bound the old ones go.
      ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .order('desc')
        .take(NEEDS_YOU_SURFACE_READ_LIMIT),
    ]);
  const skillIds = [...new Set(skillRows.flatMap((row) => row.proposedSkillId ?? []))];
  const [skills, connectable] = await Promise.all([
    Promise.all(skillIds.map(async (id) => await ctx.db.get(id))),
    connectReadyCards(ctx, surfaces, now),
  ]);
  return {
    charter: charter && !charter.approved ? charter : null,
    plans: planRows.filter((row) => !isRevocationTrialRow(row)),
    held: heldRows.filter((row) => row.approvedIndexes === undefined && !isRevocationTrialRow(row)),
    parked: deferredRows.flatMap((row) => {
      const reason = deferralWaitsOn(row);
      return reason === null ? [] : [{ row, reason }];
    }),
    skills: skills.flatMap((skill) =>
      skill && skillWaitsOnManager(skill, now)
        ? [
            {
              skill,
              waitingItems: skillRows.filter((row) => row.proposedSkillId === skill._id).length,
            },
          ]
        : [],
    ),
    stopped: failedRows.filter(stoppedRowNeedsManager),
    proposed: surfaces.filter((surface) => surface.verdict === 'proposed'),
    connectable,
  };
}

/**
 * When an employee's one-to-one began to wait on the manager: its deploy, or a charter sent back
 * since, which returns an employee with no approved charter to `deployed`. A row with neither
 * event (seeded or imported) is dated by its insert.
 *
 * @param ctx - Query context.
 * @param agent - An employee whose one-to-one waits.
 */
async function oneToOneWaitingSince(ctx: QueryCtx, agent: Doc<'agents'>): Promise<number> {
  const [deployed, sentBack] = await Promise.all([
    eventsOfType(ctx, agent._id, 'agent.deployed').order('desc').first(),
    eventsOfType(ctx, agent._id, 'charter.request_changes').order('desc').first(),
  ]);
  return Math.max(deployed?._creationTime ?? agent._creationTime, sentBack?._creationTime ?? 0);
}

/**
 * Everything one employee waits on the manager for, each entry dated.
 *
 * @param ctx - Query context.
 * @param agent - The employee.
 * @param now - The instant an authoring claim is judged against.
 */
export async function needsYouOfEmployee(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  now: number,
): Promise<NeedsYouEntry[]> {
  const waiting = await waitingRowsOf(ctx, agent._id, now);
  // Only a row that entered its wait before the stamp existed is dated by reading events.
  const unstamped = (row: Doc<'workItems'>): boolean => row.waitingSince === undefined;
  const [
    oneToOneSince,
    questions,
    planEntered,
    heldEntered,
    parkedEntered,
    stoppedEntered,
    surfaceEntered,
  ] = await Promise.all([
    oneToOneWaitsOnManager(agent) ? oneToOneWaitingSince(ctx, agent) : null,
    Promise.all(
      waiting.plans.map(
        async (row) =>
          (
            await ctx.db
              .query('managerQuestions')
              .withIndex('by_work_item', (q) => q.eq('workItemId', row._id))
              .take(NEEDS_YOU_QUESTION_READ_LIMIT)
          ).filter((question) => question.answer === undefined).length,
      ),
    ),
    enteredAtByRow(
      ctx,
      agent._id,
      ['work.plan-drafted'],
      waiting.plans.filter((row) => row.planPendingAt === undefined && unstamped(row)),
    ),
    enteredAtByRow(ctx, agent._id, ['work.actions-pending'], waiting.held.filter(unstamped)),
    enteredAtByRow(
      ctx,
      agent._id,
      ['work.evaluated', 'work.evaluation-parked'],
      waiting.parked.map(({ row }) => row).filter(unstamped),
    ),
    enteredAtByRow(
      ctx,
      agent._id,
      ['work.failed', 'work.actions-interrupted'],
      waiting.stopped.filter(unstamped),
    ),
    enteredAtByRow(ctx, agent._id, ['surface.proposed'], waiting.proposed),
  ]);

  const zone = agentZone(agent);
  const base = (key: string, subject: string, entered: EnteredAt): NeedsYouBase => ({
    key,
    agentId: agent._id,
    employeeName: agent.name,
    zone,
    subject,
    waitingSince: entered.at,
    waitingAtLeast: entered.atLeast,
  });
  const exact = (at: number): EnteredAt => ({ at, atLeast: false });
  // A row stamped as it entered its wait is dated by the stamp; one that entered before the
  // stamp existed, by its entering event as before.
  const enteredOf = (
    dates: Map<string, EnteredAt>,
    row: DatedRow & Pick<Doc<'workItems'>, 'waitingSince'>,
  ): EnteredAt =>
    row.waitingSince !== undefined
      ? exact(row.waitingSince)
      : (dates.get(row._id) ?? exact(row._creationTime));

  return [
    ...(oneToOneSince !== null
      ? [
          {
            kind: 'one-to-one' as const,
            ...base(`one-to-one:${agent._id}`, 'one-to-one', exact(oneToOneSince)),
          },
        ]
      : []),
    ...(waiting.charter
      ? [
          {
            kind: 'charter' as const,
            ...base(`charter:${waiting.charter._id}`, 'charter', exact(waiting.charter.createdAt)),
          },
        ]
      : []),
    ...waiting.plans.map((row, index) => ({
      kind: 'plan' as const,
      ...base(
        `plan:${row._id}`,
        row.title,
        row.waitingSince === undefined && row.planPendingAt !== undefined
          ? exact(row.planPendingAt)
          : enteredOf(planEntered, row),
      ),
      workItemId: row._id,
      questions: questions[index] ?? 0,
    })),
    ...waiting.held.map((row) => ({
      kind: 'held' as const,
      ...base(`held:${row._id}`, row.title, enteredOf(heldEntered, row)),
      workItemId: row._id,
      heldWrites: verdictList(row.actionVerdicts, actionsOf(row.output).length).filter(
        (verdict) => verdict.disposition === 'held',
      ).length,
    })),
    ...waiting.skills.map(({ skill, waitingItems }) => ({
      kind: 'skill' as const,
      // Stamped as the skill entered its wait (13-K's field); one stamped before none, by its proposal.
      ...base(`skill:${skill._id}`, skill.name, exact(skill.waitingSince ?? skill.createdAt)),
      skillId: skill._id,
      waitingItems,
    })),
    ...waiting.parked.map(({ row, reason }) => ({
      kind: 'parked' as const,
      ...base(`parked:${row._id}`, row.title, enteredOf(parkedEntered, row)),
      workItemId: row._id,
      reason,
    })),
    ...waiting.stopped.map((row) => ({
      kind: 'stopped' as const,
      ...base(`stopped:${row._id}`, row.title, enteredOf(stoppedEntered, row)),
      workItemId: row._id,
    })),
    ...waiting.proposed.map((surface) => ({
      kind: 'surface' as const,
      ...base(`surface:${surface._id}`, surface.displayName, enteredOf(surfaceEntered, surface)),
      surfaceId: surface._id,
    })),
    ...waiting.connectable.map(({ surface, since }) => ({
      kind: 'surface' as const,
      ...base(`surface:${surface._id}`, surface.displayName, exact(since)),
      surfaceId: surface._id,
      ready: 'connect' as const,
    })),
  ];
}

/** The inbox's one order: the longest wait first, ties by key so the order is stable. */
function longestWaitFirst(left: NeedsYouEntry, right: NeedsYouEntry): number {
  return left.waitingSince - right.waitingSince || left.key.localeCompare(right.key);
}

/**
 * A handover naming the caller as an inbox entry, waiting since it was asked.
 *
 * @param transfer - The request, as `incomingTransfersOf` reads it.
 */
function transferEntryOf(transfer: IncomingTransfer): NeedsYouEntry {
  return {
    kind: 'transfer',
    key: `transfer:${transfer.transferId}`,
    agentId: transfer.agentId,
    employeeName: transfer.employeeName,
    zone: transfer.zone,
    subject: transfer.employeeName,
    waitingSince: transfer.requestedAt,
    waitingAtLeast: false,
    transferId: transfer.transferId,
    fromAddress: transfer.fromAddress,
    expiresAt: transfer.expiresAt,
  };
}

/**
 * Public, owner-scoped: everything waiting on the manager across their
 * employees, and every handover naming the caller's verified address (the
 * ninth kind, read by address through `incomingTransfersOf`), longest wait
 * first, for the needs-you inbox on the signed-in home (N7). Evaluation agents
 * and the baseline arm are left out, as on the roster. A handover is counted
 * in `total` and on no employee in `waitingByEmployee`, since its employee is
 * not the caller's yet. A caller with no identity is refused (12-G). Writes
 * nothing.
 *
 * @returns At most `NEEDS_YOU_LIMIT` entries, how many there are in all, and
 *   how many wait on each employee.
 */
export const needsYou = query({
  args: {},
  returns: needsYouValidator,
  handler: async (ctx): Promise<Infer<typeof needsYouValidator>> => {
    const caller = await getCallerOrThrow(ctx);
    // A token with an empty subject keys nobody's rows, the malformed ones keyed '' included.
    if (caller.ownerKey === '') return { entries: [], total: 0, waitingByEmployee: [] };
    const employees = (
      await ctx.db
        .query('agents')
        .withIndex('by_userId', (q) => q.eq('userId', caller.ownerKey))
        .order('desc')
        .take(NEEDS_YOU_SCAN_LIMIT)
    )
      .filter((agent) => !isEvaluationAgent(agent))
      .slice(0, NEEDS_YOU_EMPLOYEE_LIMIT);
    const now = Date.now();
    const [perEmployee, incoming] = await Promise.all([
      Promise.all(employees.map(async (agent) => await needsYouOfEmployee(ctx, agent, now))),
      incomingTransfersOf(ctx, caller, now),
    ]);
    const waiting = perEmployee.flat().sort(longestWaitFirst);
    // No employee's page lists a handover, so every one stays in the entries
    // returned (at most MAX_OPEN_TRANSFERS_PER_ADDRESS); the longest waits fill the rest.
    const transfers = incoming.map(transferEntryOf);
    const entries = [
      ...transfers,
      ...waiting.slice(0, Math.max(0, NEEDS_YOU_LIMIT - transfers.length)),
    ].sort(longestWaitFirst);
    return {
      entries,
      total: waiting.length + transfers.length,
      waitingByEmployee: employees.map((agent, index) => ({
        agentId: agent._id,
        waiting: perEmployee[index]?.length ?? 0,
      })),
    };
  },
});

const needsYouForAgentValidator = v.object({
  entries: v.array(needsYouEntryValidator),
  total: v.number(),
});

/**
 * Public, owner-guarded (`assertOwnsAgent`): what one employee waits on the
 * manager for, longest wait first, for the Needs you tab of the employee's
 * page (N7). The same rows, kinds and dating as `needsYou`, read by the same
 * `needsYouOfEmployee`, so for an employee the home lists, the tab lists the
 * same entries in the same order. The home leaves out evaluation agents and
 * reads at most `NEEDS_YOU_EMPLOYEE_LIMIT` employees; the tab answers for the
 * one employee its page is about, whichever it is. Writes nothing.
 *
 * @returns At most `NEEDS_YOU_LIMIT` entries and how many there are in all.
 */
export const needsYouForAgent = query({
  args: { agentId: v.id('agents') },
  returns: needsYouForAgentValidator,
  handler: async (ctx, args): Promise<Infer<typeof needsYouForAgentValidator>> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const entries = (await needsYouOfEmployee(ctx, agent, Date.now())).sort(longestWaitFirst);
    return { entries: entries.slice(0, NEEDS_YOU_LIMIT), total: entries.length };
  },
});
