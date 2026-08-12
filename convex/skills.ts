import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, assertOwnsSkill } from './ownership';
import { applyVerdict } from './work';

/**
 * Skill registry + propose-author-register lifecycle. Public surfaces
 * enforce per-account ownership; internal transitions called by actions
 * skip the check.
 *
 * State machine:
 *   proposed → approved → authoring → registered
 *                       ↓           ↓
 *                   rejected     failed
 *
 * `builtin` skills come straight in at `registered`. `agent-authored`
 * skills walk the full path.
 *
 * `verified` is no longer a resting state: verification, registration and the
 * requeue of the work item that asked for the skill all land in
 * `completeRegistration`, one transaction. Rows written by the earlier
 * three-mutation path can still be sitting in it, so it is listed alongside
 * `authoring` and accepted as a retry.
 *
 * `authoring`, `verified` and `failed` are all resumable: none has ever been
 * registered, so `authorAndRegisterSkill` accepts them as a retry (see the
 * retryable-state list there). That is the way back for a skill authored
 * before Daytona was configured, or one whose sandbox check failed.
 */

export const registered = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('skills')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'registered'))
      .collect();
  },
});

/**
 * Authored but not callable: the sandbox could not run, so the body exists and
 * nothing has attested that it works. Deliberately not part of `registered`,
 * which is what the executor picks from.
 *
 * `verified` rows join them. Nothing writes that state any more, but a row
 * stranded there by the earlier split registration path would otherwise appear
 * in no panel at all, which is how it stayed invisible and unrecoverable.
 */
export const awaitingVerification = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    const byState = await Promise.all(
      (['authoring', 'verified'] as const).map((state) =>
        ctx.db
          .query('skills')
          .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', state))
          .collect(),
      ),
    );
    return byState.flat();
  },
});

/**
 * Authored and checked, and the check said no. Kept out of `registered` for the
 * same reason as `awaitingVerification`, and retryable for the same reason:
 * nothing has ever called this body.
 */
export const verificationFailed = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('skills')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'failed'))
      .collect();
  },
});

export const proposed = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('skills')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'proposed'))
      .collect();
  },
});

export const get = query({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    return await assertOwnsSkill(ctx, args.skillId);
  },
});

export const findByAgentName = query({
  args: { agentId: v.id('agents'), name: v.string() },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) => q.eq('agentId', args.agentId).eq('name', args.name))
      .first();
  },
});

export const installBuiltin = internalMutation({
  args: {
    agentId: v.id('agents'),
    name: v.string(),
    description: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'skills'>> => {
    const existing = await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) => q.eq('agentId', args.agentId).eq('name', args.name))
      .first();
    if (existing) return existing._id;
    const id = await ctx.db.insert('skills', {
      agentId: args.agentId,
      name: args.name,
      description: args.description,
      body: args.body,
      sourceType: 'builtin',
      state: 'registered',
      createdAt: Date.now(),
      registeredAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'skill.builtin-installed',
      payload: { skillId: id, name: args.name },
      createdAt: Date.now(),
    });
    return id;
  },
});

export const propose = internalMutation({
  args: {
    agentId: v.id('agents'),
    workItemId: v.id('workItems'),
    name: v.string(),
    description: v.string(),
    rationale: v.string(),
    requiredScopes: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<Id<'skills'>> => {
    const existing = await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) =>
        q.eq('agentId', args.agentId).eq('name', args.name),
      )
      .first();
    if (existing && existing.state !== 'rejected' && existing.state !== 'failed') {
      return existing._id;
    }
    const id = await ctx.db.insert('skills', {
      agentId: args.agentId,
      name: args.name,
      description: args.description,
      body: '',
      sourceType: 'agent-authored',
      state: 'proposed',
      proposedFor: args.workItemId,
      rationale: args.rationale,
      requiredScopes: args.requiredScopes,
      createdAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'skill.proposed',
      payload: {
        skillId: id,
        name: args.name,
        rationale: args.rationale,
        forWorkItem: args.workItemId,
      },
      createdAt: Date.now(),
    });
    return id;
  },
});

export const approve = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    if (row.state !== 'proposed') {
      throw new Error(`skill state is ${row.state}; expected proposed`);
    }
    await ctx.db.patch(args.skillId, { state: 'approved' });
    for (const scope of row.requiredScopes ?? []) {
      const existing = await ctx.db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', row.agentId).eq('scope', scope))
        .first();
      if (!existing) {
        await ctx.db.insert('permissionGrants', {
          agentId: row.agentId,
          scope,
          createdAt: Date.now(),
        });
      }
    }
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'skill.approved',
      payload: { skillId: args.skillId, name: row.name, scopes: row.requiredScopes ?? [] },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

export const reject = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    await ctx.db.patch(args.skillId, { state: 'rejected' });
    if (row.proposedFor) {
      await ctx.db.patch(row.proposedFor, { state: 'cancelled' });
    }
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'skill.rejected',
      payload: { skillId: args.skillId, name: row.name },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

export const setAuthoring = internalMutation({
  args: {
    skillId: v.id('skills'),
    sandboxId: v.string(),
    // Written when the authored body is all there is to keep: no sandbox ran,
    // so the skill stops here rather than continuing to `verified`.
    body: v.optional(v.string()),
    verificationLog: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.skillId, {
      state: 'authoring',
      daytonaSandboxId: args.sandboxId,
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.verificationLog !== undefined ? { verificationLog: args.verificationLog } : {}),
    });
    const row = await ctx.db.get(args.skillId);
    if (row) {
      await ctx.db.insert('events', {
        agentId: row.agentId,
        type: 'skill.authoring',
        payload: { skillId: args.skillId, sandboxId: args.sandboxId },
        createdAt: Date.now(),
      });
    }
  },
});

/**
 * Everything that has to be true at once for a skill to count as registered:
 * the verified body is stored, the row becomes callable, and the work item
 * that asked for the skill goes back into the queue.
 *
 * These used to be three mutations. A failure between the first and the second
 * left a `verified` row that no panel listed and no retry accepted; a failure
 * before the third left a callable skill whose work item stayed terminal at
 * `needs-skill`, which nothing auto-progresses. One transaction has no gap to
 * fail in: either the skill is callable and its work item is queued, or
 * neither happened and the row is still where the retry can pick it up.
 */
export const completeRegistration = internalMutation({
  args: { skillId: v.id('skills'), body: v.string(), verificationLog: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.skillId);
    if (!row) throw new Error('skill not found');
    await ctx.db.patch(args.skillId, {
      state: 'registered',
      body: args.body,
      verificationLog: args.verificationLog,
      registeredAt: row.registeredAt ?? Date.now(),
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'skill.registered',
      payload: { skillId: args.skillId, name: row.name },
      createdAt: Date.now(),
    });
    if (row.proposedFor) {
      const item = await ctx.db.get(row.proposedFor);
      if (item && item.agentId !== row.agentId) {
        throw new Error('skill and work item belong to different agents');
      }
      await applyVerdict(ctx, row.proposedFor, {
        decision: 'pending-reevaluation',
        reason: 'skill registered, ready to retry',
      });
    }
  },
});

export const setFailed = internalMutation({
  args: { skillId: v.id('skills'), reason: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.skillId, {
      state: 'failed',
      verificationLog: args.reason,
    });
    const row = await ctx.db.get(args.skillId);
    if (row) {
      await ctx.db.insert('events', {
        agentId: row.agentId,
        type: 'skill.failed',
        payload: { skillId: args.skillId, reason: args.reason },
        createdAt: Date.now(),
      });
    }
  },
});
