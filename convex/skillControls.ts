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
import { appendEvent, eventsOfType } from './eventLog';
import { assertNotBeingHandedOver } from './handoverFence';
import {
  holdersOf,
  newerVersionToRecheck,
  skillOwnerKeyOf,
  STORED_COPY_CLEARED,
} from './skillVersions';
import { applyVerdict, stopRunsInTransaction } from './work';
import { moveWaitingWork } from './waitingWork';
import { scheduleNextStep, STEP_LEASE_MS } from './workLoop';
import { isEventOf, type SkillRevokedHolder } from '../src/events/contract';
import { holdsLiveAuthoringClaim } from '../src/lib/skill-authoring';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { sameSkillShape, skillShapeFor, type ShapeSurface } from '../src/work/skill-shape';
import type { SkillShape } from '../src/work/types';
import {
  controlReasonOf,
  givenUpReason,
  RETIRED_BY_MANAGER,
  strandedItemReason,
  takenOutItemReason,
  WITHDRAWN_BY_MANAGER,
  withdrawnRunReason,
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
const releasedClaim = { authoringRunId: undefined, authoringClaimedAt: undefined } as const;

/**
 * Items of one employee in one state a Retire or a Withdraw reads for the ones its skill would
 * have run or is running. An employee's approved and running items are bounded by its
 * work-in-progress cap, far below this.
 */
const APPROVED_SCAN = 200;

/** Parked items of one employee an ended adoption reads for the ones that waited on it. */
const WAITING_SCAN = 200;

/**
 * The owner's employees a Withdraw reads for adoptions offering the version, and each one's rows
 * of the name. An offer past these bounds is still refused at Adopt, at Check it again and by the
 * authoring action, which check the version as it stands.
 */
const OFFER_EMPLOYEE_SCAN = 500;
const OFFER_ROW_SCAN = 50;

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

/** The controls that act on a callable skill an employee wrote, as their refusals name them. */
type CallableControl = 'retired' | 'withdrawn' | 're-checked' | 'revised';

/**
 * Why a row is refused by a control that acts on a callable skill an employee wrote, or nothing
 * when it may act. A built-in skill is installed with the employee and has no versions.
 *
 * @param row - The skill row.
 * @param control - Which control asks, for the refusal's words.
 */
function callableAuthoredRefusal(row: Doc<'skills'>, control: CallableControl): string | undefined {
  if (row.sourceType === 'agent-authored' && row.state === 'registered') return undefined;
  switch (control) {
    case 'retired':
    case 'withdrawn':
    case 're-checked':
      return row.sourceType !== 'agent-authored'
        ? `A built-in skill comes with the employee and is not ${control}.`
        : `Only a callable skill is ${control}; ${row.name} is ${row.state}.`;
    case 'revised':
      return 'Only a callable skill an employee wrote is revised.';
    default: {
      const unhandled: never = control;
      throw new Error(`unhandled control ${String(unhandled)}`);
    }
  }
}

/**
 * Refuse a row a control on a callable skill an employee wrote cannot act on
 * ({@link callableAuthoredRefusal}).
 *
 * @throws ConvexError with the refusal the card reads.
 */
function assertCallableAuthored(row: Doc<'skills'>, control: CallableControl): void {
  const refusal = callableAuthoredRefusal(row, control);
  if (refusal !== undefined) throw new ConvexError(refusal);
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
 * queue, and a recovery is scheduled in case no row of the name that may still become callable
 * is linked to it by then ({@link recoverStrandedParkedWork}).
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
  const waitingId = await appendEvent(ctx, {
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
  await ctx.scheduler.runAfter(STEP_LEASE_MS, internal.skillControls.recoverStrandedParkedWork, {
    workItemId: item._id,
    waitingId,
  });
  return behind?._id;
}

/** Waiting events of one employee the recovery reads for an item's newest. */
const WAITING_EVENTS_SCAN = 200;

/**
 * Internal, scheduled by every park ({@link parkForSkill}) a step lease later: an item still
 * parked by that park, with no row of the name that may still become callable linked to it,
 * would wait for ever with nothing on any card to move it (the proposal step answered a row that
 * cannot register, or never ran). It goes back to be evaluated afresh, the shape every re-queued
 * item takes, so its next evaluation proposes the skill it needs. An item a later park, a link, a
 * later evaluation or any other transition reached is left alone. The park is found among the
 * employee's newest {@link WAITING_EVENTS_SCAN} waiting events; one older than that is left alone,
 * the safe side, which the work-in-progress cap keeps out of reach within one lease.
 *
 * @returns Whether the item was sent back.
 */
export const recoverStrandedParkedWork = internalMutation({
  args: { workItemId: v.id('workItems'), waitingId: v.id('events') },
  handler: async (ctx, args): Promise<{ recovered: boolean }> => {
    const item = await ctx.db.get(args.workItemId);
    if (item?.state !== 'needs-skill') return { recovered: false };
    const linked = item.proposedSkillId ? await ctx.db.get(item.proposedSkillId) : null;
    if (linked !== null && LIVE_STATES.has(linked.state)) return { recovered: false };
    const newest = (
      await eventsOfType(ctx, item.agentId, 'work.waiting-for-skill')
        .order('desc')
        .take(WAITING_EVENTS_SCAN)
    ).find(
      (event) =>
        isEventOf(event, 'work.waiting-for-skill') && event.payload.workItemId === item._id,
    );
    if (newest?._id !== args.waitingId || !isEventOf(newest, 'work.waiting-for-skill')) {
      return { recovered: false };
    }
    // A later evaluation parked the item on a verdict of its own, and the evaluation's own
    // recovery (`work.recoverUnproposedSkill`) is the one that answers for it.
    const verdict = item.verdict as { reason?: unknown } | undefined;
    if (verdict?.reason !== newest.payload.reason) return { recovered: false };
    const name = newest.payload.name;
    await applyVerdict(ctx, item._id, {
      decision: 'pending-reevaluation',
      reason: strandedItemReason(name),
    });
    return { recovered: true };
  },
});

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
 * @param ctx - The control's mutation context.
 * @param taken - The row as the control left it, how it was taken out, and when.
 * @returns The items sent back, oldest first.
 */
async function returnApprovedItems(
  ctx: MutationCtx,
  taken: { readonly row: Doc<'skills'>; readonly how: TakenOut; readonly now: number },
): Promise<Id<'workItems'>[]> {
  const { row, how, now } = taken;
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
    ...releasedClaim,
  });
  for (const revision of await openRevisionsOf(ctx, row)) {
    await ctx.db.patch(revision._id, { state: 'rejected', ...releasedClaim });
    await appendEvent(ctx, {
      agentId: revision.agentId,
      type: 'skill.rejected',
      payload: { skillId: revision._id, name: revision.name },
      createdAt: now,
    });
  }
  const returnedItems = await returnApprovedItems(ctx, {
    row: { ...row, state: 'retired' },
    how,
    now,
  });
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
 * Retire retires one, all in this one transaction; a run of it already under way is stopped
 * ({@link stopRunsOf}), and every adoption offering it ends with it ({@link endAdoptionsOf}).
 * One `skill.revoked` on the acting employee's record names every holder retired; each holder's
 * record carries its own `skill.retired`, and each ended adoption's a `skill.rejected` saying
 * so. Refused for a row that is not a callable skill an employee wrote.
 */
export const withdraw = mutation({
  args: { skillId: v.id('skills'), reason: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ withdrawn: true; holders: number; returnedItems: number; stoppedRuns: number }> => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    const reason = controlReason(args.reason, WITHDRAWN_BY_MANAGER);
    assertCallableAuthored(row, 'withdrawn');
    const withdrawn = await withdrawVersion(ctx, row, reason);
    return { withdrawn: true, ...withdrawn };
  },
});

/**
 * Withdraw the version a callable row holds from every employee of its owner who runs it, in the
 * caller's transaction ({@link withdraw}).
 *
 * @param ctx - The control's mutation context.
 * @param row - The row the manager withdrew it from; it holds the version.
 * @param reason - The reason kept on the version, each holder and the record.
 * @returns How many holders were retired, how many approved items went back to waiting, and how
 *   many runs under way were stopped.
 * @throws ConvexError when the row holds no version of its owner's, or the version was withdrawn.
 */
async function withdrawVersion(
  ctx: MutationCtx,
  row: Doc<'skills'>,
  reason: string,
): Promise<{ holders: number; returnedItems: number; stoppedRuns: number }> {
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
  let returnedItems = 0;
  let stoppedRuns = 0;
  // `holdersOf` reads by the owner key, so every holder is the version owner's employee's.
  for (const holder of await holdersOf(ctx.db, version._id)) {
    if (holder.state !== 'registered') continue;
    const employee = await ctx.db.get(holder.agentId);
    if (employee === null) continue;
    stoppedRuns += await stopRunsOf(ctx, holder);
    returnedItems += (await retireHolder(ctx, holder, { reason, how: 'withdrawn', now })).length;
    holders.push({ skillId: holder._id, agentId: holder.agentId, agentName: employee.name });
  }
  await endAdoptionsOf(ctx, version, now);
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
  return { holders: holders.length, returnedItems, stoppedRuns };
}

/** The states of an item whose run a Withdraw stops: running, or holding the actions it drafted. */
const STOPPED_BY_WITHDRAW: readonly Doc<'workItems'>['state'][] = ['executing', 'actions-pending'];

/**
 * Stop the runs of one holder of a withdrawn version, as a handover's deadline stops a run
 * (`work.stopRunsInTransaction`; decision 3 (b), the wave 10 review, M4): every item executing
 * the row, and every item holding for the manager's approval the actions a run of it drafted,
 * fails as stopped with {@link withdrawnRunReason} and offers Retry, so the body the manager has
 * withdrawn as wrong writes nothing more. A Retire stops nothing: its dialog says a run already
 * under way finishes.
 *
 * @returns How many runs were stopped.
 */
async function stopRunsOf(ctx: MutationCtx, holder: Doc<'skills'>): Promise<number> {
  const runs: Doc<'workItems'>[] = [];
  for (const state of STOPPED_BY_WITHDRAW) {
    const items = await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', holder.agentId).eq('state', state))
      .take(APPROVED_SCAN);
    runs.push(...items.filter((item) => item.skillId === holder._id));
  }
  await stopRunsInTransaction(ctx, runs, withdrawnRunReason(holder.name));
  return runs.length;
}

/**
 * End every adoption of the owner that offers a version being withdrawn, in the Withdraw's
 * transaction (the wave 10 review, M2). Each row carrying the version as its offer, adopted or
 * not, is rejected with its claim released and any parked copy of the version cleared, so no
 * Retry, Check it again or authoring run can register the withdrawn body, and its record says the
 * adoption ended. The work waiting on it waits for a skill again and asks for one afresh, as the
 * work a Retire returns does; the version, withdrawn, is offered to it no more.
 *
 * @param ctx - The Withdraw's mutation context.
 * @param version - The version withdrawn.
 * @param now - The Withdraw's time.
 */
async function endAdoptionsOf(
  ctx: MutationCtx,
  version: Doc<'skillVersions'>,
  now: number,
): Promise<void> {
  const employees = await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', version.userId))
    .take(OFFER_EMPLOYEE_SCAN);
  for (const employee of employees) {
    // Newest first, so a long history of one name never hides the live adoption; a declined one
    // has nothing left to end.
    const offered = (
      await ctx.db
        .query('skills')
        .withIndex('by_agent_name', (q) => q.eq('agentId', employee._id).eq('name', version.name))
        .order('desc')
        .take(OFFER_ROW_SCAN)
    ).filter((row) => row.offeredVersionId === version._id && row.state !== 'rejected');
    for (const row of offered) await endAdoption(ctx, { row, version, now });
  }
}

/**
 * Whether a parked item waited on an adoption's row: linked to it, or the item the row was
 * proposed for when that one is linked to nothing. An adoption is never a revision.
 */
function waitedOnAdoption(item: Doc<'workItems'>, row: Doc<'skills'>): boolean {
  if (item.proposedSkillId === row._id) return true;
  return item.proposedSkillId === undefined && item._id === row.proposedFor;
}

/** One adoption ended because its version was withdrawn ({@link endAdoptionsOf}). */
async function endAdoption(
  ctx: MutationCtx,
  ended: {
    readonly row: Doc<'skills'>;
    readonly version: Doc<'skillVersions'>;
    readonly now: number;
  },
): Promise<void> {
  const { row, version, now } = ended;
  await ctx.db.patch(row._id, {
    state: 'rejected',
    offeredVersionId: undefined,
    ...STORED_COPY_CLEARED,
    ...releasedClaim,
  });
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'skill.rejected',
    payload: { skillId: row._id, name: row.name, offerWithdrawn: { version: version.version } },
    createdAt: now,
  });
  const waiting = (
    await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', row.agentId).eq('state', 'needs-skill'))
      .take(WAITING_SCAN)
  ).filter((item) => waitedOnAdoption(item, row));
  const returned: Id<'workItems'>[] = [];
  for (const item of waiting) {
    await parkForSkill(ctx, item, {
      name: row.name,
      reason: takenOutItemReason(row.name, 'withdrawn'),
      rationale: row.rationale ?? row.description,
      ...(row.surfaceClass !== undefined && row.operation !== undefined
        ? { shape: { surfaceClass: row.surfaceClass, operation: row.operation } }
        : {}),
      now,
    });
    returned.push(item._id);
  }
  if (returned.length > 0) {
    await ctx.scheduler.runAfter(0, internal.skillControls.proposeForReturnedWork, {
      agentId: row.agentId,
      workItemIds: returned,
      proposal: proposalOf(row),
    });
  }
}

/**
 * Public, guarded by `assertOwnsSkill`: Re-check now. Schedules the stored verification
 * (`storedVerification.verifyStoredSkill`) of the version the row holds, or, when its chip says a newer
 * version is verified, of that newer version, so a pass moves the holder onto it
 * ({@link newerVersionToRecheck}); the employee keeps running its verified body meanwhile. A pass
 * clears "Re-check due"; a sandbox failure moves the row to `failed` with the log. Refused for a
 * row that is not callable, holds no stored version, or is being checked now. Writes nothing
 * itself: the verification's claim is on the record.
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
    const newer = await newerVersionToRecheck(ctx.db, row);
    await ctx.scheduler.runAfter(0, internal.storedVerification.verifyStoredSkill, {
      skillId: row._id,
      ...(newer !== undefined ? { versionId: newer } : {}),
    });
    return { scheduled: true };
  },
});

/**
 * Public, guarded by `assertOwnsSkill`: Give up on a skill that failed its check. The row goes to
 * `rejected`, keeping its last failure on the row, and every item waiting for it is cancelled
 * with "given up after n attempts", its claim on the provider item released, through the walk a
 * rejection takes (`waitingWork.moveWaitingWork`; the wave 10 review, M9): a batch here, the rest
 * by schedule. Writes `skill.given-up` and a `work.cancelled` per item.
 *
 * @returns How many items this transaction cancelled.
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
    await ctx.db.patch(row._id, { state: 'rejected', ...releasedClaim });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.given-up',
      payload: { skillId: row._id, name: row.name, reason, attempts },
      createdAt: Date.now(),
    });
    const cancelled = await moveWaitingWork(ctx, row, { kind: 'cancel', reason });
    return { givenUp: true, cancelled };
  },
});

/**
 * Open a revision of a callable skill an employee wrote: a new row of the same name in
 * `approved`, with `revisionOf` the current row, which the manager's authoring run writes and
 * checks while the current row keeps running. At its registration the current row becomes
 * `superseded` in the same transaction and the library gains the next version
 * (`skills.completeRegistration`). History is kept, so a skill that has already run may be
 * revised. One revision is written at a time. Refused once a new manager has accepted the
 * employee and it waits for its runs: the revision would register and supersede the skill the new
 * manager previewed (U3-m3; the wave 10 review, M1).
 *
 * @param ctx - The control's mutation context.
 * @param row - The current row, which the caller owns.
 * @returns The new row the authoring run writes.
 * @throws ConvexError when a handover of the employee was accepted, the row is not a callable
 *   skill an employee wrote, or a revision of it is already being written.
 */
export async function openRevision(ctx: MutationCtx, row: Doc<'skills'>): Promise<Id<'skills'>> {
  await assertNotBeingHandedOver(ctx.db, row.agentId);
  assertCallableAuthored(row, 'revised');
  if ((await openRevisionsOf(ctx, row)).length > 0) {
    throw new ConvexError(`A revision of ${row.name} is already being written.`);
  }
  const now = Date.now();
  const revisionId = await ctx.db.insert('skills', {
    agentId: row.agentId,
    ...(await skillOwnerKeyOf(ctx.db, row.agentId)),
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
