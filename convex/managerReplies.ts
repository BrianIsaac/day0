import { v, type ObjectType } from 'convex/values';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { stepHoldOf } from './workLoop';
import { wholeSetApproval } from '../src/work/held-close';
import {
  batchDecisionNoticeText,
  CLOSE_ONLY_ON_CARD_REASON,
  closeOnCardNoticeText,
  decisionNoticeText,
} from '../src/work/manager-channel';
import { appendEvent } from './eventLog';
import { providerTsToMs } from '../src/work/provider-ts';
import { actionsOf, ledgerOf, verdictList } from './workLedger';
import { requestThreadOf } from './decisionRequests';
import {
  approveActionsInTransaction,
  approvePlanInTransaction,
  cancelPlanInTransaction,
  rejectActionsInTransaction,
} from './managerDecisions';

/*
 * A manager's reply or button press read into a decision (the wave 14 review's D-6, the
 * standard's 9.2): the sender checked against the card's manager, the code against the requests
 * and batches on the DM, a replaced code answered with the request that replaced it, and the
 * acknowledgement queued for the request's thread; moved out of `convex/work.ts` unchanged.
 * `work:resolveChannelDecision` stays registered in `convex/work.ts` and calls it, as
 * `slackSocket` does. This module sits below `convex/work.ts`: `convex/work.ts` imports it and it
 * never imports `./work`, so the move closes no import cycle. It registers no function.
 */

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

export async function queueManagerReplyNotice(
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

/** Resolve one parsed manager reply inside the same transaction as the dashboard controls. */
/** Why a reply naming a replaced request decided nothing, on its ignored event. */
export const REPLACED_DECISION_REASON = 'the request was replaced by a newer one';

/** The arguments of a manager's reply or press, as the channel resolves it. */
export const managerReplyArgs = {
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
