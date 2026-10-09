import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { toSurfaceRecord } from '../src/surfaces/records';
import { isRevocationTrialRow } from './revocationEvaluation';
import { askedFor } from '../src/work/manager-channel';
import {
  managerNotificationMode,
  type ManagerNoteKind,
  type OwedDecision,
} from '../src/work/manager-notes';
import { eventsOfType } from './eventLog';
import { typedCodeReachOf } from './slackMessagesTab';
import { typedCodeReaches } from '../src/surfaces/slack-messages-tab';
import { askableChannel } from './decisionRequests';

/*
 * The notes the gate keeps for the manager (the wave 14 review's D-6, the standard's 9.2): a
 * finished run's note kept only where there is a channel to send it, sent at once per run or kept
 * for the digest, the delivery fields every manager message needs, and what the digest says is
 * still to decide; moved out of `convex/work.ts` unchanged. The registered note and digest
 * functions (`work:prepareManagerNote`, `work:prepareManagerDigest` and their kin) stay in
 * `convex/work.ts` and call these. This module sits below `convex/work.ts`: `convex/work.ts`
 * imports it and it never imports `./work`, so the move closes no import cycle. It registers no
 * function.
 */

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
export async function managerDelivery(ctx: MutationCtx, agentId: Id<'agents'>) {
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

/**
 * Whether a note is the digest's to send. A digest agent's notes all are. A
 * per-run agent's own notes go one by one; only those kept in digest mode
 * before the switch are the digest's, by the mode stamped on the note, or
 * for a note from before the stamp, by the time of the last switch.
 */
export async function digestNoteFilter(
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
export async function owedDecisions(ctx: QueryCtx, agentId: Id<'agents'>): Promise<OwedDecision[]> {
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
