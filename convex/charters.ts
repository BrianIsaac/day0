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

export const approve = mutation({
  args: { charterId: v.id('charters') },
  handler: async (ctx, args) => {
    const charter = await assertOwnsCharter(ctx, args.charterId);
    await ctx.db.patch(args.charterId, {
      approved: true,
      approvedAt: Date.now(),
    });
    await ctx.db.patch(charter.agentId, { state: 'active' });
    await ctx.db.insert('events', {
      agentId: charter.agentId,
      type: 'charter.approved',
      payload: { charterId: args.charterId, version: charter.version },
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
