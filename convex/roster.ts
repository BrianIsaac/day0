import { paginationOptsValidator } from 'convex/server';
import { ConvexError, getDocumentSize, v, type Infer } from 'convex/values';
import { typedCodeReachOf } from './slackMessagesTab';
import { socketBridgeStateOf } from './socketHeartbeats';
import type { Doc, Id } from './_generated/dataModel';
import { query, type QueryCtx } from './_generated/server';
import { getCallerOrThrow } from './ownership';
import schema from './schema';
import { eventsOfType } from './eventLog';
import { needsYouOfEmployee } from './needsYou';
import { byWriteOrder, isEvaluationAgent } from './metrics';
import {
  holdsLiveStepClaim,
  isManagerChannel,
  OPEN_WORK_STATES,
  PARKED_WORK_STATES,
} from './workLoop';
import { agentReadsSource } from '../src/docs/agent-sources';
import { isEventOf } from '../src/events/contract';
import {
  ONE_TO_ONE_PHASE_KINDS,
  oneToOnePhase,
  type OneToOnePhase,
} from '../src/agent/one-to-one-phase';
import { agentZone, dayKey, dayStart } from '../src/lib/zone';
import { autonomousActionsOn } from '../src/work/autonomy';
import { isPaused } from '../src/work/pause';
import { decisionChannelOf, decisionsReachOf } from '../src/work/decision-channel';
import { typedCodeReaches } from '../src/surfaces/slack-messages-tab';
import { accessEnded } from '../src/work/surface-access';
import { shownEmployeeState, type CharterApproval } from '../src/work/state-labels';
import { finishedAnswerOf } from '../src/work/work-done';
import type { WorkDoneAnswer } from '../src/work/types';

/*
 * The landing page's roster: one row per employee of an owner. The home reads it by pages
 * through {@link page} (wave 17, 17-F; RM33 (a)), so an owner of fifty employees sees every one,
 * each row's day and month read at the viewer's own clock. `agents.rosterForUser`, which answered
 * the twenty newest at the backend's clock for a page loaded before wave 17, is gone since 0.22.0
 * (wave 18, F-1). Moved out of `convex/agents.ts` to keep that module under the standard's soft
 * 1,000 lines (9.2).
 */

/** The longest role line the roster shows, the ellipsis included. */
const ROLE_LINE_MAX = 90;

/** The role line of an employee whose charter the manager has not approved. */
const CHARTER_PENDING_ROLE_LINE = 'charter pending';

/** The role line of an approved charter whose body states no function. */
const ROLE_NOT_STATED = 'role not stated';

/** The most employees one page of the roster lists. */
const ROSTER_LIMIT = 20;

/**
 * How many of the owner's agent rows the roster reads to find its employees.
 * Evaluation agents are deployed under the owner's own subject, so they are
 * skipped inside this window rather than taking one of the twenty places.
 */
export const ROSTER_SCAN_LIMIT = 100;

/** The most surfaces of one employee the roster reads for its decision channel. */
const SURFACE_READ_LIMIT = 100;

/**
 * Bound on each open-state read. Open rows are held to the work-in-progress
 * cap (`AUTONOMOUS_WIP_LIMIT` across all five states), so the bound keeps
 * the read finite and is never the count.
 */
const OPEN_STATE_READ_LIMIT = 100;

/**
 * Bound on the stopped-row read. Nothing caps how many rows an employee has
 * in `failed`, and each carries its run's output, so the bound is lower than
 * the open one and is the most the list can show, the newest first.
 */
const STOPPED_READ_LIMIT = 25;

/** Bound on the owner's documentation sources read for the count. */
const DOC_SOURCE_READ_LIMIT = 100;

/**
 * Bound on an employee's completions read for the month, the newest first.
 * Each carries its run's output, so the bound is kept low; beyond it the
 * month's earliest days are left out and the count says it is a floor.
 */
const MONTH_LANDED_READ_LIMIT = 100;

/**
 * The bytes an employee's send-backs of one month may read before the count is a floor (T5, wave
 * 18): the month's send-backs are read to its start, where the newest hundred alone left out a
 * completion that landed before the oldest of them and made the count a floor past a hundred. A
 * send-back's event holds an item's id and the manager's note, so this is some thousands of them,
 * and twenty employees' months stay well inside one read.
 */
const MONTH_SENT_BACK_BYTES = 256 * 1024;

/**
 * An employee's send-backs this month, newest first, read to the month's start within
 * {@link MONTH_SENT_BACK_BYTES}.
 *
 * @param ctx - Query context.
 * @param agentId - The employee.
 * @param monthStart - The month's first midnight in the employee's zone.
 * @returns The send-backs read, and whether the bytes ran out before the month's start.
 */
async function monthSentBack(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  monthStart: number,
): Promise<{ readonly sentBack: Doc<'events'>[]; readonly more: boolean }> {
  const sentBack: Doc<'events'>[] = [];
  let room = MONTH_SENT_BACK_BYTES;
  for await (const event of eventsOfType(ctx, agentId, 'work.retry', { from: monthStart }).order(
    'desc',
  )) {
    if (room <= 0) return { sentBack, more: true };
    room -= getDocumentSize(event);
    sentBack.push(event);
  }
  return { sentBack, more: false };
}

const landedThisMonthValidator = v.object({
  /** The month, `YYYY-MM`, in the employee's zone. */
  month: v.string(),
  /**
   * Each day of the month an item first finished on, `YYYY-MM-DD`, oldest first: how many landed,
   * their runs answering done, and how many finished partly done, named beside them (RM23 (a)),
   * absent on a day with none.
   */
  days: v.array(v.object({ day: v.string(), landed: v.number(), partly: v.optional(v.number()) })),
  /** True when the read reached its bound, so the month holds at least this many. */
  atLeast: v.boolean(),
});

/** The work an employee landed this month, by day. */
type LandedThisMonth = Infer<typeof landedThisMonthValidator>;

/**
 * The items an employee completed this month in its own zone (N12), each
 * counted once, on the day it first completed within the month: landed when
 * that completion's run answered done, partly done when it answered so, and
 * neither when it answered not done (RM23 (a); `finishedAnswerOf`, the one
 * reading the card, the Work tab and the cycle time take). An item the manager
 * sent back is counted by the completion that followed, or not at all while
 * none has, as the Work tab reads its latest answer (the v0.20.0 walk's
 * finding 4). Reads the month's `work.completed` and `work.retry` events by
 * the type index, from the month's first midnight on, and dates each by the
 * instant it was logged: the newest completions to a bound, and the send-backs
 * to the month's start ({@link monthSentBack}, T5). Past the
 * completions' bound, or the send-backs' bytes, the count is a floor and says so,
 * and past the send-backs' bytes a completion older than the oldest send-back
 * read is left out, since one of the unread may have taken it back.
 *
 * @param ctx - Query context.
 * @param agent - The employee.
 * @param now - The instant whose month is read.
 */
async function landedThisMonth(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  now: number,
): Promise<LandedThisMonth> {
  const zone = agentZone(agent);
  const month = dayKey(now, zone).slice(0, 7);
  const monthStart = dayStart(`${month}-01`, zone);
  // Newest first, so a month past the bound still shows its latest days, today among them;
  // one more than the bound is read to tell a full month from a longer one.
  const [read, { sentBack, more: moreSentBack }] = await Promise.all([
    eventsOfType(ctx, agent._id, 'work.completed', { from: monthStart })
      .order('desc')
      .take(MONTH_LANDED_READ_LIMIT + 1),
    monthSentBack(ctx, agent._id, monthStart),
  ]);
  // Past the send-backs' bytes the older ones are unread: only what finished since the oldest one
  // read is known not to have been taken back.
  const from = moreSentBack ? (sentBack.at(-1)?.createdAt ?? monthStart) : monthStart;
  const firstFinished = new Map<string, { at: number; answer: WorkDoneAnswer }>();
  // Oldest first: each item keeps the first completion that did the work, in whole or in part,
  // since it was last sent back; a not-done answer lands nothing (W16-R17).
  for (const event of [...read.slice(0, MONTH_LANDED_READ_LIMIT), ...sentBack].sort(byWriteOrder)) {
    if (event.createdAt < from) continue;
    if (isEventOf(event, 'work.retry')) {
      firstFinished.delete(event.payload.workItemId);
      continue;
    }
    if (!isEventOf(event, 'work.completed')) continue;
    const workItemId: unknown = event.payload.workItemId;
    const answer = finishedAnswerOf(event.payload.output);
    if (typeof workItemId === 'string' && answer !== 'not-done' && !firstFinished.has(workItemId)) {
      firstFinished.set(workItemId, { at: event.createdAt, answer });
    }
  }
  const byDay = new Map<string, { landed: number; partly: number }>();
  for (const { at, answer } of firstFinished.values()) {
    const day = dayKey(at, zone);
    const counted = byDay.get(day) ?? { landed: 0, partly: 0 };
    byDay.set(
      day,
      answer === 'done'
        ? { ...counted, landed: counted.landed + 1 }
        : { ...counted, partly: counted.partly + 1 },
    );
  }
  return {
    month,
    days: [...byDay]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, { landed, partly }]) => ({ day, landed, ...(partly > 0 ? { partly } : {}) })),
    atLeast: read.length > MONTH_LANDED_READ_LIMIT || moreSentBack,
  };
}

/**
 * Where the one-to-one stands, as `oneToOnePhase` names it: one literal for each of its kinds, so
 * a kind the union gains or loses changes this validator with it.
 */
const oneToOnePhaseKindValidator = v.union(
  ...ONE_TO_ONE_PHASE_KINDS.map((kind: OneToOnePhase['kind']) => v.literal(kind)),
);

/** One employee as the landing page lists it, as a page of `roster.page` answers it. */
export const rosterRowValidator = v.object({
  agentId: v.id('agents'),
  name: v.string(),
  avatarId: v.optional(v.string()),
  state: schema.tables.agents.validator.fields.state,
  /** Where the one-to-one stands, so the roster says "Drafting the charter" when the pill does. */
  phase: oneToOnePhaseKindValidator,
  autonomous: v.boolean(),
  /** Whether the manager has paused the employee (12-P), so the chip reads "Paused". */
  paused: v.boolean(),
  roleLine: v.string(),
  openCount: v.number(),
  parkedCount: v.number(),
  /** The parked count by the state each row is in, so the roster says it in the page's words. */
  parkedStates: v.object({ deferred: v.number(), needsSkill: v.number(), discovered: v.number() }),
  stoppedCount: v.number(),
  needsYou: v.number(),
  docSourceCount: v.number(),
  /** Today, `YYYY-MM-DD`, in the employee's zone (N12, 16-F): the day the home's month card marks. */
  today: v.string(),
  landedThisMonth: landedThisMonthValidator,
  /** Where the employee's decisions reach the manager (12-M; H D6): a DM, buttons or not, or here. */
  decisionsReach: v.union(
    v.object({ kind: v.literal('dashboard') }),
    v.object({
      kind: v.literal('dm'),
      channel: v.string(),
      buttons: v.boolean(),
      /** Whether the manager's typed code reaches the DM's app (W12V-7). */
      typedCode: v.boolean(),
    }),
  ),
});

/** One employee as the landing page lists it. */
export type RosterRow = Infer<typeof rosterRowValidator>;

/**
 * Fit a charter's function onto the roster's one line.
 *
 * Whitespace is collapsed. A line longer than `ROLE_LINE_MAX` is cut at the
 * last space that leaves room for the ellipsis, dropping any punctuation the
 * cut leaves hanging; a single word too long for the line is cut where it
 * must be.
 *
 * Args:
 *   text: The approved charter's `proposedFunction`.
 *
 * Returns:
 *   The line as shown, at most `ROLE_LINE_MAX` characters.
 */
export function clipRoleLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= ROLE_LINE_MAX) return line;
  // One character past the kept length, so a space right after it counts as a boundary.
  const window = line.slice(0, ROLE_LINE_MAX);
  const boundary = window.lastIndexOf(' ');
  let kept = window.slice(0, boundary);
  if (boundary <= 0) {
    kept = '';
    for (const character of line) {
      if (kept.length + character.length >= ROLE_LINE_MAX) break;
      kept += character;
    }
  }
  return `${kept.replace(/[\s,;:.\u2013\u2014-]+$/, '')}\u2026`;
}

/** Where an employee's charter stands, as the roster reads it. */
interface CharterStanding {
  /** The clipped role line, or the pending or not-stated line. */
  readonly roleLine: string;
  /** The newest charter's standing, or null before one is drafted. */
  readonly newest: CharterApproval;
}

/**
 * The role line from the newest charter the manager approved, and the newest
 * charter's standing.
 *
 * An amendment is approved on insert, so it wins at once; a draft awaiting
 * approval never shows as the role (the inbox lists it as waiting on the
 * manager); a draft sent back is deleted, which leaves the employee pending again with
 * nothing to approve.
 *
 * @param ctx - Query context.
 * @param agentId - The employee.
 */
async function charterStanding(ctx: QueryCtx, agentId: Id<'agents'>): Promise<CharterStanding> {
  const charters = ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc');
  let draftAwaitsManager: boolean | undefined;
  for await (const charter of charters) {
    draftAwaitsManager ??= !charter.approved;
    if (!charter.approved) continue;
    const proposedFunction = (charter.body as { proposedFunction?: unknown } | null)
      ?.proposedFunction;
    const roleLine =
      typeof proposedFunction === 'string' && proposedFunction.trim() !== ''
        ? clipRoleLine(proposedFunction)
        : ROLE_NOT_STATED;
    return { roleLine, newest: { approved: !draftAwaitsManager } };
  }
  return {
    roleLine: CHARTER_PENDING_ROLE_LINE,
    newest: draftAwaitsManager === undefined ? null : { approved: false },
  };
}

/**
 * The employee's newest one-to-one session, the one its page reads the phase off
 * (`voice.latest`): one indexed read, the first row newest first.
 */
async function newestSession(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'voiceSessions'> | null> {
  return await ctx.db
    .query('voiceSessions')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc')
    .first();
}

/**
 * Count the employee's open work, its parked work and its stopped work.
 *
 * Open rows hold a work-in-progress slot. Parked rows hold none: deferred,
 * waiting on a skill, or waiting in `discovered` for a free slot, whether a
 * verdict queued them at the cap or none has been reached yet (U3 D5); a
 * row whose evaluation is running holds the slot it runs in and is not
 * parked. Stopped rows are failed ones
 * whose card still offers the manager a move. Reads the state index once per
 * counted state, so completed, skipped and cancelled work, however much of
 * it there is, is never read.
 *
 * @returns The open, parked and stopped counts, and the parked count by state.
 */
async function workCounts(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
): Promise<Pick<RosterRow, 'openCount' | 'parkedCount' | 'parkedStates' | 'stoppedCount'>> {
  const rowsIn = async (
    state: Doc<'workItems'>['state'],
    limit: number = OPEN_STATE_READ_LIMIT,
  ): Promise<Doc<'workItems'>[]> =>
    await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
      // Newest first: past a bound, what the manager has not seen yet is what is kept.
      .order('desc')
      .take(limit);
  const [open, parked, discovered, stoppedRows] = await Promise.all([
    Promise.all(OPEN_WORK_STATES.map((state) => rowsIn(state))),
    Promise.all(PARKED_WORK_STATES.map((state) => rowsIn(state))),
    rowsIn('discovered'),
    rowsIn('failed', STOPPED_READ_LIMIT),
  ]);
  const openRows = open.flat();
  const parkedRows = parked.flat();
  const now = Date.now();
  const waitingDiscovered = discovered.filter(
    (row) => !holdsLiveStepClaim(row, 'evaluation', now),
  ).length;
  const inState = (state: (typeof PARKED_WORK_STATES)[number]): number =>
    parkedRows.filter((row) => row.state === state).length;
  return {
    openCount: openRows.length,
    parkedCount: parkedRows.length + waitingDiscovered,
    parkedStates: {
      deferred: inState('deferred'),
      needsSkill: inState('needs-skill'),
      discovered: waitingDiscovered,
    },
    stoppedCount: stoppedRows.length,
  };
}

/**
 * Some of an owner's employees, one row each, for the landing page: who they are,
 * their state as their own page shows it (`shownEmployeeState`: a charter
 * outranks the row) and where their one-to-one stands (`oneToOnePhase`, off
 * the newest session, as the page reads it), the role the manager approved,
 * the open, parked and stopped work, what waits on the manager, whether they
 * act on their own, whether they are paused, how much documentation they
 * read, and what they landed this month.
 *
 * @param ctx - The query's context.
 * @param ownerKey - The owner the employees belong to.
 * @param agents - The employees to list, in the order to list them.
 * @param at - The instant whose day and month each row reads, in the employee's own zone: the
 *   viewer's clock (W16-R32), or the backend's for a caller that sends none.
 */
async function rosterRows(
  ctx: QueryCtx,
  ownerKey: string,
  agents: readonly Doc<'agents'>[],
  at: number,
): Promise<RosterRow[]> {
  const sources = await ctx.db
    .query('docSources')
    .withIndex('by_user', (q) => q.eq('userId', ownerKey))
    .take(DOC_SOURCE_READ_LIMIT);
  // What stands now (a wait, an access ended, a bridge's heartbeat) is read at the backend's
  // clock, as the writes that change it are stamped; only the calendar follows the viewer's.
  const now = Date.now();
  return await Promise.all(
    agents.map(async (agent): Promise<RosterRow> => {
      const [charter, counts, waiting, landed, session, surfaces] = await Promise.all([
        charterStanding(ctx, agent._id),
        workCounts(ctx, agent._id),
        needsYouOfEmployee(ctx, agent, now),
        landedThisMonth(ctx, agent, at),
        newestSession(ctx, agent._id),
        ctx.db
          .query('surfaces')
          .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
          .take(SURFACE_READ_LIMIT),
      ]);
      const channel = decisionChannelOf(
        surfaces.filter((surface) => isManagerChannel(surface) && !accessEnded(surface, now)),
      );
      return {
        agentId: agent._id,
        name: agent.name,
        ...(agent.avatarId !== undefined ? { avatarId: agent.avatarId } : {}),
        // The state the employee's own page shows, so the roster and its pill never disagree.
        state: shownEmployeeState(agent.state, charter.newest),
        phase: oneToOnePhase(session).kind,
        autonomous: autonomousActionsOn(agent),
        paused: isPaused(agent),
        roleLine: charter.roleLine,
        ...counts,
        // The inbox's own count (decision F-2): what the employee's Needs you lists, every kind,
        // so the roster and the inbox never disagree; the field stays, filled from it.
        needsYou: waiting.length,
        docSourceCount: sources.filter((source) => agentReadsSource(agent, source._id)).length,
        today: dayKey(at, agentZone(agent)),
        landedThisMonth: landed,
        decisionsReach: decisionsReachOf(
          channel,
          channel === undefined ? 'unconfigured' : await socketBridgeStateOf(ctx, channel, now),
          channel === undefined || typedCodeReaches(await typedCodeReachOf(ctx, channel)),
        ),
      };
    }),
  );
}

/** The last instant the roster's calendar is read at: the start of the last day Day0 counts. */
const LAST_ROSTER_INSTANT = Date.UTC(9999, 11, 30);

/** What a caller is told whose clock is no time on the calendar. */
const NOT_A_CALENDAR_TIME =
  'The page’s clock is not a time Day0 can place on the calendar; reload the page';

/** One page of the roster, as the page's paginated read takes it. */
const rosterPageValidator = v.object({
  page: v.array(rosterRowValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

/**
 * One page of the caller's employees for the landing page, newest first ({@link rosterRows}), so
 * the home lists every employee an owner holds and not the twenty newest (wave 17, 17-F;
 * RM33 (a)). Each row's day and month are read at `at`, the viewer's clock rounded down to a
 * quarter hour (`rosterClock`), in the employee's own zone: a cached query's own clock stands
 * still, so the month card's today went stale past midnight on an idle page (W16-R32). Evaluation
 * agents and the baseline arm are left out, so a page may hold fewer rows than it read.
 *
 * Public, any signed-in caller, for the caller's own employees only (`getCallerOrThrow`, 12-G;
 * the read is keyed by the caller's owner key). A page reads at most `ROSTER_LIMIT` employees
 * whatever is asked. Writes nothing.
 *
 * @throws ConvexError when `at` is no time on the calendar.
 */
export const page = query({
  args: { paginationOpts: paginationOptsValidator, at: v.number() },
  returns: rosterPageValidator,
  handler: async (ctx, args): Promise<Infer<typeof rosterPageValidator>> => {
    const identity = await getCallerOrThrow(ctx);
    // The guard first: a caller it refuses learns nothing of the arguments (12-G).
    if (!Number.isFinite(args.at) || args.at < 0 || args.at > LAST_ROSTER_INSTANT) {
      throw new ConvexError(NOT_A_CALENDAR_TIME);
    }
    // A token with an empty subject keys nobody's rows, the malformed ones keyed '' included.
    if (identity.ownerKey === '') return { page: [], isDone: true, continueCursor: '' };
    const read = await ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', identity.ownerKey))
      .order('desc')
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, ROSTER_LIMIT),
      });
    // The paginated read's own split hints (`splitCursor`, `pageStatus`) are left out by name,
    // never spread: what it pages is twenty `agents` rows, which no client needs to split.
    return {
      page: await rosterRows(
        ctx,
        identity.ownerKey,
        read.page.filter((agent) => !isEvaluationAgent(agent)),
        args.at,
      ),
      isDone: read.isDone,
      continueCursor: read.continueCursor,
    };
  },
});
