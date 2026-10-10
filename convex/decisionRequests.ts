import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { isManagerChannel } from './workLoop';
import { askedFor, type DecisionKind } from '../src/work/manager-channel';
import { accessEnded } from '../src/work/surface-access';
import { appendEvent } from './eventLog';
import { compareProviderTs } from '../src/work/provider-ts';

/*
 * A decision request's lifecycle (the wave 14 review's D-6, the standard's 9.2): asking the
 * manager through a channel they can be reached on, keeping a replaced or taken-back code
 * answerable, closing what a previous manager was asked at a handover, the requests and batches
 * open on a channel and the thread an answer goes in; moved out of `convex/work.ts` unchanged. The
 * registered request functions (`work:prepareDecisionRequest`, `work:recordDecisionRequest`,
 * `work:openDecisions` and their kin) stay in `convex/work.ts` and call these, and the jobs these
 * schedule keep their `managerChannelActions:*` names. This module sits below `convex/work.ts`:
 * `convex/work.ts` imports it and it never imports `./work`, so the move closes no import cycle.
 * It registers no function.
 */

/** Avoid scheduling an outbound action when no connected manager channel can claim it. */
export async function scheduleDecisionRequest(
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
export function askableChannel(surface: Doc<'surfaces'>): boolean {
  return isManagerChannel(surface) && !accessEnded(surface, Date.now());
}

/**
 * Mark an undelivered request failed and send a fresh one in its place.
 *
 * The old code stays on the row, marked failed, until the resend claims a
 * new one; a duplicate resend is refused by the claim because the id it
 * names is no longer the live one.
 */
export async function supersedeDecisionRequest(
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

/**
 * Remember a decision request a newer one replaces, or a path takes back, before the row's
 * `decision` is overwritten or cleared (wave 12, 12-M; F2 D14): its code stays answerable ("that
 * request was replaced by ..."), and a delivered message whose text was kept is edited once to say
 * so. A decided request is history on the row's record, not a replaced one, and a code already
 * remembered is not remembered twice. Only a row whose employee has a manager chat channel ever
 * carries a request, so nothing else writes a row here.
 *
 * @param ctx - The transaction that replaces or clears the request.
 * @param row - The work item as it stands, its `decision` the one going.
 * @param now - The transaction's time.
 */
export async function rememberReplacedRequest(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  now: number,
): Promise<void> {
  const decision = row.decision;
  if (decision === undefined || decision.decidedAt !== undefined) return;
  const kept = await ctx.db
    .query('replacedDecisionRequests')
    .withIndex('by_agent_decision', (q) =>
      q.eq('agentId', row.agentId).eq('decisionId', decision.id),
    )
    .first();
  if (kept !== null) return;
  const replacedId = await ctx.db.insert('replacedDecisionRequests', {
    agentId: row.agentId,
    workItemId: row._id,
    decisionId: decision.id,
    kind: decision.kind,
    surfaceSlug: decision.surfaceSlug,
    channel: decision.channel,
    ...(decision.ts === undefined ? {} : { ts: decision.ts }),
    ...(decision.requestText === undefined ? {} : { requestText: decision.requestText }),
    ...(decision.withButtons === true ? { withButtons: true } : {}),
    replacedAt: now,
  });
  if (decision.ts !== undefined && decision.requestText !== undefined) {
    await ctx.scheduler.runAfter(0, internal.managerChannelActions.markRequestReplaced, {
      replacedId,
    });
  }
}

/**
 * How long the park's edit of a decided request waits when the decision's own edit is in flight
 * (claimed, no result yet): past the transport's 20 s timeout and its retries, so the two
 * `chat.update` calls on the one message never run beside each other (W14-R51).
 */
export const CLOSE_EDIT_IN_FLIGHT_MS = 2 * 60 * 1000;

/**
 * Remember a decided request whose message the decision's own edit has not marked yet, before a
 * park clears it (W13-R50): the apply of an approval that left a close for its card parks the
 * close and asks about it again, and the edit the approval scheduled (`closeDecisionRequest`)
 * finds its request gone if it runs after the park, so the request's message would read as still
 * open. Kept with its outcome, the message is edited once by the replaced edit to say how it was
 * decided and that the close is asked about again; its code is answered as decided and replaced.
 * When the decision's own edit is in flight at the park, this edit is made after it rather than
 * beside it: both would be a `chat.update` of the one message, and whichever landed last decided
 * what the manager reads. Made after, this one's words always stand.
 *
 * @param ctx - The park's transaction.
 * @param row - The work item as it stands, its `decision` the one going.
 * @param now - The transaction's time.
 */
export async function rememberDecidedUnmarked(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  now: number,
): Promise<void> {
  const decision = row.decision;
  if (
    decision === undefined ||
    decision.decidedAt === undefined ||
    decision.ts === undefined ||
    decision.requestText === undefined ||
    // An edit that recorded a result marked the message or said why not; one claimed with no
    // result may have died, and the park leaves nothing its sweep could settle (the second pass).
    decision.closedAt !== undefined ||
    decision.closeFailure !== undefined
  ) {
    return;
  }
  const kept = await ctx.db
    .query('replacedDecisionRequests')
    .withIndex('by_agent_decision', (q) =>
      q.eq('agentId', row.agentId).eq('decisionId', decision.id),
    )
    .first();
  if (kept !== null) return;
  const replacedId = await ctx.db.insert('replacedDecisionRequests', {
    agentId: row.agentId,
    workItemId: row._id,
    decisionId: decision.id,
    kind: decision.kind,
    surfaceSlug: decision.surfaceSlug,
    channel: decision.channel,
    ts: decision.ts,
    requestText: decision.requestText,
    ...(decision.withButtons === true ? { withButtons: true } : {}),
    replacedAt: now,
    ...(decision.outcome === undefined ? {} : { outcome: decision.outcome }),
    decidedAt: decision.decidedAt,
    ...(decision.decidedVia === undefined ? {} : { decidedVia: decision.decidedVia }),
  });
  const wait = decision.closeClaimedAt === undefined ? 0 : CLOSE_EDIT_IN_FLIGHT_MS;
  await ctx.scheduler.runAfter(wait, internal.managerChannelActions.markRequestReplaced, {
    replacedId,
  });
}

/** The most of an agent's recent acknowledgements the already-decided notice reads. */
const ACKNOWLEDGEMENTS_READ = 50;

/**
 * Whether the acknowledgement of a decision is queued and not yet sent or failed, so the notice
 * that the request was already decided waits for it (W12V-10).
 */
export async function acknowledgementUnsent(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  decisionId: string,
): Promise<boolean> {
  const recent = await ctx.db
    .query('managerDecisionNotices')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc')
    .take(ACKNOWLEDGEMENTS_READ);
  return recent.some(
    (notice) =>
      notice.decisionId === decisionId &&
      notice.kind === 'received' &&
      notice.providerTs === undefined &&
      notice.failure === undefined,
  );
}

/**
 * Remember the request of a plan the manager turned down before Retry drafts a new one and clears
 * it (W12V-16): an undecided request as `rememberReplacedRequest` does, and a decided one too,
 * since the redraft's request replaces it, so its code is answered "replaced" rather than unknown.
 * A decided request's message already says how it was decided, so it is never edited again.
 *
 * @param ctx - The Retry's transaction.
 * @param row - The cancelled work item as it stands, its `decision` the one going.
 * @param now - The transaction's time.
 */
export async function rememberRetriedRequest(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  now: number,
): Promise<void> {
  const decision = row.decision;
  if (decision === undefined) return;
  if (decision.decidedAt === undefined) {
    await rememberReplacedRequest(ctx, row, now);
    return;
  }
  const kept = await ctx.db
    .query('replacedDecisionRequests')
    .withIndex('by_agent_decision', (q) =>
      q.eq('agentId', row.agentId).eq('decisionId', decision.id),
    )
    .first();
  if (kept !== null) return;
  // No `ts` or text: nothing edits a decided message again, nor reads its thread from here. The
  // decision it had rides along, so its code is answered as decided as well as replaced (W12V-16).
  await ctx.db.insert('replacedDecisionRequests', {
    agentId: row.agentId,
    workItemId: row._id,
    decisionId: decision.id,
    kind: decision.kind,
    surfaceSlug: decision.surfaceSlug,
    channel: decision.channel,
    replacedAt: now,
    ...(decision.outcome === undefined ? {} : { outcome: decision.outcome }),
    decidedAt: decision.decidedAt,
    ...(decision.decidedVia === undefined ? {} : { decidedVia: decision.decidedVia }),
  });
}

/** The most of one item's replaced requests the new request names itself on. */
const REPLACED_NAMED_SCAN = 50;

/**
 * Name a new request on every earlier request of its kind for the item, so a reply to any of those
 * codes is answered with the newest in one step, however often the request was replaced (W12-R20).
 */
export async function nameReplacement(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  decision: { readonly id: string; readonly kind: DecisionKind },
): Promise<void> {
  // The newest first: an older one was named when it was among them, and its answer follows that
  // chain, or the item's own request past the walk.
  const replaced = await ctx.db
    .query('replacedDecisionRequests')
    .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
    .order('desc')
    .take(REPLACED_NAMED_SCAN);
  for (const earlier of replaced) {
    if (
      earlier.replacedBy === decision.id ||
      earlier.kind !== decision.kind ||
      earlier.decisionId === decision.id
    ) {
      continue;
    }
    await ctx.db.patch(earlier._id, { replacedBy: decision.id });
  }
}

/**
 * Why a request delivered to the manager's previous DM is sent again: a new manager, or the
 * employee's new Slack app after a forget (W13V-4).
 */
export const MANAGER_CHANGED_RESEND_REASON =
  "the manager's DM changed (a new manager, or the employee's new Slack app after a forget), and the request had gone to the earlier DM";

/**
 * Why a request asked of the manager who handed the employee over is closed at the move: their
 * reply to it decides nothing, and the new manager is asked afresh.
 */
export const HANDED_OVER_REQUEST_REASON =
  'the employee was handed over to a new manager; the request went to the previous one';

/**
 * Close the employee's open decision requests at a handover's move (the transfer plan, section
 * 6.4; D6). Each request asked and undecided is closed and its failure recorded with
 * {@link HANDED_OVER_REQUEST_REASON}, so a reply to its code decides nothing and the dashboard
 * decides the row. A delivered one is marked failed and sent again, with a fresh code, on the new
 * manager's DM once their chat surface connects ({@link resendDecisionsAfterManagerChange}, which
 * re-sends a delivered request marked failed); one still on its way is taken off the row, so the
 * stall sweep asks the new manager once a channel exists. A request already decided or already
 * failed is left as it is.
 *
 * @param ctx - The move's mutation context.
 * @param agentId - The employee.
 * @param now - The move's time.
 * @returns How many requests were closed.
 */
export async function voidDecisionRequestsForHandover(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<number> {
  const parked = await Promise.all(
    (['plan-pending', 'actions-pending'] as const).map(
      async (state) =>
        await ctx.db
          .query('workItems')
          .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
          .collect(),
    ),
  );
  let voided = 0;
  for (const row of parked.flat()) {
    const decision = row.decision;
    if (!decision || !askedFor(decision, row.state) || decision.requestFailedAt !== undefined) {
      continue;
    }
    // A delivered request keeps its code, marked failed, for the probe to re-send; one still on
    // its way would be re-sent by nothing, so it is taken back and the stall sweep asks afresh.
    if (decision.ts === undefined) await rememberReplacedRequest(ctx, row, now);
    await ctx.db.patch(row._id, {
      decision:
        decision.ts === undefined
          ? undefined
          : { ...decision, requestFailedAt: now, requestFailure: HANDED_OVER_REQUEST_REASON },
    });
    await appendEvent(ctx, {
      agentId,
      type: 'work.decision-request-failed',
      payload: {
        workItemId: row._id,
        decisionId: decision.id,
        kind: decision.kind,
        reason: HANDED_OVER_REQUEST_REASON,
      },
      createdAt: now,
    });
    voided += 1;
  }
  return voided;
}

/**
 * Return to the new manager every approval the old one gave that has not started (decision D13
 * (a)): an approval given for the old manager's connections does not run on the new manager's
 * authority. A plan approved and not yet executing goes back to `plan-pending`, with a
 * `work.plan-held` event saying its predecessor approved it; a held set approved and kept from
 * its apply (`claimApprovedActions` refuses while the handover finishes) goes back to held. Each
 * loses the old manager's decision, so the new manager is asked: in the dashboard, or by DM once
 * their chat surface connects (the stall sweep asks a parked row with no request).
 *
 * @param ctx - The move's mutation context.
 * @param agentId - The employee.
 * @param now - The move's time.
 * @returns How many approvals were returned, plans and held sets together.
 */
export async function returnApprovalsForHandover(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<number> {
  const [approvedPlans, pending] = await Promise.all(
    (['plan-approved', 'actions-pending'] as const).map(
      async (state) =>
        await ctx.db
          .query('workItems')
          .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
          .collect(),
    ),
  );
  for (const row of approvedPlans) {
    // The answers were given with the old manager's approval, and a run reads them as the
    // manager's: they go with it, as on every other path back to drafting.
    await ctx.db.patch(row._id, {
      state: 'plan-pending',
      planPendingAt: now,
      waitingSince: now,
      decision: undefined,
      managerAnswers: undefined,
    });
    await appendEvent(ctx, {
      agentId,
      type: 'work.plan-held',
      payload: { workItemId: row._id, reason: 'approved-by-predecessor' },
      createdAt: now,
    });
  }
  const approvedSets = pending.filter((row) => row.approvedIndexes !== undefined);
  for (const row of approvedSets) {
    await ctx.db.patch(row._id, {
      approvedIndexes: undefined,
      applyPhase: undefined,
      decision: undefined,
      // The set waits on the manager again, from now.
      waitingSince: now,
    });
  }
  return approvedPlans.length + approvedSets.length;
}

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
    // A request stranded on the DM that still stands keeps its own failure: the DM did not change.
    const reason =
      decision.channel === currentChannel
        ? (decision.requestFailure ?? MANAGER_CHANGED_RESEND_REASON)
        : MANAGER_CHANGED_RESEND_REASON;
    await supersedeDecisionRequest(ctx, row, decision, reason);
  }
  return stale.length;
}

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
export async function openRequestsOn(
  ctx: QueryCtx,
  surface: Doc<'surfaces'>,
): Promise<OpenRequest[]> {
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

/**
 * Undecided batches of one manager channel read, newest first, for the ones
 * with open members. A batch is marked decided by a reply to its code or by
 * the decision of its last open member (`settleBatchesHolding`), so the
 * undecided ones are those still waiting; the bound holds the read to the
 * newest, where an open batch is, since it is no older than the requests it
 * names.
 */
export const OPEN_BATCH_SCAN = 200;

/**
 * Whether a batch member is still open: its item parked on the run the
 * request showed, under the code the request carried, undecided. The same
 * test a reply to the batch's code applies before it decides a member.
 */
function batchMemberOpen(
  item: Doc<'workItems'> | null,
  member: Doc<'decisionBatches'>['members'][number],
): boolean {
  const decision = item?.decision;
  return (
    item !== null &&
    decision !== undefined &&
    decision.id === member.decisionId &&
    decision.decidedAt === undefined &&
    item.state === 'actions-pending' &&
    item.pendingRunId === member.pendingRunId
  );
}

/** Whether no member of a batch is open any more. */
async function batchSettled(
  ctx: Pick<QueryCtx, 'db'>,
  batch: Doc<'decisionBatches'>,
): Promise<boolean> {
  for (const member of batch.members) {
    if (batchMemberOpen(await ctx.db.get(member.workItemId), member)) return false;
  }
  return true;
}

/** Batches one page of the `decision-batches-settled` migration reads. */
const BATCH_SETTLE_PAGE = 100;

/**
 * One page of the `decision-batches-settled` migration (S2 D6): an undecided
 * batch none of whose members is open any more, left so by decisions made one
 * member at a time before the decide paths settled it, is marked decided now.
 * Run by `migrations:runPending`.
 *
 * @param cursor - Where the previous page stopped, or null for the first.
 * @returns What the page read and changed, and where the next one starts.
 */
export async function settleDecisionBatchesPage(
  ctx: MutationCtx,
  cursor: string | null,
): Promise<{ read: number; changed: number; cursor: string; isDone: boolean }> {
  const page = await ctx.db
    .query('decisionBatches')
    .paginate({ cursor, numItems: BATCH_SETTLE_PAGE });
  const now = Date.now();
  let changed = 0;
  for (const batch of page.page) {
    if (batch.decidedAt !== undefined || !(await batchSettled(ctx, batch))) continue;
    await ctx.db.patch(batch._id, { decidedAt: now });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/**
 * Mark decided every undecided batch on a just-decided item's channel that
 * holds its decision and has no member left open, in the decision's own
 * transaction (S2 D6). A batch decided member by member has no one outcome
 * and no reply that decided it, so only the time is stamped; a later reply to
 * its code is answered as already decided.
 *
 * @param item - The item as the decision left it.
 */
export async function settleBatchesHolding(
  ctx: MutationCtx,
  item: Doc<'workItems'>,
): Promise<void> {
  const decision = item.decision;
  if (!decision?.surfaceSlug || !decision.channel) return;
  const { surfaceSlug, channel } = decision;
  const batches = await ctx.db
    .query('decisionBatches')
    .withIndex('by_agent_channel_decided', (q) =>
      q
        .eq('agentId', item.agentId)
        .eq('surfaceSlug', surfaceSlug)
        .eq('channel', channel)
        .eq('decidedAt', undefined),
    )
    .order('desc')
    .take(OPEN_BATCH_SCAN);
  const now = Date.now();
  for (const batch of batches) {
    if (!batch.members.some((member) => member.decisionId === decision.id)) continue;
    if (await batchSettled(ctx, batch)) await ctx.db.patch(batch._id, { decidedAt: now });
  }
}

/**
 * Mark decided every undecided batch on a channel that has no member open any
 * more, whatever closed its members: a decision one at a time, a request sent
 * again under a new code, or an item that left the parked state (S2 D6). Run
 * where a new request is claimed on the channel, so the open-batch read never
 * fills with batches nothing can decide.
 *
 * @param channel - The manager DM, as its surface names it.
 */
export async function settleClosedBatchesOn(
  ctx: MutationCtx,
  channel: { readonly agentId: Id<'agents'>; readonly surfaceSlug: string; readonly id: string },
): Promise<void> {
  const batches = await ctx.db
    .query('decisionBatches')
    .withIndex('by_agent_channel_decided', (q) =>
      q
        .eq('agentId', channel.agentId)
        .eq('surfaceSlug', channel.surfaceSlug)
        .eq('channel', channel.id)
        .eq('decidedAt', undefined),
    )
    .order('desc')
    .take(OPEN_BATCH_SCAN);
  const now = Date.now();
  for (const batch of batches) {
    if (await batchSettled(ctx, batch)) await ctx.db.patch(batch._id, { decidedAt: now });
  }
}

/** The most of Day0's other recent messages in a DM whose threads one poll reads (M10). */
export const RECENT_THREADS_READ = 10;

/**
 * The provider timestamps of Day0's other messages in a manager DM within the notice window,
 * newest first, at most {@link RECENT_THREADS_READ} (M10): the requests decided in it, the
 * replaced requests whose message was edited in it, and the notes sent in it. An open request's
 * own thread is read already and is left out.
 *
 * @param since - The start of the notice window.
 * @param known - The decided requests' timestamps, and the open requests' to leave out.
 */
export async function recentThreadsOn(
  ctx: QueryCtx,
  surface: Doc<'surfaces'>,
  channel: string,
  since: number,
  known: { readonly decided: readonly string[]; readonly open: readonly string[] },
): Promise<string[]> {
  const [replaced, notes] = await Promise.all([
    ctx.db
      .query('replacedDecisionRequests')
      .withIndex('by_agent_edit_open', (q) =>
        q.eq('agentId', surface.agentId).gte('editedAt', since),
      )
      // Newest edits first, so a window with more than one poll reads keeps the latest.
      .order('desc')
      .take(RECENT_THREADS_READ),
    ctx.db
      .query('managerNotes')
      .withIndex('by_agent', (q) => q.eq('agentId', surface.agentId))
      .order('desc')
      .take(RECENT_THREADS_READ),
  ]);
  const open = new Set(known.open);
  const stamps = [
    ...known.decided,
    ...replaced.flatMap((row) =>
      row.ts !== undefined && row.surfaceSlug === surface.slug && row.channel === channel
        ? [row.ts]
        : [],
    ),
    ...notes.flatMap((note) =>
      note.providerTs !== undefined && note.createdAt >= since ? [note.providerTs] : [],
    ),
  ];
  return [...new Set(stamps)]
    .filter((ts) => !open.has(ts))
    .sort((left, right) => compareProviderTs(right, left))
    .slice(0, RECENT_THREADS_READ);
}

/**
 * Schedule the one edit that marks a decided request in the manager DM
 * (M finding 3), in the transaction that decided it. Only a request that
 * reached the DM, and kept its text, has a message to edit; whether the card
 * allows the edit is the action's to check.
 *
 * @param workItemId - The item just decided.
 */
export async function scheduleRequestClose(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
): Promise<void> {
  const decision = (await ctx.db.get(workItemId))?.decision;
  if (!decision?.decidedAt || !decision.ts || !decision.requestText) return;
  await ctx.scheduler.runAfter(0, internal.managerChannelActions.closeDecisionRequest, {
    workItemId,
    decisionId: decision.id,
  });
}

/**
 * The provider timestamp of the request message a decision's acknowledgement
 * answers, so it goes in that message's thread (M finding 3): the item's own
 * request for its code, or, for a batch code, the request it was sent in,
 * which is the one of the member that anchors the batch.
 *
 * @returns The timestamp, or undefined when the request left none.
 */
export async function requestThreadOf(
  ctx: QueryCtx,
  workItem: Doc<'workItems'>,
  decisionId: string,
): Promise<string | undefined> {
  const decision = workItem.decision;
  if (decision?.id !== decisionId) {
    // A replaced request's answer goes in the replaced message's own thread.
    const replaced = await ctx.db
      .query('replacedDecisionRequests')
      .withIndex('by_agent_decision', (q) =>
        q.eq('agentId', workItem.agentId).eq('decisionId', decisionId),
      )
      .first();
    if (replaced !== null) return replaced.ts;
  }
  if (!decision?.ts) return undefined;
  if (decision.id === decisionId) return decision.ts;
  const batch = await ctx.db
    .query('decisionBatches')
    .withIndex('by_agent_id', (q) => q.eq('agentId', workItem.agentId).eq('id', decisionId))
    .unique();
  return batch?.members.some((member) => member.decisionId === decision.id)
    ? decision.ts
    : undefined;
}
