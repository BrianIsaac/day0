import { ConvexError, v, type ObjectType } from 'convex/values';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertOwnsWorkItem } from './ownership';
import { settleHandoverAfterRun } from './transferInFlight';
import { questionNoticeOwed, questionRequestsOn } from './managerQuestions';
import { conflictNoticeReplyLine } from '../src/agent/reorientation-words';
import { toSurfaceRecord } from '../src/surfaces/records';
import { closeAgainstWordsOf } from '../src/work/work-done';
import { awaitingIndexes, wholeSetApproval } from '../src/work/held-close';
import {
  askedFor,
  canEditManagerMessage,
  DECISION_NOTICE_WINDOW_MS,
  DECISION_REQUEST_RECOVERY_MS,
  type DecisionKind,
  NOTHING_OPEN,
  type OpenDecisionBatch,
  type OpenDecisionRequest,
  type OpenDecisions,
  undeliveredDecisionReason,
} from '../src/work/manager-channel';
import { digestDue, digestText, managerNotificationMode } from '../src/work/manager-notes';
import { agentZone } from '../src/lib/zone';
import { appendEvent, eventsOfType } from './eventLog';
import { typedCodeReachOf } from './slackMessagesTab';
import { socketBridgeStateOf } from './socketHeartbeats';
import type { DecisionAcknowledgementKind, DecisionNoticeKind } from '../src/events/contract';
import { redactTokenShapes } from '../src/surfaces/redact';
import { decisionButtonsFor } from '../src/surfaces/slack-socket';
import { typedCodeReaches } from '../src/surfaces/slack-messages-tab';
import { slackEscaped } from '../src/surfaces/slack-markup';
import { pressFreeText } from '../src/work/decision-blocks';
import { decisionChannelOf } from '../src/work/decision-channel';
import { providerTsToMs } from '../src/work/provider-ts';
import { actionsOf, indexesWith, ledgerOf, refusedReasonEntries, verdictList } from './workLedger';
import {
  acknowledgementUnsent,
  askableChannel,
  nameReplacement,
  OPEN_BATCH_SCAN,
  openRequestsOn,
  RECENT_THREADS_READ,
  QUESTION_THREADS_READ,
  recentThreadsOn,
  rememberDecidedUnmarked,
  rememberRequestWithQuestion,
  rememberReplacedRequest,
  requestThreadOf,
  scheduleDecisionRequest,
  settleClosedBatchesOn,
  supersedeDecisionRequest,
} from './decisionRequests';
import { approveActionsInTransaction } from './managerDecisions';
import { queueManagerReplyNotice } from './managerReplies';
import { digestNoteFilter, managerDelivery, owedDecisions } from './managerNotes';

/*
 * The manager channel's handler bodies (wave 18, 18-s): the decision request's claim, recovery,
 * record, close and replaced edit; the poll's open decisions and checkpoint; the notices in the
 * manager's DM; the per-run notes and the digest; the park on held actions, the batch approval and
 * its code; a lost thread and an unreadable reply. Each stays registered in `convex/work.ts` at
 * the path the actions and the scheduler hold (S-1), where it validates, guards and calls its body
 * here; the bodies, their validators and the bounds and helpers they alone read moved out of that
 * module as they stood. They reach their siblings through `internal.work.*`, never by import:
 * this module is below `convex/work.ts` and never imports it.
 */

/** What `work.prepareDecisionRequest` takes. */
export const prepareDecisionRequestArgs = {
  workItemId: v.id('workItems'),
  kind: v.union(v.literal('plan'), v.literal('actions')),
  decisionId: v.string(),
  /** The undelivered request this one replaces; a delivered code is never replaced. */
  supersedes: v.optional(v.string()),
};

/**
 * Claim the only outbound message for one parked decision state.
 * The body of `work.prepareDecisionRequest`.
 */
export async function prepareDecisionRequestInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof prepareDecisionRequestArgs>,
) {
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
}

/** What `work.recoverUndeliveredDecisionRequest` takes. */
export const recoverUndeliveredDecisionRequestArgs = {
  workItemId: v.id('workItems'),
  decisionId: v.string(),
};

/**
 * The request path's dead-man's switch: resend a claim that has neither a provider timestamp
 * nor a failure past the recovery bound.
 * The body of `work.recoverUndeliveredDecisionRequest`.
 */
export async function recoverUndeliveredDecisionRequestInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof recoverUndeliveredDecisionRequestArgs>,
): Promise<{ recovered: 'resent' | 'ignored' }> {
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
}

/** What `work.openDecisions` takes. */
export const openDecisionsArgs = { surfaceId: v.id('surfaces') };

/**
 * What one manager chat channel has open, for the decision poll (Q13).
 * The body of `work.openDecisions`.
 */
export async function openDecisionsInTransaction(
  ctx: QueryCtx,
  args: ObjectType<typeof openDecisionsArgs>,
): Promise<OpenDecisions> {
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
  // A conflict's question waits beside a decided plan for as long as it stands (16-O, M1), and
  // its request's thread is read for as long, whatever the window (17-C).
  const asking = await questionRequestsOn(ctx, surface, channel, QUESTION_THREADS_READ);
  const threads = await recentThreadsOn(ctx, surface, channel, since, {
    decided: decidedLately.flatMap((row) => (row.decision?.ts ? [row.decision.ts] : [])),
    open: requests.flatMap((request) => (request.ts ? [request.ts] : [])),
    questions: asking.flatMap((request) => (request.ts ? [request.ts] : [])),
  });
  return {
    requests,
    batches,
    noticeOwed: decidedLately.length > 0 || asking.length > 0,
    ...(threads.length > 0 ? { threads } : {}),
  };
}

/** What `work.recordDecisionPoll` takes. */
export const recordDecisionPollArgs = {
  surfaceId: v.id('surfaces'),
  polledAt: v.optional(v.number()),
  failure: v.optional(v.string()),
};

/**
 * Record the outcome of one manager-reply poll.
 * The body of `work.recordDecisionPoll`.
 */
export async function recordDecisionPollInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof recordDecisionPollArgs>,
): Promise<boolean> {
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
}

/** What `work.recordDecisionRequest` takes. */
export const recordDecisionRequestArgs = {
  workItemId: v.id('workItems'),
  decisionId: v.string(),
  ts: v.optional(v.string()),
  /** The text the request carried, kept for the edit that marks it decided. */
  text: v.optional(v.string()),
  /** The request went out with Approve and Reject buttons, which its edits remove. */
  withButtons: v.optional(v.boolean()),
  failure: v.optional(v.string()),
};

/**
 * Attach provider evidence, or a bounded failure, to the claimed request.
 * The body of `work.recordDecisionRequest`.
 */
export async function recordDecisionRequestInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof recordDecisionRequestArgs>,
): Promise<boolean> {
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
}

/**
 * The most of a request's text a decision keeps for the edit that marks it
 * decided; Slack takes 40,000 characters, and a request is a few thousand.
 */
const REQUEST_TEXT_KEPT = 12_000;

/** What `work.prepareRequestClose` takes. */
export const prepareRequestCloseArgs = { workItemId: v.id('workItems'), decisionId: v.string() };

/**
 * Claim the one edit that marks a decided request in the manager DM, and say what it writes.
 * The body of `work.prepareRequestClose`.
 */
export async function prepareRequestCloseInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof prepareRequestCloseArgs>,
) {
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
  const where = decision.decidedVia === 'channel' ? 'in this DM' : 'in Day0';
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
}

/** The most of a close edit's failure a decision keeps. */
const CLOSE_FAILURE_KEPT = 240;

/** Why a replaced request's message was not edited: no connected card can edit it now. */
const REPLACED_EDIT_UNAVAILABLE =
  "the manager DM's chat card cannot edit this message now (not connected, another DM, or no chat.update)";

/** What `work.prepareReplacedEdit` takes. */
export const prepareReplacedEditArgs = { replacedId: v.id('replacedDecisionRequests') };

/**
 * Claim the one edit that marks a replaced request in the manager DM, and say what it writes.
 * The body of `work.prepareReplacedEdit`.
 */
export async function prepareReplacedEditInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof prepareReplacedEditArgs>,
) {
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
        : `${pressFreeText(replaced.requestText)}\n\nDecided: ${replaced.outcome} ${replaced.decidedVia === 'channel' ? 'in this DM' : 'in Day0'} (${replaced.decisionId}). The ticket close it held waits on its card, and Day0 asks about it in a new message.`,
  };
}

/** What `work.recordReplacedEdit` takes. */
export const recordReplacedEditArgs = {
  replacedId: v.id('replacedDecisionRequests'),
  claimedAt: v.number(),
  editedAt: v.optional(v.number()),
  failure: v.optional(v.string()),
};

/**
 * Record the result of a replaced request's one edit: when it landed, or why not.
 * The body of `work.recordReplacedEdit`.
 */
export async function recordReplacedEditInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof recordReplacedEditArgs>,
): Promise<boolean> {
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
}

/** What `work.recordRequestClose` takes. */
export const recordRequestCloseArgs = {
  workItemId: v.id('workItems'),
  decisionId: v.string(),
  claimedAt: v.number(),
  closedAt: v.optional(v.number()),
  failure: v.optional(v.string()),
};

/**
 * Record the result of the one edit that marks a decided request: when it landed, or why not.
 * The body of `work.recordRequestClose`.
 */
export async function recordRequestCloseInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof recordRequestCloseArgs>,
): Promise<boolean> {
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
}

/** What `work.prepareDecisionNotice` takes. */
export const prepareDecisionNoticeArgs = {
  workItemId: v.id('workItems'),
  decisionId: v.string(),
  /** Send now, whether or not the acknowledgement it follows was sent (its wait ran out). */
  afterWait: v.optional(v.boolean()),
};

/**
 * Claim the one acknowledgement for late or duplicate manager replies.
 * The body of `work.prepareDecisionNotice`.
 */
export async function prepareDecisionNoticeInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof prepareDecisionNoticeArgs>,
) {
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
  if (args.afterWait !== true && (await acknowledgementUnsent(ctx, row.agentId, args.decisionId))) {
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
    row.decision.decidedVia === 'channel' ? row.decision.surfaceName : 'the Day0 dashboard';
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
}

/** What `work.recordDecisionNotice` takes. */
export const recordDecisionNoticeArgs = {
  workItemId: v.id('workItems'),
  decisionId: v.string(),
  ts: v.optional(v.string()),
  failure: v.optional(v.string()),
};

/**
 * Store delivery evidence for the single duplicate-reply acknowledgement.
 * The body of `work.recordDecisionNotice`.
 */
export async function recordDecisionNoticeInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof recordDecisionNoticeArgs>,
): Promise<boolean> {
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
}

/** A notice's kind as an acknowledgement's: every kind but the question, which has its own claim. */
function acknowledgementKindOf(kind: DecisionNoticeKind): DecisionAcknowledgementKind {
  if (kind === 'question') throw new Error('a question notice is claimed as a question');
  return kind;
}

/** What `work.prepareManagerReplyNotice` takes. */
export const prepareManagerReplyNoticeArgs = { noticeId: v.id('managerDecisionNotices') };

/**
 * Claim one notice in the manager's DM before its provider call: the acknowledgement of a
 * reply, or a conflict's question for the thread of a request already delivered.
 * The body of `work.prepareManagerReplyNotice`.
 */
export async function prepareManagerReplyNoticeInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof prepareManagerReplyNoticeArgs>,
) {
  const notice = await ctx.db.get(args.noticeId);
  if (!notice || notice.claimedAt) return { prepared: false as const };
  const owed = notice.kind === 'question' ? await questionNoticeOwed(ctx, notice) : undefined;
  if (owed?.state === 'wait') return { prepared: false as const, wait: true as const };
  if (owed?.state === 'drop') {
    await ctx.db.delete(notice._id);
    return { prepared: false as const, dropped: true as const };
  }
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
  const named = {
    workItemId: notice.workItemId,
    decisionId: notice.decisionId,
    messageTs: notice.messageTs,
  };
  const requestRunId = await appendEvent(ctx, {
    agentId: notice.agentId,
    type: 'work.decision-acknowledging',
    payload:
      owed?.state === 'send'
        ? { ...named, kind: 'question', questionId: owed.questionId }
        : { ...named, kind: acknowledgementKindOf(notice.kind) },
    createdAt: Date.now(),
  });
  await ctx.db.patch(notice._id, { claimedAt: Date.now() });
  const threadTs =
    owed?.state === 'send'
      ? owed.threadTs
      : await requestThreadOf(ctx, workItem, notice.decisionId);
  // A question is followed by how to answer it: by its number where the plan has several, on
  // the card where the employee's app takes no typed reply (W12V-7).
  const text =
    owed?.state !== 'send'
      ? notice.text
      : `${slackEscaped(notice.text)}\n${
          typedCodeReaches(await typedCodeReachOf(ctx, surface))
            ? conflictNoticeReplyLine(notice.decisionId, owed.number)
            : 'Answer it on the plan’s card in Day0.'
        }`;
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
    text,
  };
}

/** What `work.recordManagerReplyNotice` takes. */
export const recordManagerReplyNoticeArgs = {
  noticeId: v.id('managerDecisionNotices'),
  providerTs: v.optional(v.string()),
  failure: v.optional(v.string()),
};

/**
 * Store provider evidence for one notice in the manager's DM: its timestamp, or why it failed.
 * The body of `work.recordManagerReplyNotice`.
 */
export async function recordManagerReplyNoticeInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof recordManagerReplyNoticeArgs>,
): Promise<boolean> {
  const notice = await ctx.db.get(args.noticeId);
  if (!notice) return false;
  await ctx.db.patch(notice._id, {
    ...(args.providerTs ? { providerTs: args.providerTs } : {}),
    ...(args.failure ? { failure: args.failure.slice(0, 240) } : {}),
  });
  return true;
}

/**
 * Ask the manager on the chat surface again, from the card, about the item the caller owns.
 * The body of `work.resendDecisionRequest`.
 */
export async function resendDecisionRequestInTransaction(ctx: MutationCtx, row: Doc<'workItems'>) {
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
}

/** What `work.prepareManagerNote` takes. */
export const prepareManagerNoteArgs = { noteId: v.id('managerNotes') };

/**
 * Claim one per-run note for sending.
 * The body of `work.prepareManagerNote`.
 */
export async function prepareManagerNoteInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof prepareManagerNoteArgs>,
) {
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
}

/** Why a claimed per-run note is recorded as not delivered. */
export const UNSENT_NOTE_REASON =
  'the send stopped before Slack answered; the note was not delivered';

/** What `work.recoverUnsentManagerNote` takes. */
export const recoverUnsentManagerNoteArgs = { noteId: v.id('managerNotes') };

/**
 * A per-run note's dead-man's switch: mark a note a send died on as not delivered.
 * The body of `work.recoverUnsentManagerNote`.
 */
export async function recoverUnsentManagerNoteInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof recoverUnsentManagerNoteArgs>,
): Promise<{ recovered: 'marked-undelivered' | 'ignored' }> {
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
}

/** What `work.recordManagerNote` takes. */
export const recordManagerNoteArgs = {
  noteId: v.id('managerNotes'),
  ts: v.optional(v.string()),
  failure: v.optional(v.string()),
};

/**
 * Mark a manager note as sent, or keep it for the digest, after the send action returns.
 * The body of `work.recordManagerNote`.
 */
export async function recordManagerNoteInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof recordManagerNoteArgs>,
): Promise<void> {
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
}

/** The most unsent notes one agent's digest takes. */
const DIGEST_NOTE_LIMIT = 500;

/** A digest this soon after the last one waits: at most one per quarter hour, whatever triggered it. */
const DIGEST_MIN_GAP_MS = 15 * 60_000;

/** The most agents one page of digest candidates reads. */
const DIGEST_AGENT_PAGE = 100;

/** What `work.digestCandidates` takes. */
export const digestCandidatesArgs = { cursor: v.union(v.string(), v.null()) };

/**
 * One page of the agents holding notes not sent yet.
 * The body of `work.digestCandidates`.
 */
export async function digestCandidatesInTransaction(
  ctx: QueryCtx,
  args: ObjectType<typeof digestCandidatesArgs>,
): Promise<{ agentIds: Id<'agents'>[]; cursor: string | null }> {
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
}

/** What `work.prepareManagerDigest` takes. */
export const prepareManagerDigestArgs = { agentId: v.id('agents') };

/**
 * Gather an employee's kept notes into one digest and claim them for the send.
 * The body of `work.prepareManagerDigest`.
 */
export async function prepareManagerDigestInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof prepareManagerDigestArgs>,
) {
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
}

/** What `work.recordManagerDigest` takes. */
export const recordManagerDigestArgs = {
  agentId: v.id('agents'),
  noteIds: v.array(v.id('managerNotes')),
  ts: v.optional(v.string()),
  failure: v.optional(v.string()),
};

/**
 * Record the digest as sent, or release its notes back after a failed send.
 * The body of `work.recordManagerDigest`.
 */
export async function recordManagerDigestInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof recordManagerDigestArgs>,
): Promise<void> {
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
}

/** What `work.setAwaitingApproval` takes. */
export const setAwaitingApprovalArgs = {
  workItemId: v.id('workItems'),
  runId: v.id('events'),
  applyAttemptId: v.id('events'),
  output: v.any(),
};

/**
 * Park a run whose auto rows have landed until the manager decides the rest.
 * The body of `work.setAwaitingApproval`.
 */
export async function setAwaitingApprovalInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof setAwaitingApprovalArgs>,
): Promise<{ parked: boolean }> {
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
  // The plan's request goes with this park; while a conflict's question of the plan is open its
  // code and its thread are still the way to answer (17-C, C-3).
  await rememberRequestWithQuestion(ctx, row, Date.now());
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
}

/** What `work.approveActionsBatch` takes. */
export const approveActionsBatchArgs = {
  members: v.array(
    v.object({
      workItemId: v.id('workItems'),
      pendingRunId: v.id('events'),
      approvedIndexes: v.array(v.number()),
    }),
  ),
};

/**
 * Approve held actions across several items in one transaction, each item guarded as the caller's.
 * The body of `work.approveActionsBatch`.
 */
export async function approveActionsBatchInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof approveActionsBatchArgs>,
): Promise<{
  ok: true;
  approved: Array<{ workItemId: Id<'workItems'>; approvedIndexes: number[] }>;
}> {
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
}

/** What `work.prepareDecisionBatch` takes. */
export const prepareDecisionBatchArgs = {
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
};

/**
 * Record one batch code over the open action decisions it was issued for.
 * The body of `work.prepareDecisionBatch`.
 */
export async function prepareDecisionBatchInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof prepareDecisionBatchArgs>,
): Promise<{ prepared: boolean; reason?: string }> {
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
}

/** Why a request whose message the DM no longer holds is sent again. */
export const THREAD_NOT_FOUND_REASON =
  'the request message is no longer in the manager DM (thread_not_found)';

/** What `work.closeDecisionThread` takes. */
export const closeDecisionThreadArgs = { surfaceId: v.id('surfaces'), decisionId: v.string() };

/**
 * Close a delivered request whose thread the provider says does not exist, and send it again
 * with a fresh code.
 * The body of `work.closeDecisionThread`.
 */
export async function closeDecisionThreadInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof closeDecisionThreadArgs>,
): Promise<boolean> {
  const surface = await ctx.db.get(args.surfaceId);
  if (!surface) return false;
  const open = (await openRequestsOn(ctx, surface)).find(
    ({ decision }) => decision.id === args.decisionId && decision.ts !== undefined,
  );
  if (!open) return false;
  await supersedeDecisionRequest(ctx, open.row, open.decision, THREAD_NOT_FOUND_REASON);
  return true;
}

/** Why a manager reply got the unreadable-reply notice, on its ignored event. */
export const UNREADABLE_REPLY_REASON = 'reply not readable as a decision';

/** The most open codes the unreadable-reply notice names. */
const UNREADABLE_NOTICE_CODES = 5;

/** What `work.noticeUnreadableReply` takes. */
export const noticeUnreadableReplyArgs = {
  surfaceId: v.id('surfaces'),
  userId: v.string(),
  messageTs: v.string(),
};

/**
 * Tell the manager, once, that a reply could not be read as a decision.
 * The body of `work.noticeUnreadableReply`.
 */
export async function noticeUnreadableReplyInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof noticeUnreadableReplyArgs>,
): Promise<boolean> {
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
}
