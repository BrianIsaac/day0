import { ConvexError, v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, assertOwnsSkill } from './ownership';
import { appendEvent } from './eventLog';
import { holdersOf } from './skillVersions';
import { scheduleNextStep } from './workLoop';
import type { SkillRevokedHolder } from '../src/events/contract';
import { holdsLiveAuthoringClaim } from '../src/lib/skill-authoring';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { sameSkillShape, skillShapeFor, type ShapeSurface } from '../src/work/skill-shape';
import type { SkillShape } from '../src/work/types';
import {
  controlReasonOf,
  givenUpReason,
  RETIRED_BY_MANAGER,
  takenOutItemReason,
  WITHDRAWN_BY_MANAGER,
  type TakenOut,
} from '../src/work/skill-controls';

/*
 * The manager's controls on a skill (the enhancements plan, section 4.1, "the five controls";
 * wave 10's 10-C): Retire one employee's copy, Withdraw a version from every employee who holds
 * it (A12), Re-check now, Give up on a failed draft, and Ask for a revision, which writes a new
 * version while the current one keeps running. "Used N times" is counted by the execution claim
 * and "Attempt n of 3" by the authoring claim (10-K); the re-check triggers stamp through
 * `skillVersions.stampRecheckDue` from the writes that cause them (A13: never on a timer).
 *
 * Every public function is guarded by `assertOwnsSkill` or `assertOwnsAgent` and refuses with a
 * `ConvexError` the card reads. Every transition out of `registered` releases the authoring claim,
 * so a re-check in flight is fenced out of the row it no longer holds.
 */

/** Everything a run releases when the row it held leaves its state under it. */
const RELEASED_CLAIM = { authoringRunId: undefined, authoringClaimedAt: undefined } as const;

/**
 * Approved items of one employee a Retire reads for the ones its skill would have run. An
 * employee's approved items are bounded by its work-in-progress cap, far below this.
 */
const APPROVED_SCAN = 200;

/** Parked items one batch of a Give up's cancellation reads before it continues by schedule. */
const CANCEL_SCAN = 200;

/** The states in which a row of a name may still become callable: the row an item waits behind. */
const LIVE_STATES: ReadonlySet<Doc<'skills'>['state']> = new Set([
  'proposed',
  'approved',
  'authoring',
  'verified',
  'failed',
]);

/** The states of a revision still being written: approved for it, being written, or failed. */
const OPEN_REVISION_STATES: ReadonlySet<Doc<'skills'>['state']> = new Set([
  'approved',
  'authoring',
  'verified',
  'failed',
]);

/**
 * A reason a control keeps, refused with the card's words when it is too long.
 *
 * @param reason - What the manager typed, if anything.
 * @param fallback - The control's own words for an empty reason.
 */
function controlReason(
  reason: string | undefined,
  fallback: typeof RETIRED_BY_MANAGER | typeof WITHDRAWN_BY_MANAGER,
): string {
  try {
    return controlReasonOf(reason, fallback);
  } catch (err) {
    throw new ConvexError(err instanceof Error ? err.message : 'The reason was refused.');
  }
}

/**
 * Refuse a row Retire, Re-check now or Ask for a revision cannot act on: only a callable skill an
 * employee wrote. A built-in skill is installed with the employee and has no versions.
 *
 * @param row - The skill row.
 * @param control - Which control asks, for the refusal's words.
 */
function assertCallableAuthored(
  row: Doc<'skills'>,
  control: 'retired' | 're-checked' | 'revised',
): void {
  if (row.sourceType !== 'agent-authored') {
    throw new ConvexError(
      control === 'retired'
        ? 'A built-in skill comes with the employee and is not retired.'
        : 'Only a callable skill an employee wrote is revised.',
    );
  }
  if (row.state !== 'registered') {
    throw new ConvexError(
      control === 'revised'
        ? 'Only a callable skill an employee wrote is revised.'
        : `Only a callable skill is ${control}; ${row.name} is ${row.state}.`,
    );
  }
}

/**
 * The newest row of a name that may still become callable for the employee: the row an item
 * whose skill is not callable waits behind, so that row's registration re-queues it and its
 * rejection or Give up cancels it.
 */
async function liveSkillNamed(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  name: string,
): Promise<Doc<'skills'> | undefined> {
  const rows = await ctx.db
    .query('skills')
    .withIndex('by_agent_name', (q) => q.eq('agentId', agentId).eq('name', name))
    .order('desc')
    .collect();
  return rows.find((row) => LIVE_STATES.has(row.state));
}

/** What an item parked for a skill waits on, and why. */
interface SkillWait {
  readonly name: string;
  readonly reason: string;
  readonly rationale: string;
  readonly shape?: SkillShape;
  readonly now: number;
}

/**
 * Park one approved item at `needs-skill` behind the skill it needs, in the shape the evaluator's
 * `needs-skill` verdict takes, so the skill's registration re-queues it as it re-queues every
 * item waiting for that name (`skills.completeRegistration`, its same-name reach). The approved
 * plan goes with it: it was approved to run a body the employee no longer runs, and the next
 * plan is drafted and approved afresh once a skill is callable. The item's slot is freed for the
 * queue.
 *
 * @param ctx - The control's or the executor's mutation context.
 * @param item - The approved item.
 * @param wait - The skill it waits for and why.
 * @returns The row it waits behind, when one of the name may still become callable.
 */
async function parkForSkill(
  ctx: MutationCtx,
  item: Doc<'workItems'>,
  wait: SkillWait,
): Promise<Id<'skills'> | undefined> {
  const behind = await liveSkillNamed(ctx, item.agentId, wait.name);
  await ctx.db.patch(item._id, {
    state: 'needs-skill',
    verdict: {
      decision: 'needs-skill',
      reason: wait.reason,
      suggestedSkillName: wait.name,
      suggestedSkillRationale: wait.rationale,
      ...(wait.shape !== undefined ? { suggestedSkillShape: wait.shape } : {}),
    },
    proposedSkillId: behind?._id,
    plan: undefined,
    planPendingAt: undefined,
    decision: undefined,
    managerAnswers: undefined,
    draftClaimedAt: undefined,
  });
  await appendEvent(ctx, {
    agentId: item.agentId,
    type: 'work.waiting-for-skill',
    payload: {
      workItemId: item._id,
      ...(behind !== undefined ? { skillId: behind._id } : {}),
      name: wait.name,
      reason: wait.reason,
      previousState: item.state,
    },
    createdAt: wait.now,
  });
  await scheduleNextStep(ctx, { ...item, state: 'needs-skill' });
  return behind?._id;
}

/**
 * Whether an approved item would have run this skill: it names the row (a run's `skillId`, its
 * proposal, or the item the row was proposed for), or its shape is the row's and no other
 * callable skill of the employee covers that shape.
 */
async function coveredItemTest(
  ctx: MutationCtx,
  row: Doc<'skills'>,
): Promise<(item: Doc<'workItems'>) => boolean> {
  const names = (item: Doc<'workItems'>): boolean =>
    item.skillId === row._id || item.proposedSkillId === row._id || item._id === row.proposedFor;
  const shape =
    row.surfaceClass !== undefined && row.operation !== undefined
      ? { surfaceClass: row.surfaceClass, operation: row.operation }
      : undefined;
  if (shape === undefined) return names;
  const stillCallable = await ctx.db
    .query('skills')
    .withIndex('by_agent_state', (q) => q.eq('agentId', row.agentId).eq('state', 'registered'))
    .collect();
  const covered = stillCallable.some(
    (other) =>
      other._id !== row._id &&
      other.surfaceClass !== undefined &&
      other.operation !== undefined &&
      sameSkillShape({ surfaceClass: other.surfaceClass, operation: other.operation }, shape),
  );
  if (covered) return names;
  const surfaces: readonly ShapeSurface[] =
    SURFACE_MODE === 'real'
      ? await ctx.db
          .query('surfaces')
          .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
          .collect()
      : [];
  return (item) =>
    names(item) || sameSkillShape(skillShapeFor(item, surfaces, SURFACE_MODE), shape);
}

/**
 * Send back to `needs-skill` every approved item that would have run a row taken out of use.
 *
 * @returns The items sent back, oldest first.
 */
async function returnApprovedItems(
  ctx: MutationCtx,
  row: Doc<'skills'>,
  how: TakenOut,
  now: number,
): Promise<Id<'workItems'>[]> {
  const covers = await coveredItemTest(ctx, row);
  const approved = await ctx.db
    .query('workItems')
    .withIndex('by_agent_state', (q) => q.eq('agentId', row.agentId).eq('state', 'plan-approved'))
    .take(APPROVED_SCAN);
  const returned: Id<'workItems'>[] = [];
  for (const item of approved) {
    if (!covers(item)) continue;
    await parkForSkill(ctx, item, {
      name: row.name,
      reason: takenOutItemReason(row.name, how),
      rationale: row.rationale ?? row.description,
      ...(row.surfaceClass !== undefined && row.operation !== undefined
        ? { shape: { surfaceClass: row.surfaceClass, operation: row.operation } }
        : {}),
      now,
    });
    returned.push(item._id);
  }
  return returned;
}

/**
 * The revisions of a row still being written: Ask for a revision's new rows (`revisionOf`) that
 * have neither registered nor ended.
 */
async function openRevisionsOf(ctx: MutationCtx, row: Doc<'skills'>): Promise<Doc<'skills'>[]> {
  const sameName = await ctx.db
    .query('skills')
    .withIndex('by_agent_name', (q) => q.eq('agentId', row.agentId).eq('name', row.name))
    .collect();
  return sameName.filter(
    (other) => other.revisionOf === row._id && OPEN_REVISION_STATES.has(other.state),
  );
}

/**
 * Take one employee's row out of its use: `registered` to `retired` with the reason, the claim
 * released, any revision still being written ended (its registration would otherwise make the
 * skill callable again), and the approved items it would have run returned to `needs-skill`.
 *
 * @returns The items returned.
 */
async function retireHolder(
  ctx: MutationCtx,
  row: Doc<'skills'>,
  retirement: { readonly reason: string; readonly how: TakenOut; readonly now: number },
): Promise<Id<'workItems'>[]> {
  const { reason, how, now } = retirement;
  await ctx.db.patch(row._id, {
    state: 'retired',
    retiredAt: now,
    retiredReason: reason,
    ...RELEASED_CLAIM,
  });
  for (const revision of await openRevisionsOf(ctx, row)) {
    await ctx.db.patch(revision._id, { state: 'rejected', ...RELEASED_CLAIM });
    await appendEvent(ctx, {
      agentId: revision.agentId,
      type: 'skill.rejected',
      payload: { skillId: revision._id, name: revision.name },
      createdAt: now,
    });
  }
  const returnedItems = await returnApprovedItems(ctx, { ...row, state: 'retired' }, how, now);
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'skill.retired',
    payload: {
      skillId: row._id,
      name: row.name,
      reason,
      ...(row.versionId !== undefined ? { versionId: row.versionId } : {}),
      ...(how === 'withdrawn' ? { withdrawn: true as const } : {}),
      returnedItems,
    },
    createdAt: now,
  });
  if (returnedItems.length > 0) {
    await ctx.scheduler.runAfter(0, internal.skillControls.proposeForReturnedWork, {
      agentId: row.agentId,
      workItemIds: returnedItems,
      proposal: proposalOf(row),
    });
  }
  return returnedItems;
}

/** What a proposal for work a control parked asks for: the taken-out row's own shape. */
const proposalValidator = v.object({
  name: v.string(),
  description: v.string(),
  rationale: v.string(),
  requiredScopes: v.array(v.string()),
  surfaceClass: v.optional(v.string()),
  operation: v.optional(v.string()),
});

/** A proposal for parked work, as {@link proposalValidator} carries it. */
export type ParkedWorkProposal = typeof proposalValidator.type;

/** The proposal a taken-out row's parked work asks for: the same skill, written again. */
function proposalOf(row: Doc<'skills'>): ParkedWorkProposal {
  return {
    name: row.name,
    description: row.description,
    rationale: row.rationale ?? row.description,
    requiredScopes: [...(row.requiredScopes ?? [])],
    ...(row.surfaceClass !== undefined ? { surfaceClass: row.surfaceClass } : {}),
    ...(row.operation !== undefined ? { operation: row.operation } : {}),
  };
}

/**
 * Ask for the skill parked work needs, through the proposal step every `needs-skill` verdict
 * takes (`skills.propose`), and link each item to the row it answers while that row may still
 * become callable. The first item is the one the proposal is for. A row the proposal step answers
 * that can no longer become callable is not linked: the items wait on their verdict's name, which
 * the next registration of that name reaches.
 *
 * @param ctx - The executor's or the scheduled proposal's action context.
 * @param args - The employee, the parked items, and the skill they need.
 * @returns The row the items were linked to, if any.
 */
export async function proposeBehindParkedWork(
  ctx: ActionCtx,
  args: {
    readonly agentId: Id<'agents'>;
    readonly workItemIds: readonly Id<'workItems'>[];
    readonly proposal: ParkedWorkProposal;
  },
): Promise<Id<'skills'> | undefined> {
  const [first] = args.workItemIds;
  if (first === undefined) return undefined;
  const skillId = await ctx.runMutation(internal.skills.propose, {
    agentId: args.agentId,
    workItemId: first,
    ...args.proposal,
  });
  const linked = await ctx.runMutation(internal.skillControls.linkParkedWork, {
    skillId,
    workItemIds: [...args.workItemIds],
  });
  return linked ? skillId : undefined;
}

/**
 * Internal: link parked items to the row the proposal step answered, when that row may still
 * become callable and each item still waits at `needs-skill` unlinked or behind a row that cannot.
 *
 * @returns Whether the row could take the items.
 */
export const linkParkedWork = internalMutation({
  args: { skillId: v.id('skills'), workItemIds: v.array(v.id('workItems')) },
  handler: async (ctx, args): Promise<boolean> => {
    const skill = await ctx.db.get(args.skillId);
    if (skill === null || !LIVE_STATES.has(skill.state)) return false;
    for (const workItemId of args.workItemIds) {
      const item = await ctx.db.get(workItemId);
      if (item?.state !== 'needs-skill' || item.agentId !== skill.agentId) continue;
      const current = item.proposedSkillId ? await ctx.db.get(item.proposedSkillId) : null;
      if (current !== null && LIVE_STATES.has(current.state)) continue;
      await ctx.db.patch(workItemId, { proposedSkillId: skill._id });
    }
    return true;
  },
});

/**
 * Internal, scheduled by Retire and Withdraw: propose the skill the work they parked needs.
 */
export const proposeForReturnedWork = internalAction({
  args: {
    agentId: v.id('agents'),
    workItemIds: v.array(v.id('workItems')),
    proposal: proposalValidator,
  },
  handler: async (ctx, args): Promise<{ linkedTo: Id<'skills'> | null }> => ({
    linkedTo: (await proposeBehindParkedWork(ctx, args)) ?? null,
  }),
});

/**
 * Public, guarded by `assertOwnsSkill`: Retire one employee's copy of a skill. The row goes from
 * `registered` to `retired` with the manager's reason (or "retired by the manager"), its claim is
 * released, a revision still being written is ended, and the approved items it would have run go
 * back to `needs-skill` behind a new proposal; the version and every other holder are untouched.
 * Writes `skill.retired`, and `work.waiting-for-skill` for each item.
 */
export const retire = mutation({
  args: { skillId: v.id('skills'), reason: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ retired: true; returnedItems: number }> => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    const reason = controlReason(args.reason, RETIRED_BY_MANAGER);
    assertCallableAuthored(row, 'retired');
    const returned = await retireHolder(ctx, row, { reason, how: 'retired', now: Date.now() });
    return { retired: true, returnedItems: returned.length };
  },
});

/**
 * Public, guarded by `assertOwnsSkill`: Withdraw for every employee (A12). The version the row
 * holds is stamped withdrawn (`revokedAt`, `revokedReason`), so it is offered to nobody and no
 * stored verification registers it again, and every holder of it that is callable is retired as
 * Retire retires one, all in this one transaction. One `skill.revoked` on the acting employee's
 * record names every holder retired; each holder's record carries its own `skill.retired`.
 */
export const withdraw = mutation({
  args: { skillId: v.id('skills'), reason: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ withdrawn: true; holders: number }> => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    const reason = controlReason(args.reason, WITHDRAWN_BY_MANAGER);
    const version = row.versionId === undefined ? null : await ctx.db.get(row.versionId);
    const owner = (await ctx.db.get(row.agentId))?.userId;
    if (version === null || version.userId !== owner) {
      throw new ConvexError(
        `${row.name} holds no library version, so no other employee holds it; retire it instead.`,
      );
    }
    if (version.revokedAt !== undefined) {
      throw new ConvexError(`Version ${version.version} of ${row.name} was already withdrawn.`);
    }
    const now = Date.now();
    await ctx.db.patch(version._id, { revokedAt: now, revokedReason: reason });
    const holders: SkillRevokedHolder[] = [];
    for (const holder of await holdersOf(ctx.db, version._id)) {
      if (holder.state !== 'registered') continue;
      const employee = await ctx.db.get(holder.agentId);
      if (employee === null || employee.userId !== version.userId) continue;
      await retireHolder(ctx, holder, { reason, how: 'withdrawn', now });
      holders.push({ skillId: holder._id, agentId: holder.agentId, agentName: employee.name });
    }
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.revoked',
      payload: {
        skillId: row._id,
        name: row.name,
        reason,
        versionId: version._id,
        version: version.version,
        holders,
      },
      createdAt: now,
    });
    return { withdrawn: true, holders: holders.length };
  },
});

/**
 * Public, guarded by `assertOwnsSkill`: Re-check now. Schedules the stored verification
 * (`skillActions.verifyStoredSkill`) of the version the row holds; the employee keeps running its
 * verified body meanwhile. A pass clears "Re-check due"; a sandbox failure moves the row to
 * `failed` with the log. Refused for a row that is not callable, holds no stored version, or is
 * being checked now. Writes nothing itself: the verification's claim is on the record.
 */
export const recheckNow = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ scheduled: true }> => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    assertCallableAuthored(row, 're-checked');
    if (row.versionId === undefined) {
      throw new ConvexError(
        `${row.name} has no stored version to re-check; ask for a revision instead.`,
      );
    }
    if (holdsLiveAuthoringClaim(row, Date.now())) {
      throw new ConvexError(`A check of ${row.name} is already running.`);
    }
    await ctx.scheduler.runAfter(0, internal.skillActions.verifyStoredSkill, {
      skillId: row._id,
    });
    return { scheduled: true };
  },
});

/**
 * Cancel the parked items waiting for a skill that will never register, a batch per transaction:
 * every item at `needs-skill` linked to it, and the item it was proposed for when that one is
 * linked to nothing else. Each carries the reason on its card and a `work.cancelled` event.
 *
 * @param after - Where the previous batch stopped; absent for the first.
 * @returns How many items this batch cancelled.
 */
async function cancelWaitingWork(
  ctx: MutationCtx,
  skill: Doc<'skills'>,
  reason: string,
  after?: number,
): Promise<number> {
  const page = await ctx.db
    .query('workItems')
    .withIndex('by_agent_state', (q) => {
      const parked = q.eq('agentId', skill.agentId).eq('state', 'needs-skill');
      return after === undefined ? parked : parked.gt('_creationTime', after);
    })
    .take(CANCEL_SCAN);
  let cancelled = 0;
  for (const item of page) {
    const waits =
      item.proposedSkillId === skill._id ||
      (item.proposedSkillId === undefined && item._id === skill.proposedFor);
    if (!waits) continue;
    await ctx.db.patch(item._id, { state: 'cancelled', skipReason: reason });
    await appendEvent(ctx, {
      agentId: item.agentId,
      type: 'work.cancelled',
      payload: { workItemId: item._id, skillId: skill._id, reason },
      createdAt: Date.now(),
    });
    await scheduleNextStep(ctx, { ...item, state: 'cancelled' });
    cancelled += 1;
  }
  const last = page.at(-1);
  if (page.length === CANCEL_SCAN && last !== undefined) {
    await ctx.scheduler.runAfter(0, internal.skillControls.continueCancellingWaitingWork, {
      skillId: skill._id,
      reason,
      after: last._creationTime,
    });
  }
  return cancelled;
}

/**
 * Internal, scheduled by a Give up whose employee had more parked items than one batch reads:
 * the next batch, while the skill is still given up.
 */
export const continueCancellingWaitingWork = internalMutation({
  args: { skillId: v.id('skills'), reason: v.string(), after: v.number() },
  handler: async (ctx, args): Promise<{ cancelled: number }> => {
    const skill = await ctx.db.get(args.skillId);
    if (skill?.state !== 'rejected') return { cancelled: 0 };
    return { cancelled: await cancelWaitingWork(ctx, skill, args.reason, args.after) };
  },
});

/**
 * Public, guarded by `assertOwnsSkill`: Give up on a skill that failed its check. The row goes to
 * `rejected`, keeping its last failure on the row, and every item waiting for it is cancelled
 * with "given up after n attempts". Writes `skill.given-up` and a `work.cancelled` per item.
 */
export const giveUp = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ givenUp: true; cancelled: number }> => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    if (row.state !== 'failed') {
      throw new ConvexError(
        `Only a skill that failed its check is given up; ${row.name} is ${row.state}.`,
      );
    }
    const attempts = Math.max(1, row.authoringAttempts ?? 0);
    const reason = givenUpReason(attempts);
    await ctx.db.patch(row._id, { state: 'rejected', ...RELEASED_CLAIM });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.given-up',
      payload: { skillId: row._id, name: row.name, reason, attempts },
      createdAt: Date.now(),
    });
    const cancelled = await cancelWaitingWork(ctx, { ...row, state: 'rejected' }, reason);
    return { givenUp: true, cancelled };
  },
});

/**
 * Open a revision of a callable skill an employee wrote: a new row of the same name in
 * `approved`, with `revisionOf` the current row, which the manager's authoring run writes and
 * checks while the current row keeps running. At its registration the current row becomes
 * `superseded` in the same transaction and the library gains the next version
 * (`skills.completeRegistration`). History is kept, so a skill that has already run may be
 * revised. One revision is written at a time.
 *
 * @param ctx - The control's mutation context.
 * @param row - The current row, which the caller owns.
 * @returns The new row the authoring run writes.
 */
export async function openRevision(ctx: MutationCtx, row: Doc<'skills'>): Promise<Id<'skills'>> {
  assertCallableAuthored(row, 'revised');
  if ((await openRevisionsOf(ctx, row)).length > 0) {
    throw new ConvexError(`A revision of ${row.name} is already being written.`);
  }
  const now = Date.now();
  const revisionId = await ctx.db.insert('skills', {
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    body: '',
    sourceType: 'agent-authored',
    state: 'approved',
    ...(row.proposedFor !== undefined ? { proposedFor: row.proposedFor } : {}),
    ...(row.rationale !== undefined ? { rationale: row.rationale } : {}),
    requiredScopes: [...(row.requiredScopes ?? [])],
    ...(row.targetSurface !== undefined ? { targetSurface: row.targetSurface } : {}),
    ...(row.surfaceClass !== undefined ? { surfaceClass: row.surfaceClass } : {}),
    ...(row.operation !== undefined ? { operation: row.operation } : {}),
    revisionOf: row._id,
    createdAt: now,
  });
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'skill.revision-requested',
    payload: { skillId: row._id, name: row.name, revisionId },
    createdAt: now,
  });
  return revisionId;
}

/**
 * Public, guarded by `assertOwnsSkill`: Ask for a revision ({@link openRevision}). The caller
 * starts the authoring run on the row it answers (`skillActions.authorAndRegisterSkill`).
 */
export const askForRevision = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ revisionId: Id<'skills'> }> => ({
    revisionId: await openRevision(ctx, await assertOwnsSkill(ctx, args.skillId)),
  }),
});

/**
 * Public, guarded by `assertOwnsAgent`: the employee's revisions not yet being written, which no
 * other list on the Skills tab shows (an `approved` row whose run has not started, or whose run
 * stopped before it claimed). Reads only.
 */
export const pendingRevisions = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    const approved = await ctx.db
      .query('skills')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'approved'))
      .collect();
    return approved.filter((row) => row.revisionOf !== undefined);
  },
});

/**
 * Internal, the executor's no-match (E-1): park an approved item whose skill is not callable at
 * `needs-skill` behind the skill's registration, instead of failing it into a Retry that fails
 * again. Does nothing to an item that has left `plan-approved`.
 *
 * @returns Whether the item was parked, and the row it waits behind when one may still become
 *   callable; without one the caller proposes the skill.
 */
export const parkForMissingSkill = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    name: v.string(),
    reason: v.string(),
    rationale: v.string(),
    shape: v.object({ surfaceClass: v.string(), operation: v.string() }),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ parked: false } | { parked: true; behind: Id<'skills'> | null }> => {
    const item = await ctx.db.get(args.workItemId);
    if (item?.state !== 'plan-approved') return { parked: false };
    const behind = await parkForSkill(ctx, item, {
      name: args.name,
      reason: args.reason,
      rationale: args.rationale,
      shape: args.shape,
      now: Date.now(),
    });
    return { parked: true, behind: behind ?? null };
  },
});
