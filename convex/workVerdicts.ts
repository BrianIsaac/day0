import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { waitingStamp } from '../src/work/needs-manager';
import { permissionDeferralReason } from '../src/work/deferral-reason';
import { openSlotCount, scheduleNextStep, STEP_LEASE_MS } from './workLoop';
import { verdictFor } from '../src/surfaces/verdict';
import { autonomousActionsOn } from '../src/work/autonomy';
import {
  AUTONOMOUS_WIP_LIMIT,
  COLD_START_WIP_LIMIT,
  SCOPE_JUDGEMENT_UNAVAILABLE,
} from '../src/work/types';
import type { ClaimHolder } from '../src/work/claim-key';
import { isRevocationTrialRow } from './revocationEvaluation';
import { browserComponentRefusal, withBrowserComponentState } from '../src/surfaces/browser';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { missingSurfaceResolvedBy } from '../src/surfaces/identity';
import { appendEvent, eventsOfType } from './eventLog';
import {
  type ParkedVerdict,
  REEVALUATION_BATCH,
  reevaluationSpent,
  reevaluationStamp,
} from './workReevaluation';
import {
  claimRefusedVerdict,
  externalClaimHeldElsewhere,
  logClaimRefused,
  takeExternalClaim,
} from './workClaims';

/*
 * The verdict path (the wave 14 review's D-6, the standard's 9.2): an evaluation's verdict, the
 * claim it takes or is refused, the readmission of a row whose wait ended while it was judged, and
 * the requeue behind a skill that registered; moved out of `convex/work.ts` unchanged. Its
 * schedules still name `work:recoverUnproposedSkill` and `work:readmitSatisfiedDeferrals`, which
 * stay registered in `convex/work.ts` with `work:setVerdict`. This module sits below
 * `convex/work.ts`: `convex/work.ts` imports it and it never imports `./work`, so the move closes
 * no import cycle. It registers no function.
 */

/** The verdicts that park a row until a skill or a connection arrives; they check the claim and take none. */
const PARKING_DECISIONS: ReadonlySet<string> = new Set(['needs-skill', 'defer']);

/** What a parked verdict waits on, as the evaluator and the skill pane write it. */
type WaitingVerdict = ParkedVerdict & { suggestedSkillName?: string };

/** What the owner of the registration race did with a row. */
type RegisteredSkillOutcome = 'requeued' | 'skipped' | 'left';

/** A re-admission decided where a verdict is written, linked or checked, not by a policy change. */
type SatisfiedTrigger = 'verdict-write' | 'check' | 'skill-registered';

/**
 * Whether what a waiting verdict names is present now, and under which key.
 *
 * An evaluation reads the surfaces and the grants, judges scope with a model
 * call, and writes its verdict seconds later; the connection or the grant can
 * land in between, and the write that landed it re-admits only rows already
 * parked. The key names the state of the thing waited on: a connection's is
 * the one `recordConnected` stamps, so one connection buys a row one
 * re-evaluation whichever path gives it.
 *
 * A `needs-skill` verdict naming a skill that registered meanwhile is not
 * answered here. That race belongs to `requeueBehindRegisteredSkill`, which
 * the proposal step reaches in every mode, so the race has one owner and one
 * key whatever the mode. (Two readers with a key each once overwrote one
 * another on the row's single `reevaluation` key and re-admitted the row in
 * turn for ever; the row now keeps every key it has spent.)
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: The employee.
 *   verdict: The defer verdict.
 *   now: The instant to judge surface liveness against.
 *
 * Returns:
 *   The key of what satisfies the verdict and what landed, in words for the
 *   card, or undefined while it still waits.
 */
async function waitSatisfiedBy(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  verdict: WaitingVerdict,
  now: number,
): Promise<{ key: string; landed: string } | undefined> {
  if (verdict.decision === 'defer' && verdict.reason === 'awaiting-connection') {
    const missing = verdict.missingSurface;
    if (typeof missing !== 'string') return undefined;
    // The surfaces as the evaluation reads them: a browser-driven surface this
    // deployment cannot drive is not connected, whatever its last probe said.
    const refusal = browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL);
    const surfaces = (
      await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (index) => index.eq('agentId', agentId))
        .collect()
    ).map((surface) => withBrowserComponentState(surface, refusal));
    const live = surfaces.find(
      (surface) =>
        verdictFor(surface, now) === 'connected' &&
        missingSurfaceResolvedBy(missing, surface, surfaces),
    );
    return live
      ? { key: `surface:${live._id}:${live.lastVerifiedAt}`, landed: `${live.slug} connected` }
      : undefined;
  }
  if (verdict.decision === 'defer' && verdict.reason === SCOPE_JUDGEMENT_UNAVAILABLE) {
    // Check for new work asks the judgement again, once per lease window, so
    // an outage that outlasted the attempts ends at the manager's check.
    return {
      key: `scope-retry:${Math.floor(now / STEP_LEASE_MS)}`,
      landed: 'the scope judgement is asked again',
    };
  }
  if (verdict.decision === 'defer' && verdict.reason === 'awaiting-permission') {
    // The verdict arrives as `v.any()`: a shape the evaluator never writes
    // parks as written rather than failing the write that ends the step.
    const named = Array.isArray(verdict.missingPermissions) ? verdict.missingPermissions : [];
    const scopes = [...new Set(named)]
      .filter((scope): scope is string => typeof scope === 'string')
      .sort();
    if (scopes.length === 0 || scopes.length !== new Set(named).size) return undefined;
    const grants: string[] = [];
    for (const scope of scopes) {
      const grant = (
        await ctx.db
          .query('permissionGrants')
          .withIndex('by_agent_scope', (index) => index.eq('agentId', agentId).eq('scope', scope))
          .collect()
      ).find((row) => row.revokedAt === undefined);
      if (!grant) return undefined;
      grants.push(grant._id);
    }
    return { key: `grants:${grants.join(',')}`, landed: `${scopes.join(', ')} granted` };
  }
  return undefined;
}

/**
 * The registered skill a `needs-skill` verdict names, if there is one.
 *
 * Only the evaluator writes `suggestedSkillName`; the verdicts `convex/skills.ts`
 * applies after a failed or unverified authoring run name none.
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: The employee.
 *   verdict: The verdict on the row.
 *
 * Returns:
 *   The registered skill of that name, or undefined.
 */
async function registeredSkillNamedBy(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  verdict: WaitingVerdict,
): Promise<Doc<'skills'> | undefined> {
  const name = verdict.suggestedSkillName;
  if (verdict.decision !== 'needs-skill' || typeof name !== 'string' || name === '') {
    return undefined;
  }
  return (
    await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (index) => index.eq('agentId', agentId).eq('name', name))
      .collect()
  ).find((row) => row.state === 'registered');
}

/** One registration of one skill: a revision clears `registeredAt`, so the next is a new key. */
function skillRegistrationKey(skill: Doc<'skills'>): string {
  return `skill-registered:${skill._id}:${skill.registeredAt ?? 0}`;
}

/**
 * Re-queue a row whose `needs-skill` verdict names a skill that has registered.
 *
 * The one owner of "the skill registered while this item was being
 * evaluated". An evaluation reads the skill list, spends its time in a model,
 * and writes its verdict afterwards. A registration that lands in between has
 * already re-queued the rows waiting then, so this row arrives at a callable
 * skill with nobody left to move it. The verdict write parks it as written;
 * the proposal step that follows (`skills.propose`) calls this, in every
 * mode, and Check for new work calls it for a row whose proposal step never
 * ran. The row is sent back once per registration, keyed among the keys its
 * `reevaluation` record has spent, so no other kind of re-admission in
 * between buys the registration a second turn. A second `needs-skill` naming the same registration
 * was decided with the skill on the list, so the skill does not cover the
 * row: it is skipped with that reason, which leaves it a Retry on its card,
 * rather than evaluated for ever or parked where nothing moves it.
 *
 * Args:
 *   ctx: Mutation context.
 *   skill: The registered skill the verdict names.
 *   workItemId: The row the verdict was written on.
 *   via: Who reached the row, for the `work.requeued` event: the proposal
 *     step, or Check for new work.
 *
 * Returns:
 *   Whether the row was re-queued, skipped, or was not waiting and left alone.
 */
export async function requeueBehindRegisteredSkill(
  ctx: MutationCtx,
  skill: Doc<'skills'>,
  workItemId: Id<'workItems'>,
  via: 'skill-registered' | 'check' = 'skill-registered',
): Promise<RegisteredSkillOutcome> {
  const item = await ctx.db.get(workItemId);
  if (!item || item.state !== 'needs-skill' || item.agentId !== skill.agentId) return 'left';
  const key = skillRegistrationKey(skill);
  if (reevaluationSpent(item, key)) {
    await applyVerdict(ctx, workItemId, {
      decision: 'skip',
      reason: `registered skill "${skill.name}" was tried and does not cover this item`,
    });
    return 'skipped';
  }
  const at = Date.now();
  await ctx.db.patch(workItemId, {
    proposedSkillId: skill._id,
    reevaluation: reevaluationStamp(item, 'skill-registered', key, at),
  });
  await applyVerdict(ctx, workItemId, {
    decision: 'pending-reevaluation',
    reason: 'skill registered, ready to retry',
  });
  await logSatisfiedRequeue(ctx, item, via, key, (item.verdict ?? {}) as WaitingVerdict, at);
  return 'requeued';
}

/** The employee to check and the creation-time watermarks a continuation resumes from. */
interface ReadmitSatisfiedArgs {
  agentId: Id<'agents'>;
  after?: { deferred?: number; needsSkill?: number };
}

/** The `work.requeued` event of a row re-admitted because its wait is over. */
async function logSatisfiedRequeue(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  trigger: SatisfiedTrigger,
  key: string,
  waited: WaitingVerdict,
  now: number,
): Promise<void> {
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.requeued',
    payload: {
      workItemId: row._id,
      trigger,
      key,
      previousState: row.state,
      ...(waited.missingSurface ? { previousMissingSurface: waited.missingSurface } : {}),
    },
    createdAt: now,
  });
}

/**
 * Re-admit the parked rows whose wait is already over.
 *
 * A row deferred on a surface that has since connected, or on grants that
 * are all live, goes back to `discovered` for a fresh evaluation. Each row
 * returns once per key of the thing it waited on, so a row the evaluator
 * parks again for the same connection stays parked until the connection
 * changes. A row parked at `needs-skill` naming a skill that is registered is
 * handed to `requeueBehindRegisteredSkill`: back once per registration, then
 * skipped with the reason. A batch of
 * `REEVALUATION_BATCH` rows per state is examined; when a batch fills, the
 * rest is scheduled as a continuation carrying creation-time watermarks.
 *
 * Args:
 *   ctx: Mutation context.
 *   args: The employee and, for a continuation, where to resume.
 *   now: The instant to judge liveness against and to stamp.
 *
 * Returns:
 *   How many rows were re-admitted and examined, and whether a continuation was scheduled.
 */
export async function readmitSatisfiedInTransaction(
  ctx: MutationCtx,
  args: ReadmitSatisfiedArgs,
  now: number,
): Promise<{ readmitted: number; examined: number; continued: boolean }> {
  const after: ReadmitSatisfiedArgs['after'] = { ...args.after };
  let readmitted = 0;
  let examined = 0;
  let continued = false;
  for (const [state, mark] of [
    ['deferred', 'deferred'],
    ['needs-skill', 'needsSkill'],
  ] as const) {
    const watermark = after[mark];
    const rows = await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (index) => {
        const range = index.eq('agentId', args.agentId).eq('state', state);
        return watermark === undefined ? range : range.gt('_creationTime', watermark);
      })
      .take(REEVALUATION_BATCH);
    for (const row of rows) {
      examined += 1;
      if (isRevocationTrialRow(row)) continue;
      const waited = (row.verdict ?? {}) as WaitingVerdict;
      // A row behind a registered skill goes to that race's one owner, under
      // its key and its once-then-skip rule, so the check and the proposal
      // step cannot each give the row a turn.
      const skill = await registeredSkillNamedBy(ctx, args.agentId, waited);
      if (skill) {
        const outcome = await requeueBehindRegisteredSkill(ctx, skill, row._id, 'check');
        if (outcome === 'requeued') readmitted += 1;
        continue;
      }
      const satisfied = await waitSatisfiedBy(ctx, args.agentId, waited, now);
      if (!satisfied || reevaluationSpent(row, satisfied.key)) continue;
      await ctx.db.patch(row._id, {
        state: 'discovered',
        verdict: undefined,
        // The wait is over, so the reason that said what it waited on goes with it (RM12 (c)).
        skipReason: undefined,
        reevaluation: reevaluationStamp(row, 'check', satisfied.key, now),
        evaluationAttempts: undefined,
        evaluationUnavailableAt: undefined,
        evaluationUnavailableCause: undefined,
      });
      await logSatisfiedRequeue(ctx, row, 'check', satisfied.key, waited, now);
      await scheduleNextStep(ctx, { ...row, state: 'discovered', verdict: undefined });
      readmitted += 1;
    }
    if (rows.length === REEVALUATION_BATCH) {
      after[mark] = rows[rows.length - 1]._creationTime;
      continued = true;
    } else {
      delete after[mark];
    }
  }
  if (continued) {
    await ctx.scheduler.runAfter(0, internal.work.readmitSatisfiedDeferrals, {
      agentId: args.agentId,
      after,
    });
  }
  return { readmitted, examined, continued };
}

/**
 * The charter a verdict names: the one the evaluation read, when it is this
 * employee's, else the newest approved charter. A draft awaiting approval
 * decides nothing, so no verdict names one.
 *
 * @param ctx - The verdict's mutation context.
 * @param agentId - The employee.
 * @param evaluatedCharterId - The charter the evaluation read, when it said.
 * @returns The charter row, or undefined when the employee has no approved one.
 */
async function verdictCharter(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  evaluatedCharterId: Id<'charters'> | undefined,
): Promise<Doc<'charters'> | undefined> {
  const evaluated = evaluatedCharterId ? await ctx.db.get(evaluatedCharterId) : null;
  if (evaluated?.agentId === agentId && evaluated.approved) return evaluated;
  const recent = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc')
    .take(VERDICT_CHARTER_READ);
  return recent.find((charter) => charter.approved);
}

/**
 * Whether a queue verdict repeats the row's standing one: queued for the same reason, and judged
 * under the charter its last evaluation named. A judgement under a newer approved charter is a
 * new one, so the record names the rules that decided it (Q14).
 */
async function repeatsQueuedJudgement(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  effective: { decision: string; [key: string]: unknown },
  evaluatedCharterId: Id<'charters'> | undefined,
): Promise<boolean> {
  const standing = row.verdict as { decision?: unknown; reason?: unknown } | undefined;
  if (standing?.decision !== 'queue' || standing.reason !== effective.reason) return false;
  const [charter, recent] = await Promise.all([
    verdictCharter(ctx, row.agentId, evaluatedCharterId),
    eventsOfType(ctx, row.agentId, 'work.evaluated').order('desc').take(REEVALUATION_BATCH),
  ]);
  const last = recent.find(
    (event) => (event.payload as { workItemId?: unknown }).workItemId === row._id,
  );
  return (last?.payload as { charterId?: unknown } | undefined)?.charterId === charter?._id;
}

/**
 * The newest charter rows a verdict looks through for an approved one: drafts
 * sent back and redrafted stack above it only a few deep.
 */
const VERDICT_CHARTER_READ = 20;

/**
 * Record an evaluation verdict and move the row to where it puts it.
 *
 * A plain helper rather than only a mutation, because `skills.completeRegistration`
 * has to requeue every work item waiting for a skill inside the same
 * transaction that registers the skill - a registered, callable skill with a
 * work item still parked at `needs-skill` behind it is a state nothing in the
 * product knows how to leave.
 *
 * The `work.evaluated` event names `evaluatedCharterId` when the caller read
 * one (the evaluation stage), else the newest approved charter.
 */
export async function applyVerdict(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  verdict: unknown,
  evaluatedCharterId?: Id<'charters'>,
): Promise<{ decision: string; [key: string]: unknown }> {
  const row = await ctx.db.get(workItemId);
  if (!row) throw new Error('workItem not found');
  const proposed = verdict as { decision: string; [key: string]: unknown };

  // Late-arriving verdict guard: a verdict is the entry transition from
  // `discovered` (initial evaluation) or `needs-skill` (pending-reevaluation
  // after a skill registers). If the row has already advanced past these -
  // claimed, plan-pending, plan-approved, executing, completed, etc. - a stale
  // verdict must NOT stomp the row's state, which would wipe a drafted plan or
  // running execution. Ignore silently.
  if (row.state !== 'discovered' && row.state !== 'needs-skill') {
    return proposed;
  }

  let effective = proposed;
  if (proposed.decision === 'claim') {
    const agent = await ctx.db.get(row.agentId);
    if (!agent) throw new Error('agent not found');
    const autonomous = autonomousActionsOn(agent);
    const wipCap = autonomous ? AUTONOMOUS_WIP_LIMIT : COLD_START_WIP_LIMIT;
    const openClaims = await openSlotCount(ctx, row.agentId, wipCap);
    if (openClaims >= wipCap) {
      const posture = autonomous ? 'autonomous concurrency' : 'supervised cold-start';
      effective = {
        decision: 'queue',
        reason: `WIP cap reached: ${posture} limit is ${wipCap}`,
        openClaims,
      };
    }
  }

  // One work item holds each provider item across the owner's employees: the
  // claim is taken here, in the claiming transaction, or the verdict becomes
  // a skip naming who holds it. A verdict that parks the row for a skill or a
  // connection takes nothing, but a colleague's hold still skips it.
  let refused: { key: string; holder: ClaimHolder } | undefined;
  const claimRead =
    effective.decision === 'claim'
      ? await takeExternalClaim(ctx, row, Date.now())
      : PARKING_DECISIONS.has(effective.decision)
        ? await externalClaimHeldElsewhere(ctx, row, Date.now())
        : undefined;
  if (claimRead?.heldBy) {
    effective = claimRefusedVerdict(row, claimRead.heldBy.holder, claimRead.heldBy.state);
    refused = { key: claimRead.key, holder: claimRead.heldBy.holder };
  }

  // A verdict that waits on a surface or a grant was computed from reads taken
  // before the model call. When what it names is present by now, parking the
  // row would strand it: the write that landed it has already looked for
  // parked rows and found this one still `discovered`. The row goes back for
  // a fresh evaluation instead, once per key, so an evaluator that keeps
  // disagreeing with this read parks on its second verdict. A `needs-skill`
  // naming a skill that registered meanwhile parks as written: the proposal
  // step that follows hands it to `requeueBehindRegisteredSkill`.
  let readmission: { key: string; waited: WaitingVerdict; at: number } | undefined;
  if (SURFACE_MODE === 'real' && !isRevocationTrialRow(row)) {
    const at = Date.now();
    const waited = effective as WaitingVerdict;
    const satisfied = await waitSatisfiedBy(ctx, row.agentId, waited, at);
    if (satisfied && !reevaluationSpent(row, satisfied.key)) {
      readmission = { key: satisfied.key, waited, at };
      effective = {
        decision: 'pending-reevaluation',
        reason: `${satisfied.landed} while this was being evaluated`,
        superseded: effective,
      };
    }
  }

  // A queued row judged again with no slot free is the same judgement, not a new one: the mock
  // loop asks after every change to the queue, and the record says it once (the redeploy walk
  // saw "queued behind its open work" twice). Only the evaluation step's own marks are cleared.
  // Real mode is left as it was: its loop never judges a queued row while no slot is free.
  if (
    SURFACE_MODE !== 'real' &&
    row.state === 'discovered' &&
    effective.decision === 'queue' &&
    (await repeatsQueuedJudgement(ctx, row, effective, evaluatedCharterId))
  ) {
    if (
      row.evaluationClaimedAt !== undefined ||
      row.evaluationAttempts !== undefined ||
      row.evaluationUnavailableAt !== undefined ||
      row.evaluationUnavailableCause !== undefined
    ) {
      await ctx.db.patch(workItemId, {
        evaluationClaimedAt: undefined,
        evaluationAttempts: undefined,
        evaluationUnavailableAt: undefined,
        evaluationUnavailableCause: undefined,
      });
    }
    await scheduleNextStep(ctx, { ...row, verdict: effective });
    return effective;
  }

  const decision = effective.decision;
  let nextState: Doc<'workItems'>['state'] = 'discovered';
  let skipReason: string | undefined;
  let deferralReason: string | undefined;
  if (decision === 'claim') nextState = 'claimed';
  else if (decision === 'skip') {
    nextState = 'skipped';
    skipReason = effective.reason as string | undefined;
  } else if (decision === 'queue') nextState = 'discovered';
  else if (decision === 'defer') {
    nextState = 'deferred';
    // A deferral for a missing permission says which, in words the manager reads (RM12 (c)): the
    // row held only the verdict's code. Whatever sends the row back clears it: the readmission of
    // a satisfied wait below, and the re-evaluation of parked rows (`workReevaluation.ts`).
    if (effective.reason === 'awaiting-permission') {
      const employee = await ctx.db.get(row.agentId);
      deferralReason = permissionDeferralReason(
        { missingPermissions: effective.missingPermissions },
        employee?.name ?? 'the employee',
      );
    }
  } else if (decision === 'needs-skill') nextState = 'needs-skill';
  await ctx.db.patch(workItemId, {
    verdict: effective,
    state: nextState,
    ...waitingStamp(nextState, Date.now()),
    ...(nextState === 'claimed' ? { claimedAt: Date.now() } : {}),
    ...(skipReason ? { skipReason } : {}),
    ...(deferralReason ? { skipReason: deferralReason } : {}),
    // The verdict ends the evaluation step; a row queued at the cap must be
    // evaluable again the moment a slot frees, and counts no attempt.
    ...(row.evaluationClaimedAt !== undefined ? { evaluationClaimedAt: undefined } : {}),
    evaluationAttempts: undefined,
    evaluationUnavailableAt: undefined,
    evaluationUnavailableCause: undefined,
    ...(readmission
      ? { reevaluation: reevaluationStamp(row, 'verdict-write', readmission.key, readmission.at) }
      : {}),
  });
  // The verdict names the charter it was reached under, so the trail says
  // which rules decided (Q14): the one the evaluation read, else the newest
  // approved one, never a draft above it (review M17).
  const charter = await verdictCharter(ctx, row.agentId, evaluatedCharterId);
  const evaluatedId = await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.evaluated',
    payload: {
      workItemId,
      decision,
      verdict: effective,
      ...(charter ? { charterId: charter._id, charterVersion: charter.version } : {}),
    },
    createdAt: Date.now(),
  });
  // The proposal is written by the evaluating action after this commit; if it
  // throws, nothing else ever moves the row (P5-2).
  if (nextState === 'needs-skill' && SURFACE_MODE === 'real') {
    await ctx.scheduler.runAfter(STEP_LEASE_MS, internal.work.recoverUnproposedSkill, {
      workItemId,
      evaluatedId,
    });
  }
  if (nextState === 'skipped') {
    // A skip ends the item: its terminal event, as every terminal transition writes one.
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.skipped',
      payload: { workItemId, ...(skipReason ? { reason: skipReason } : {}) },
      createdAt: Date.now(),
    });
  }
  if (readmission) {
    await logSatisfiedRequeue(
      ctx,
      row,
      'verdict-write',
      readmission.key,
      readmission.waited,
      readmission.at,
    );
  }
  if (refused) await logClaimRefused(ctx, row, refused);
  await scheduleNextStep(ctx, { ...row, state: nextState, verdict: effective });
  return effective;
}
