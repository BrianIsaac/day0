import { v } from 'convex/values';
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsCharter } from './ownership';
import { writeFileImpl } from './workspace';
import { declareCharterSystem, retireCharterSystem, scheduleOrientationFor } from './surfaces';
import type { Charter } from '../src/agent/charter';
import {
  applyCharterChanges,
  charterDiff,
  nextCharterVersion,
  type CharterChange,
} from '../src/agent/charter-amendment';
import {
  CONSTRAINT_KINDS,
  strikeOutcome,
  type CharterConstraint,
} from '../src/agent/charter-constraints';
import { identityFromCharter, toolsFromCharter } from '../src/agent/charter-workspace';
import { SYSTEM_CLASSES } from '../src/agent/system-classes';
import { SURFACE_MODE } from '../src/lib/surface-mode';

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

/** A strike or an approval either lands or names the reason it was refused. */
const strikeResultValidator = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({ ok: v.literal(false), reason: v.string() }),
);

export type StrikeResult = { ok: true } | { ok: false; reason: string };

/**
 * Strike or restore one constraint on a drafted charter.
 *
 * The draft's clauses are left as synthesised until approval, so a strike
 * costs nothing to reverse and the manager reads the same draft throughout;
 * `approve` is where the struck wording leaves the clauses. The effective
 * charter is computed here all the same, with the function approval uses,
 * so a strike approval could not honour is refused now, with the reason,
 * and the flag is never set.
 */
export const setConstraintStruck = mutation({
  args: { charterId: v.id('charters'), index: v.number(), struck: v.boolean() },
  returns: strikeResultValidator,
  handler: async (ctx, args): Promise<StrikeResult> => {
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
    const toggled: Charter = { ...body, constraints };
    if (args.struck) {
      const outcome = strikeOutcome(toggled);
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
    }
    await ctx.db.patch(args.charterId, { body: toggled });
    return { ok: true };
  },
});

/**
 * Approve the draft, applying its strikes to the clauses.
 *
 * A strike is refused by `setConstraintStruck` before it is ever flagged,
 * so the refusal here is a last guard for a body that reached the table
 * some other way; it returns the reason rather than throwing, and leaves
 * the row as it was.
 */
export const approve = mutation({
  args: { charterId: v.id('charters') },
  returns: strikeResultValidator,
  handler: async (ctx, args): Promise<StrikeResult> => {
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
      const outcome = strikeOutcome(drafted);
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      const approved = outcome.charter;
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

const listClauseField = v.union(
  v.literal('willDo'),
  v.literal('willNotDo'),
  v.literal('escalationTriggers'),
);

const literals = <T extends string>(values: readonly T[]) =>
  v.union(...(values.map((value) => v.literal(value)) as [ReturnType<typeof v.literal<T>>]));

/** One typed change to an approved charter; see `src/agent/charter-amendment.ts`. */
export const charterChangeValidator = v.union(
  v.object({ kind: v.literal('edit-function'), text: v.string() }),
  v.object({
    kind: v.literal('edit-clause'),
    field: listClauseField,
    index: v.number(),
    text: v.string(),
  }),
  v.object({ kind: v.literal('answer-question'), question: v.string(), answer: v.string() }),
  v.object({
    kind: v.literal('add-constraint'),
    constraint: v.object({
      kind: literals(CONSTRAINT_KINDS),
      quote: v.string(),
      clause: listClauseField,
    }),
  }),
  v.object({ kind: v.literal('strike-constraint'), index: v.number() }),
  v.object({
    kind: v.literal('add-system'),
    system: v.object({
      name: v.string(),
      class: literals(SYSTEM_CLASSES),
      whereMentioned: v.string(),
    }),
  }),
  v.object({ kind: v.literal('remove-system'), name: v.string() }),
);

/** Who sent an amendment. */
export type AmendmentVia = 'dashboard' | 'plan-approval' | 'channel';


/**
 * Amend the agent's approved charter: one new version, one event, the
 * workspace re-rendered, orientation for an added system, and a
 * re-evaluation of parked work, all in this transaction.
 *
 * Every row is kept. The new row is approved on insert (the manager sent the
 * change) and supersedes the previous one, so `latest` switches the whole
 * app to the new version in one write. The event carries the changes as
 * sent and the per-field diff, because no store gives actor, reason and diff
 * for free.
 *
 * Args:
 *   ctx: Mutation context.
 *   args: The agent, the changes, who sent them and an optional reason.
 *
 * Returns:
 *   The new charter row's id and version.
 *
 * Raises:
 *   Error: When the agent has no approved charter, a change names something
 *     the charter lacks, or the changes leave the body as it was.
 */
export async function amendCharterInTransaction(
  ctx: MutationCtx,
  args: {
    agentId: Id<'agents'>;
    changes: readonly CharterChange[];
    via: AmendmentVia;
    reason?: string;
  },
): Promise<{ charterId: Id<'charters'>; version: string; previousVersion: string }> {
  const previous = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
    .order('desc')
    .first();
  if (!previous) throw new Error('the agent has no charter to amend');
  if (!previous.approved) {
    throw new Error('the charter is not approved yet; approve it or request changes instead');
  }
  const now = Date.now();
  const before = previous.body as Charter;
  const version = nextCharterVersion(previous.version);
  const applied = applyCharterChanges(before, args.changes, new Date(now));
  const after: Charter = { ...applied.charter, version };
  const diff = charterDiff(before, after);
  if (diff.length === 0) throw new Error('the amendment changes nothing');

  const charterId = await ctx.db.insert('charters', {
    agentId: args.agentId,
    version,
    body: after,
    approved: true,
    approvedAt: now,
    supersedes: previous._id,
    createdAt: now,
  });
  await renderWorkspaceFromCharter(ctx, args.agentId, after);
  await ctx.db.insert('events', {
    agentId: args.agentId,
    type: 'charter.amended',
    payload: {
      charterId,
      previousCharterId: previous._id,
      version,
      previousVersion: previous.version,
      via: args.via,
      ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
      changes: args.changes,
      diff,
    },
    createdAt: now,
  });

  // Systems become surfaces in real mode only, as at approval; the hosted
  // mock keeps its synthetic surfaces and files no orientation.
  if (SURFACE_MODE === 'real') {
    for (const system of applied.systemsAdded) {
      const declared = await declareCharterSystem(ctx, { agentId: args.agentId, system, now });
      if (!declared.surfaceId) continue;
      const surface = await ctx.db.get(declared.surfaceId);
      if (surface) await scheduleOrientationFor(ctx, surface);
    }
    for (const system of applied.systemsRemoved) {
      await retireCharterSystem(ctx, { agentId: args.agentId, system, now });
    }
  }

  await scheduleReevaluation(ctx, args.agentId, charterId);
  return { charterId, version, previousVersion: previous.version };
}

/**
 * Send the work parked under the previous version back for evaluation.
 *
 * The new charter row is the trigger's idempotency key: one amendment
 * re-admits a parked row once, and the row's verdict is judged again
 * against the current charter, never reconciled against the diff.
 */
async function scheduleReevaluation(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  charterId: Id<'charters'>,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.work.reevaluatePending, {
    agentId,
    trigger: 'charter',
    key: charterId,
  });
}

/** Amend the owner's approved charter from the dashboard. */
export const amend = mutation({
  args: {
    agentId: v.id('agents'),
    changes: v.array(charterChangeValidator),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ charterId: Id<'charters'>; version: string }> => {
    await assertOwnsAgent(ctx, args.agentId);
    const result = await amendCharterInTransaction(ctx, {
      agentId: args.agentId,
      changes: args.changes,
      via: 'dashboard',
      reason: args.reason,
    });
    return { charterId: result.charterId, version: result.version };
  },
});

/**
 * Reject only the current unapproved draft. An earlier approved charter stays
 * in force; without one, the employee returns to Day-1 for another 1:1.
 */
export const requestChanges = mutation({
  args: { charterId: v.id('charters'), notes: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const charter = await assertOwnsCharter(ctx, args.charterId);
    const agentId = charter.agentId;
    if (charter.approved) throw new Error('An approved charter cannot be sent back; amend it instead.');
    const latest = await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .order('desc')
      .first();
    if (latest?._id !== charter._id) throw new Error('Only the latest draft can be sent back.');
    let approvedCharterRemains = false;
    for await (const previous of ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .order('desc')) {
      if (previous._id !== charter._id && previous.approved) {
        approvedCharterRemains = true;
        break;
      }
    }
    await ctx.db.delete(args.charterId);
    await ctx.db.patch(agentId, { state: approvedCharterRemains ? 'active' : 'deployed' });
    await ctx.db.insert('events', {
      agentId,
      type: 'charter.request_changes',
      payload: { charterId: args.charterId, notes: args.notes ?? '' },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});
