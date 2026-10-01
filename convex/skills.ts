import { v } from 'convex/values';
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, assertOwnsSkill } from './ownership';
import { applyVerdict, requeueBehindRegisteredSkill, skillRejectedReason } from './work';
import { scheduleNextStep } from './workLoop';
import { AUTHORING_LEASE_MS } from '../src/lib/skill-authoring';
import { skillApprovalRefusal } from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { browserComponentRefusal, withBrowserComponentState } from '../src/surfaces/browser';
import { grantScopeInTransaction } from './agents';
import { namedSurfacesFor, targetSurfaceFor } from '../src/work/skill-shape';
import { surfaceSlug } from '../src/surfaces/slug';
import { redactTokenShapes } from '../src/surfaces/redact';
import { appendEvent } from './eventLog';
import type { SkillAuthoringRefusedPayload } from '../src/events/contract';
import { readRefValidator, recordRegisteredVersion } from './skillVersions';
import { countsAsAuthoringAttempt } from '../src/work/skill-library';

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
 * requeue of every work item waiting for the skill all land in
 * `completeRegistration`, one transaction. Rows written by the earlier
 * three-mutation path can still be sitting in it, so it is listed alongside
 * `authoring` and accepted as a retry.
 *
 * `authoring`, `verified` and `failed` are all resumable: none has ever been
 * registered, so a new authoring run may claim them (see `claimAuthoringRun`).
 * That is the way back for a skill authored before either sandbox backend was
 * available, or one whose sandbox check failed.
 *
 * Authoring is an exclusive, fenced run, because the transitions above are made
 * by an action that spends minutes in a model and a sandbox between reading the
 * state and writing its result:
 *
 *   - exclusive: `claimAuthoringRun` decides and takes the skill in one
 *     transaction, so a second run cannot start alongside the first;
 *   - fenced: every mutation on that path carries the run's id and is refused
 *     unless the skill still carries it, so a run that lost its claim - to a
 *     takeover, or to the boss rejecting the skill underneath it - cannot write
 *     a result the current state has moved past.
 */

/**
 * Where an authoring run may start. `approved` is the boss's first go-ahead;
 * `authoring`, `verified` and `failed` are retries of a skill that never
 * registered, so re-authoring cannot pull the ground out from under an executor
 * already calling it.
 *
 * `registered` and `rejected` are absent on purpose. Both are decisions -
 * one the sandbox made, one the boss made - and a run that could reopen either
 * is the race this claim exists to close.
 */
const CLAIMABLE_STATES = ['approved', 'authoring', 'verified', 'failed'] as const;

/**
 * Where a stored body's verification may start (`skillActions.verifyStoredSkill`): the claimable
 * states, for an adoption approved and a retry of one, and `registered`, for a re-check of a
 * callable skill, which is checked again without being taken out of use.
 */
const STORED_VERIFICATION_STATES = [...CLAIMABLE_STATES, 'registered'] as const;

/**
 * Why a claim found a row in a state it may not take, in the words the run reports.
 *
 * @param state - The row's state.
 * @param claimable - The states the claim could take.
 */
function unclaimableReason(
  state: Doc<'skills'>['state'],
  claimable: readonly Doc<'skills'>['state'][],
): string {
  switch (state) {
    case 'registered':
      return 'this skill is already registered';
    case 'rejected':
      return 'this skill was rejected';
    case 'retired':
      return 'this skill was retired';
    case 'superseded':
      return 'this skill was superseded by a revision';
    case 'proposed':
    case 'approved':
    case 'authoring':
    case 'verified':
    case 'failed':
      return `skill state is ${state}; expected one of ${claimable.join(', ')}`;
  }
}

/** Where the boss may still reject. `registered` is out: a callable skill whose
 * source work has already been requeued is not a proposal any more. */
const REJECTABLE_STATES = ['proposed', 'approved', 'authoring', 'verified', 'failed'] as const;

/** The event beside `skill.failed` that says which half of an authoring run failed. */
export const authoringFailureEventValidator = v.union(
  v.literal('skill.author-failed'),
  v.literal('skill.verification-failed'),
);

type AuthoringClaim =
  | { claimed: true; runId: Id<'events'>; skill: Doc<'skills'> }
  | { claimed: false; reason: string };

/**
 * The fence. A run's write is applied only while the skill still carries that
 * run's id; anything else is a late writer whose result describes a skill that
 * has since moved on, and is refused.
 *
 * The refusal is recorded rather than silent. A discarded result is a real
 * thing that happened to a skill the boss is watching, and the alternative is a
 * run that reports failure with nothing in the feed to say why.
 */
async function claimHolder(
  ctx: MutationCtx,
  skillId: Id<'skills'>,
  runId: Id<'events'>,
  attempted: SkillAuthoringRefusedPayload['attempted'],
): Promise<Doc<'skills'> | null> {
  const row = await ctx.db.get(skillId);
  if (!row) return null;
  if (row.authoringRunId === runId) return row;
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'skill.authoring-refused',
    payload: { skillId, name: row.name, attempted, state: row.state },
    createdAt: Date.now(),
  });
  return null;
}

/** Everything a run releases when it stops holding the skill. */
const RELEASED = { authoringRunId: undefined, authoringClaimedAt: undefined } as const;

/** How long a deferred authoring waits before it is tried again. */
export const AUTHORING_DEFERRAL_MS = 5 * 60 * 1000;

/**
 * How many authoring runs in a row may be deferred for the model provider
 * before the skill fails for the manager's Retry: a provider outage longer
 * than a quarter of an hour is the manager's to see.
 */
export const MAX_AUTHORING_DEFERRALS = 3;

/**
 * Which of the employee's rows a skill's transition reaches.
 *
 * `queued` also takes the rows registration already sent back to `discovered`;
 * `sameName` also takes rows parked behind another proposal of this name, or
 * behind none yet. The row the skill was proposed for is always read in both
 * states, as it was when it was the only row this looked at.
 */
interface WaitingScope {
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
async function waitingRows(
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

const waitingState = v.union(v.literal('discovered'), v.literal('needs-skill'));

/** What a skill's transition does to each row waiting for it. */
const waitingMove = v.union(
  v.object({
    kind: v.literal('verdict'),
    verdict: v.object({ decision: v.string(), reason: v.string() }),
  }),
  v.object({ kind: v.literal('cancel') }),
);
type WaitingMove = typeof waitingMove.type;

const waitingScope = v.object({
  queued: v.optional(v.boolean()),
  sameName: v.optional(v.boolean()),
});

/** Where a batched walk stopped: the state being read and the last row read in it. */
const waitingProgress = v.object({
  state: waitingState,
  after: v.optional(v.number()),
  /** The source row was moved first, from `discovered`, and is not moved again. */
  skipSource: v.boolean(),
});
type WaitingProgress = typeof waitingProgress.type;

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
 *   move: The verdict each waiting row takes, or `cancel` for a rejection.
 *   scope: How far the transition reaches.
 *   from: Where an earlier batch stopped; absent for the first.
 *
 * Returns:
 *   How many rows this batch moved.
 */
async function moveWaitingWork(
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
    const skipReason = skillRejectedReason(skill.name);
    await ctx.db.patch(row._id, { state: 'cancelled', skipReason });
    // The item's terminal event, as every terminal transition writes one (A9's cycle time).
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.cancelled',
      payload: { workItemId: row._id, skillId: skill._id, reason: skipReason },
      createdAt: Date.now(),
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
 * The next batch of a walk over the rows waiting for a skill.
 *
 * Internal; scheduled by `moveWaitingWork` only. Does nothing once the skill
 * has left the state the walk began in.
 */
export const continueWaitingWork = internalMutation({
  args: {
    skillId: v.id('skills'),
    skillState: v.string(),
    move: waitingMove,
    scope: waitingScope,
    from: waitingProgress,
  },
  handler: async (ctx, args): Promise<{ moved: number }> => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill || skill.state !== args.skillState) return { moved: 0 };
    return { moved: await moveWaitingWork(ctx, skill, args.move, args.scope, args.from) };
  },
});

/**
 * Put every work item waiting for this skill back where the boss can see what
 * it is waiting for, starting in the transaction of the skill write that
 * caused it; see `moveWaitingWork`.
 */
async function requeueWaitingWork(
  ctx: MutationCtx,
  skill: Doc<'skills'>,
  verdict: { decision: string; reason: string },
  scope: WaitingScope = {},
): Promise<void> {
  await moveWaitingWork(ctx, skill, { kind: 'verdict', verdict }, scope);
}

/**
 * The target surface named by the work, falling back to its intake source.
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: The agent.
 *   workItemId: The work item the skill is proposed for.
 *
 * Returns:
 *   The source plus the literal target slug in real mode.
 */
async function surfaceForWork(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  workItemId: Id<'workItems'>,
): Promise<{ sourceSystem: string; targetSurface?: string }> {
  const item = await ctx.db.get(workItemId);
  if (!item) throw new Error('work item for skill proposal not found');
  if (item.agentId !== agentId) {
    throw new Error('skill and work item belong to different agents');
  }
  if (SURFACE_MODE !== 'real') return { sourceSystem: item.sourceSystem };
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .collect();
  // The same rule the evaluator shaped the proposal by, so the surface whose
  // class named the skill is the surface the scopes and the approval gate
  // are about.
  const sourceSlug = surfaceSlug(item.sourceSystem);
  const namedSlugs = [
    ...new Set(
      namedSurfacesFor(item, surfaces)
        .map((surface: Doc<'surfaces'>): string => surface.slug)
        .filter((slug: string): boolean => slug !== sourceSlug),
    ),
  ];
  if (namedSlugs.length > 1) {
    throw new Error(`work evidence names more than one target surface: ${namedSlugs.join(', ')}`);
  }
  const targetSurface = targetSurfaceFor(item, surfaces)?.slug ?? item.sourceSystem;
  if (
    surfaces.filter((surface: Doc<'surfaces'>): boolean => surface.slug === targetSurface).length >
    1
  ) {
    throw new Error(`more than one surface is listed with slug ${targetSurface}`);
  }
  return { sourceSystem: item.sourceSystem, targetSurface };
}

/** Public, owner-guarded: an employee's registered skills. */
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

/** Internal: an employee's registered skills, for a scheduled step with no caller. */
export const registeredInternal = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> =>
    await ctx.db
      .query('skills')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'registered'))
      .collect(),
});

/**
 * Authored but not callable: the sandbox could not run, so the body exists and
 * nothing has attested that it works. A skill an authoring run is holding right
 * now is here too, which is what keeps a run that dies mid-flight from taking
 * the skill out of every panel with it. Deliberately not part of `registered`,
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

/** Public, owner-guarded: an employee's proposed skills awaiting the manager. */
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

/** Public, owner-guarded: one skill. */
export const get = query({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    return await assertOwnsSkill(ctx, args.skillId);
  },
});

/** Public, owner-guarded: an employee's skill by name. */
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

/** Internal: registers a built-in skill for an employee at deployment. */
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
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'skill.builtin-installed',
      payload: { skillId: id, name: args.name },
      createdAt: Date.now(),
    });
    return id;
  },
});

/** Internal: proposes a skill for the manager, from the work that needed it. */
export const propose = internalMutation({
  args: {
    agentId: v.id('agents'),
    workItemId: v.id('workItems'),
    name: v.string(),
    description: v.string(),
    rationale: v.string(),
    requiredScopes: v.array(v.string()),
    surfaceClass: v.optional(v.string()),
    operation: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<'skills'>> => {
    const target = await surfaceForWork(ctx, args.agentId, args.workItemId);
    const targetSurface = target.targetSurface;
    const requestedScopes =
      targetSurface && targetSurface !== target.sourceSystem
        ? args.requiredScopes.filter(
            (scope: string): boolean => scope !== `${target.sourceSystem}:write`,
          )
        : args.requiredScopes;
    const proposedScopes = targetSurface
      ? [...new Set([...requestedScopes, `${targetSurface}:read`, `${targetSurface}:write`])]
      : requestedScopes;
    // The live row of this name, wherever it sits among rejected and failed
    // ones: reading the oldest row alone meant that once a failed proposal
    // existed, every later item inserted a fresh duplicate beside the live one.
    const existing = (
      await ctx.db
        .query('skills')
        .withIndex('by_agent_name', (q) => q.eq('agentId', args.agentId).eq('name', args.name))
        .collect()
    ).find((row: Doc<'skills'>): boolean => row.state !== 'rejected' && row.state !== 'failed');
    if (existing) {
      if (existing.state === 'registered') {
        // The late verdict's one way back: the verdict write parked it and
        // stood down, so the row is re-queued here, once per registration.
        await requeueBehindRegisteredSkill(ctx, existing, args.workItemId);
      }
      if (existing.state === 'proposed') {
        if (
          existing.targetSurface &&
          targetSurface &&
          existing.targetSurface !== targetSurface &&
          existing.proposedFor !== args.workItemId
        ) {
          throw new Error(
            `skill ${args.name} is already proposed for surface ${existing.targetSurface}`,
          );
        }
        const targetChanged =
          existing.targetSurface !== undefined && existing.targetSurface !== targetSurface;
        await ctx.db.patch(existing._id, {
          targetSurface: existing.targetSurface ?? targetSurface,
          ...(targetChanged ? { targetSurface } : {}),
          requiredScopes: targetChanged
            ? proposedScopes
            : [...new Set([...(existing.requiredScopes ?? []), ...proposedScopes])],
          surfaceClass: existing.surfaceClass ?? args.surfaceClass,
          operation: existing.operation ?? args.operation,
        });
      }
      return existing._id;
    }
    // A skill proposed for work that came in from a discovered surface acts on
    // that surface: it is named on the row so approval can insist the surface
    // is connected, and its scopes are the surface's read and write pair.
    const id = await ctx.db.insert('skills', {
      agentId: args.agentId,
      name: args.name,
      description: args.description,
      body: '',
      sourceType: 'agent-authored',
      state: 'proposed',
      proposedFor: args.workItemId,
      rationale: args.rationale,
      requiredScopes: proposedScopes,
      targetSurface,
      surfaceClass: args.surfaceClass,
      operation: args.operation,
      createdAt: Date.now(),
    });
    await appendEvent(ctx, {
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

/**
 * Public, owner-guarded: approves a proposed skill whose target surface is
 * connected, grants its required scopes and records the approval. Nothing is
 * scheduled here; the dashboard starts the authoring once this returns.
 */
export const approve = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    if (row.state !== 'proposed') {
      throw new Error(`cannot approve "${row.name}": it is ${row.state}, not proposed`);
    }
    // A skill may only target a connected surface. The sandbox stays offline,
    // so approval is the first point at which the target is checked, and the
    // refusal reads the same on the button and in the thrown error.
    if (row.targetSurface) {
      const surface = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) =>
          q.eq('agentId', row.agentId).eq('slug', row.targetSurface!),
        )
        .unique();
      const refusal = skillApprovalRefusal(
        row.targetSurface,
        surface
          ? toSurfaceRecord(
              withBrowserComponentState(
                surface,
                browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL),
              ),
            )
          : undefined,
        Date.now(),
      );
      if (refusal) throw new Error(`cannot approve "${row.name}": ${refusal}`);
    }
    await ctx.db.patch(args.skillId, { state: 'approved' });
    for (const scope of row.requiredScopes ?? []) {
      await grantScopeInTransaction(ctx, row.agentId, scope, 'skill');
    }
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.approved',
      payload: { skillId: args.skillId, name: row.name, scopes: row.requiredScopes ?? [] },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * The boss's refusal, and the end of the line for this skill.
 *
 * Rejecting releases any authoring run holding the skill, which is what makes
 * the refusal final: the released run is fenced out of its own result, so a
 * sandbox that finishes after this cannot register the skill the boss just
 * turned down and leave its source work cancelled underneath it.
 */
export const reject = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    if (row.state === 'rejected') return { ok: true };
    if (!REJECTABLE_STATES.includes(row.state as (typeof REJECTABLE_STATES)[number])) {
      throw new Error(
        `skill state is ${row.state}; expected one of ${REJECTABLE_STATES.join(', ')}`,
      );
    }
    await ctx.db.patch(args.skillId, { state: 'rejected', ...RELEASED });
    // Every row still waiting for this proposal leaves `needs-skill` with the
    // reason on its card, a batch at a time. A row that has moved on, or is
    // now linked to a different proposal, is not this rejection's to cancel.
    await moveWaitingWork(ctx, row, { kind: 'cancel' });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.rejected',
      payload: { skillId: args.skillId, name: row.name },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Where a skill's source work may be for the skill to be revised: waiting, so
 * nothing can reach an approved plan and the executor's pick while the skill
 * is unregistered. A claimed or plan-pending row would be approved (by the
 * manager, or by the sweep under autonomy) and failed by the executor for
 * want of a registered skill, since neither approval nor the pick waits for
 * one under revision.
 */
const REVISABLE_SOURCE_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set([
  'discovered',
  'needs-skill',
  'deferred',
]);

/**
 * Send an agent-authored skill back through authoring before its first use.
 * Public; the caller must own the skill. Clears the body, re-queues the rows
 * waiting for the skill and writes `skill.revision-requested`.
 *
 * Registration makes a skill callable, so revision is deliberately narrower
 * than rejection: the manager may reopen only the proposal's own skill while
 * no execution has ever claimed it and its source work is still waiting
 * (`REVISABLE_SOURCE_STATES`). Once a work row names the skill under
 * `skillId`, its body is part of a durable run and this transition is
 * permanently closed.
 */
export const requestRevision = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    if (row.sourceType !== 'agent-authored' || row.state !== 'registered') {
      throw new Error('only a registered agent-authored skill can be revised');
    }
    const executed = await ctx.db
      .query('workItems')
      .withIndex('by_skill', (q) => q.eq('skillId', args.skillId))
      .first();
    if (executed) {
      throw new Error('cannot revise a skill after an execution has claimed it');
    }
    if (!row.proposedFor) {
      throw new Error('cannot revise an authored skill without its source work');
    }
    const sourceWork = await ctx.db.get(row.proposedFor);
    if (
      !sourceWork ||
      sourceWork.agentId !== row.agentId ||
      !REVISABLE_SOURCE_STATES.has(sourceWork.state)
    ) {
      throw new Error('cannot revise while the source work has moved on');
    }

    await ctx.db.patch(args.skillId, {
      state: 'approved',
      body: '',
      sandboxId: undefined,
      verificationLog: undefined,
      refusedBody: undefined,
      refusedSmokeTest: undefined,
      pendingSmokeTest: undefined,
      registeredAt: undefined,
      ...RELEASED,
    });
    await requeueWaitingWork(
      ctx,
      row,
      {
        decision: 'needs-skill',
        reason: 'registered skill sent back for revision before first execution',
      },
      { queued: true },
    );
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.revision-requested',
      payload: { skillId: args.skillId, name: row.name },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * One-off: re-queue the rows an earlier registration left at `needs-skill`.
 *
 * Until registration reached every waiting row, a deployment could register a
 * skill and leave every item but the first parked behind it. Nothing re-reads
 * such a row: the registration that should have moved it has already happened.
 * This applies, for every registered skill, the re-queue its registration
 * would apply today.
 *
 *   npx convex run skills:requeueStranded
 *
 * Safe to run twice: a re-queued row is no longer at `needs-skill`.
 */
export const requeueStranded = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ requeued: number }> => {
    let requeued = 0;
    for (const agent of await ctx.db.query('agents').collect()) {
      const registeredSkills = await ctx.db
        .query('skills')
        .withIndex('by_agent_state', (q) => q.eq('agentId', agent._id).eq('state', 'registered'))
        .collect();
      for (const skill of registeredSkills) {
        for (const row of await waitingRows(ctx, skill, { sameName: true })) {
          if (row.state !== 'needs-skill') continue;
          await applyVerdict(ctx, row._id, {
            decision: 'pending-reevaluation',
            reason: 'skill registered, ready to retry',
          });
          requeued += 1;
        }
      }
    }
    return { requeued };
  },
});

/**
 * Retire a registered skill that predates shapes.
 *
 * A skill proposed before shapes existed carries no `surfaceClass` and was
 * named after the work item that first needed it (`linear-action-revops-7`),
 * with that item's values in its body. The matcher still serves such a row
 * through the name-token path while no shaped skill covers the shape, so it
 * keeps working; it also keeps the reusable procedure from being proposed for
 * that shape. Retiring it is the operator's decision, made once per row:
 *
 *   npx convex run skills:retireUnshaped '{"skillId":"<id>"}'
 *
 * Nothing is deleted. The row moves to `rejected`, which no panel lists and
 * the executor never picks from, its history stays readable under every run
 * that named it, and the next work item of its shape proposes the shaped
 * skill. A shaped row and a builtin row are refused: the first is the
 * reusable procedure for its shape, the second is installed, not authored.
 */
export const retireUnshaped = internalMutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ retired: boolean; reason?: string }> => {
    const row = await ctx.db.get(args.skillId);
    if (!row) throw new Error('skill not found');
    if (row.state === 'rejected') return { retired: false, reason: 'already retired' };
    if (row.state !== 'registered') {
      throw new Error(`skill state is ${row.state}; only a registered skill is retired`);
    }
    if (row.sourceType !== 'agent-authored') {
      throw new Error('a builtin skill is installed, not authored, and is not retired');
    }
    if (row.surfaceClass !== undefined && row.operation !== undefined) {
      throw new Error(
        `skill ${row.name} is the reusable procedure for ${row.surfaceClass}/${row.operation}, not a legacy row`,
      );
    }
    await ctx.db.patch(args.skillId, { state: 'rejected', ...RELEASED });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.retired',
      payload: {
        skillId: args.skillId,
        name: row.name,
        reason:
          'proposed before skills were shaped; the next work item of its shape proposes the reusable procedure',
      },
      createdAt: Date.now(),
    });
    return { retired: true };
  },
});

/**
 * Take exclusive ownership of a skill for one authoring run, or report that
 * somebody else has it.
 *
 * This is the whole of the concurrency control for authoring, and it is the
 * same shape as `work.claimForExecution`: a mutation is a transaction, so the
 * state check and the move to `authoring` cannot be split by a second caller,
 * where an action that reads the state and writes it back as two calls can be -
 * and both callers then author, verify and write a result for the same skill.
 *
 * The winner gets a `runId`: the id of the claim event, durable, unique per
 * claim and derived from nothing the caller supplies. Every later write on this
 * path presents it and is refused once it is no longer the id on the row.
 *
 * A claim that has outlived the lease is taken over rather than honoured. The
 * skill stays listed and retryable throughout, so a run that dies mid-flight
 * costs a lease rather than the skill.
 *
 * An authoring claim that writes a body counts an attempt
 * (`authoringAttempts`, "Attempt n of 3"); one that carries on an attempt
 * already counted does not (`countsAsAuthoringAttempt`). A stored
 * verification (`purpose: 'verify-stored'`, `skillActions.verifyStoredSkill`)
 * writes no body and counts nothing; it may also take a registered row, for a
 * re-check, which stays registered and keeps running its verified body while
 * the check runs.
 */
export const claimAuthoringRun = internalMutation({
  args: {
    skillId: v.id('skills'),
    /** Authoring (the default) or a stored body's verification. */
    purpose: v.optional(v.union(v.literal('author'), v.literal('verify-stored'))),
  },
  handler: async (ctx, args): Promise<AuthoringClaim> => {
    const row = await ctx.db.get(args.skillId);
    if (!row) throw new Error('skill not found');
    const verifying = args.purpose === 'verify-stored';
    const claimable: readonly Doc<'skills'>['state'][] = verifying
      ? STORED_VERIFICATION_STATES
      : CLAIMABLE_STATES;
    if (!claimable.includes(row.state)) {
      return { claimed: false, reason: unclaimableReason(row.state, claimable) };
    }
    if (row.authoringRunId) {
      const heldFor = Date.now() - (row.authoringClaimedAt ?? 0);
      if (heldFor < AUTHORING_LEASE_MS) {
        return {
          claimed: false,
          reason: `another authoring run has held this skill for ${Math.round(heldFor / 1000)}s; it can be taken over after ${Math.round(AUTHORING_LEASE_MS / 60000)} minutes`,
        };
      }
      await appendEvent(ctx, {
        agentId: row.agentId,
        type: 'skill.authoring-superseded',
        payload: { skillId: args.skillId, name: row.name, heldForMs: heldFor },
        createdAt: Date.now(),
      });
    }
    const runId = await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.authoring-claimed',
      payload: { skillId: args.skillId, name: row.name, fromState: row.state },
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.skillId, {
      state: verifying && row.state === 'registered' ? 'registered' : 'authoring',
      authoringRunId: runId,
      authoringClaimedAt: Date.now(),
      ...(!verifying && countsAsAuthoringAttempt(row)
        ? { authoringAttempts: (row.authoringAttempts ?? 0) + 1 }
        : {}),
    });
    return { claimed: true, runId, skill: row };
  },
});

/**
 * Store the authored body as soon as a sandbox exists, so the boss can read
 * what was written whichever way the check goes. The run keeps its claim: this
 * is progress, not a result.
 *
 * Every authoring write below applies the structural floor to the text it
 * keeps, as `parkUnverified` does: the body, the log and the reasons are model
 * output and sandbox output, and a provider token in any of them has no
 * business on a row, an event or a work item whatever the action did first.
 */
export const recordAuthoringProgress = internalMutation({
  args: {
    skillId: v.id('skills'),
    runId: v.id('events'),
    sandboxId: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args): Promise<{ held: boolean }> => {
    const row = await claimHolder(ctx, args.skillId, args.runId, 'authoring-progress');
    if (!row) return { held: false };
    await ctx.db.patch(args.skillId, {
      sandboxId: args.sandboxId,
      body: redactTokenShapes(args.body),
      refusedBody: undefined,
      refusedSmokeTest: undefined,
    });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.authoring',
      payload: { skillId: args.skillId, sandboxId: args.sandboxId },
      createdAt: Date.now(),
    });
    return { held: true };
  },
});

/**
 * Take the row a registering revision replaces out of use: the employee's own registered row
 * named by `revisionOf` becomes `superseded` in the revision's transaction, and stops being
 * picked once the revision is callable.
 *
 * @returns The superseded row, or undefined when the row is no revision or its original has
 *   already left `registered`.
 */
async function supersedeReplacedRow(
  ctx: MutationCtx,
  row: Doc<'skills'>,
): Promise<Id<'skills'> | undefined> {
  if (row.revisionOf === undefined) return undefined;
  const replaced = await ctx.db.get(row.revisionOf);
  if (replaced?.agentId !== row.agentId || replaced.state !== 'registered') return undefined;
  await ctx.db.patch(replaced._id, { state: 'superseded' });
  return replaced._id;
}

/**
 * Everything that has to be true at once for a skill to count as registered:
 * the verified body is stored, the row becomes callable, the owner's library
 * records it, and every work item waiting for the skill goes back into the
 * queue.
 *
 * These used to be three mutations. A failure between the first and the second
 * left a `verified` row that no panel listed and no retry accepted; a failure
 * before the third left a callable skill whose work item stayed terminal at
 * `needs-skill`, which nothing auto-progresses. One transaction has no gap to
 * fail in: either the skill is callable and its work item is queued, or
 * neither happened and the row is still where the retry can pick it up.
 *
 * The run releases its claim here, which is what lets the next run - a retry
 * after a later problem - start at all.
 *
 * The library (K1): the passing smoke test is kept on the version, not thrown
 * away, so the body can be verified again; the row is linked to the version it
 * was verified as or to the next version of its name
 * (`skillVersions.recordRegisteredVersion`), with the pages the authoring read.
 * A pass is a passing re-check, so it clears "Re-check due". A revision that
 * registers supersedes the row it replaces in this same transaction, so one of
 * the two is callable at every moment. The smoke test is optional only for a
 * run that began before this release; such a version is kept without its check
 * and is not offerable until a re-check keeps one.
 */
export const completeRegistration = internalMutation({
  args: {
    skillId: v.id('skills'),
    runId: v.id('events'),
    body: v.string(),
    verificationLog: v.string(),
    /** The smoke test that passed, as the sandbox ran it before the harness wrapped it. */
    smokeTest: v.optional(v.string()),
    /** The tools SKILL.md names that the harness's surfaces allowed. */
    harnessTools: v.optional(v.array(v.string())),
    /** The pages the authoring run read (`linkedRunbookPages`). */
    readRefs: v.optional(v.array(readRefValidator)),
  },
  handler: async (ctx, args): Promise<{ registered: boolean }> => {
    const row = await claimHolder(ctx, args.skillId, args.runId, 'register');
    if (!row) return { registered: false };
    const now = Date.now();
    const body = redactTokenShapes(args.body);
    const library = await recordRegisteredVersion(ctx, row, {
      body,
      smokeTest: args.smokeTest === undefined ? undefined : redactTokenShapes(args.smokeTest),
      harnessTools: args.harnessTools ?? [],
      readRefs: args.readRefs ?? [],
      now,
      stampsOlderHolders: true,
    });
    const held = library.kind === 'outside' ? undefined : library;
    await ctx.db.patch(args.skillId, {
      state: 'registered',
      body,
      verificationLog: redactTokenShapes(args.verificationLog),
      refusedBody: undefined,
      refusedSmokeTest: undefined,
      pendingSmokeTest: undefined,
      registeredAt: row.registeredAt ?? now,
      authoringDeferrals: undefined,
      versionId: held?.versionId,
      adoptedAt: held?.adopted ? (row.adoptedAt ?? now) : undefined,
      recheckDueAt: undefined,
      recheckReason: undefined,
      ...RELEASED,
    });
    const replaced = await supersedeReplacedRow(ctx, row);
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.registered',
      payload: {
        skillId: args.skillId,
        name: row.name,
        ...(held !== undefined ? { version: held.version, versionId: held.versionId } : {}),
        ...(held?.adopted ? { adopted: true as const } : {}),
        ...(replaced !== undefined && held?.superseded !== undefined
          ? { supersedes: { skillId: replaced, version: held.superseded.version } }
          : {}),
      },
      createdAt: now,
    });
    await requeueWaitingWork(
      ctx,
      row,
      { decision: 'pending-reevaluation', reason: 'skill registered, ready to retry' },
      { sameName: true },
    );
    return { registered: true };
  },
});

/**
 * The run failed, and the skill is parked where the boss can see why: `failed`
 * is listed with a Retry, the feed carries the reason, and the work item that
 * asked for the skill says what it is still waiting for.
 *
 * A refusal before the sandbox keeps the draft it turned away, already
 * redacted and bounded by the action, so the row carries something to read
 * and the retry something to correct; in real mode a sandbox that said no
 * keeps its draft the same way, so a failed first attempt can be read and
 * exported afterwards. A failure with no draft to keep clears whatever an
 * earlier refusal left: the row describes its latest attempt only. The draft
 * never goes in `pendingSmokeTest`: that field means "not yet run", and a
 * Retry that found it would run a program already known to fail.
 *
 * One transaction for the same reason as registration. A failing run that could
 * write the skill and the work item separately is a failing run that can put
 * the work item back at `needs-skill` after somebody else has already moved it
 * on.
 */
export const failAuthoringRun = internalMutation({
  args: {
    skillId: v.id('skills'),
    runId: v.id('events'),
    /** Kept on the row, so it is what the skills panel shows. */
    rowReason: v.string(),
    /** The shorter form for the event feed and the work item. */
    reason: v.string(),
    eventType: authoringFailureEventValidator,
    refusedBody: v.optional(v.string()),
    refusedSmokeTest: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ recorded: boolean }> => {
    const row = await claimHolder(ctx, args.skillId, args.runId, 'fail');
    if (!row) return { recorded: false };
    const reason = redactTokenShapes(args.reason);
    await ctx.db.patch(args.skillId, {
      state: 'failed',
      verificationLog: redactTokenShapes(args.rowReason),
      refusedBody: args.refusedBody === undefined ? undefined : redactTokenShapes(args.refusedBody),
      refusedSmokeTest:
        args.refusedSmokeTest === undefined ? undefined : redactTokenShapes(args.refusedSmokeTest),
      pendingSmokeTest: undefined,
      authoringDeferrals: undefined,
      ...RELEASED,
    });
    for (const type of ['skill.failed', args.eventType] as const) {
      await appendEvent(ctx, {
        agentId: row.agentId,
        type,
        payload: { skillId: args.skillId, name: row.name, reason },
        createdAt: Date.now(),
      });
    }
    await requeueWaitingWork(ctx, row, { decision: 'needs-skill', reason });
    return { recorded: true };
  },
});

/**
 * Defer an authoring run the model provider could not answer (U9 step 20): an
 * outage, a rate limit, a timeout. Internal; the authoring action calls it
 * with the run's own id. The skill stays at `authoring` - listed, uncallable,
 * retryable - with the claim released and the reason on the row, and the run
 * is tried again after `AUTHORING_DEFERRAL_MS`. After
 * `MAX_AUTHORING_DEFERRALS` in a row it fails for the manager's Retry, as
 * any authoring failure does.
 *
 * @returns Whether the run was deferred (false once it failed, or when the
 *   run no longer holds the skill), and the reason the caller reports.
 */
export const deferAuthoringRun = internalMutation({
  args: { skillId: v.id('skills'), runId: v.id('events'), reason: v.string() },
  handler: async (ctx, args): Promise<{ deferred: boolean; reason: string }> => {
    const row = await claimHolder(ctx, args.skillId, args.runId, 'defer');
    if (!row) return { deferred: false, reason: 'another authoring run holds this skill' };
    const reason = redactTokenShapes(args.reason);
    const attempt = (row.authoringDeferrals ?? 0) + 1;
    if (attempt > MAX_AUTHORING_DEFERRALS) {
      const failed = `the model provider could not be reached through ${MAX_AUTHORING_DEFERRALS + 1} tries: ${reason}`;
      await ctx.db.patch(args.skillId, {
        state: 'failed',
        verificationLog: failed,
        pendingSmokeTest: undefined,
        authoringDeferrals: undefined,
        ...RELEASED,
      });
      for (const type of ['skill.failed', 'skill.author-failed'] as const) {
        await appendEvent(ctx, {
          agentId: row.agentId,
          type,
          payload: { skillId: args.skillId, name: row.name, reason: failed },
          createdAt: Date.now(),
        });
      }
      await requeueWaitingWork(ctx, row, { decision: 'needs-skill', reason: failed });
      return { deferred: false, reason: failed };
    }
    const minutes = Math.round(AUTHORING_DEFERRAL_MS / 60_000);
    const deferred = `${reason}. The model provider could not be reached, so authoring is tried again in ${minutes} minutes (${attempt} of ${MAX_AUTHORING_DEFERRALS}).`;
    await ctx.db.patch(args.skillId, {
      state: 'authoring',
      verificationLog: deferred,
      authoringDeferrals: attempt,
      ...RELEASED,
    });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.authoring-deferred',
      payload: {
        skillId: args.skillId,
        name: row.name,
        reason,
        retryInMs: AUTHORING_DEFERRAL_MS,
        attempt,
      },
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      AUTHORING_DEFERRAL_MS,
      internal.skillActions.authorAndRegisterSkillInternal,
      { skillId: args.skillId },
    );
    return { deferred: true, reason: deferred };
  },
});

/**
 * No sandbox ran, so the body is all there is to keep. The skill stops at
 * `authoring` - listed, uncallable, retryable - because registering is what
 * claims the body was checked, and nothing checked it.
 *
 * The claim is released: this run is over, and the retry that follows a sandbox
 * appearing - a DAYTONA_API_KEY, or `pnpm sandbox:up` - must be able to start.
 */
export const parkUnverified = internalMutation({
  args: {
    skillId: v.id('skills'),
    runId: v.id('events'),
    sandboxId: v.string(),
    body: v.string(),
    smokeTest: v.string(),
    verificationLog: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<{ recorded: boolean }> => {
    const row = await claimHolder(ctx, args.skillId, args.runId, 'park-unverified');
    if (!row) return { recorded: false };
    const reason = redactTokenShapes(args.reason);
    await ctx.db.patch(args.skillId, {
      state: 'authoring',
      body: redactTokenShapes(args.body),
      pendingSmokeTest: redactTokenShapes(args.smokeTest),
      sandboxId: args.sandboxId,
      verificationLog: redactTokenShapes(args.verificationLog),
      refusedBody: undefined,
      refusedSmokeTest: undefined,
      authoringDeferrals: undefined,
      ...RELEASED,
    });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.sandbox-skipped',
      payload: { skillId: args.skillId, name: row.name, reason },
      createdAt: Date.now(),
    });
    await requeueWaitingWork(ctx, row, {
      decision: 'needs-skill',
      reason: `skill authored but not verified - ${reason}`,
    });
    return { recorded: true };
  },
});
