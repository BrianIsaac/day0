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
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { DEFAULT_POSTURE } from '../src/work/posture';

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
      posture: DEFAULT_POSTURE,
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
      await ctx.db.insert('permissionGrants', {
        agentId,
        scope,
        createdAt: Date.now(),
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
      const existing = await ctx.db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', args.agentId).eq('scope', scope))
        .first();
      if (existing) continue;
      await ctx.db.insert('permissionGrants', {
        agentId: args.agentId,
        scope,
        createdAt: Date.now(),
      });
      added += 1;
    }
    return { added };
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
): Promise<{ added: boolean }> {
  const existing = await ctx.db
    .query('permissionGrants')
    .withIndex('by_agent_scope', (index) => index.eq('agentId', agentId).eq('scope', scope))
    .filter((query) => query.eq(query.field('revokedAt'), undefined))
    .first();
  if (existing) return { added: false };
  await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: Date.now() });
  return { added: true };
}

/** Grant one read or write scope idempotently after a provider connection succeeds. */
export const grantScope = internalMutation({
  args: { agentId: v.id('agents'), scope: v.string() },
  handler: async (ctx, args): Promise<{ added: boolean }> =>
    await grantScopeInTransaction(ctx, args.agentId, args.scope),
});
