import { v, type Infer } from 'convex/values';
import { typedCodeReachOf } from './slackMessagesTab';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import schema from './schema';
import { eventsOfType } from './eventLog';
import { isEvaluationAgent } from './metrics';
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
import { socketBridgeConfigured } from '../src/surfaces/slack-socket';
import { autonomousActionsOn } from '../src/work/autonomy';
import { isPaused } from '../src/work/pause';
import { decisionChannelOf, decisionsReachOf } from '../src/work/decision-channel';
import { typedCodeReaches } from '../src/surfaces/slack-messages-tab';
import { accessEnded } from '../src/work/surface-access';
import {
  NEEDS_MANAGER_STATES,
  parkedRowNeedsManager,
  stoppedRowNeedsManager,
} from '../src/work/needs-manager';
import { shownEmployeeState, type CharterApproval } from '../src/work/state-labels';

/*
 * The landing page's roster: one row per employee of an owner, read for `agents.rosterForUser`,
 * which validates and authorises and calls {@link rosterOf} (standard 9.3). Moved out of
 * `convex/agents.ts` to keep that module under the standard's soft 1,000 lines (9.2); the
 * query's path is unchanged.
 */

/** The longest role line the roster shows, the ellipsis included. */
const ROLE_LINE_MAX = 90;

/** The role line of an employee whose charter the manager has not approved. */
const CHARTER_PENDING_ROLE_LINE = 'charter pending';

/** The role line of an approved charter whose body states no function. */
const ROLE_NOT_STATED = 'role not stated';

/** The most employees the landing page lists, as `listForUser` returns. */
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

const landedThisMonthValidator = v.object({
  /** The month, `YYYY-MM`, in the employee's zone. */
  month: v.string(),
  /** Each day of the month an item first landed on, `YYYY-MM-DD`, with how many, oldest first. */
  days: v.array(v.object({ day: v.string(), landed: v.number() })),
  /** True when the read reached its bound, so the month holds at least this many. */
  atLeast: v.boolean(),
});

/** The work an employee landed this month, by day. */
type LandedThisMonth = Infer<typeof landedThisMonthValidator>;

/**
 * The items an employee completed this month in its own zone (N12), each
 * counted once, on the day it first completed within the month. Reads the
 * month's `work.completed` events by the type index, from the month's first
 * midnight on, and dates each by the instant it was logged.
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
  const read = await eventsOfType(ctx, agent._id, 'work.completed', { from: monthStart })
    .order('desc')
    .take(MONTH_LANDED_READ_LIMIT + 1);
  const firstLanded = new Map<string, number>();
  for (const event of read.slice(0, MONTH_LANDED_READ_LIMIT)) {
    if (!isEventOf(event, 'work.completed') || event.createdAt < monthStart) continue;
    const workItemId: unknown = event.payload.workItemId;
    // Read newest first, so the last completion kept per item is its first in the month.
    if (typeof workItemId === 'string') firstLanded.set(workItemId, event.createdAt);
  }
  const byDay = new Map<string, number>();
  for (const at of firstLanded.values()) {
    const day = dayKey(at, zone);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return {
    month,
    days: [...byDay]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, landed]) => ({ day, landed })),
    atLeast: read.length > MONTH_LANDED_READ_LIMIT,
  };
}

/**
 * Where the one-to-one stands, as `oneToOnePhase` names it: one literal for each of its kinds, so
 * a kind the union gains or loses changes this validator with it.
 */
const oneToOnePhaseKindValidator = v.union(
  ...ONE_TO_ONE_PHASE_KINDS.map((kind: OneToOnePhase['kind']) => v.literal(kind)),
);

/** One employee as the landing page lists it, as `agents.rosterForUser` answers it. */
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
  /** Whether the newest charter is a draft the manager has not approved yet. */
  readonly draftAwaitsManager: boolean;
  /** The newest charter's standing, or null before one is drafted. */
  readonly newest: CharterApproval;
}

/**
 * The role line from the newest charter the manager approved, and whether a
 * newer draft waits on the manager's approval.
 *
 * An amendment is approved on insert, so it wins at once; a draft awaiting
 * approval never shows as the role but counts as waiting on the manager; a
 * draft sent back is deleted, which leaves the employee pending again with
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
    return { roleLine, draftAwaitsManager, newest: { approved: !draftAwaitsManager } };
  }
  return {
    roleLine: CHARTER_PENDING_ROLE_LINE,
    draftAwaitsManager: draftAwaitsManager ?? false,
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
 * Count the employee's open work, its parked work, its stopped work, and the
 * part of the three waiting on the manager.
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
 * @returns The open, parked and stopped counts, the parked count by state, and the needs-you
 *   count.
 */
async function workCounts(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
): Promise<
  Pick<RosterRow, 'openCount' | 'parkedCount' | 'parkedStates' | 'stoppedCount' | 'needsYou'>
> {
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
  // Several rows can wait on one skill, so each skill is read once.
  const skillIds = [...new Set(parkedRows.flatMap((row) => row.proposedSkillId ?? []))];
  const skills = new Map(
    await Promise.all(
      skillIds.map(
        async (id): Promise<[Id<'skills'>, Doc<'skills'> | null]> => [id, await ctx.db.get(id)],
      ),
    ),
  );
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
    needsYou:
      openRows.filter((row) => NEEDS_MANAGER_STATES.has(row.state)).length +
      parkedRows.filter((row) => parkedRowNeedsManager(row, skills, now)).length +
      stoppedRows.filter(stoppedRowNeedsManager).length,
  };
}

/**
 * The owner's employees, one row each, for the landing page: who they are,
 * their state as their own page shows it (`shownEmployeeState`: a charter
 * outranks the row) and where their one-to-one stands (`oneToOnePhase`, off
 * the newest session, as the page reads it), the role the manager approved,
 * the open, parked and stopped work, what waits on the manager, whether they
 * act on their own, whether they are paused, how much documentation they
 * read, and what they landed this month. Evaluation agents and the baseline arm are left out.
 *
 * @param ctx - The query's context.
 * @param ownerKey - The owner whose employees are listed.
 * @returns At most `ROSTER_LIMIT` rows, newest first.
 */
export async function rosterOf(ctx: QueryCtx, ownerKey: string): Promise<RosterRow[]> {
  const agents = (
    await ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', ownerKey))
      .order('desc')
      .take(ROSTER_SCAN_LIMIT)
  )
    .filter((agent) => !isEvaluationAgent(agent))
    .slice(0, ROSTER_LIMIT);
  const sources = await ctx.db
    .query('docSources')
    .withIndex('by_user', (q) => q.eq('userId', ownerKey))
    .take(DOC_SOURCE_READ_LIMIT);
  const now = Date.now();
  const bridgeConfigured = socketBridgeConfigured();
  return await Promise.all(
    agents.map(async (agent): Promise<RosterRow> => {
      const [charter, counts, landed, session, surfaces] = await Promise.all([
        charterStanding(ctx, agent._id),
        workCounts(ctx, agent._id),
        landedThisMonth(ctx, agent, now),
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
        // A drafted charter is the one thing the manager must approve before any work.
        needsYou: counts.needsYou + (charter.draftAwaitsManager ? 1 : 0),
        docSourceCount: sources.filter((source) => agentReadsSource(agent, source._id)).length,
        landedThisMonth: landed,
        decisionsReach: decisionsReachOf(
          channel,
          bridgeConfigured,
          channel === undefined || typedCodeReaches(await typedCodeReachOf(ctx, channel)),
        ),
      };
    }),
  );
}
