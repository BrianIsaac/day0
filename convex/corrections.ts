import { v } from 'convex/values';
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent } from './ownership';
import { isRevocationTrialRow } from './revocationEvaluation';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import {
  CORRECTIONS_MAX,
  CORRECTIONS_MAX_CHARS,
  correctionSurfaces,
  type CorrectionKind,
} from '../src/work/corrections';
import { surfaceSlug } from '../src/surfaces/slug';
import type { ExecutionPlan } from '../src/work/types';

/**
 * The manager's corrections, kept per employee and fed back into its later
 * work. The work transitions that take the manager's words keep them here;
 * the planner reads the matching active ones through `selectedForCandidate`, the executor
 * the ones its approved plan applied through `forPlan`, and the dashboard
 * lists and retires them. Selection is `src/work/corrections.ts`.
 *
 * One correction crosses employees: the first plan rejection on a provider
 * item, which every other employee of the same owner that drafts a plan for
 * that item reads (decision N3), through `firstTicketRejection`.
 */

/** The most corrections the dashboard returns per employee, newest first. */
export const CORRECTIONS_READ = 200;

/** The most work items read per name of a provider item: one per employee that discovered it. */
const TICKET_ROWS_READ = 32;

/** The first time the manager rejected a plan for a provider item, as a sibling reads it. */
export interface TicketRejection {
  readonly workItemId: Id<'workItems'>;
  readonly agentId: Id<'agents'>;
  readonly rejectedAt: number;
  /** The manager's words, kept as a correction; absent when the rejection gave no reason or the manager retired it. */
  readonly correction?: Doc<'corrections'>;
}

/**
 * The first plan rejection on the same provider item as a work item, by any
 * employee of the same owner, on any other work item.
 *
 * Rejecting a plan releases the item, and another employee may then take it
 * (N3: "release, but never to autonomy"). That employee's plan needs a human
 * decision, and the manager's first reason reaches its planner and executor
 * though it was kept against the employee whose plan was rejected. The item
 * is matched on the claim key and alias captured at intake; a row without
 * either (mock mode, or a row seeded before keys existed) matches nothing.
 *
 * Args:
 *   ctx: Query or mutation context.
 *   row: The work item whose plan is being decided or drafted.
 *
 * Returns:
 *   The earliest rejection, or undefined when no other row for the item was rejected.
 */
export async function firstTicketRejection(
  ctx: Pick<QueryCtx, 'db'>,
  row: Doc<'workItems'>,
): Promise<TicketRejection | undefined> {
  if (SURFACE_MODE !== 'real') return undefined;
  const names = [row.externalClaimKey, row.externalClaimAlias].filter(
    (name): name is string => name !== undefined,
  );
  if (names.length === 0) return undefined;
  const owner = (await ctx.db.get(row.agentId))?.userId;
  if (!owner) return undefined;
  const candidates: Doc<'workItems'>[] = [];
  for (const name of names) {
    candidates.push(
      ...(await ctx.db
        .query('workItems')
        .withIndex('by_claim_key', (q) => q.eq('externalClaimKey', name))
        .take(TICKET_ROWS_READ)),
      ...(await ctx.db
        .query('workItems')
        .withIndex('by_claim_alias', (q) => q.eq('externalClaimAlias', name))
        .take(TICKET_ROWS_READ)),
    );
  }
  let first: { row: Doc<'workItems'>; rejectedAt: number } | undefined;
  for (const other of candidates) {
    const rejectedAt = other.planRejectedAt;
    if (other._id === row._id || rejectedAt === undefined) continue;
    if (first && first.rejectedAt <= rejectedAt) continue;
    if (isRevocationTrialRow(other)) continue;
    if ((await ctx.db.get(other.agentId))?.userId !== owner) continue;
    first = { row: other, rejectedAt };
  }
  if (!first) return undefined;
  const correction = await firstPlanRejectionCorrection(ctx, first.row);
  return {
    workItemId: first.row._id,
    agentId: first.row.agentId,
    rejectedAt: first.rejectedAt,
    ...(correction ? { correction } : {}),
  };
}

async function firstPlanRejectionCorrection(
  ctx: Pick<QueryCtx, 'db'>,
  rejected: Doc<'workItems'>,
): Promise<Doc<'corrections'> | undefined> {
  const kept = await ctx.db
    .query('corrections')
    .withIndex('by_agent', (q) => q.eq('agentId', rejected.agentId))
    .order('desc')
    .take(CORRECTIONS_READ);
  return kept
    .filter(
      (correction) =>
        correction.workItemId === rejected._id &&
        correction.kind === 'plan-rejection' &&
        correction.retiredAt === undefined,
    )
    .reduce<
      Doc<'corrections'> | undefined
    >((earliest, correction) => (earliest && earliest.createdAt <= correction.createdAt ? earliest : correction), undefined);
}

/**
 * Whether a correction may reach a work item's plan: the employee's own, or
 * the first rejection of a plan for the same provider item.
 */
async function sharedTicketCorrectionId(
  ctx: Pick<QueryCtx, 'db'>,
  row: Doc<'workItems'> | null,
): Promise<Id<'corrections'> | undefined> {
  if (!row) return undefined;
  return (await firstTicketRejection(ctx, row))?.correction?._id;
}

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
 * may be: still active, and this employee's own or the first rejection of a
 * plan for the same provider item.
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
  const shared = await sharedTicketCorrectionId(ctx, row);
  for (const raw of ids) {
    const id = typeof raw === 'string' ? ctx.db.normalizeId('corrections', raw) : null;
    if (!id || kept.includes(id)) continue;
    const correction = await ctx.db.get(id);
    if (!correction || correction.retiredAt !== undefined) continue;
    if (correction.agentId !== row.agentId && correction._id !== shared) continue;
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

/**
 * The newest matching corrections, with the prompt bound applied during the
 * indexed scan. Internal; read by the planner. Given the work item, the first
 * rejection of a plan for the same provider item comes first, whichever
 * employee it was kept against.
 */
export const selectedForCandidate = internalQuery({
  args: {
    agentId: v.id('agents'),
    sourceCategory: v.string(),
    sourceSystem: v.string(),
    workItemId: v.optional(v.id('workItems')),
  },
  handler: async (ctx, args): Promise<Doc<'corrections'>[]> => {
    const slug = surfaceSlug(args.sourceSystem);
    const selected: Doc<'corrections'>[] = [];
    let remaining = CORRECTIONS_MAX_CHARS;
    const item = args.workItemId ? await ctx.db.get(args.workItemId) : null;
    const shared = item ? (await firstTicketRejection(ctx, item))?.correction : undefined;
    if (shared && shared.text.length <= remaining) {
      selected.push(shared);
      remaining -= shared.text.length;
    }
    for await (const row of ctx.db
      .query('corrections')
      .withIndex('by_agent_active_createdAt', (q) =>
        q.eq('agentId', args.agentId).eq('retiredAt', undefined),
      )
      .order('desc')) {
      if (selected.length === CORRECTIONS_MAX || remaining === 0) break;
      if (row._id === shared?._id) continue;
      if (row.sourceCategory !== args.sourceCategory && !row.surfaces.includes(slug)) continue;
      if (row.text.length > remaining) continue;
      selected.push(row);
      remaining -= row.text.length;
      if (selected.length === CORRECTIONS_MAX || remaining === 0) break;
    }
    return selected;
  },
});

/**
 * The corrections an approved plan applied, for its executor: the plan's
 * own snapshot, so one retired after the plan was approved still reaches
 * the run the manager approved with it. Internal. Never another employee's,
 * except the first rejection of a plan for the work item's provider item.
 */
export const forPlan = internalQuery({
  args: {
    agentId: v.id('agents'),
    ids: v.array(v.string()),
    workItemId: v.optional(v.id('workItems')),
  },
  handler: async (ctx, args): Promise<Doc<'corrections'>[]> => {
    const rows: Doc<'corrections'>[] = [];
    let shared: Id<'corrections'> | undefined;
    let sharedRead = false;
    for (const raw of args.ids) {
      const id = ctx.db.normalizeId('corrections', raw);
      const row = id ? await ctx.db.get(id) : null;
      if (!row) continue;
      if (row.agentId !== args.agentId && args.workItemId) {
        if (!sharedRead) {
          shared = await sharedTicketCorrectionId(ctx, await ctx.db.get(args.workItemId));
          sharedRead = true;
        }
        if (row._id !== shared) continue;
      } else if (row.agentId !== args.agentId) {
        continue;
      }
      rows.push(row);
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
