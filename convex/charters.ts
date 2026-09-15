import { v } from 'convex/values';
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server';
import type { Id } from './_generated/dataModel';
import { assertOwnsAgent, assertOwnsCharter } from './ownership';
import { writeFileImpl } from './workspace';
import type { Charter } from '../src/agent/charter';
import { effectiveCharter, type CharterConstraint } from '../src/agent/charter-constraints';
import { identityFromCharter, toolsFromCharter } from '../src/agent/charter-workspace';

/**
 * Charter CRUD + binary-plus-edit approval mutation. Every public
 * function asserts the caller owns the agent the charter belongs to.
 */

/** One of the eight workspace files, rendered by the caller before the commit. */
export const workspaceFileValidator = v.object({
  fileName: v.string(),
  content: v.string(),
});

export interface WorkspaceFile {
  fileName: string;
  content: string;
}

/**
 * Everything a drafted charter writes, as one transaction: the charter row, the
 * workspace files rendered from it, and the event that announces it. Callers
 * that also finalise a voice session (`voice.finaliseSession`) reuse this so the
 * session, its charter and its workspace can never disagree about whether the
 * Day-1 1:1 produced anything.
 */
export async function commitCharterAndWorkspace(
  ctx: MutationCtx,
  args: {
    agentId: Id<'agents'>;
    version: string;
    body: unknown;
    workspaceFiles: WorkspaceFile[];
  },
): Promise<Id<'charters'>> {
  const charterId = await ctx.db.insert('charters', {
    agentId: args.agentId,
    version: args.version,
    body: args.body,
    approved: false,
    createdAt: Date.now(),
  });
  for (const file of args.workspaceFiles) {
    await writeFileImpl(ctx, {
      agentId: args.agentId,
      fileName: file.fileName,
      content: file.content,
    });
  }
  await ctx.db.insert('events', {
    agentId: args.agentId,
    type: 'charter.drafted',
    payload: { charterId, version: args.version },
    createdAt: Date.now(),
  });
  return charterId;
}

export const latest = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .first();
  },
});

export const latestInternal = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) =>
    await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .first(),
});

export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .collect();
  },
});

/**
 * Commit a charter that has no voice session behind it — the chat-mode 1:1 and
 * the answers-first entry point. A run that does have one goes through
 * `voice.finaliseSession`, which adds the session transition to this same
 * transaction.
 *
 * The agent moves to `charter-pending` here for the same reason it does there:
 * the 1:1 is over the moment a charter exists. Without it the chat route left
 * the row at `day-one-in-progress` for good — a dashboard still showing the
 * 1:1 in progress under the charter it produced, and an avatar still working
 * on the landing page.
 */
export const commit = internalMutation({
  args: {
    agentId: v.id('agents'),
    version: v.string(),
    body: v.any(),
    workspaceFiles: v.array(workspaceFileValidator),
  },
  handler: async (ctx, args): Promise<Id<'charters'>> => {
    const charterId = await commitCharterAndWorkspace(ctx, {
      agentId: args.agentId,
      version: args.version,
      body: args.body,
      workspaceFiles: args.workspaceFiles,
    });
    await ctx.db.patch(args.agentId, { state: 'charter-pending' });
    return charterId;
  },
});

/**
 * Re-render the two workspace files a charter body decides.
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: Agent whose workspace to write.
 *   charter: The body to render from.
 */
export async function renderWorkspaceFromCharter(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  charter: Charter,
): Promise<void> {
  await writeFileImpl(ctx, { agentId, fileName: 'IDENTITY.md', content: identityFromCharter(charter) });
  await writeFileImpl(ctx, { agentId, fileName: 'TOOLS.md', content: toolsFromCharter(charter) });
}

/**
 * Strike or restore one constraint on a drafted charter.
 *
 * The draft's clauses are left as synthesised until approval, so a strike
 * costs nothing to reverse and the manager reads the same draft throughout;
 * `approve` is where the struck wording leaves the clauses.
 */
export const setConstraintStruck = mutation({
  args: { charterId: v.id('charters'), index: v.number(), struck: v.boolean() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const charter = await assertOwnsCharter(ctx, args.charterId);
    if (charter.approved) {
      throw new Error('the charter is approved; amend it to strike a constraint');
    }
    const body = charter.body as Charter;
    const constraints = [...(body.constraints ?? [])];
    const target = constraints[args.index];
    if (!Number.isInteger(args.index) || !target) {
      throw new Error(`no constraint at index ${args.index}`);
    }
    constraints[args.index] = { ...target, struck: args.struck };
    await ctx.db.patch(args.charterId, { body: { ...body, constraints } });
    return { ok: true };
  },
});

export const approve = mutation({
  args: { charterId: v.id('charters') },
  handler: async (ctx, args) => {
    const charter = await assertOwnsCharter(ctx, args.charterId);
    const drafted = charter.body as Charter;
    const struck = (drafted.constraints ?? []).filter(
      (constraint: CharterConstraint): boolean => constraint.struck === true,
    );
    // A strike changes the body, and the body is what every downstream
    // reader and the two workspace files are rendered from. With nothing
    // struck the row is patched for approval only and the draft stays
    // byte-identical.
    if (struck.length > 0) {
      const approved = effectiveCharter(drafted);
      await ctx.db.patch(args.charterId, {
        body: approved,
        approved: true,
        approvedAt: Date.now(),
      });
      await renderWorkspaceFromCharter(ctx, charter.agentId, approved);
    } else {
      await ctx.db.patch(args.charterId, {
        approved: true,
        approvedAt: Date.now(),
      });
    }
    await ctx.db.patch(charter.agentId, { state: 'active' });
    await ctx.db.insert('events', {
      agentId: charter.agentId,
      type: 'charter.approved',
      payload: {
        charterId: args.charterId,
        version: charter.version,
        ...(struck.length > 0
          ? { struckConstraints: struck.map((constraint: CharterConstraint): string => constraint.quote) }
          : {}),
      },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Boss rejected the charter and wants to redo the Day-1 1:1. We flip
 * the agent back to `deployed` so the dashboard re-renders the mode
 * picker (voice / chat) — a fresh session creates a new voice session
 * row and overwrites the workspace files on synthesis. The old
 * charter row stays in the table for audit but stops being "latest"
 * once a new one is persisted.
 */
export const requestChanges = mutation({
  args: { charterId: v.id('charters'), notes: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const charter = await assertOwnsCharter(ctx, args.charterId);
    const agentId = charter.agentId;
    await ctx.db.delete(args.charterId);
    await ctx.db.patch(agentId, { state: 'deployed' });
    await ctx.db.insert('events', {
      agentId,
      type: 'charter.request_changes',
      payload: { charterId: args.charterId, notes: args.notes ?? '' },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});
