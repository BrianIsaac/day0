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
import { slackEscaped } from '../src/surfaces/slack-markup';
import { actionsOf, ledgerOf, verdictList } from './workLedger';
import { requestThreadOf } from './decisionRequests';
import {
  answerConflictInTransaction,
  numberedConflictQuestions,
  openConflictQuestions,
  type NumberedConflictQuestion,
} from './managerQuestions';
import {
  CONFLICT_CHOICES,
  pagePlaces,
  type ConflictChoice,
  type NamedPageWords,
} from '../src/agent/reorientation-words';
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

/** One standing question as "Which one?" names it: its number, its heading and its two pages. */
export interface WhichQuestion {
  readonly number: number;
  readonly heading: string;
  readonly pages: readonly [NamedPageWords, NamedPageWords];
}

/**
 * One of a question's two pages as "Which one?" names it: its title, and where the two titles are
 * alike, what tells them apart (W17-R1's place, or the source where the sources differ).
 */
function whichPageName(pages: readonly [NamedPageWords, NamedPageWords], index: 0 | 1): string {
  const page = pages[index];
  const title = `“${slackEscaped(page.title)}”`;
  if (pages[0].title !== pages[1].title) return title;
  const place =
    pagePlaces(pages)[index] ?? (pages[0].source !== pages[1].source ? page.source : undefined);
  return place === undefined ? title : `${title} (${slackEscaped(place)})`;
}

/**
 * What Day0 answers a bare `answer {code} B` while several of the plan's questions stand (17-C;
 * section 7's draft, W17-R13): each open question by its number, its heading and its two pages,
 * so two conflicts under one heading read apart, then how to answer. Nothing is decided. A
 * heading and a title are a page's own words, so they are escaped as Slack asks and never read as
 * a mention or a link.
 */
export function whichQuestionText(id: string, open: readonly WhichQuestion[]): string {
  const example = open[1]?.number ?? open[0]?.number ?? 1;
  // Each carries commas of its own, so the list is set off by semicolons.
  const named = open
    .map(
      (question) =>
        `${question.number}, under “${slackEscaped(question.heading)}”, ${whichPageName(question.pages, 0)} or ${whichPageName(question.pages, 1)}`,
    )
    .join('; ');
  return `Which one? This plan has ${open.length} questions open: ${named}. Answer with its number, for example “answer ${id} ${example} B”.`;
}

/**
 * Which of a plan's questions still stand, and how to answer one, after a reply that named one
 * that does not (W17-R13; section 7's draft): nothing where none stands.
 */
function standingLine(id: string, standing: readonly { readonly number: number }[]): string[] {
  const [first] = standing;
  if (first === undefined) return [];
  if (standing.length === 1) {
    return [
      `Question ${first.number} is open: answer with “answer ${id} ${first.number} A”, “B” or “both”.`,
    ];
  }
  const numbers = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' }).format(
    standing.map((question) => String(question.number)),
  );
  return [
    `Questions ${numbers} are open: answer one by its number, for example “answer ${id} ${first.number} A”, “B” or “both”.`,
  ];
}

/**
 * Answer one of a plan's conflict questions from the manager's reply in the DM or in the request's
 * thread (RM20 (a); 17-C): the question the reply numbers, or the one that stands where the reply
 * numbers none and exactly one does, decided as the manager says and acknowledged in the request's
 * thread. A bare answer with several standing decides nothing and asks which; a number that names
 * no standing question says what became of it.
 */
async function answerFromChannel(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  request: {
    readonly row: Doc<'workItems'>;
    readonly decisionId: string;
    /**
     * For a request a park kept, when it was kept: only the questions asked by then are its own
     * to answer, a later plan's having a request of its own (W17-R13).
     */
    readonly keptAt?: number;
  },
  args: {
    userId: string;
    messageTs: string;
    reply: {
      verb: 'answer';
      id: string;
      choice: ConflictChoice;
      number?: number;
      runTogether?: true;
    };
  },
) {
  const { row, decisionId } = request;
  // A reply is answered once: its acknowledgement is keyed by the message, so a poll that delivers
  // the same message again finds it and answers no second question.
  const answered = await ctx.db
    .query('managerDecisionNotices')
    .withIndex('by_surface_message', (q) =>
      q.eq('surfaceId', surface._id).eq('messageTs', args.messageTs),
    )
    .unique();
  if (answered !== null) return { status: 'ignored' as const, reason: 'already answered' };
  // The item's questions are numbered whatever plan asked them (C-4), so a kept request's own are
  // the first of them, and the numbers it was shown still name them.
  const askedBy = (question: NumberedConflictQuestion): boolean =>
    request.keptAt === undefined || question.question.askedAt <= request.keptAt;
  const numbered = (await numberedConflictQuestions(ctx, row._id)).filter(askedBy);
  const standing = numbered.filter((question) => question.standing);
  const notice = async (text: string) =>
    await queueManagerReplyNotice(ctx, {
      surfaceId: surface._id,
      workItemId: row._id,
      decisionId,
      messageTs: args.messageTs,
      kind: 'received',
      text,
    });
  const ignored = async (reason: string, text: string) => ({
    status: 'ignored' as const,
    reason,
    notified: await notice(text),
  });
  const { number } = args.reply;
  if (args.reply.runTogether === true && numbered.length > 0) {
    const letter = args.reply.choice === 'from' ? 'A' : args.reply.choice === 'to' ? 'B' : 'both';
    return await ignored(
      'number run into its letter',
      `Write the question’s number and the letter apart, for example “answer ${decisionId} ${number ?? 1} ${letter}”: this plan’s questions are numbered 1 to ${numbered.length}.`,
    );
  }
  if (number === undefined && standing.length === 0) {
    return await ignored(
      'no open question',
      `Nothing is waiting on an answer for decision ${decisionId}.`,
    );
  }
  if (number === undefined && standing.length > 1) {
    return await ignored(
      'several questions open',
      whichQuestionText(
        decisionId,
        standing.flatMap((question) =>
          question.conflict === undefined
            ? []
            : [
                {
                  number: question.number,
                  heading: question.question.context.text,
                  pages: [question.conflict.from, question.conflict.to] as const,
                },
              ],
        ),
      ),
    );
  }
  const target =
    number === undefined ? standing[0] : numbered.find((question) => question.number === number);
  if (target === undefined) {
    return await ignored(
      'no such question',
      numbered.length === 0
        ? `Nothing is waiting on an answer for decision ${decisionId}.`
        : `This plan has no question ${number}: its questions are numbered 1 to ${numbered.length}.`,
    );
  }
  if (!target.standing) {
    const { answer, closed } = target.question;
    const became =
      answer !== undefined
        ? `Question ${target.number} was already answered: ${slackEscaped(answer.text)}.`
        : closed?.reason === 'redrafted'
          ? // Its pages may still disagree: the plan it was asked beside is gone, and the plan that
            // stands now asks its own.
            `Question ${target.number} was closed: the plan was drafted again.`
          : `Question ${target.number} was closed: its two pages no longer disagree.`;
    return await ignored(
      'question no longer open',
      [became, ...standingLine(decisionId, standing)].join(' '),
    );
  }
  // The reply's sender was checked against the card's manager: the relation is decided in the
  // manager's name, as the Documentation tab's card decides it.
  const agent = await ctx.db.get(row.agentId);
  const { text } = await answerConflictInTransaction(ctx, target.question, {
    choice: args.reply.choice,
    via: 'slack',
    decidedBy: agent?.bossEmail,
  });
  // Read again after the answer: naming one page right settles every other question about it.
  const left = (await numberedConflictQuestions(ctx, row._id)).filter(
    (question) => askedBy(question) && question.standing,
  ).length;
  // O-17: Retry runs the held steps, and drafts again those that relied on the losing page (m7).
  // "Both hold" gives no page away, and beside a finished item nothing waits at all (W17-R10).
  const after =
    row.state === 'completed' || row.state === 'cancelled'
      ? 'Nothing of this item waits on the answer.'
      : args.reply.choice === 'both'
        ? 'Retry runs the steps that waited on it.'
        : 'Retry runs the steps that waited on it, drafted again where they relied on the other page.';
  const notified = await notice(
    [
      `Recorded${number === undefined ? '' : ` for question ${target.number}`}: ${slackEscaped(text)}. ${after}`,
      ...(left === 0
        ? []
        : [
            left === 1
              ? '1 more question of this plan is still open.'
              : `${left} more questions of this plan are still open.`,
          ]),
    ].join(' '),
  );
  return { status: 'answered' as const, notified };
}

/** Resolve one parsed manager reply inside the same transaction as the dashboard controls. */
/** Why a reply naming a replaced request decided nothing, on its ignored event. */
export const REPLACED_DECISION_REASON = 'the request was replaced by a newer one';

/** The arguments of a manager's reply or press, as the channel resolves it. */
export const managerReplyArgs = {
  surfaceId: v.id('surfaces'),
  userId: v.string(),
  messageTs: v.string(),
  reply: v.union(
    v.object({
      verb: v.union(v.literal('approve'), v.literal('reject')),
      id: v.string(),
      reason: v.optional(v.string()),
    }),
    /** The answer to a conflict's question in a plan's request (RM20 (a)), by its number (17-C). */
    v.object({
      verb: v.literal('answer'),
      id: v.string(),
      choice: v.union(...CONFLICT_CHOICES.map((choice) => v.literal(choice))),
      number: v.optional(v.number()),
      /** The number was typed run into its letter ("2B"): answered with how to write it (W17-R13). */
      runTogether: v.optional(v.literal(true)),
    }),
  ),
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
  // A code a newer request replaced (a redraft, a re-held set) is answered as replaced, whatever
  // the reply's verb (W12-R19; an answer to a conflict's question too, the second pass's M1).
  const replacedReply = async () => {
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
  };
  const row = await ctx.db
    .query('workItems')
    .withIndex('by_agent_decision', (q) =>
      q.eq('agentId', surface.agentId).eq('decision.id', args.reply.id),
    )
    .first();
  // An answer to a plan's conflict question names that plan's own request, decided or not: the
  // plan goes on meanwhile, so the answer can come after the approval (RM20 (a)).
  if (args.reply.verb === 'answer') {
    if (!row?.decision) {
      // A park cleared the plan's request from its item while its question was open, and kept it
      // (17-C, C-3): its code still answers. A request a redraft replaced was never decided, and
      // its questions closed with its plan, so it is answered as replaced.
      const kept = await ctx.db
        .query('replacedDecisionRequests')
        .withIndex('by_agent_decision', (q) =>
          q.eq('agentId', surface.agentId).eq('decisionId', args.reply.id),
        )
        .first();
      const item =
        kept?.kind === 'plan' &&
        kept.decidedAt !== undefined &&
        kept.surfaceSlug === surface.slug &&
        kept.channel === surface.managerDmChannelId
          ? await ctx.db.get(kept.workItemId)
          : null;
      // Only the questions asked beside the kept request's own plan are its to answer: one asked
      // since it was kept belongs to a plan drafted after it, whose request has its own code.
      const own =
        kept === null || item === null
          ? []
          : (await openConflictQuestions(ctx, item._id)).filter(
              (question) => question.askedAt <= kept.replacedAt,
            );
      if (kept !== null && item !== null && own.length > 0) {
        return await answerFromChannel(
          ctx,
          surface,
          { row: item, decisionId: kept.decisionId, keptAt: kept.replacedAt },
          { ...args, reply: args.reply },
        );
      }
      return await replacedReply();
    }
    if (
      row.decision.kind !== 'plan' ||
      row.decision.surfaceSlug !== surface.slug ||
      row.decision.channel !== surface.managerDmChannelId
    ) {
      return await unknown('no plan request with that code on this channel');
    }
    return await answerFromChannel(
      ctx,
      surface,
      { row, decisionId: row.decision.id },
      {
        ...args,
        reply: args.reply,
      },
    );
  }
  if (!row?.decision) {
    const batch = await ctx.db
      .query('decisionBatches')
      .withIndex('by_agent_id', (q) => q.eq('agentId', surface.agentId).eq('id', args.reply.id))
      .first();
    if (batch)
      return await resolveChannelBatch(ctx, surface, batch, { ...args, reply: args.reply });
    return await replacedReply();
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
