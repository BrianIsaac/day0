import { ConvexError, v, type Infer } from 'convex/values';
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  assertOwnsAgent,
  getCaller,
  getCallerOrThrow,
  ownedAgentOrNull,
  verifiedAddressOf,
  type Caller,
} from './ownership';
import { assertRealMode, SURFACE_MODE } from '../src/lib/surface-mode';
import { AUTONOMY_CHANGE_REASON, autonomousActionsOn } from '../src/work/autonomy';
import {
  holdsLiveStepClaim,
  OPEN_WORK_STATES,
  PARKED_WORK_STATES,
  wakeQueuedWork,
} from './workLoop';
import {
  NEEDS_MANAGER_STATES,
  parkedRowNeedsManager,
  stoppedRowNeedsManager,
  stoppedRowOffersMove,
} from '../src/work/needs-manager';
import { agentReadsSource } from '../src/docs/agent-sources';
import { isEvaluationAgent } from './metrics';
import { isManagerLookupFailure } from '../src/surfaces/manager-lookup';
import {
  MANAGER_ADDRESS_REFUSAL,
  UNVERIFIED_FOR_DEPLOY,
  isEvaluationShapedAddress,
  isManagerAddressShaped,
  normaliseManagerAddress,
} from '../src/agent/manager-address';
import { evaluationBedName, evaluationBedRefusal } from '../src/evaluation/bed-flag';
import { shownEmployeeState, type CharterApproval } from '../src/work/state-labels';
import {
  ONE_TO_ONE_PHASE_KINDS,
  oneToOnePhase,
  type OneToOnePhase,
} from '../src/agent/one-to-one-phase';
import {
  managerNotificationMode,
  NOTIFICATIONS_CHANGE_REASON,
  type ManagerNotificationMode,
} from '../src/work/manager-notes';
import { agentZone, canonicalZone, dayKey, dayStart, deploymentZone } from '../src/lib/zone';
import { appendEvent, eventsOfType } from './eventLog';
import { isEventOf } from '../src/events/contract';

/** Where a permission grant came from: deployment, the manager, a skill or a surface. */
export const PERMISSION_GRANT_SOURCES = ['deploy', 'manager', 'skill', 'surface'] as const;
/** One source of a permission grant. */
export type PermissionGrantSource = (typeof PERMISSION_GRANT_SOURCES)[number];

const permissionGrantSource = v.union(
  v.literal('deploy'),
  v.literal('manager'),
  v.literal('skill'),
  v.literal('surface'),
);

/**
 * Agent CRUD + state transitions. Each agent is owned by one caller subject -
 * a Clerk user, or the single synthetic user in no-auth dev mode;
 * `listForUser` filters by the signed-in user so concurrent demos stay
 * isolated. All other public functions that take an `agentId` enforce
 * ownership via `assertOwnsAgent` before reading or writing.
 */

export const listForUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getCaller(ctx);
    if (!identity) return [];
    return await ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', identity.ownerKey))
      .order('desc')
      .take(20);
  },
});

const agentStateValidator = v.union(
  v.literal('deployed'),
  v.literal('day-one-in-progress'),
  v.literal('charter-pending'),
  v.literal('active'),
);

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
const ROSTER_SCAN_LIMIT = 100;

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

const rosterRowValidator = v.object({
  agentId: v.id('agents'),
  name: v.string(),
  avatarId: v.optional(v.string()),
  state: agentStateValidator,
  /** Where the one-to-one stands, so the roster says "Drafting the charter" when the pill does. */
  phase: oneToOnePhaseKindValidator,
  autonomous: v.boolean(),
  roleLine: v.string(),
  openCount: v.number(),
  parkedCount: v.number(),
  /** The parked count by the state each row is in, so the roster says it in the page's words. */
  parkedStates: v.object({ deferred: v.number(), needsSkill: v.number(), discovered: v.number() }),
  stoppedCount: v.number(),
  needsYou: v.number(),
  docSourceCount: v.number(),
  landedThisMonth: landedThisMonthValidator,
});

/** One employee as the landing page lists it. */
type RosterRow = Infer<typeof rosterRowValidator>;

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
  const [open, parked, discovered, failed] = await Promise.all([
    Promise.all(OPEN_WORK_STATES.map((state) => rowsIn(state))),
    Promise.all(PARKED_WORK_STATES.map((state) => rowsIn(state))),
    rowsIn('discovered'),
    rowsIn('failed', STOPPED_READ_LIMIT),
  ]);
  const stoppedRows = failed.filter(stoppedRowOffersMove);
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
 * act on their own, how much documentation they read, and what they landed
 * this month.
 *
 * Owner-scoped like `listForUser`; evaluation agents and the baseline arm
 * are left out. An anonymous caller gets an empty list.
 *
 * @returns At most `ROSTER_LIMIT` rows, newest first.
 */
export const rosterForUser = query({
  args: {},
  returns: v.array(rosterRowValidator),
  handler: async (ctx): Promise<RosterRow[]> => {
    const identity = await getCaller(ctx);
    if (!identity?.ownerKey) return [];
    const agents = (
      await ctx.db
        .query('agents')
        .withIndex('by_userId', (q) => q.eq('userId', identity.ownerKey))
        .order('desc')
        .take(ROSTER_SCAN_LIMIT)
    )
      .filter((agent) => !isEvaluationAgent(agent))
      .slice(0, ROSTER_LIMIT);
    const sources = await ctx.db
      .query('docSources')
      .withIndex('by_user', (q) => q.eq('userId', identity.ownerKey))
      .take(DOC_SOURCE_READ_LIMIT);
    const now = Date.now();
    return await Promise.all(
      agents.map(async (agent): Promise<RosterRow> => {
        const [charter, counts, landed, session] = await Promise.all([
          charterStanding(ctx, agent._id),
          workCounts(ctx, agent._id),
          landedThisMonth(ctx, agent, now),
          newestSession(ctx, agent._id),
        ]);
        return {
          agentId: agent._id,
          name: agent.name,
          ...(agent.avatarId !== undefined ? { avatarId: agent.avatarId } : {}),
          // The state the employee's own page shows, so the roster and its pill never disagree.
          state: shownEmployeeState(agent.state, charter.newest),
          phase: oneToOnePhase(session).kind,
          autonomous: autonomousActionsOn(agent),
          roleLine: charter.roleLine,
          ...counts,
          // A drafted charter is the one thing the manager must approve before any work.
          needsYou: counts.needsYou + (charter.draftAwaitsManager ? 1 : 0),
          docSourceCount: sources.filter((source) => agentReadsSource(agent, source._id)).length,
          landedThisMonth: landed,
        };
      }),
    );
  },
});

/**
 * Public, owner-guarded by `ownedAgentOrNull`: one employee, or null once it is gone (retired,
 * or never there), so the employee page can say so. Another owner's employee is refused. The id
 * is taken as the address gave it, so a malformed or truncated link reads as no employee rather
 * than as a validation failure the page could only show as a crash.
 */
export const get = query({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    const agentId = ctx.db.normalizeId('agents', args.agentId);
    if (agentId === null) {
      await getCallerOrThrow(ctx);
      return null;
    }
    return await ownedAgentOrNull(ctx, agentId);
  },
});

/**
 * Internal-only fetch used by action-side ownership assertions; bypasses
 * the public `get` so that `assertOwnsAgentAction` doesn't recurse through
 * its own ownership check before it can compare userId.
 */
export const getInternal = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.agentId);
  },
});

/** What a deploy is asked for that decides the employee's address. */
interface DeployAddressArgs {
  readonly evaluationAddress?: string;
  readonly name: string;
  readonly arm: 'day0' | 'baseline';
}

/**
 * The address a new employee reports to: the deploying caller's verified
 * address, since the account that owns an employee is its manager (the
 * transfer plan, section 3.3, D1 (b) and D2 (a)). The evaluation harness
 * names a reserved address instead, its evaluation marker, taken only on an
 * evaluation bed and only when the row it makes reads as an evaluation
 * employee; the caller must still have a verified address of its own.
 *
 * @throws ConvexError for a caller without a verified address, an evaluation
 *   address off a bed, or one that would not mark an evaluation employee.
 */
function deployAddress(caller: Caller, args: DeployAddressArgs): string {
  const callerAddress = verifiedAddressOf(caller);
  if (callerAddress === undefined) throw new ConvexError(UNVERIFIED_FOR_DEPLOY);
  if (args.evaluationAddress === undefined) return callerAddress;
  if (evaluationBedName() === undefined) {
    throw new ConvexError(evaluationBedRefusal('agents.deploy with an evaluation address'));
  }
  const evaluationAddress = normaliseManagerAddress(args.evaluationAddress);
  if (
    evaluationAddress === undefined ||
    !isEvaluationShapedAddress(evaluationAddress) ||
    !isEvaluationAgent({ bossEmail: evaluationAddress, name: args.name, arm: args.arm })
  ) {
    throw new ConvexError(
      "An evaluation address must be the harness's reserved eval-<run>@day0.local address of " +
        'an employee named as an evaluation one.',
    );
  }
  return evaluationAddress;
}

/**
 * Public, signed in with a verified address: creates an employee for the
 * caller, reporting to that address (or, from the evaluation harness on a
 * bed, to its reserved `evaluationAddress`), in the caller's zone with its
 * deployment grants; records both, and schedules the mirror of the caller's
 * already-synced documentation sources to it. The workspace is written
 * later, when the charter is committed.
 */
export const deploy = mutation({
  args: {
    /** The harness's reserved address; refused off an evaluation bed. */
    evaluationAddress: v.optional(v.string()),
    name: v.optional(v.string()),
    avatarId: v.optional(v.string()),
    arm: v.optional(v.union(v.literal('day0'), v.literal('baseline'))),
    excludedDocSourceIds: v.optional(v.array(v.id('docSources'))),
    /** The manager's browser zone (N12); one the backend does not know reads as the deployment's. */
    zone: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<'agents'>> => {
    const identity = await getCallerOrThrow(ctx);
    const name = args.name ?? 'Day0';
    const arm = args.arm ?? 'day0';
    const bossEmail = deployAddress(identity, {
      evaluationAddress: args.evaluationAddress,
      name,
      arm,
    });
    // The control arm exists only for the mock-mode comparison. Nothing on the
    // real path reads the arm, so a baseline row there would be a day0 agent
    // wearing the wrong label in the evidence.
    if (arm === 'baseline' && SURFACE_MODE !== 'mock') {
      throw new Error('the baseline comparison arm can only be deployed in mock mode');
    }
    for (const sourceId of args.excludedDocSourceIds ?? []) {
      const source = await ctx.db.get(sourceId);
      if (!source || source.userId !== identity.ownerKey) {
        throw new Error('Documentation source not found or owned by another user.');
      }
    }
    const zone = canonicalZone(args.zone) ?? deploymentZone();
    const agentId = await ctx.db.insert('agents', {
      bossEmail,
      name,
      avatarId: args.avatarId,
      excludedDocSourceIds: args.excludedDocSourceIds?.length
        ? args.excludedDocSourceIds
        : undefined,
      userId: identity.ownerKey,
      state: 'deployed',
      arm,
      zone,
      mode: SURFACE_MODE,
      createdAt: Date.now(),
    });
    await appendEvent(ctx, {
      agentId,
      type: 'agent.deployed',
      payload: { bossEmail, arm, zone, mode: SURFACE_MODE },
      createdAt: Date.now(),
    });
    const initialScopes =
      SURFACE_MODE === 'mock'
        ? [
            'boss:message',
            'docs:read',
            'spreadsheet:read',
            'social:read',
            'ticket:read',
            'slack:read',
          ]
        : ['boss:message', 'docs:read'];
    for (const scope of initialScopes) {
      const createdAt = Date.now();
      await ctx.db.insert('permissionGrants', {
        agentId,
        scope,
        source: 'deploy',
        createdAt,
      });
      await appendEvent(ctx, {
        agentId,
        type: 'permission.granted',
        payload: { scope, source: 'deploy' },
        createdAt,
      });
    }
    await ctx.scheduler.runAfter(0, internal.docSyncActions.mirrorForAgent, { agentId });
    return agentId;
  },
});

/**
 * Public, any caller: the verified address a deploy by this caller would
 * store, so the deploy form shows the server's address and not the
 * browser's. Writes nothing.
 *
 * @returns The address, or null for an anonymous caller or one whose sign-in asserts none verified.
 */
export const myManagerAddress = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx): Promise<string | null> => {
    const caller = await getCaller(ctx);
    return (caller && verifiedAddressOf(caller)) ?? null;
  },
});

/** The verdicts a surface keeps while its approval and credential stand. */
const MANAGER_REPROBE_VERDICTS: ReadonlyArray<Doc<'surfaces'>['verdict']> = [
  'connected',
  'ungranted',
  'listed-dead',
];

/**
 * Whether changing the manager can change what a probe of this surface finds.
 *
 * Only a chat surface looks the manager up. A connected one is re-probed so
 * the DM moves to the new manager at once; a failed one only when the manager
 * lookup, not the credential, is what failed (Q6).
 */
function reprobedForManagerChange(surface: Doc<'surfaces'>): boolean {
  return (
    surface.class === 'chat' &&
    surface.credentialId !== undefined &&
    surface.managerApprovedAt !== undefined &&
    MANAGER_REPROBE_VERDICTS.includes(surface.verdict) &&
    (surface.verdict === 'connected' || isManagerLookupFailure(surface.reason))
  );
}

/**
 * Change who the agent reports to.
 *
 * Public, owner-guarded. Writes the agent's `bossEmail` and a `manager.changed`
 * event (`via: 'dashboard'`), then, in real mode, schedules a probe of every
 * chat surface the change can mend, so the manager DM moves to the new person
 * and a surface that failed on the old person's lookup comes back (Q6). A
 * probe that resolves a different Slack user writes its own
 * `manager.changed` (`via: 'probe'`) and re-sends the open decision requests.
 * An evaluation agent's address is its evaluation marker and is refused.
 *
 * @returns Whether the address changed, and how many surfaces were re-probed.
 * @throws ConvexError for a malformed address or an evaluation agent.
 */
export const setBossEmail = mutation({
  args: { agentId: v.id('agents'), bossEmail: v.string() },
  handler: async (ctx, args): Promise<{ changed: boolean; reprobed: number }> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const bossEmail = args.bossEmail.trim();
    if (!isManagerAddressShaped(bossEmail)) throw new ConvexError(MANAGER_ADDRESS_REFUSAL);
    if (isEvaluationAgent(agent) || isEvaluationAgent({ ...agent, bossEmail })) {
      throw new ConvexError("An evaluation agent's manager address is fixed by its run.");
    }
    if (bossEmail.toLowerCase() === agent.bossEmail.trim().toLowerCase()) {
      return { changed: false, reprobed: 0 };
    }
    const now = Date.now();
    await ctx.db.patch(agent._id, { bossEmail });
    await appendEvent(ctx, {
      agentId: agent._id,
      type: 'manager.changed',
      payload: { via: 'dashboard', bossEmail },
      createdAt: now,
    });
    if (SURFACE_MODE === 'mock') return { changed: true, reprobed: 0 };
    const surfaces = (
      await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
        .collect()
    ).filter(reprobedForManagerChange);
    await Promise.all(
      surfaces.map(
        async (surface) =>
          await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
            surfaceId: surface._id,
          }),
      ),
    );
    return { changed: true, reprobed: surfaces.length };
  },
});

/** Public, owner-guarded: grants permission scopes to an employee as the manager. */
export const grantScopes = mutation({
  args: { agentId: v.id('agents'), scopes: v.array(v.string()) },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    let added = 0;
    for (const scope of args.scopes) {
      if (scope.trim() === '') throw new Error('permission scope must not be empty');
      const result = await grantScopeInTransaction(ctx, args.agentId, scope, 'manager');
      if (result.added) added += 1;
    }
    return { added };
  },
});

/** Revoke every active copy of one scope and leave its audit history intact. */
export const revokeScope = mutation({
  args: {
    agentId: v.id('agents'),
    scope: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ revoked: number }> => {
    await assertOwnsAgent(ctx, args.agentId);
    if (args.scope.trim() === '') throw new Error('permission scope must not be empty');
    const grants = await ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', args.agentId).eq('scope', args.scope))
      .collect();
    const active = grants.filter((grant) => grant.revokedAt === undefined);
    if (active.length === 0) return { revoked: 0 };
    const revokedAt = Date.now();
    for (const grant of active) await ctx.db.patch(grant._id, { revokedAt });
    const reason = args.reason?.replace(/\s+/g, ' ').trim().slice(0, 200);
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'permission.revoked',
      payload: {
        scope: args.scope,
        by: 'manager',
        ...(reason ? { reason } : {}),
      },
      createdAt: revokedAt,
    });
    return { revoked: active.length };
  },
});

/** Active and revoked scopes, collapsed to the latest edge for the dashboard. */
export const permissionScopes = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    const [grants, surfaces, skills] = await Promise.all([
      ctx.db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('skills')
        .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId))
        .collect(),
    ]);
    const baseline = new Set([
      'boss:message',
      'docs:read',
      'spreadsheet:read',
      'social:read',
      'ticket:read',
    ]);
    const inferredSource = (scope: string): PermissionGrantSource => {
      if (baseline.has(scope)) return 'deploy';
      if (surfaces.some((surface) => scope === `${surface.slug}:read`)) return 'surface';
      if (skills.some((skill) => skill.requiredScopes?.includes(scope))) return 'skill';
      return 'manager';
    };
    const byScope = new Map<string, Doc<'permissionGrants'>[]>();
    for (const grant of grants) {
      const rows = byScope.get(grant.scope) ?? [];
      rows.push(grant);
      byScope.set(grant.scope, rows);
    }
    return [...byScope.entries()]
      .map(([scope, rows]) => {
        const newestFirst = [...rows].sort((left, right) => right.createdAt - left.createdAt);
        const active = newestFirst.find((row) => row.revokedAt === undefined);
        const latest = active ?? newestFirst[0];
        return {
          scope,
          active: active !== undefined,
          source: latest.source ?? inferredSource(scope),
          grantedAt: latest.createdAt,
          revokedAt: latest.revokedAt ?? null,
        };
      })
      .sort((left, right) => left.scope.localeCompare(right.scope));
  },
});

/** Internal: sets an employee's lifecycle state. */
export const setState = internalMutation({
  args: {
    agentId: v.id('agents'),
    state: agentStateValidator,
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.agentId, { state: args.state });
  },
});

/** Public, owner-guarded: an employee's most recent events, newest first. */
export const recentEvents = query({
  args: { agentId: v.id('agents'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    const limit = args.limit ?? 50;
    return await ctx.db
      .query('events')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .take(limit);
  },
});

/** Internal: an employee's active permission grants. */
export const grantedScopes = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'permissionGrants'>[]> => {
    const all = await ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', args.agentId))
      .collect();
    return all.filter((g) => !g.revokedAt);
  },
});

/**
 * Grant one scope inside the caller's transaction, once.
 *
 * Exported as a plain helper so that the write which makes a surface
 * `connected` can grant its read scope in the same transaction, rather than
 * from a second call that may never run.
 *
 * Args:
 *   ctx: Mutation context of the caller.
 *   agentId: Agent receiving the grant.
 *   scope: Scope string such as `linear:read`.
 *
 * Returns:
 *   Whether a new grant row was inserted; an active grant is left alone.
 */
export async function grantScopeInTransaction(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  scope: string,
  source: PermissionGrantSource,
): Promise<{ added: boolean }> {
  const existing = (
    await ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (index) => index.eq('agentId', agentId).eq('scope', scope))
      .collect()
  ).find((grant) => grant.revokedAt === undefined);
  if (existing) return { added: false };
  const createdAt = Date.now();
  await ctx.db.insert('permissionGrants', { agentId, scope, source, createdAt });
  await appendEvent(ctx, {
    agentId,
    type: 'permission.granted',
    payload: { scope, source },
    createdAt,
  });
  return { added: true };
}

/** Grant one read or write scope idempotently after a provider connection succeeds. */
export const grantScope = internalMutation({
  args: { agentId: v.id('agents'), scope: v.string(), source: permissionGrantSource },
  handler: async (ctx, args): Promise<{ added: boolean }> =>
    await grantScopeInTransaction(ctx, args.agentId, args.scope, args.source),
});

/**
 * Choose how the manager hears about run outcomes: as each run finishes, or
 * in one digest on the hour in the agent's zone. Decision requests are sent
 * at once either way; notes kept for a digest are sent when the manager
 * switches back to per run.
 */
export const setManagerNotifications = mutation({
  args: { agentId: v.id('agents'), mode: v.union(v.literal('per-run'), v.literal('digest')) },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; managerNotifications: ManagerNotificationMode; changed: boolean }> => {
    assertRealMode('Manager notifications');
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const from = managerNotificationMode(agent);
    if (from === args.mode) return { ok: true, managerNotifications: from, changed: false };
    await ctx.db.patch(args.agentId, { managerNotifications: args.mode });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agent.notifications-changed',
      payload: { from, to: args.mode, reason: NOTIFICATIONS_CHANGE_REASON },
      createdAt: Date.now(),
    });
    // The notes kept for the next digest would otherwise wait for an hour
    // that per run never has: send them now.
    if (args.mode === 'per-run') {
      await ctx.scheduler.runAfter(0, internal.managerChannelActions.sendManagerDigests, {});
    }
    return { ok: true, managerNotifications: args.mode, changed: true };
  },
});

/**
 * Set the zone the agent's day is measured in, from the card (N12).
 *
 * Public, owner-guarded, both modes. Every day boundary the server draws for
 * the agent and every stamp the dashboard prints move with it; setting the
 * zone the row already has records nothing. Writes `agents.zone` and an
 * `agent.zone-changed` event.
 *
 * @throws ConvexError when the zone is not one the backend knows.
 */
export const setZone = mutation({
  args: { agentId: v.id('agents'), zone: v.string() },
  handler: async (ctx, args): Promise<{ zone: string; changed: boolean }> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const zone = canonicalZone(args.zone);
    if (zone === undefined) throw new ConvexError(`${args.zone} is not a time zone.`);
    const from = agentZone(agent);
    if (agent.zone === zone) return { zone, changed: false };
    await ctx.db.patch(args.agentId, { zone });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agent.zone-changed',
      payload: { from, to: zone },
      createdAt: Date.now(),
    });
    return { zone, changed: true };
  },
});

/**
 * The manager's switch: whether the agent may act on connected systems
 * without asking.
 *
 * Owner-scoped, real mode only: the hosted mock has no gate for the switch
 * to change, so it is refused there before the ownership check, and the
 * header keeps its static label. Off is the deploy default (an absent field
 * reads as off). Every change that changes anything is an event; setting
 * the value the row already has records nothing.
 */
export const setAutonomousActions = mutation({
  args: { agentId: v.id('agents'), on: v.boolean() },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; autonomousActions: boolean; changed: boolean }> => {
    assertRealMode('Autonomous actions');
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const from = autonomousActionsOn(agent);
    if (from === args.on) return { ok: true, autonomousActions: from, changed: false };
    await ctx.db.patch(args.agentId, { autonomousActions: args.on });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agent.autonomy-changed',
      payload: { from, to: args.on, reason: AUTONOMY_CHANGE_REASON },
      createdAt: Date.now(),
    });
    // On raises the cap without moving a row; the work queued at the old cap gets the new slots.
    if (args.on) await wakeQueuedWork(ctx, args.agentId);
    return { ok: true, autonomousActions: args.on, changed: true };
  },
});
