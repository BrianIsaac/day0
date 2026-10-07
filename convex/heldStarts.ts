import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import { appendEvent, eventsOfType } from './eventLog';
import type { EventType, HeldAuthoringSpentWhy } from '../src/events/contract';
import { cronsPauseReason } from '../src/lib/crons-pause';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { heldStartLine } from '../src/work/held-starts';
import { runHoldOf, type RunHold } from '../src/work/item-display';
import { isPaused, stepHoldReason } from '../src/work/pause';
import { holdsLiveAuthoringClaim } from '../src/lib/skill-authoring';
import { AUTHORING_CLAIMABLE_STATES, MAX_AUTHORING_ATTEMPTS } from '../src/work/skill-library';

/*
 * What a pause holds besides the work loop's steps (the wave 12 review's D-8, recommendation (b);
 * wave 13 item 6): a skill's authoring, at its claim (`skillAuthoringClaim.ts`), and a system's
 * orientation, before it reads anything (`orientationActions.orientOne`). Each is held by the rule
 * every step is held by (`stepMayRun` in `workLoop.ts`: the employee's pause, then the deployment's
 * pause of its scheduled work; real mode only), and each hold is an event. The resume, and the
 * stalled-step sweep once the deployment's work runs again, start what was held since the last
 * resume (`resumeHeldStartsInTransaction`, from `resumeAgentStepsInTransaction`).
 *
 * This module reads the pause itself rather than through `workLoop.ts`, which imports it.
 */

/** How many held starts of one kind one resume reads: far more than one employee holds. */
const HELD_STARTS_READ = 50;

/** Why a start is held now: the step's reason for the record, and whose pause for the card. */
export interface StartHold {
  /** The step's reason (`stepHoldReason`), as a held claim's event records it. */
  readonly reason: string;
  /** Whose pause it is, as the manager's line names it ({@link heldStartLine}). */
  readonly hold: RunHold;
}

/**
 * Whether a start of this employee is held now, and why: the rule `stepMayRun` reads, so a skill's
 * authoring and a system's orientation wait exactly when a step would. Undefined while one may
 * start, and always in mock mode, where the page drives every step and a pause is refused.
 *
 * @param db - Any reader.
 * @param agentId - The employee whose start it is.
 */
export async function startHoldOf(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
): Promise<StartHold | undefined> {
  if (SURFACE_MODE !== 'real') return undefined;
  const agent = await db.get(agentId);
  const cronsReason = cronsPauseReason();
  const reason = stepHoldReason(agent, cronsReason);
  const hold = runHoldOf({
    real: true,
    employeeName: agent?.name ?? 'the employee',
    employeePaused: agent !== null && isPaused(agent),
    scheduledWorkPaused: cronsReason !== undefined,
  });
  return reason === undefined || hold === undefined ? undefined : { reason, hold };
}

/**
 * Record that a pause held a skill's authoring at its claim, and say why in the words the Skills
 * card shows the manager. The row is left as it was: no claim, no attempt counted.
 *
 * @param skill - The skill whose authoring was held.
 * @param held - Why ({@link startHoldOf}).
 * @returns The claim's refusal reason.
 */
export async function recordAuthoringHeld(
  ctx: MutationCtx,
  skill: Pick<Doc<'skills'>, '_id' | 'agentId' | 'name'>,
  held: StartHold,
): Promise<string> {
  await appendEvent(ctx, {
    agentId: skill.agentId,
    type: 'skill.authoring-held',
    payload: { skillId: skill._id, name: skill.name, reason: held.reason },
    createdAt: Date.now(),
  });
  return heldStartLine(held.hold, 'authoring');
}

/**
 * Internal, for `orientationActions.orientOne` before it reads anything: hold a declared system's
 * orientation while a pause holds the employee's steps. The card's reason says so and the hold is
 * recorded with how the orientation was asked for, so the resume asks for it the same way. A
 * surface no longer declared is left to the orientation, which skips it.
 *
 * @returns Whether the orientation was held.
 */
export const holdOrientation = internalMutation({
  args: { surfaceId: v.id('surfaces'), requested: v.boolean() },
  handler: async (ctx, args): Promise<{ held: boolean }> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (surface === null || surface.verdict !== 'declared') return { held: false };
    const held = await startHoldOf(ctx.db, surface.agentId);
    if (held === undefined) return { held: false };
    await ctx.db.patch(surface._id, { reason: heldStartLine(held.hold, 'orientation') });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.orientation-held',
      payload: { surfaceId: surface._id, reason: held.reason, requested: args.requested },
      createdAt: Date.now(),
    });
    return { held: true };
  },
});

/**
 * The payloads of one employee's held starts of one kind since that kind was last taken up,
 * newest first: a resume records, for each start it takes up, either that it started it or that
 * its hold is spent (W13-R46), so every hold before the newest of either has been taken up.
 *
 * @param held - The kind's held event.
 * @param takenUp - The kind's events that take a hold up: resumed, and spent.
 */
async function heldSinceLastResume(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  held: Extract<EventType, 'skill.authoring-held' | 'surface.orientation-held'>,
  takenUp: readonly Extract<
    EventType,
    | 'skill.authoring-resumed'
    | 'skill.authoring-hold-spent'
    | 'surface.orientation-resumed'
    | 'surface.orientation-hold-spent'
  >[],
): Promise<Doc<'events'>[]> {
  // A hold is taken up by a resume that starts it or spends it (W13-R46), so the newest of either
  // kind bounds what is still held.
  const newest = await Promise.all(
    takenUp.map(async (type) => await eventsOfType(ctx, agentId, type).order('desc').first()),
  );
  const last = Math.max(-1, ...newest.map((event) => event?._creationTime ?? -1));
  return await eventsOfType(ctx, agentId, held, last < 0 ? undefined : { after: last })
    .order('desc')
    .take(HELD_STARTS_READ);
}

/**
 * Start the authoring of every skill a pause held since the last resume, once each: a skill the
 * manager has since rejected, retired or given up, one a run holds now, and one claimed since its
 * hold (a stored version's check, a press after the pause) is left to the state it is in: its hold
 * is spent, and recorded as spent with why, so no later resume reads it again and one skill
 * started beside it cannot decide its fate instead (W13-R46). The claim decides the rest, as it
 * does for a manager's press.
 *
 * @returns How many authorings were started.
 */
async function resumeHeldAuthoring(ctx: MutationCtx, agentId: Id<'agents'>): Promise<number> {
  const now = Date.now();
  const seen = new Set<string>();
  let started = 0;
  for (const event of await heldSinceLastResume(ctx, agentId, 'skill.authoring-held', [
    'skill.authoring-resumed',
    'skill.authoring-hold-spent',
  ])) {
    const skillId = payloadId(event.payload, 'skillId') as Id<'skills'> | undefined;
    if (skillId === undefined || seen.has(skillId)) continue;
    seen.add(skillId);
    const skill = await ctx.db.get(skillId);
    const why =
      skill === null
        ? 'gone'
        : (authoringSpentWhy(skill, now) ??
          ((await claimedSince(ctx, agentId, skillId, event._creationTime))
            ? 'claimed'
            : undefined));
    if (why !== undefined) {
      const named = (event.payload as { name?: unknown }).name;
      await appendEvent(ctx, {
        agentId,
        type: 'skill.authoring-hold-spent',
        payload: {
          skillId,
          name: skill?.name ?? (typeof named === 'string' ? named : 'unnamed'),
          why,
        },
        createdAt: now,
      });
      continue;
    }
    if (skill === null) continue;
    await ctx.scheduler.runAfter(0, internal.skillActions.authorAndRegisterSkillInternal, {
      skillId,
    });
    await appendEvent(ctx, {
      agentId,
      type: 'skill.authoring-resumed',
      payload: { skillId, name: skill.name },
      createdAt: now,
    });
    started += 1;
  }
  return started;
}

/** Whether an event's payload names a row by this field; the id, or undefined when it does not. */
function payloadId(payload: unknown, field: 'skillId' | 'surfaceId'): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/** Whether the skill was claimed after its hold, which spends the hold. */
async function claimedSince(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  skillId: Id<'skills'>,
  heldAt: number,
): Promise<boolean> {
  const claims = await eventsOfType(ctx, agentId, 'skill.authoring-claimed', { after: heldAt })
    .order('desc')
    .take(HELD_STARTS_READ);
  return claims.some((claim) => payloadId(claim.payload, 'skillId') === skillId);
}

/**
 * Why a held authoring does not go on, or undefined when it does: the skill is no longer in a
 * state a claim takes or has no attempts left (`decided`: what the manager decided since, a
 * rejection, a give-up, a retire, stands), or a live run holds it (`running`).
 *
 * @param skill - The skill as the resume reads it.
 * @param now - The instant to judge a run's claim against.
 */
function authoringSpentWhy(
  skill: Doc<'skills'>,
  now: number,
): Extract<HeldAuthoringSpentWhy, 'decided' | 'running'> | undefined {
  if (!(AUTHORING_CLAIMABLE_STATES as readonly string[]).includes(skill.state)) return 'decided';
  if (skill.state === 'failed' && (skill.authoringAttempts ?? 0) >= MAX_AUTHORING_ATTEMPTS) {
    return 'decided';
  }
  return holdsLiveAuthoringClaim(skill, now) ? 'running' : undefined;
}

/**
 * Orient again every system a pause held since the last resume, once each and as it was asked
 * for (the manager's request for its card kept when any of its holds carried one), clearing the
 * held line its card shows and recording the job as the surface's orientation in flight. A system
 * no longer declared (oriented by a manager's re-run, or found absent) is left as it is, its hold
 * recorded as spent.
 *
 * @returns How many orientations were started.
 */
async function resumeHeldOrientation(ctx: MutationCtx, agentId: Id<'agents'>): Promise<number> {
  const now = Date.now();
  const requested = new Map<string, boolean>();
  for (const event of await heldSinceLastResume(ctx, agentId, 'surface.orientation-held', [
    'surface.orientation-resumed',
    'surface.orientation-hold-spent',
  ])) {
    const surfaceId = payloadId(event.payload, 'surfaceId');
    if (surfaceId === undefined) continue;
    const asked = (event.payload as { requested?: unknown }).requested === true;
    requested.set(surfaceId, (requested.get(surfaceId) ?? false) || asked);
  }
  let started = 0;
  for (const [id, asked] of requested) {
    const surfaceId = id as Id<'surfaces'>;
    const surface = await ctx.db.get(surfaceId);
    if (surface === null || surface.verdict !== 'declared') {
      // Settled while the pause held it: the hold is spent (W13-R46).
      await appendEvent(ctx, {
        agentId,
        type: 'surface.orientation-hold-spent',
        payload: { surfaceId, why: 'settled' },
        createdAt: now,
      });
      continue;
    }
    const orientationJobId = await ctx.scheduler.runAfter(
      0,
      internal.orientationActions.orientOne,
      { surfaceId, requested: asked },
    );
    await ctx.db.patch(surfaceId, { reason: undefined, orientationJobId });
    await appendEvent(ctx, {
      agentId,
      type: 'surface.orientation-resumed',
      payload: { surfaceId },
      createdAt: now,
    });
    started += 1;
  }
  return started;
}

/**
 * Start what a pause held of one employee's authoring and orientation, in the resume's
 * transaction (or the sweep's, once the deployment's work runs again). The caller has checked that
 * the employee's steps may run.
 *
 * @param ctx - Mutation context.
 * @param agentId - The employee.
 * @returns How many starts were scheduled.
 */
export async function resumeHeldStartsInTransaction(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
): Promise<number> {
  return (await resumeHeldAuthoring(ctx, agentId)) + (await resumeHeldOrientation(ctx, agentId));
}
