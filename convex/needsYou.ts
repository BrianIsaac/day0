import { v, type Infer } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { IncomingTransfer } from './managerTransfers';
import {
  oneToOneWaitsOnManager,
  skillWaitsOnManager,
  stoppedRowNeedsManager,
} from '../src/work/needs-manager';
import { AWAITING_CHARTER } from './workLoop';
import { EVALUATION_ATTEMPTS_SPENT } from '../src/work/queue-order';
import {
  accessRequestReason,
  organisationSystemOf,
  servedByIssuer,
} from '../src/surfaces/access-request';
import { SCOPE_JUDGEMENT_UNAVAILABLE } from '../src/work/types';
import { isRevocationTrialRow } from './revocationEvaluation';
import { agentZone } from '../src/lib/zone';
import { accessEnded } from '../src/work/surface-access';
import { eventsOfType } from './eventLog';
import { activeConnectionFor } from './organisationConnectionReads';
import { isEventOf } from '../src/events/contract';
import { actionsOf, verdictList } from './workLedger';

/*
 * The needs-you projection (the wave 14 review's D-6, the standard's 9.2): everything one employee
 * waits on the manager for, each entry dated by when it began to wait, and the inbox's one order;
 * moved out of `convex/work.ts` unchanged. The registered inbox reads (`work:needsYou`,
 * `work:needsYouForAgent`) and their `returns` validators stay in `convex/work.ts` and build on the
 * entry validator here, which `NeedsYouEntry` is inferred from. This module sits below
 * `convex/work.ts`: `convex/work.ts` imports it and it never imports `./work`, so the move closes no
 * import cycle. It registers no function.
 */

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

export const needsYouEntryValidator = v.union(
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
export function longestWaitFirst(left: NeedsYouEntry, right: NeedsYouEntry): number {
  return left.waitingSince - right.waitingSince || left.key.localeCompare(right.key);
}

/**
 * A handover naming the caller as an inbox entry, waiting since it was asked.
 *
 * @param transfer - The request, as `incomingTransfersOf` reads it.
 */
export function transferEntryOf(transfer: IncomingTransfer): NeedsYouEntry {
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
