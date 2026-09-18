import { v } from 'convex/values';
import { internalQuery, mutation, query, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent } from './ownership';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { correctionSurfaces, type CorrectionKind } from '../src/work/corrections';
import type { ExecutionPlan } from '../src/work/types';

/**
 * The manager's corrections, kept per employee and fed back into its later
 * work. The work transitions that take the manager's words keep them here;
 * the planner reads the active ones through `activeForAgent`, the executor
 * the ones its approved plan applied through `forPlan`, and the dashboard
 * lists and retires them. Selection is `src/work/corrections.ts`.
 */

/** The most corrections one read returns per employee, newest first. */
export const CORRECTIONS_READ = 200;

/**
 * Keep the manager's words on a work item as a correction, in real mode.
 *
 * Runs inside the transition that took the words, so the correction exists
 * the moment the manager gives it. Nothing reads corrections in mock mode,
 * so none is kept there.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item as it was when the manager wrote.
 *   kind: Which of the manager's words these are.
 *   text: The words, already normalised and capped.
 *   runId: The run the reason was given on, when there was one.
 *
 * Returns:
 *   The kept correction, or undefined when nothing was kept.
 */
export async function keepCorrectionInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  kind: CorrectionKind,
  text: string,
  runId?: Id<'events'>,
): Promise<Id<'corrections'> | undefined> {
  if (SURFACE_MODE !== 'real' || text.trim() === '') return undefined;
  return await ctx.db.insert('corrections', {
    agentId: row.agentId,
    workItemId: row._id,
    ...(runId ? { runId } : {}),
    kind,
    text,
    itemTitle: row.title,
    sourceCategory: row.sourceCategory,
    sourceSystem: row.sourceSystem,
    surfaces: correctionSurfaces(row.sourceSystem, row.plan as ExecutionPlan | undefined),
    createdAt: Date.now(),
    appliedTo: [],
  });
}

/**
 * Record that a stored plan applied corrections, keeping only the ones that
 * may be: this employee's own, still active.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item whose plan is being stored.
 *   ids: The ids the plan says it applied.
 *
 * Returns:
 *   The ids kept, each now listing the work item in `appliedTo`.
 */
export async function markCorrectionsAppliedInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  ids: readonly unknown[],
): Promise<Id<'corrections'>[]> {
  const kept: Id<'corrections'>[] = [];
  for (const raw of ids) {
    const id = typeof raw === 'string' ? ctx.db.normalizeId('corrections', raw) : null;
    if (!id || kept.includes(id)) continue;
    const correction = await ctx.db.get(id);
    if (!correction || correction.agentId !== row.agentId || correction.retiredAt !== undefined) continue;
    if (!correction.appliedTo.includes(row._id)) {
      await ctx.db.patch(id, { appliedTo: [...correction.appliedTo, row._id] });
    }
    kept.push(id);
  }
  return kept;
}

/** The employee's kept corrections for the dashboard, newest first, retired ones included. */
export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'corrections'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('corrections')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .take(CORRECTIONS_READ);
  },
});

/** The employee's active corrections, newest first, for the planner's selection. */
export const activeForAgent = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'corrections'>[]> =>
    await ctx.db
      .query('corrections')
      .withIndex('by_agent_active', (q) => q.eq('agentId', args.agentId).eq('retiredAt', undefined))
      .order('desc')
      .take(CORRECTIONS_READ),
});

/**
 * The corrections an approved plan applied, for its executor: the plan's
 * own snapshot, so one retired after the plan was approved still reaches
 * the run the manager approved with it. Never another employee's.
 */
export const forPlan = internalQuery({
  args: { agentId: v.id('agents'), ids: v.array(v.string()) },
  handler: async (ctx, args): Promise<Doc<'corrections'>[]> => {
    const rows: Doc<'corrections'>[] = [];
    for (const raw of args.ids) {
      const id = ctx.db.normalizeId('corrections', raw);
      const row = id ? await ctx.db.get(id) : null;
      if (row && row.agentId === args.agentId) rows.push(row);
    }
    return rows;
  },
});

/** Stop feeding a correction back into later work. Idempotent. */
export const retire = mutation({
  args: { correctionId: v.id('corrections') },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const correction = await ctx.db.get(args.correctionId);
    if (!correction) throw new Error('correction not found');
    await assertOwnsAgent(ctx, correction.agentId);
    if (correction.retiredAt !== undefined) return { ok: true };
    await ctx.db.patch(args.correctionId, { retiredAt: Date.now() });
    await ctx.db.insert('events', {
      agentId: correction.agentId,
      type: 'work.correction-retired',
      payload: { correctionId: args.correctionId, workItemId: correction.workItemId },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});
