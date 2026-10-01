import { v } from 'convex/values';
import type { MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { appendEvent } from './eventLog';
import { applyVerdict, releaseExternalClaim, skillRejectedReason } from './work';
import { scheduleNextStep } from './workLoop';

/*
 * The one walk of the work waiting for a skill (the cockpit's item; the wave 10 review, M9): a
 * skill's transition moves every item waiting for it, a batch per transaction, whether it
 * registered (each item is evaluated again), failed or parked (each waits with the reason), or
 * ended without registering, rejected or given up (each is cancelled with the reason, and its
 * claim on the provider item released as cancelling a plan releases it). Kept out of
 * `convex/skills.ts` so the manager's controls (`convex/skillControls.ts`) share it without an
 * import cycle; the continuation stays registered as `skills.continueWaitingWork`, the path every
 * batch already scheduled names.
 */

/**
 * Which of the employee's rows a skill's transition reaches.
 *
 * `queued` also takes the rows registration already sent back to `discovered`;
 * `sameName` also takes rows parked behind another proposal of this name, or
 * behind none yet. The row the skill was proposed for is always read in both
 * states, as it was when it was the only row this looked at.
 */
export interface WaitingScope {
  queued?: boolean;
  sameName?: boolean;
}

/**
 * Every row of the employee that is waiting for this skill, in discovery order.
 *
 * The first evaluation to need a skill proposes it and becomes `proposedFor`;
 * every later item of the same shape is linked to that proposal through
 * `proposedSkillId` and waits beside it. A transition that reached only
 * `proposedFor` left the others parked at `needs-skill` behind a skill that
 * had registered, with nothing on the card to move them.
 *
 * A row linked to a different proposal is not waiting for this one, whoever
 * it was first proposed for. The exception is registration: a callable skill
 * of this name serves a row parked behind an earlier, failed proposal of the
 * same name, and a row whose verdict names the skill but whose link has not
 * landed yet.
 *
 * Args:
 *   ctx: Mutation context.
 *   skill: The skill whose transition is being applied.
 *   scope: How far the transition reaches.
 *
 * Returns:
 *   The waiting rows, oldest first.
 */
export async function waitingRows(
  ctx: MutationCtx,
  skill: Doc<'skills'>,
  scope: WaitingScope = {},
): Promise<Doc<'workItems'>[]> {
  const waitsForThis = waitingPredicate(ctx, skill, scope);
  const source = await waitingSource(ctx, skill);
  const rows: Doc<'workItems'>[] = [];
  const states = scope.queued
    ? (['discovered', 'needs-skill'] as const)
    : (['needs-skill'] as const);
  for (const state of states) {
    for await (const row of ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', skill.agentId).eq('state', state))) {
      if (await waitsForThis(row)) rows.push(row);
    }
  }
  if (!scope.queued && source?.state === 'discovered' && (await waitsForThis(source))) {
    rows.push(source);
  }
  return rows.sort((a, b) => a._creationTime - b._creationTime);
}

/**
 * The row a skill was proposed for, refused when it belongs to another employee.
 *
 * Args:
 *   ctx: Mutation context.
 *   skill: The skill.
 *
 * Returns:
 *   The source row, or null when the skill has none or it is gone.
 */
async function waitingSource(
  ctx: MutationCtx,
  skill: Doc<'skills'>,
): Promise<Doc<'workItems'> | null> {
  const source = skill.proposedFor ? await ctx.db.get(skill.proposedFor) : null;
  if (source && source.agentId !== skill.agentId) {
    throw new Error('skill and work item belong to different agents');
  }
  return source;
}

/**
 * Whether one row of the employee is waiting for this skill; see `waitingRows`.
 *
 * Args:
 *   ctx: Mutation context.
 *   skill: The skill whose transition is being applied.
 *   scope: How far the transition reaches.
 *
 * Returns:
 *   The test, which reads another proposal at most once per call site.
 */
function waitingPredicate(
  ctx: MutationCtx,
  skill: Doc<'skills'>,
  scope: WaitingScope,
): (row: Doc<'workItems'>) => Promise<boolean> {
  const sameNameSkill = new Map<Id<'skills'>, boolean>();
  const namesThisSkill = async (skillId: Id<'skills'>): Promise<boolean> => {
    const known = sameNameSkill.get(skillId);
    if (known !== undefined) return known;
    const other = await ctx.db.get(skillId);
    const same = other?.agentId === skill.agentId && other.name === skill.name;
    sameNameSkill.set(skillId, same);
    return same;
  };
  return async (row: Doc<'workItems'>): Promise<boolean> => {
    if (row.proposedSkillId === skill._id) return true;
    if (row.proposedSkillId) {
      return scope.sameName === true && (await namesThisSkill(row.proposedSkillId));
    }
    if (row._id === skill.proposedFor) return true;
    return (
      scope.sameName === true &&
      (row.verdict as { suggestedSkillName?: unknown } | undefined)?.suggestedSkillName ===
        skill.name
    );
  };
}

/** Waiting rows one transaction moves; the rest continue by schedule, as `reevaluatePending` does. */
export const WAITING_BATCH = 25;

/** Rows of one state one transaction reads while looking for the ones waiting. */
const WAITING_SCAN = 200;

export const waitingState = v.union(v.literal('discovered'), v.literal('needs-skill'));

/** What a skill's transition does to each row waiting for it. */
export const waitingMove = v.union(
  v.object({
    kind: v.literal('verdict'),
    verdict: v.object({ decision: v.string(), reason: v.string() }),
  }),
  v.object({
    kind: v.literal('cancel'),
    /** The reason each cancelled item carries; a rejection's own words when absent. */
    reason: v.optional(v.string()),
  }),
);

/** What a skill's transition does to each row waiting for it ({@link waitingMove}). */
export type WaitingMove = typeof waitingMove.type;

export const waitingScope = v.object({
  queued: v.optional(v.boolean()),
  sameName: v.optional(v.boolean()),
});

/** Where a batched walk stopped: the state being read and the last row read in it. */
export const waitingProgress = v.object({
  state: waitingState,
  after: v.optional(v.number()),
  /** The source row was moved first, from `discovered`, and is not moved again. */
  skipSource: v.boolean(),
});
/** Where a batched walk stopped ({@link waitingProgress}). */
export type WaitingProgress = typeof waitingProgress.type;

/**
 * Move every work item waiting for this skill, a batch per transaction.
 *
 * The first batch lands in the transaction of the skill write that caused
 * it, and the continuation is scheduled in that same transaction, so a
 * callable skill with work still parked behind it, or parked work whose skill
 * never landed, lasts only until the continuation runs; nothing is left for a
 * later write to find. A continuation stops once the skill has left the state
 * this transition put it in: the next transition walks the rows itself.
 *
 * The needs-skill rows are read before the discovered ones, so a row this
 * walk moves into a later state is never read twice. Each row takes the move
 * the first one takes, oldest first within a state; the work-in-progress cap
 * is the loop's, which evaluates the queue's next row when a slot is free.
 *
 * Args:
 *   ctx: Mutation context.
 *   skill: The skill as the transition left it.
 *   move: The verdict each waiting row takes, or `cancel` with the reason for a skill that
 *     ended without registering (a rejection, a Give up).
 *   scope: How far the transition reaches.
 *   from: Where an earlier batch stopped; absent for the first.
 *
 * Returns:
 *   How many rows this batch moved.
 */
export async function moveWaitingWork(
  ctx: MutationCtx,
  skill: Doc<'skills'>,
  move: WaitingMove,
  scope: WaitingScope = {},
  from?: WaitingProgress,
): Promise<number> {
  const waitsForThis = waitingPredicate(ctx, skill, scope);
  const apply = async (row: Doc<'workItems'>): Promise<boolean> => {
    if (move.kind === 'verdict') {
      await applyVerdict(ctx, row._id, move.verdict);
      return true;
    }
    if (row.state !== 'needs-skill') return false;
    // A revision shares its original's source item without being what that item waits for, so
    // its end reaches only the items linked to it.
    if (skill.revisionOf !== undefined && row.proposedSkillId !== skill._id) return false;
    const skipReason = move.reason ?? skillRejectedReason(skill.name);
    const now = Date.now();
    await ctx.db.patch(row._id, { state: 'cancelled', skipReason });
    // A Retire parks an approved item here keeping the claim its plan took: cancelled, it lets go
    // of the provider item and wakes the colleague the claim held off, as `cancelPlan` does.
    await releaseExternalClaim(ctx, row._id, now);
    // The item's terminal event, as every terminal transition writes one (A9's cycle time).
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.cancelled',
      payload: { workItemId: row._id, skillId: skill._id, reason: skipReason },
      createdAt: now,
    });
    await scheduleNextStep(ctx, { ...row, state: 'cancelled' });
    return true;
  };

  let moved = 0;
  let skipSource = from?.skipSource ?? false;
  if (from === undefined) {
    const source = await waitingSource(ctx, skill);
    if (!scope.queued && source?.state === 'discovered' && (await waitsForThis(source))) {
      skipSource = await apply(source);
      if (skipSource) moved += 1;
    }
  }

  const states = scope.queued
    ? (['needs-skill', 'discovered'] as const)
    : (['needs-skill'] as const);
  let stateIndex = from === undefined ? 0 : states.findIndex((state) => state === from.state);
  // A continuation always carries a state of its own walk; any other is not this walk's to read.
  if (stateIndex < 0) return moved;
  let after = from?.after;
  for (; stateIndex < states.length; stateIndex += 1, after = undefined) {
    const state = states[stateIndex];
    const page = await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => {
        const inState = q.eq('agentId', skill.agentId).eq('state', state);
        return after === undefined ? inState : inState.gt('_creationTime', after);
      })
      .take(WAITING_SCAN);
    for (const row of page) {
      if (moved === WAITING_BATCH) {
        await continueLater(ctx, skill, move, scope, { state, after, skipSource });
        return moved;
      }
      after = row._creationTime;
      if (skipSource && row._id === skill.proposedFor) continue;
      if ((await waitsForThis(row)) && (await apply(row))) moved += 1;
    }
    if (page.length === WAITING_SCAN) {
      await continueLater(ctx, skill, move, scope, { state, after, skipSource });
      return moved;
    }
  }
  return moved;
}

/**
 * Schedule the next batch of a walk, fenced on the state the transition wrote.
 *
 * The skill is read again because callers hold the row as it was before
 * their own write.
 */
async function continueLater(
  ctx: MutationCtx,
  skill: Doc<'skills'>,
  move: WaitingMove,
  scope: WaitingScope,
  from: WaitingProgress,
): Promise<void> {
  const current = await ctx.db.get(skill._id);
  if (!current) return;
  await ctx.scheduler.runAfter(0, internal.skills.continueWaitingWork, {
    skillId: skill._id,
    skillState: current.state,
    move,
    scope,
    from,
  });
}

/**
 * Put every work item waiting for this skill back where the boss can see what
 * it is waiting for, starting in the transaction of the skill write that
 * caused it; see `moveWaitingWork`.
 */
export async function requeueWaitingWork(
  ctx: MutationCtx,
  skill: Doc<'skills'>,
  verdict: { decision: string; reason: string },
  scope: WaitingScope = {},
): Promise<void> {
  await moveWaitingWork(ctx, skill, { kind: 'verdict', verdict }, scope);
}
