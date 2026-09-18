import { v, type Infer } from 'convex/values';
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
import { assertOwnsAgent, getCaller, getCallerOrThrow } from './ownership';
import { assertRealMode, SURFACE_MODE } from '../src/lib/surface-mode';
import { AUTONOMY_CHANGE_REASON, autonomousActionsOn } from '../src/work/autonomy';
import { OPEN_WORK_STATES, wakeQueuedWork } from './workLoop';
import { agentReadsSource } from './docSources';
import {
  managerNotificationMode,
  NOTIFICATIONS_CHANGE_REASON,
  type ManagerNotificationMode,
} from '../src/work/manager-notes';

export const PERMISSION_GRANT_SOURCES = ['deploy', 'manager', 'skill', 'surface'] as const;
export type PermissionGrantSource = (typeof PERMISSION_GRANT_SOURCES)[number];

const permissionGrantSource = v.union(
  v.literal('deploy'),
  v.literal('manager'),
  v.literal('skill'),
  v.literal('surface'),
);

/**
 * Agent CRUD + state transitions. Each agent is owned by one caller subject —
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
      .withIndex('by_userId', (q) => q.eq('userId', identity.subject))
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

/** Bound on the owner's documentation sources read for the count. */
const DOC_SOURCE_READ_LIMIT = 100;

/** The open states that wait on the manager: a plan to approve, a held action set. */
const NEEDS_MANAGER_STATES: ReadonlySet<string> = new Set(['plan-pending', 'actions-pending']);

const rosterRowValidator = v.object({
  agentId: v.id('agents'),
  name: v.string(),
  avatarId: v.optional(v.string()),
  state: agentStateValidator,
  autonomous: v.boolean(),
  roleLine: v.string(),
  openCount: v.number(),
  needsYou: v.number(),
  docSourceCount: v.number(),
});

/** One employee as the landing page lists it. */
type RosterRow = Infer<typeof rosterRowValidator>;

/**
 * Whether an agent row belongs to an evaluation run rather than the company.
 *
 * Both evaluation paths deploy under the operator's own subject. Match their
 * generated address and name together: the deploy mutation also accepts an
 * ordinary manager address beginning with `eval-`.
 *
 * Args:
 *   agent: The agent row's boss address and arm.
 *
 * Returns:
 *   True for an evaluation agent.
 */
function isEvaluationAgent(agent: Pick<Doc<'agents'>, 'bossEmail' | 'name' | 'arm'>): boolean {
  if (agent.arm === 'baseline') return true;
  if (agent.name === 'Day0 revocation evaluation') {
    return /^eval-revocation-\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}z@day0\.local$/.test(
      agent.bossEmail,
    );
  }
  return (
    /^Day0 evaluation [1-9]\d*$/.test(agent.name) &&
    /^eval-day0-r[1-9]\d*-\d{13}@day0\.local$/.test(agent.bossEmail)
  );
}

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
  const kept = boundary > 0 ? window.slice(0, boundary) : line.slice(0, ROLE_LINE_MAX - 1);
  return `${kept.replace(/[\s,;:.\u2013\u2014-]+$/, '')}\u2026`;
}

/**
 * The role line from the newest charter the manager approved.
 *
 * An amendment is approved on insert, so it wins at once; a draft awaiting
 * approval never shows; a draft sent back is deleted, which leaves the
 * employee pending again.
 *
 * Args:
 *   ctx: Query context.
 *   agentId: The employee.
 *
 * Returns:
 *   The clipped role line, or the pending or not-stated line.
 */
async function approvedRoleLine(ctx: QueryCtx, agentId: Id<'agents'>): Promise<string> {
  const charters = ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc');
  for await (const charter of charters) {
    if (!charter.approved) continue;
    const proposedFunction = (charter.body as { proposedFunction?: unknown } | null)
      ?.proposedFunction;
    return typeof proposedFunction === 'string' && proposedFunction.trim() !== ''
      ? clipRoleLine(proposedFunction)
      : ROLE_NOT_STATED;
  }
  return CHARTER_PENDING_ROLE_LINE;
}

/**
 * Count the employee's open work and the part of it waiting on the manager.
 *
 * Reads the state index once per open state, so finished work, however much
 * of it there is, is never read.
 *
 * Args:
 *   ctx: Query context.
 *   agentId: The employee.
 *
 * Returns:
 *   The open count and the needs-you count.
 */
async function openWorkCounts(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
): Promise<{ openCount: number; needsYou: number }> {
  const perState = await Promise.all(
    OPEN_WORK_STATES.map(
      async (state): Promise<[string, number]> => [
        state,
        (
          await ctx.db
            .query('workItems')
            .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
            .take(OPEN_STATE_READ_LIMIT)
        ).length,
      ],
    ),
  );
  let openCount = 0;
  let needsYou = 0;
  for (const [state, count] of perState) {
    openCount += count;
    if (NEEDS_MANAGER_STATES.has(state)) needsYou += count;
  }
  return { openCount, needsYou };
}

/**
 * The owner's employees, one row each, for the landing page: who they are,
 * the role the manager approved, the open work, what waits on the manager,
 * whether they act on their own, and how much documentation they read.
 *
 * Owner-scoped like `listForUser`; evaluation agents and the baseline arm
 * are left out. An anonymous caller gets an empty list.
 *
 * Returns:
 *   At most `ROSTER_LIMIT` rows, newest first.
 */
export const rosterForUser = query({
  args: {},
  returns: v.array(rosterRowValidator),
  handler: async (ctx): Promise<RosterRow[]> => {
    const identity = await getCaller(ctx);
    if (!identity?.subject) return [];
    const agents = (
      await ctx.db
        .query('agents')
        .withIndex('by_userId', (q) => q.eq('userId', identity.subject))
        .order('desc')
        .take(ROSTER_SCAN_LIMIT)
    )
      .filter((agent) => !isEvaluationAgent(agent))
      .slice(0, ROSTER_LIMIT);
    const sources = await ctx.db
      .query('docSources')
      .withIndex('by_user', (q) => q.eq('userId', identity.subject))
      .take(DOC_SOURCE_READ_LIMIT);
    return await Promise.all(
      agents.map(async (agent): Promise<RosterRow> => {
        const [roleLine, counts] = await Promise.all([
          approvedRoleLine(ctx, agent._id),
          openWorkCounts(ctx, agent._id),
        ]);
        return {
          agentId: agent._id,
          name: agent.name,
          ...(agent.avatarId !== undefined ? { avatarId: agent.avatarId } : {}),
          state: agent.state,
          autonomous: autonomousActionsOn(agent),
          roleLine,
          ...counts,
          docSourceCount: sources.filter((source) => agentReadsSource(agent, source._id)).length,
        };
      }),
    );
  },
});

export const get = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    return await assertOwnsAgent(ctx, args.agentId);
  },
});

export const getByEmail = query({
  args: { bossEmail: v.string() },
  handler: async (ctx, args) => {
    const identity = await getCaller(ctx);
    if (!identity) return null;
    const row = await ctx.db
      .query('agents')
      .withIndex('by_bossEmail', (q) => q.eq('bossEmail', args.bossEmail))
      .order('desc')
      .first();
    if (!row) return null;
    if (row.userId !== identity.subject) return null;
    return row;
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

export const deploy = mutation({
  args: {
    bossEmail: v.string(),
    name: v.optional(v.string()),
    avatarId: v.optional(v.string()),
    arm: v.optional(v.union(v.literal('day0'), v.literal('baseline'))),
    excludedDocSourceIds: v.optional(v.array(v.id('docSources'))),
  },
  handler: async (ctx, args): Promise<Id<'agents'>> => {
    const identity = await getCallerOrThrow(ctx);
    // The control arm exists only for the mock-mode comparison. Nothing on the
    // real path reads the arm, so a baseline row there would be a day0 agent
    // wearing the wrong label in the evidence.
    if (args.arm === 'baseline' && SURFACE_MODE !== 'mock') {
      throw new Error('the baseline comparison arm can only be deployed in mock mode');
    }
    for (const sourceId of args.excludedDocSourceIds ?? []) {
      const source = await ctx.db.get(sourceId);
      if (!source || source.userId !== identity.subject) {
        throw new Error('Documentation source not found or owned by another user.');
      }
    }
    const agentId = await ctx.db.insert('agents', {
      bossEmail: args.bossEmail,
      name: args.name ?? 'Day0',
      avatarId: args.avatarId,
      excludedDocSourceIds: args.excludedDocSourceIds?.length
        ? args.excludedDocSourceIds
        : undefined,
      userId: identity.subject,
      state: 'deployed',
      arm: args.arm ?? 'day0',
      createdAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId,
      type: 'agent.deployed',
      payload: { bossEmail: args.bossEmail, arm: args.arm ?? 'day0' },
      createdAt: Date.now(),
    });
    const initialScopes =
      SURFACE_MODE === 'mock'
        ? ['boss:message', 'docs:read', 'spreadsheet:read', 'social:read', 'ticket:read', 'slack:read']
        : ['boss:message', 'docs:read'];
    for (const scope of initialScopes) {
      const createdAt = Date.now();
      await ctx.db.insert('permissionGrants', {
        agentId,
        scope,
        source: 'deploy',
        createdAt,
      });
      await ctx.db.insert('events', {
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
    await ctx.db.insert('events', {
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

export const setState = internalMutation({
  args: {
    agentId: v.id('agents'),
    state: agentStateValidator,
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.agentId, { state: args.state });
  },
});

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
  await ctx.db.insert('events', {
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
 * in one hourly digest. Decision requests are sent at once either way.
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
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'agent.notifications-changed',
      payload: { from, to: args.mode, reason: NOTIFICATIONS_CHANGE_REASON },
      createdAt: Date.now(),
    });
    return { ok: true, managerNotifications: args.mode, changed: true };
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
    await ctx.db.insert('events', {
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
