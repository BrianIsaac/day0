import { v } from 'convex/values';
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertOwnsAgent, getCaller, getCallerOrThrow } from './ownership';
import { assertRealMode, SURFACE_MODE } from '../src/lib/surface-mode';
import { AUTONOMY_CHANGE_REASON, autonomousActionsOn } from '../src/work/autonomy';

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
    excludedDocSourceIds: v.optional(v.array(v.id('docSources'))),
  },
  handler: async (ctx, args): Promise<Id<'agents'>> => {
    const identity = await getCallerOrThrow(ctx);
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
      createdAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId,
      type: 'agent.deployed',
      payload: { bossEmail: args.bossEmail },
      createdAt: Date.now(),
    });
    const initialScopes =
      SURFACE_MODE === 'mock'
        ? ['boss:message', 'docs:read', 'spreadsheet:read', 'social:read', 'ticket:read']
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
    state: v.union(
      v.literal('deployed'),
      v.literal('day-one-in-progress'),
      v.literal('charter-pending'),
      v.literal('active'),
    ),
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
    return { ok: true, autonomousActions: args.on, changed: true };
  },
});
