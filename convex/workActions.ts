'use node';

import { v } from 'convex/values';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { api, internal } from './_generated/api';
import {
  evaluateCandidate,
  inferRequiredPermissions,
  type EvaluateLookups,
} from '../src/work/evaluate';
import { spanModelFromEnv } from '../src/redaction/client';
import {
  candidateRecordRead,
  redactGroundingRead,
  draftExecutionPlan,
  type CandidateRecord,
  type DraftPlanArgs,
} from '../src/work/plan';
import {
  ClosingGateRefusal,
  DEFERRALS_KEPT,
  deferralAudit,
  dependentActionCap,
  HELD_ITEM_REPLY_COMPLETED,
  removePrewrittenClosingActions,
  repairableReadFailures,
  repairFailedReads,
  repairHeldWriteArguments,
  repairToolArguments,
  withArgumentRepairs,
  withholdActions,
  runDependentSkill,
  runSkill,
} from '../src/work/execute-skill';
import type { Charter } from '../src/agent/charter';
import {
  type ArgumentRepairAttempt,
  type DependentExecutionOutput,
  type ExecutionPlan,
  type ManagerAnswer,
  type MockAction,
  type PlanStepOutcome,
  type RefusedClosing,
  type WorkCandidate,
  type WorkSourceCategory,
} from '../src/work/types';
import {
  closingPhaseOwed,
  declaredReads,
  openManagerQuestion,
  openQuestionStopReason,
  transitionPromised,
  withheldForAnswerReason,
  type DeclaredRead,
} from '../src/work/obligations';
import { replyTargetFor } from '../src/work/reply-target';
import type { Doc, Id } from './_generated/dataModel';
import { asAgentId } from '../src/lib/ids';
import {
  applySurfaceActions,
  readSurfaceSnapshot,
  type ClaimHold,
  type RealAdapterDeps,
} from '../src/surfaces/registry';
import { heldItemOfBlockedStep, heldItemReplyFindings, plannedWriteTargets, withHeldItemsSaid, withheldByClaim, withheldByClaimReason, writeTargetIds, type HeldExternalItem } from '../src/work/claim-key';
import type { AppliedAction, BeforeSurfaceTransport, SurfaceRecord } from '../src/surfaces/types';
import { decryptCredential } from '../src/surfaces/credentials';
import { ownerKnownValues, scrubKnownValues } from '../src/redaction/known-values';
import { createMastraMcpClient } from '../src/surfaces/mcp';
import { toSurfaceRecord } from '../src/surfaces/records';
import { ledgerRunIds } from '../src/surfaces/browser-session';
import { carriedReadIndexes, rereadStopReason, withRereads, type FailedReread } from '../src/surfaces/rereads';
import { verdictFor } from '../src/surfaces/verdict';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { observeModelCalls, type ModelCallReport } from '../src/lib/model-call-telemetry';
import { browserComponent } from '../src/surfaces/browser';
import type { ExecutionOutput, LandedWrite, SkillShape } from '../src/work/types';
import {
  sameSkillShape,
  skillOperationLabel,
  skillShapeFor,
  skillSurfacePhrase,
  type ShapeSurface,
} from '../src/work/skill-shape';
import { autonomousActionsOn } from '../src/work/autonomy';
import { liveManagerFeedback } from '../src/work/manager-feedback';
import {
  scrubbedCorrectionEntries,
  type PlannerCorrection,
} from '../src/work/corrections';
import { droppedReadRefusal, gateRefusalStop, landedWork, WITHHELD_ON_STOP, withRefusedReadsDropped } from '../src/work/stop';
import { resumedClosingLedger, type ClosingResume } from '../src/work/closing-resume';
import { landedWritesOf, reusedLedger } from '../src/work/landed-writes';
import type { GroundingRead } from '../src/work/evidence-claims';
import { carriedDeclaredReads, groundingReadSurfaces, noteReleasesRead } from '../src/work/promised-reads';
import { actionIdempotencyKey } from '../src/work/idempotency';
import { redactTokenShapes } from '../src/surfaces/redact';
import {
  grantRefusal,
  actionIntent,
  describeAction,
  isAutomatic,
  isAuditComment,
  isGateRefusal,
  isManagerDm,
  isStatusChange,
  needsStandingGrant,
  NOT_AUTOMATIC,
  mcpEndpointRefusal,
  parseSurfaceAction,
  type ParsedSurfaceAction,
  pathRefusal,
  replayAuthorityRefusal,
  surfaceRefusal,
  toolRefusal,
  UNKNOWN_SURFACE,
} from '../src/surfaces/policy';

/**
 * Node actions for the work loop — Layer-2 evaluation, Layer-3 plan
 * draft, and post-approval skill execution.
 *
 * Each handler derives its agent from the work item it loaded rather than
 * accepting one as an argument. `api.work.get` proves the caller owns that
 * item's agent; a separately supplied agent id proves only that the caller
 * owns *some* agent, which is enough to run one agent's approved work against
 * another's charter, skills and work environment.
 */

interface SimpleSkillRow {
  _id: Id<'skills'>;
  name: string;
  description: string;
  body: string;
  requiredScopes?: string[];
  targetSurface?: string;
  surfaceClass?: string;
  operation?: string;
}

interface MatchableSkill {
  name: string;
  description: string;
  requiredScopes?: readonly string[];
  targetSurface?: string;
  surfaceClass?: string;
  operation?: string;
}

interface SkillMatchCandidate {
  sourceSystem: string;
  title: string;
  contentSummary: string;
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/\W+/)
    .filter(Boolean);
}

function declaredSurfaces(skill: MatchableSkill): Set<string> {
  const surfaces = new Set<string>();
  if (skill.targetSurface) surfaces.add(skill.targetSurface.toLowerCase());
  for (const scope of skill.requiredScopes ?? []) {
    const match = /^([^:]+):(?:read|write)$/.exec(scope.toLowerCase());
    if (match) surfaces.add(match[1]);
  }
  return surfaces;
}

/**
 * The registered skill that covers a candidate.
 *
 * A skill proposed by shape is matched by shape and nothing else: the one
 * registered row whose surface class and operation are the candidate's. Rows
 * without a shape (the builtin docs skill, and skills proposed before shapes
 * existed) are served by the older token match, so they keep working until
 * the operator retires them; they are never preferred over a shaped match.
 *
 * Args:
 *   candidate: The work being evaluated or executed.
 *   skills: The agent's registered skills.
 *   shape: The candidate's shape, from `skillShapeFor`.
 *
 * Returns:
 *   The covering skill, or undefined when none does.
 */
export function findMatchingSkillForCandidate<T extends MatchableSkill>(
  candidate: SkillMatchCandidate,
  skills: readonly T[],
  shape: SkillShape,
): T | undefined {
  const shaped = skills.find(
    (skill: T): boolean =>
      skill.surfaceClass !== undefined &&
      skill.operation !== undefined &&
      sameSkillShape({ surfaceClass: skill.surfaceClass, operation: skill.operation }, shape),
  );
  if (shaped) return shaped;
  if (shape.operation === 'read') return undefined;

  const source = candidate.sourceSystem.toLowerCase();
  const sourceTokens = tokens(candidate.sourceSystem);
  const candidateTokens = new Set(
    tokens(`${candidate.title} ${candidate.contentSummary}`).filter((token) => token.length >= 4),
  );
  let best: T | undefined;
  let bestScore = 0;

  for (const skill of skills) {
    if (skill.surfaceClass !== undefined && skill.operation !== undefined) continue;
    const surfaces = declaredSurfaces(skill);
    const skillTokens = new Set(tokens(`${skill.name} ${skill.description}`));
    const sourceCompatible =
      surfaces.size > 0
        ? surfaces.has(source)
        : sourceTokens.some((token) => skillTokens.has(token));
    if (!sourceCompatible) continue;

    let score = 0;
    for (const token of candidateTokens) if (skillTokens.has(token)) score += 1;
    for (const token of sourceTokens) if (skillTokens.has(token)) score += 4;
    if (score > bestScore) {
      best = skill;
      bestScore = score;
    }
  }

  return bestScore >= 3 ? best : undefined;
}

/**
 * The registry description of a shape: what the skill does, for the panel
 * and the author. It names no work item, so a later item of the same shape
 * reads as covered by it.
 *
 * Args:
 *   shape: Surface class and operation.
 *
 * Returns:
 *   One sentence.
 */
export function skillDescriptionFor(shape: SkillShape): string {
  const label = skillOperationLabel(shape);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} on ${skillSurfacePhrase(shape)}, parameterised from each work item and its runbook.`;
}

function rowToCandidate(row: Doc<'workItems'>): WorkCandidate {
  return {
    sourceCategory: row.sourceCategory as WorkSourceCategory,
    sourceSystem: row.sourceSystem,
    externalId: row.externalId,
    title: row.title,
    contentSummary: row.contentSummary,
    contentRefs: row.contentRefs,
    observedAt: new Date(row.observedAt),
    priority: row.priority,
    requesterLabel: row.requesterLabel,
    owner: row.owner,
    requester: row.requester,
    replyTarget: replyTargetFor(row),
  };
}

function buildLookups(args: {
  ctx: ActionCtx;
  agentId: Id<'agents'>;
  registeredSkills: SimpleSkillRow[];
  grantedScopes: Set<string>;
  internalCaller: boolean;
}): EvaluateLookups {
  return {
    hasGrantForScope: async (scope) => args.grantedScopes.has(scope),
    findExistingClaim: async (sourceSystem, externalId) => {
      const lookup = { agentId: args.agentId, sourceSystem, externalId };
      return args.internalCaller
        ? await args.ctx.runQuery(internal.work.findExistingClaimInternal, lookup)
        : await args.ctx.runQuery(api.work.findExistingClaim, lookup);
    },
    countOpenClaims: async () => {
      return args.internalCaller
        ? await args.ctx.runQuery(internal.work.countOpenForAgentInternal, { agentId: args.agentId })
        : await args.ctx.runQuery(api.work.countOpenForAgent, { agentId: args.agentId });
    },
    findMatchingSkill: async (candidate, charter, shape) => {
      void charter;
      const skill = findMatchingSkillForCandidate(candidate, args.registeredSkills, shape);
      return skill ? { name: skill.name, description: skill.description } : null;
    },
  };
}

/** The loop steps whose model calls go on the item's events. */
type ModelCallStage = 'evaluation' | 'draft' | 'execution' | 'closing';

/**
 * Run one loop step with each of its model calls recorded on the item's
 * events as `work.model-call`, in real mode.
 *
 * The record is the retry wrapper's report (stage, agent, attempts, retries,
 * duration, outcome) and nothing of the prompt or the reply, so a step that
 * held its slot for five minutes reads afterwards as one slow call or as
 * retries. Mock mode writes nothing: its event feed is what the frozen
 * harness and the hosted demo read.
 *
 * Args:
 *   ctx: Convex action context.
 *   step: The item, its agent and which step this is.
 *   fn: The step's work.
 *
 * Returns:
 *   Whatever the step returns.
 */
async function recordingModelCalls<T>(
  ctx: ActionCtx,
  step: { agentId: Id<'agents'>; workItemId: Id<'workItems'>; stage: ModelCallStage },
  fn: () => Promise<T>,
): Promise<T> {
  if (SURFACE_MODE !== 'real') return await fn();
  return await observeModelCalls(async (report: ModelCallReport): Promise<void> => {
    await ctx.runMutation(internal.events.log, {
      agentId: step.agentId,
      type: 'work.model-call',
      payload: { workItemId: step.workItemId, stage: step.stage, ...report },
    });
  }, fn);
}

/**
 * Evaluate one discovered work item and store the verdict.
 *
 * The dashboard's public action and the server loop's internal one share
 * this handler; `internalCaller` swaps the ownership-checked reads for
 * internal ones, since a scheduled step has no caller. In real mode the step
 * claims the row first, so a second run arriving while this one holds the
 * model call returns at once.
 *
 * Args:
 *   ctx: Convex action context.
 *   args: The work item.
 *   internalCaller: Whether the caller is the scheduler rather than a page.
 *
 * Returns:
 *   The stored decision, or a `noop-` reason when the step was not this run's.
 */
async function evaluateWorkItemHandler(
  ctx: ActionCtx,
  args: { workItemId: Id<'workItems'> },
  internalCaller = false,
): Promise<{ decision: string }> {
  const item: Doc<'workItems'> | null = internalCaller
    ? await ctx.runQuery(internal.work.getInternal, { workItemId: args.workItemId })
    : await ctx.runQuery(api.work.get, { workItemId: args.workItemId });
  if (!item) throw new Error('workItem not found');
  const agentId = item.agentId;
  // Race-tolerance: the dashboard's auto-progress useEffect can fire
  // evaluateWorkItem after the item already moved past `discovered`
  // (e.g. evaluator + draftPlan on the same render tick). The
  // findExistingClaim self-match below would otherwise see the
  // item's own `claimed` state and stomp the verdict back to skip.
  // No-op cleanly in that case — same posture as draftPlan and
  // executeApprovedPlan (lines below).
  if (item.state !== 'discovered') {
    return { decision: `noop-state=${item.state}` };
  }
  if (SURFACE_MODE === 'real') {
    const claim = await ctx.runMutation(internal.work.claimLoopStep, {
      workItemId: args.workItemId,
      step: 'evaluation',
    });
    if (!claim.claimed) return { decision: `noop-${claim.reason}` };
  }
  const charterRow = internalCaller
    ? await ctx.runQuery(internal.charters.latestInternal, { agentId })
    : await ctx.runQuery(api.charters.latest, { agentId });
  if (!charterRow || !charterRow.approved) {
    throw new Error('cannot evaluate: charter not approved');
  }
  const charter = charterRow.body as Charter;
  const [agent, agentsMd, skillRows, grantRows, surfaceConfig, surfaces] = internalCaller
    ? await Promise.all([
        ctx.runQuery(internal.agents.getInternal, { agentId }),
        ctx.runQuery(internal.workspace.readFileInternal, { agentId, fileName: 'AGENTS.md' }),
        ctx.runQuery(internal.skills.registeredInternal, { agentId }),
        ctx.runQuery(internal.agents.grantedScopes, { agentId }),
        { mode: SURFACE_MODE },
        ctx.runQuery(internal.orientationData.surfacesForAgent, { agentId }),
      ])
    : await Promise.all([
        ctx.runQuery(api.agents.get, { agentId }),
        ctx.runQuery(api.workspace.readFile, {
          agentId,
          fileName: 'AGENTS.md',
        }),
        ctx.runQuery(api.skills.registered, { agentId }),
        ctx.runQuery(internal.agents.grantedScopes, { agentId }),
        ctx.runQuery(api.config.surfaceMode, {}),
        ctx.runQuery(api.surfaces.listForAgent, { agentId }),
      ]);
  if (!agent) throw new Error('agent not found');
  const registeredSkills: SimpleSkillRow[] = skillRows.map((s: Doc<'skills'>) => ({
    _id: s._id,
    name: s.name,
    description: s.description,
    body: s.body,
    requiredScopes: s.requiredScopes,
    targetSurface: s.targetSurface,
    surfaceClass: s.surfaceClass,
    operation: s.operation,
  }));
  const grantedScopes = new Set<string>(grantRows.map((g) => g.scope));

  const lookups = buildLookups({
    ctx,
    agentId,
    registeredSkills,
    grantedScopes,
    internalCaller,
  });
  const candidate = rowToCandidate(item);
  // A row judged in scope against the charter that is still the approved one
  // is not judged again: a skill registering, a slot freeing or a connection
  // landing changes nothing that judgement reads. A policy change clears the
  // admission when it sends the row back, and an amendment is a new charter.
  const scopeHeld =
    surfaceConfig.mode === 'real' && item.scopeAdmission?.charterId === charterRow._id;
  let scopeJudgementUnavailable: string | undefined;
  let scopeAdmission: { basis: string; namedBy?: string; overruled?: string[] } | undefined;
  const step = { agentId, workItemId: args.workItemId, stage: 'evaluation' } as const;
  const verdict = await recordingModelCalls(ctx, step, () => evaluateCandidate(
    candidate,
    {
      agentId: asAgentId(agentId),
      charter,
      agentsMd: agentsMd ?? '',
      bossLabel: charter.approvalChain.boss,
      autonomousActions: autonomousActionsOn(agent),
      surfaceMode: surfaceConfig.mode,
      surfaces,
      qualityFitWaived: item.qualityFitWaivedAt !== undefined,
      scopeWaived: item.scopeWaivedAt !== undefined,
      scopeHeld,
    },
    lookups,
    {
      onScopeJudgement: (judgement): void => {
        if (judgement.admitted && judgement.failedOpen !== undefined) {
          scopeJudgementUnavailable = judgement.failedOpen;
        }
        // Only a reading of the charter is kept: the model's own in-scope
        // judgement, or the skip readings a named source set aside. A waiver
        // is already on the row, a held judgement is the one already kept,
        // and a fail-open admission read nothing.
        const judged =
          judgement.admitted &&
          (judgement.overruled !== undefined ||
            (judgement.basis === 'charter-judgement' && judgement.failedOpen === undefined));
        if (surfaceConfig.mode === 'real' && judged) {
          scopeAdmission = {
            basis: judgement.basis,
            ...(judgement.namedBy !== undefined ? { namedBy: judgement.namedBy } : {}),
            ...(judgement.overruled !== undefined ? { overruled: judgement.overruled } : {}),
          };
        }
      },
    },
  ));
  if (scopeJudgementUnavailable !== undefined) {
    await ctx.runMutation(internal.events.log, {
      agentId,
      type: 'work.scope-judgement-unavailable',
      payload: { workItemId: args.workItemId, cause: scopeJudgementUnavailable },
    });
  }
  if (scopeAdmission !== undefined) {
    await ctx.runMutation(internal.work.recordScopeAdmission, {
      workItemId: args.workItemId,
      charterId: charterRow._id,
      admission: scopeAdmission,
    });
  }
  const storedVerdict: { decision: string } = await ctx.runMutation(internal.work.setVerdict, {
    workItemId: args.workItemId,
    verdict,
  });

  // For needs-skill, propose a new skill row immediately.
  if (storedVerdict.decision === 'needs-skill' && verdict.decision === 'needs-skill') {
    const required = inferRequiredPermissions(candidate);
    const writeScope = `${candidate.sourceSystem}:write`;
    const requiredScopes = [...new Set([...required, writeScope])];
    const shape = verdict.suggestedSkillShape;
    const skillId = await ctx.runMutation(internal.skills.propose, {
      agentId,
      workItemId: args.workItemId,
      name: verdict.suggestedSkillName,
      description: skillDescriptionFor(shape),
      rationale: verdict.suggestedSkillRationale,
      requiredScopes,
      surfaceClass: shape.surfaceClass,
      operation: shape.operation,
    });
    await ctx.runMutation(internal.work.setProposedSkill, {
      workItemId: args.workItemId,
      skillId,
    });
  }

  return { decision: storedVerdict.decision };
}

export const evaluateWorkItem = action({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ decision: string }> =>
    await evaluateWorkItemHandler(ctx, args),
});

/** The server loop's evaluation step, scheduled when a row enters `discovered`. */
export const evaluateWorkItemInternal = internalAction({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ decision: string }> => {
    if (SURFACE_MODE !== 'real') return { decision: 'noop-mode=mock' };
    return await evaluateWorkItemHandler(ctx, args, true);
  },
});

/**
 * Draft the plan for one claimed work item, and continue into execution when
 * the autonomous switch approves it at the decision boundary.
 *
 * Shared by the dashboard's public action and the server loop's internal one,
 * as `evaluateWorkItemHandler` is; the execution it chains into reads the
 * same way its caller did.
 *
 * Args:
 *   ctx: Convex action context.
 *   args: The work item.
 *   internalCaller: Whether the caller is the scheduler rather than a page.
 *
 * Returns:
 *   Whether a plan was stored, and the execution's result when it continued.
 */
async function draftPlanHandler(
  ctx: ActionCtx,
  args: { workItemId: Id<'workItems'> },
  internalCaller = false,
): Promise<{ ok: boolean; reason?: string }> {
  const item: Doc<'workItems'> | null = internalCaller
    ? await ctx.runQuery(internal.work.getInternal, { workItemId: args.workItemId })
    : await ctx.runQuery(api.work.get, { workItemId: args.workItemId });
  if (!item) return { ok: false, reason: 'workItem not found' };
  const agentId = item.agentId;
  // Race-tolerant: the dashboard's auto-progress useEffect can fire
  // draftPlan after the state has already moved past 'claimed' (e.g.
  // a stale render, or an evaluator stomp). Treat the mismatch as a
  // no-op rather than an error so the React tree doesn't surface it
  // as a fatal Console Error.
  if (item.state !== 'claimed') {
    return { ok: false, reason: `state is ${item.state}; expected claimed` };
  }
  if (SURFACE_MODE === 'real') {
    const claim = await ctx.runMutation(internal.work.claimLoopStep, {
      workItemId: args.workItemId,
      step: 'draft',
    });
    if (!claim.claimed) {
      return {
        ok: false,
        reason:
          claim.reason === 'claimed'
            ? 'another draft of this work item is running'
            : `${claim.reason}; expected claimed`,
      };
    }
  }
  const charterRow = internalCaller
    ? await ctx.runQuery(internal.charters.latestInternal, { agentId })
    : await ctx.runQuery(api.charters.latest, { agentId });
  if (!charterRow) return { ok: false, reason: 'no charter' };
  const agent = internalCaller
    ? await ctx.runQuery(internal.agents.getInternal, { agentId })
    : await ctx.runQuery(api.agents.get, { agentId });
  if (!agent) return { ok: false, reason: 'agent not found' };
  const candidate = rowToCandidate(item);
  const grounding = await planGrounding(ctx, agentId, internalCaller);
  const knownValues = await knownValuesForAgent(ctx, agent);
  const record =
    SURFACE_MODE === 'real' && agent
      ? await readCandidateRecord(ctx, {
          workItemId: args.workItemId,
          agentId,
          agentName: agent.name,
          autonomousActions: autonomousActionsOn(agent),
          candidate,
          surfaces: grounding.surfaces ?? [],
          knownValues,
        })
      : undefined;
  const corrections = SURFACE_MODE === 'real' ? await plannerCorrections(ctx, item, knownValues) : undefined;
  const step = { agentId, workItemId: args.workItemId, stage: 'draft' } as const;
  const plan = await recordingModelCalls(ctx, step, () => draftExecutionPlan({
    candidate,
    charter: charterRow.body as Charter,
    autonomousActions: autonomousActionsOn(agent),
    surfaceMode: SURFACE_MODE,
    ...grounding,
    ...(record ? { record } : {}),
    ...(corrections && corrections.entries.length > 0
      ? {
          corrections: corrections.entries,
          ...(corrections.redaction ? { correctionsRedaction: corrections.redaction } : {}),
        }
      : {}),
    onObligationEvent: async (event) => {
      await ctx.runMutation(internal.events.log, {
        agentId,
        type: event.type,
        payload: { workItemId: args.workItemId, ...event.payload },
      });
    },
  }));
  const stored = await ctx.runMutation(internal.work.setPlan, {
    workItemId: args.workItemId,
    plan,
  });
  if (!stored.stored) {
    return { ok: false, reason: 'another draft stored a plan for this work item first' };
  }
  const decision = await ctx.runMutation(internal.work.decidePlan, {
    workItemId: args.workItemId,
  });
  if (decision.approved) {
    return await executeApprovedPlanHandler(ctx, args, internalCaller);
  }
  return { ok: true };
}

export const draftPlan = action({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> =>
    await draftPlanHandler(ctx, args),
});

/** The server loop's drafting step, scheduled when a row enters `claimed` without a plan. */
export const draftPlanInternal = internalAction({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    if (SURFACE_MODE !== 'real') return { ok: false, reason: 'the server loop is real-mode only' };
    return await draftPlanHandler(ctx, args, true);
  },
});

async function executeApprovedPlanHandler(
  ctx: ActionCtx,
  args: { workItemId: Id<'workItems'> },
  internalCaller = false,
): Promise<{ ok: boolean; reason?: string; additionalModelCalls?: number }> {
  const item: Doc<'workItems'> | null = internalCaller
    ? await ctx.runQuery(internal.work.getInternal, { workItemId: args.workItemId })
    : await ctx.runQuery(api.work.get, { workItemId: args.workItemId });
  if (!item) return { ok: false, reason: 'workItem not found' };
  const agentId = item.agentId;
  // Cheap early-out for the common case; `claimForExecution` below is what
  // actually decides, because only a mutation can read and move the state
  // without another caller slipping between the two.
  if (item.state !== 'plan-approved') {
    return { ok: false, reason: `state is ${item.state}; expected plan-approved` };
  }
  const charterRow = internalCaller
    ? await ctx.runQuery(internal.charters.latestInternal, { agentId })
    : await ctx.runQuery(api.charters.latest, { agentId });
  if (!charterRow) return { ok: false, reason: 'no charter' };
  const charter = charterRow.body as Charter;
  const plan = item.plan as Awaited<ReturnType<typeof draftExecutionPlan>>;
  const candidate = rowToCandidate(item);

  const skills: Doc<'skills'>[] = internalCaller
    ? await ctx.runQuery(internal.skills.registeredInternal, { agentId })
    : await ctx.runQuery(api.skills.registered, { agentId });
  // The same shape the evaluator matched on, read from the same surfaces, so
  // the skill that runs is the skill the verdict promised.
  const shapeSurfaces: readonly ShapeSurface[] =
    SURFACE_MODE === 'real' ? await loadSurfaces(ctx, agentId) : [];
  const pickedSkill = findMatchingSkillForCandidate(
    candidate,
    skills,
    skillShapeFor(candidate, shapeSurfaces, SURFACE_MODE),
  );
  if (!pickedSkill) {
    const reason = `no registered skill matches source surface ${candidate.sourceSystem}`;
    await ctx.runMutation(internal.work.setFailed, {
      workItemId: args.workItemId,
      reason,
    });
    return { ok: false, reason };
  }
  // Nothing above this line touches a model or an adapter, so a caller that
  // loses the claim costs a handful of reads and stops here.
  const claim = await ctx.runMutation(internal.work.claimForExecution, {
    workItemId: args.workItemId,
    skillId: pickedSkill._id,
  });
  if (!claim.claimed) return { ok: false, reason: claim.reason };
  const resume = item.output as DependentAuthoringOutput | undefined;
  // What earlier runs of this item put on a provider, read from the row's
  // output before this run replaces it: the retry's prompts list these and
  // a comment on a target one of them carries is reused, never sent again.
  const landedWrites = SURFACE_MODE === 'real' ? landedWritesOf(item.output) : [];
  if (SURFACE_MODE === 'real' && resume?.resumedClosing && resume.phase === 'dependent-authoring') {
    // The carried reads were taken before the retry; the closing set is
    // authored from what they read now, or not at all.
    const reread = await refreshCarriedReads(ctx, {
      workItemId: args.workItemId, agentId, runId: claim.runId, resume,
    });
    if (!reread.ok) {
      await ctx.runMutation(internal.work.setFailed, {
        workItemId: args.workItemId,
        runId: claim.runId,
        reason: reread.failed.reason,
        stopped: true,
        output: { ...resume, failedReread: reread.failed },
      });
      return { ok: false, reason: reread.failed.reason };
    }
    const prepared = await ctx.runMutation(internal.work.prepareDependentPhase, {
      workItemId: args.workItemId, runId: claim.runId, output: withLandedWrites(reread.output, landedWrites),
    });
    return { ok: prepared.prepared, reason: 'resuming closing actions from the previous ledger' };
  }
  const step = { agentId, workItemId: args.workItemId, stage: 'execution' } as const;
  return await recordingModelCalls(ctx, step, () => holdDay0Actions(ctx, {
    workItemId: args.workItemId,
    item,
    agentId,
    runId: claim.runId,
    skill: pickedSkill,
    plan,
    candidate,
    charter,
    internalCaller,
    managerFeedback: liveManagerFeedback(item.managerFeedback),
    managerAnswers: managerAnswersOf(item),
    landedWrites,
  }));
}

/**
 * Apply a resumed closing phase's carried reads again, under the new run.
 *
 * The reads go out in one invocation of the apply path, with the rules and
 * the transport check every read passes, in the auto phase: a read needs its
 * grant now. On a browser-driven surface the run's own sign-in is replayed
 * first, under the authority each replayed row landed with. Each re-read
 * keeps its carried index, so its key is `<item>:<new run>:<index>`, below
 * the closing offset and never an earlier run's, and it replaces the carried
 * row in the ledger the closing phase reads. The old rows stay on the
 * earlier run's `work.failed` record. Nothing but reads and the replay is
 * sent: every other carried row is passed through as already decided.
 *
 * Args:
 *   ctx: Convex action context.
 *   args: The work item, its agent, the new run and the resumed ledger.
 *
 * Returns:
 *   The resumed ledger with its reads taken again, or the first re-read that
 *   did not land with every row the attempt recorded.
 */
async function refreshCarriedReads(
  ctx: ActionCtx,
  args: {
    workItemId: Id<'workItems'>;
    agentId: Id<'agents'>;
    runId: Id<'events'>;
    resume: DependentAuthoringOutput;
  },
): Promise<{ ok: true; output: DependentAuthoringOutput } | { ok: false; failed: FailedReread }> {
  const surfaces = await loadSurfaces(ctx, args.agentId);
  const { actions, applied } = args.resume;
  const indexes = carriedReadIndexes(actions, applied, surfaces);
  if (indexes.length === 0) return { ok: true, output: args.resume };
  const reread = new Set(indexes);
  try {
    const agent = await ctx.runQuery(internal.agents.getInternal, { agentId: args.agentId });
    if (!agent) throw new Error('agent not found');
    const knownValues = await knownValuesForAgent(ctx, agent);
    const grantRows: Doc<'permissionGrants'>[] = await ctx.runQuery(internal.agents.grantedScopes, {
      agentId: args.agentId,
    });
    const browserMcpUrl = process.env.DAY0_BROWSER_MCP_URL;
    const rows = await applySurfaceActions(
      ctx,
      SURFACE_MODE,
      surfaces,
      { agentId: args.agentId, agentName: agent.name, workItemId: args.workItemId, runId: args.runId },
      actions,
      {
        deps: realAdapterDeps(
          authorityBeforeTransport(ctx, args.agentId, 'auto', browserMcpUrl),
          browserMcpUrl,
          knownValues,
        ),
        grants: new Set(grantRows.map((grant) => grant.scope)),
        approvedIndexes: reread,
        priorLedger: applied.map((row, index) => (reread.has(index) ? undefined : row)),
        resumedRunIds: ledgerRunIds(applied),
        authorityByIndex: new Map(indexes.flatMap((index) => {
          const authority = applied[index]?.authority;
          return authority ? [[index, authority] as const] : [];
        })),
        autoPhase: true,
        autonomousActions: autonomousActionsOn(agent),
      },
    );
    const refreshed = withRereads({ actions, applied }, scrubKnownValues(rows, knownValues), indexes, Date.now());
    return refreshed.ok ? { ok: true, output: { ...args.resume, applied: refreshed.applied } } : refreshed;
  } catch (error) {
    const surfaceNames = [...new Set(indexes.map((index) => String(actions[index]!.args.surface)))];
    return {
      ok: false,
      failed: {
        reason: rereadStopReason(surfaceNames.join(', '), error instanceof Error ? error.message : String(error)),
        at: Date.now(),
        actions: indexes.map((index) => actions[index]!),
        applied: [],
      },
    };
  }
}

/** An output with the writes earlier runs landed on it, when there are any. */
function withLandedWrites<T extends object>(output: T, landedWrites: readonly LandedWrite[]): T & { landedWrites?: LandedWrite[] } {
  return landedWrites.length > 0 ? { ...output, landedWrites: [...landedWrites] } : output;
}

/** The manager's answers at approval, as the executor reads them. */
/** The answers the manager gave at approval, as the executor reads them. */
export function managerAnswersOf(item: Doc<'workItems'>): ManagerAnswer[] | undefined {
  const rows = item.managerAnswers;
  if (!rows || rows.length === 0) return undefined;
  return rows.map((row) => ({ question: row.question, answer: row.answer }));
}

export const executeApprovedPlan = action({
  args: { workItemId: v.id('workItems') },
  handler: executeApprovedPlanHandler,
});

/** Continue a plan approved through the manager channel, without a browser identity. */
export const executeApprovedPlanInternal = internalAction({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    if (SURFACE_MODE !== 'real') {
      return { ok: false, reason: 'manager-channel execution is real-mode only' };
    }
    return await executeApprovedPlanHandler(ctx, args, true);
  },
});

/**
 * Run a day0 skill and stop its proposed writes at the exact-action gate.
 *
 * Args:
 *   ctx: Convex action context.
 *   args: Work, run, skill and evaluation context.
 *
 * Returns:
 *   The pending result, or the fenced failure.
 */
async function holdDay0Actions(
  ctx: ActionCtx,
  args: {
    workItemId: Id<'workItems'>;
    /** The work item as the execution claim read it. */
    item: Doc<'workItems'>;
    agentId: Id<'agents'>;
    runId: Id<'events'>;
    skill: SimpleSkillRow;
    plan: Awaited<ReturnType<typeof draftExecutionPlan>>;
    candidate: WorkCandidate;
    charter: Charter;
    internalCaller: boolean;
    /** The manager's reason for rejecting the previous attempt, if this is a retry. */
    managerFeedback?: string;
    /** What the manager answered when approving the plan. */
    managerAnswers?: readonly ManagerAnswer[];
    /** Writes earlier runs of this item landed, for the prompts and the reuse at apply. */
    landedWrites?: readonly LandedWrite[];
  },
): Promise<{ ok: boolean; reason?: string; additionalModelCalls?: number }> {
  let additionalModelCalls = 0;
  const result = (
    value: { ok: boolean; reason?: string },
  ): { ok: boolean; reason?: string; additionalModelCalls?: number } =>
    additionalModelCalls > 0 ? { ...value, additionalModelCalls } : value;
  try {
    const agent = await ctx.runQuery(internal.agents.getInternal, { agentId: args.agentId });
    if (!agent) throw new Error('agent not found');
    const mockEnv = args.internalCaller
      ? await ctx.runQuery(internal.mock.snapshotInternal, { agentId: args.agentId })
      : await readSurfaceSnapshot(ctx, args.agentId, 'mock', []);
    const surfaces = SURFACE_MODE === 'real' ? await loadSurfaces(ctx, args.agentId) : [];
    const appliedCorrections = await executorCorrections(ctx, {
      agent,
      item: args.item,
      plan: args.plan,
      runId: args.runId,
    });
    await claimPlannedWriteTargets(ctx, args.workItemId, args.plan, surfaces, mockEnv);
    const heldElsewhere = await itemsHeldElsewhere(ctx, agent, args.workItemId);
    const output = await runSkill({
      skill: {
        name: args.skill.name,
        description: args.skill.description,
        body: args.skill.body,
      },
      plan: args.plan,
      candidate: args.candidate,
      charter: args.charter,
      mockEnv,
      surfaces,
      mode: SURFACE_MODE,
      autonomousActions: autonomousActionsOn(agent),
      managerFeedback: args.managerFeedback,
      managerAnswers: args.managerAnswers,
      landedWrites: args.landedWrites,
      heldElsewhere,
      appliedCorrections,
      groundingReads: await itemGroundingReads(ctx, args.workItemId),
      onAdditionalModelCall: () => {
        additionalModelCalls += 1;
      },
      onAuditCorrection: async (removedIndices, reason) => {
        await ctx.runMutation(internal.events.log, {
          agentId: args.agentId, type: 'audit.corrected',
          payload: { workItemId: args.workItemId, runId: args.runId, removedIndices, reason },
        });
      },
    });
    const staged = withLandedWrites(
      SURFACE_MODE === 'real'
        ? prerequisiteOutput(output, args.plan)
        : { ...output, needsDependentPhase: false },
      args.landedWrites ?? [],
    );
    // A write whose argument names the probed schema refuses is re-authored
    // once here, so the payload the manager approves is one the provider
    // can accept; nothing reaches a surface in the repair.
    const repairedStaged =
      SURFACE_MODE === 'real'
        ? await repairedForHold(staged, {
            surfaces,
            skill: { name: args.skill.name },
            candidate: args.candidate,
            onAdditionalModelCall: () => {
              additionalModelCalls += 1;
            },
          })
        : staged;
    const auditedOutput = repairedStaged.argumentRepairs?.some((attempt) => attempt.repaired)
      ? await auditRepairedPayloads(ctx, repairedStaged, args, surfaces)
      : repairedStaged;
    const stagedOutput =
      SURFACE_MODE === 'real'
        ? withOpenQuestionHeld(auditedOutput, {
            plan: args.plan,
            surfaces,
            answered: managerHasAnswered(args.item, args.plan),
          })
        : auditedOutput;
    if (stagedOutput.needsDependentPhase && stagedOutput.actions.length === 0) {
      // Nothing to wait for is not a failed prerequisite: the closing phase
      // authors the whole set and accounts for every plan step, and a step
      // that promised a read no ledger row shows is what fails the run.
      const prepared = await ctx.runMutation(internal.work.prepareDependentPhase, {
        workItemId: args.workItemId,
        runId: args.runId,
        output: {
          ...stagedOutput,
          phase: 'dependent-authoring',
          applied: [],
        } satisfies DependentAuthoringOutput,
      });
      if (!prepared.prepared) {
        return result({
          ok: false,
          reason: 'the run moved on before its dependent phase was prepared',
        });
      }
      return result({
        ok: true,
        reason: 'no prerequisite action to apply; dependent actions authoring',
      });
    }
    const pending = await ctx.runMutation(internal.work.setActionsPending, {
      workItemId: args.workItemId,
      runId: args.runId,
      output: stagedOutput,
    });
    if (!pending.pending) {
      return result({
        ok: false,
        reason: 'the run was moved on before its actions could be held',
      });
    }
    return result({
      ok: true,
      reason:
        pending.phase === 'auto'
          ? 'automatic actions applying'
          : "actions pending the manager's approval",
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await ctx.runMutation(internal.work.setFailed, {
      workItemId: args.workItemId,
      reason,
      runId: args.runId,
    });
    return result({ ok: false, reason });
  }
}

/**
 * The deferral audit on a phase-one output whose payloads the argument
 * repair changed: a closing action the repair revealed (a comment whose body
 * only the corrected key carries) is removed as prewritten, a deferral the
 * audit cannot tie to a result is left to the closing phase, and each
 * correction is recorded. Nothing here stops the run.
 */
async function auditRepairedPayloads<T extends ExecutionOutput>(
  ctx: ActionCtx,
  output: T,
  args: {
    workItemId: Id<'workItems'>;
    agentId: Id<'agents'>;
    runId: Id<'events'>;
    skill: { body: string };
    plan: ExecutionPlan;
    candidate: WorkCandidate;
  },
  surfaces: readonly SurfaceRecord[],
): Promise<T> {
  const prewrittenIndices: number[] = [];
  const issues = deferralAudit(output, args.candidate, {
    mode: SURFACE_MODE, plan: args.plan, surfaces, skillBody: args.skill.body, now: Date.now(),
  }, prewrittenIndices);
  const record = async (removedIndices: number[], reason: string): Promise<void> => {
    await ctx.runMutation(internal.events.log, {
      agentId: args.agentId, type: 'audit.corrected',
      payload: { workItemId: args.workItemId, runId: args.runId, removedIndices, reason },
    });
  };
  let corrected: T = output;
  if (prewrittenIndices.length > 0) {
    const removed = new Set(prewrittenIndices);
    const reindex = (index: number): number => index - prewrittenIndices.filter((removedIndex) => removedIndex < index).length;
    corrected = {
      ...removePrewrittenClosingActions(output, prewrittenIndices),
      ...(output.argumentRepairs
        ? {
            argumentRepairs: output.argumentRepairs
              .filter((attempt) => !removed.has(attempt.index))
              .map((attempt) => ({ ...attempt, index: reindex(attempt.index) })),
          }
        : {}),
    } as T;
    await record(prewrittenIndices, 'prewritten closing actions');
  }
  const kept = issues.filter((issue) => !issue.startsWith('prewrote a closing action'));
  if (kept.length > 0) await record([], `${DEFERRALS_KEPT}: ${kept.join('; ')}`);
  return corrected;
}

/** A ledger as the row carries it between the two phases. */
type LedgerOutput = ExecutionOutput & { applied?: Array<AppliedAction | undefined> };

/**
 * The phase's actions with every write the probed schema refuses given its
 * one repair, and the attempts recorded on the output for the card.
 *
 * Args:
 *   output: The phase's output as the executor returned it.
 *   context: The surfaces, the skill, the candidate and the model-call hook.
 *
 * Returns:
 *   The output the gate holds.
 */
async function repairedForHold<T extends { actions: MockAction[] }>(
  output: T,
  context: {
    surfaces: readonly SurfaceRecord[];
    skill: { name: string };
    candidate: WorkCandidate;
    onAdditionalModelCall: () => void;
  },
): Promise<T & { argumentRepairs?: ArgumentRepairAttempt[] }> {
  const repaired = await repairHeldWriteArguments({
    actions: output.actions,
    surfaces: context.surfaces,
    skill: context.skill,
    candidate: context.candidate,
    repair: repairToolArguments,
    onAdditionalModelCall: context.onAdditionalModelCall,
  });
  if (repaired.argumentRepairs.length === 0) return output;
  return { ...output, actions: repaired.actions, argumentRepairs: repaired.argumentRepairs };
}

interface DependentAuthoringOutput extends ExecutionOutput {
  phase: 'dependent-authoring';
  resumedClosing?: boolean;
  previousClosing?: ClosingResume['previousClosing'];
  applied: AppliedAction[];
  initialFailure?: string;
  /** The closing set a gate refused, kept with its reason; see `RefusedClosing`. */
  refusedClosing?: RefusedClosing;
  /** A re-read on resume that did not land: the run stopped before its closing set. */
  failedReread?: FailedReread;
}

interface DependentPendingOutput extends DependentExecutionOutput {
  phase: 'dependent';
  actionIndexOffset: number;
  initial: DependentAuthoringOutput;
  applied?: AppliedAction[];
  /**
   * The held items this set's blocked steps were left to when it was authored.
   * Kept with the set, as a claim-withheld row keeps its line: what becomes of
   * a holder after the reply has said where the work is does not fail the run.
   */
  leftToHolders?: HeldExternalItem[];
}

function isDependentPendingOutput(
  output: LedgerOutput | DependentPendingOutput,
): output is DependentPendingOutput {
  return (output as { phase?: unknown }).phase === 'dependent';
}

/**
 * Whether the approved plan or emitted prerequisites require one result-aware
 * turn: the output asked for one, the plan declares a read, or the plan
 * declares nothing usable and is read as reading (`closingPhaseOwed`).
 */
export function needsDependentPhase(output: ExecutionOutput, plan: ExecutionPlan): boolean {
  return output.needsDependentPhase === true || closingPhaseOwed(plan);
}

/**
 * Stage a phase-one output for the gate.
 *
 * The deferral audit in `runSkill` has already refused a closing action
 * written before its result existed and a fixed-payload write left out, so
 * every action here is one phase one may carry: the batch after the last
 * read is kept whole. The flag is settled the same way the executor settled
 * it, so a persisted output from before the audit reads the same.
 */
export function prerequisiteOutput(output: ExecutionOutput, plan: ExecutionPlan): ExecutionOutput {
  return { ...output, needsDependentPhase: needsDependentPhase(output, plan) };
}

/**
 * Whether the ledger shows the manager's word on this item already: a live
 * rejection reason or retry note, answers given when the plan was approved,
 * or a kept correction the approved plan applied. A write the plan left to
 * the manager's answer is then no longer waiting on a question.
 *
 * Args:
 *   item: The work item as the run read it.
 *   plan: Its approved plan.
 *
 * Returns:
 *   True when the manager has spoken on the item or a kept correction is in scope.
 */
export function managerHasAnswered(
  item: Pick<Doc<'workItems'>, 'managerFeedback' | 'managerAnswers'>,
  plan: Pick<ExecutionPlan, 'appliedCorrections'>,
): boolean {
  return (
    liveManagerFeedback(item.managerFeedback) !== undefined ||
    (item.managerAnswers ?? []).length > 0 ||
    (plan.appliedCorrections ?? []).length > 0
  );
}

/** A set that may carry a question to the manager beside the writes that wait on its answer. */
type QuestionableOutput = Parameters<typeof withholdActions>[0] & {
  argumentRepairs?: ArgumentRepairAttempt[];
  openQuestion?: ExecutionOutput['openQuestion'];
};

/**
 * The set with the writes the approved plan left to the manager's answer
 * withheld, when the run asks the manager a question nobody has answered
 * (`openManagerQuestion`). The question and everything else in the set go on;
 * the withheld writes stay on the output with their reason, and the open
 * question is recorded so the run stops with it once the rest has settled.
 *
 * Args:
 *   output: The set as it would reach the gate.
 *   context: The plan, the surfaces, whether the manager has answered, and
 *     the manager messages this run already landed.
 *
 * Returns:
 *   The same output when nothing waits on a question.
 */
export function withOpenQuestionHeld<T extends QuestionableOutput>(
  output: T,
  context: {
    plan: ExecutionPlan;
    surfaces: readonly SurfaceRecord[];
    answered: boolean;
    askedEarlier?: readonly MockAction[];
  },
): T {
  const open = openManagerQuestion({ ...context, actions: output.actions });
  if (!open) return output;
  const removed = new Set(open.withheld.map((row) => row.index));
  const withheld = withholdActions(
    output,
    open.withheld.map(({ index, step }) => ({ index, reason: withheldForAnswerReason(step) })),
    "for the manager's answer",
  );
  const reindex = (index: number): number => index - [...removed].filter((removedIndex) => removedIndex < index).length;
  return {
    ...withheld,
    ...(output.argumentRepairs
      ? {
          argumentRepairs: output.argumentRepairs
            .filter((attempt) => !removed.has(attempt.index))
            .map((attempt) => ({ ...attempt, index: reindex(attempt.index) })),
        }
      : {}),
    openQuestion: { question: open.question, steps: open.steps },
  };
}

/** The reason a run ends on when it, or the phase before it, left a question to the manager open. */
function openQuestionStop(output: { openQuestion?: ExecutionOutput['openQuestion']; initial?: { openQuestion?: ExecutionOutput['openQuestion'] } }): string | undefined {
  const open = output.openQuestion ?? output.initial?.openQuestion;
  return open ? openQuestionStopReason(open) : undefined;
}

function successfulReadSurfaces(
  actions: readonly ExecutionOutput['actions'][number][],
  applied: readonly AppliedAction[],
): Set<string> {
  const surfaces = new Set<string>();
  actions.forEach((action, index): void => {
    const row = applied[index];
    const parsed = parseSurfaceAction(action);
    if (row?.ok && !row.held && parsed.ok && actionIntent(parsed.action) === 'read') {
      surfaces.add(parsed.action.surface.toLowerCase());
    }
  });
  return surfaces;
}

/**
 * Refuse a silent omission when an approved step declares a surface read.
 *
 * A step owes a read of exactly the surfaces its declared obligations list
 * (`declaredReads`, the same reading the closing resume makes), and only of
 * surfaces the gate holds: an absent or ungranted surface is never owed. A
 * plan with no declared obligations owes no read here; the prose is never
 * consulted. What may stand behind a declared read is `unmetDeclaredReads`'.
 */
export function validatePlanStepOutcomes(args: PlanStepOutcomeCheck): void {
  const ordered = [...args.outcomes].sort((a, b) => a.step - b.step);
  if (
    ordered.length !== args.plan.steps.length ||
    ordered.some((outcome, index) => outcome.step !== index + 1)
  ) {
    throw new Error('dependent phase did not account for every approved plan step exactly once');
  }
  if (!args.managerFeedback?.trim()) {
    const cited = ordered.find((outcome) => outcome.basis === 'manager-feedback');
    if (cited) {
      throw new Error(
        `approved plan step ${cited.step} cites manager feedback the run does not carry`,
      );
    }
  }
  const unmet = unmetDeclaredReads(args)[0];
  if (unmet) throw new Error(missingReadReason(unmet));
}

/** What the promised-read gate is given: the plan, the closing phase's account of it, and what the run read. */
export interface PlanStepOutcomeCheck {
  plan: ExecutionPlan;
  outcomes: readonly PlanStepOutcome[];
  initialActions: readonly ExecutionOutput['actions'][number][];
  initialLedger: readonly AppliedAction[];
  surfaces: ReadonlyArray<{ slug: string; displayName: string }>;
  /** The manager's live feedback on the run; a step may rest on it only when it is here. */
  managerFeedback?: string;
  /** The live feedback again when it is a note given with Retry: only such a note can release a declared read. */
  retryNote?: string;
  /** The work item, so its own plan-grounding read can be told from another ticket's. */
  candidate?: Pick<WorkCandidate, 'externalId'>;
  /** The item's plan-grounding reads, as `internal.work.planGroundingReads` returns them. */
  groundingReads?: readonly GroundingRead[];
}

/**
 * The declared reads a closing account leaves with nothing behind them.
 *
 * A declared read is met by a landed read of its surface in phase one's
 * ledger, or by the item's own plan-grounding read of that surface: the
 * product made that read itself, under standing authority, before the plan
 * that declares it was drafted. It is released when the manager's retry
 * note removes it and the step's outcome rests on that note
 * (`noteReleasesRead`). Otherwise the step may not be reported satisfied,
 * and must say why it is not.
 *
 * Args:
 *   args: The same arguments the gate takes.
 *
 * Returns:
 *   The unmet reads in step order; empty when the gate has nothing to refuse.
 */
export function unmetDeclaredReads(args: PlanStepOutcomeCheck): DeclaredRead[] {
  const reads = successfulReadSurfaces(args.initialActions, args.initialLedger);
  for (const surface of groundingReadSurfaces(args.candidate?.externalId, args.groundingReads)) reads.add(surface);
  const note = args.retryNote?.trim();
  return declaredReads(args.plan, args.surfaces).filter((read): boolean => {
    if (reads.has(read.surface.slug.toLowerCase())) return false;
    const outcome = args.outcomes.find((row) => row.step === read.step);
    if (!outcome) return true;
    if (note && outcome.basis === 'manager-feedback' && outcome.evidence.trim() !== '' && noteReleasesRead(note, read)) {
      return false;
    }
    return outcome.status === 'satisfied' || outcome.evidence.trim() === '';
  });
}

/** Why a declared read has no landed read behind it: the step and the surface it declared. */
export function missingReadReason(read: DeclaredRead): string {
  const surface = read.surface.displayName;
  return `approved plan step ${read.step} declares a read of ${surface}, but no landed ${surface} read or blocking ledger reason was recorded`;
}

/** The event a closing phase logs when it applied the reads its refused set carried. */
const CARRIED_READS_APPLIED = 'work.carried-reads-applied';

/**
 * Apply the reads a closing set carried for its own declared reads, as added
 * prerequisites of the run.
 *
 * The gate reads the ledger, so a read inside the closing set can never
 * stand behind the step that declares it, and the model cannot repair that:
 * nothing it returns lands a read. The reads go out the way a resumed
 * closing phase takes its carried reads again: one invocation of the apply
 * path in the auto phase, with every rule and the transport check a read
 * passes, each under the key `<item>:<run>:<index>` after the last
 * prerequisite. Every row is kept, landed or not, so the second authoring
 * reads what happened and the gate judges that account.
 *
 * Args:
 *   ctx: Convex action context.
 *   args: The run, its agent and surfaces, the prerequisites so far and the reads to add.
 *
 * Returns:
 *   The prerequisites with the reads and their ledger rows appended.
 */
async function applyCarriedReads(
  ctx: ActionCtx,
  args: {
    workItemId: Id<'workItems'>;
    runId: Id<'events'>;
    agent: Doc<'agents'>;
    surfaces: SurfaceRecord[];
    knownValues: readonly string[];
    initial: DependentAuthoringOutput;
    reads: MockAction[];
  },
): Promise<DependentAuthoringOutput> {
  const offset = args.initial.actions.length;
  const actions = [...args.initial.actions, ...args.reads];
  const indexes = args.reads.map((_, index) => offset + index);
  const grantRows: Doc<'permissionGrants'>[] = await ctx.runQuery(internal.agents.grantedScopes, {
    agentId: args.agent._id,
  });
  const browserMcpUrl = process.env.DAY0_BROWSER_MCP_URL;
  const rows = await applySurfaceActions(
    ctx,
    SURFACE_MODE,
    args.surfaces,
    { agentId: args.agent._id, agentName: args.agent.name, workItemId: args.workItemId, runId: args.runId },
    actions,
    {
      deps: realAdapterDeps(
        authorityBeforeTransport(ctx, args.agent._id, 'auto', browserMcpUrl),
        browserMcpUrl,
        args.knownValues,
      ),
      grants: new Set(grantRows.map((grant) => grant.scope)),
      approvedIndexes: new Set(indexes),
      priorLedger: [...args.initial.applied, ...args.reads.map(() => undefined)],
      resumedRunIds: ledgerRunIds(args.initial.applied),
      autoPhase: true,
      autonomousActions: autonomousActionsOn(args.agent),
    },
  );
  const applied = scrubKnownValues(rows, args.knownValues);
  await ctx.runMutation(internal.events.log, {
    agentId: args.agent._id,
    type: CARRIED_READS_APPLIED,
    payload: {
      workItemId: args.workItemId,
      runId: args.runId,
      indexes,
      surfaces: [...new Set(args.reads.map((read) => String(read.args.surface)))],
      landed: indexes.every((index) => applied[index]?.ok === true && !applied[index]?.held),
    },
  });
  return { ...args.initial, actions, applied };
}

/**
 * Why a closing action set may not stand, judged against the plan it closes.
 *
 * After a failed prerequisite no ticket state may change. Otherwise a
 * ticket-update plan whose declared transition commits the run to the close
 * (promised, conditional on the evidence, or conditional on the manager,
 * whose Done is emitted and held) must either carry the transition or
 * account for its absence: a phase that withholds Done because a
 * prerequisite was held, or the evidence was wrong, records the step as
 * blocked, and that record is honoured rather than refused. A plan whose
 * transition is withheld or none owes no transition, and a closing set that
 * leaves the state alone satisfies it; so does a plan with no declared
 * obligations.
 */
export function dependentTransitionRefusal(args: {
  plan: ExecutionPlan;
  actions: readonly ExecutionOutput['actions'][number][];
  planStepOutcomes: readonly PlanStepOutcome[];
  initialFailure?: string;
}): string | undefined {
  const statusChange = args.actions.some((action): boolean => {
    const parsed = parseSurfaceAction(action);
    return parsed.ok && isStatusChange(parsed.action);
  });
  if (args.initialFailure) {
    return statusChange
      ? 'dependent phase cannot change ticket state after a prerequisite failure'
      : undefined;
  }
  if (
    args.plan.expectedOutputType !== 'ticket-update' ||
    !transitionPromised(args.plan) ||
    statusChange ||
    args.planStepOutcomes.some((outcome) => outcome.status === 'blocked')
  ) {
    return undefined;
  }
  return 'dependent phase omitted the approved ticket state transition without a blocked plan step';
}

function flattenedDependentOutput(
  output: DependentPendingOutput,
  applied: AppliedAction[],
): ExecutionOutput & { applied: AppliedAction[]; planStepOutcomes: PlanStepOutcome[]; prerequisiteCount: number } {
  const withheldActions = [...(output.initial.withheldActions ?? []), ...(output.withheldActions ?? [])];
  return {
    draft: output.draft,
    notes: output.notes,
    needsDependentPhase: false,
    actions: [...output.initial.actions, ...output.actions],
    procedureTrails: (output.procedureTrails ?? []).map((trail) => {
      if ('state' in trail) {
        return trail.state === 'mapped'
          ? { ...trail, actionIndex: trail.actionIndex + output.actionIndexOffset }
          : trail;
      }
      return {
        ...trail,
        actionIndex:
          trail.actionIndex === null ? null : trail.actionIndex + output.actionIndexOffset,
      };
    }),
    ...(output.procedureTrailLimitations
      ? {
          procedureTrailLimitations: output.procedureTrailLimitations.map((limitation) => ({
            ...limitation,
            actionIndex: limitation.actionIndex + output.actionIndexOffset,
          })),
        }
      : {}),
    applied: [...output.initial.applied, ...applied],
    planStepOutcomes: output.planStepOutcomes,
    prerequisiteCount: output.initial.actions.length,
    ...(output.initial.landedWrites ? { landedWrites: output.initial.landedWrites } : {}),
    ...(withheldActions.length > 0 ? { withheldActions } : {}),
    ...(output.openQuestion ?? output.initial.openQuestion
      ? { openQuestion: output.openQuestion ?? output.initial.openQuestion }
      : {}),
  };
}

/**
 * Why blocked plan steps fail a run, if they do.
 *
 * A blocked step is the closing phase's honest account of something it
 * could not prove, and that account is kept on the item either way. It fails
 * the run only when the work did not land: no action was emitted, an emitted
 * action did not reach its surface, or the plan promised a ticket close and
 * no state transition landed. A run whose every action landed is completed,
 * with the blocked steps recorded beside it, rather than reported as failed
 * against a provider that shows the change.
 *
 * Args:
 *   outcomes: The closing phase's plan-step accounting.
 *   run: The run's whole action set with its ledger, and the plan it closed.
 *
 * Returns:
 *   The failure reason, or undefined when the run may complete.
 */
export function blockedPlanReason(
  outcomes: readonly PlanStepOutcome[],
  run?: {
    plan: ExecutionPlan;
    actions: readonly ExecutionOutput['actions'][number][];
    applied: readonly (Partial<AppliedAction> | undefined)[];
    /** The items other work items hold, as the executor was told before it authored. */
    heldElsewhere?: readonly HeldExternalItem[];
  },
): string | undefined {
  const blocked = outcomes.filter((outcome) => outcome.status === 'blocked');
  if (blocked.length === 0) return undefined;
  if (run && run.actions.length > 0) {
    const landed = (index: number): boolean => {
      const row = run.applied[index];
      return row?.ok === true && row.held !== true;
    };
    // A read the gate refused was never sent and had nothing to change: the
    // step that needed it is the blocked step, not an action that did not land.
    const refusedRead = (index: number): boolean => {
      const row = run.applied[index];
      if (row?.held !== true) return false;
      if (!isGateRefusal(droppedReadRefusal(row.reason) ?? row.reason)) return false;
      const parsed = parseSurfaceAction(run.actions[index]!);
      return parsed.ok && actionIntent(parsed.action) === 'read';
    };
    // A write withheld for another work item's claim is that item's to land;
    // it is not work this run left undone.
    const everyActionLanded = run.actions.every(
      (_action, index) => landed(index) || withheldByClaim(run.applied[index]) || refusedRead(index),
    );
    // A step the executor left out because its target has a work item of its
    // own is accounted for as the withheld write would have been: the holder
    // lands it. With every blocked step such a step, nothing here was left
    // undone; one blocked for any other reason is judged as before.
    const leftToHolders = blocked.every(
      (outcome) => heldItemOfBlockedStep(outcome, run.plan, run.heldElsewhere) !== undefined,
    );
    if (everyActionLanded && leftToHolders) return undefined;
    const closePromised =
      run.plan.expectedOutputType === 'ticket-update' && transitionPromised(run.plan);
    const transitionLanded = run.actions.some((action, index): boolean => {
      const parsed = parseSurfaceAction(action);
      return parsed.ok && isStatusChange(parsed.action) && landed(index);
    });
    const ticketEffectLanded = run.actions.some((action, index): boolean => {
      const parsed = parseSurfaceAction(action);
      return (
        parsed.ok &&
        (isAuditComment(parsed.action) || isStatusChange(parsed.action)) &&
        landed(index)
      );
    });
    const primaryEffectLanded =
      run.plan.expectedOutputType !== 'ticket-update' || ticketEffectLanded;
    if (everyActionLanded && primaryEffectLanded && (!closePromised || transitionLanded)) {
      return undefined;
    }
  }
  return `${blocked.length} approved plan step(s) remained blocked: ${blocked
    .map((outcome) => `step ${outcome.step} (${outcome.evidence})`)
    .join('; ')}`;
}

/**
 * A manager message that puts something to the manager: a question, or an
 * ask for a decision. A note that only reports is not a way to unblock the
 * work, so a stop still withholds it.
 */
const MANAGER_ASK = /\?|\b(?:please|could you|can you|would you|let me know|decide|approve|confirm|needs?)\b/i;

/** The text a manager message carries, whichever transport it takes. */
function managerMessageText(parsed: ParsedSurfaceAction): string {
  if (parsed.kind === 'mcp.call') {
    const text = ['text', 'message', 'body'].map((key) => parsed.toolArgs[key]).find((value) => typeof value === 'string');
    return typeof text === 'string' ? text : '';
  }
  return typeof parsed.bodyJson?.text === 'string' ? parsed.bodyJson.text : '';
}

/**
 * Why the run stops before its closing actions reach the gate, if it does.
 *
 * A run stops when nothing has landed and no decision could still complete
 * the plan: the prerequisite phase failed, or a plan step is blocked in a way
 * the closing actions would not settle even if every one of them landed.
 * Putting the closing set to the manager then would ask for a decision that
 * changes nothing; the record carries the reason instead and no message is
 * sent for it. Once work has landed the run goes on as before, because the
 * closing set may be the audit of what landed.
 *
 * Args:
 *   run: The prerequisite ledger, the closing actions and the outcomes.
 *
 * Returns:
 *   The stop reason, or undefined when the closing set should reach the gate.
 */
export function closingStopReason(run: {
  plan: ExecutionPlan;
  outcomes: readonly PlanStepOutcome[];
  initialActions: readonly ExecutionOutput['actions'][number][];
  initialApplied: readonly AppliedAction[];
  closingActions: readonly ExecutionOutput['actions'][number][];
  initialFailure?: string;
  surfaces: readonly SurfaceRecord[];
  /** The items other work items hold, as the closing executor was told. */
  heldElsewhere?: readonly HeldExternalItem[];
}): string | undefined {
  const landed = landedWork(
    { actions: run.initialActions, applied: run.initialApplied },
    run.surfaces,
  );
  if (landed.length > 0) return undefined;
  const escalationOnly = run.closingActions.length > 0 && run.closingActions.every(action => {
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok) return false;
    const surface = run.surfaces.find(row => row.slug === parsed.action.surface);
    return surface !== undefined && isManagerDm(parsed.action, surface) &&
      MANAGER_ASK.test(managerMessageText(parsed.action));
  });
  if (escalationOnly) return undefined;
  if (run.initialFailure) return run.initialFailure;
  const asIfLanded = run.closingActions.map((): Partial<AppliedAction> => ({ ok: true }));
  return blockedPlanReason(run.outcomes, {
    plan: run.plan,
    actions: [...run.initialActions, ...run.closingActions],
    applied: [...run.initialApplied, ...asIfLanded],
    heldElsewhere: run.heldElsewhere,
  });
}

/**
 * The closing set with where a held item's work is said in its reply, for the
 * steps the executor left to that item's own work item.
 *
 * The authoring's own check asks this of a set that writes to a held item. An
 * executor that obeyed the held-items block wrote to none, so the check never
 * ran; the person who asked is owed the same sentence, and it is Day0's, built
 * from the holder's row.
 *
 * Args:
 *   actions: The closing set, after its repairs.
 *   outcomes: The closing phase's plan-step accounting.
 *   plan: The approved plan.
 *   heldElsewhere: The items other work items hold, as the executor was told.
 *   surfaces: The agent's surfaces.
 *   replyTarget: The thread the work item answers, when it came from chat.
 *
 * Returns:
 *   The set, and the sentences added to it; the same set when none was owed.
 */
export function withLeftStepsSaid(
  actions: ExecutionOutput['actions'],
  outcomes: readonly PlanStepOutcome[],
  plan: ExecutionPlan,
  heldElsewhere: readonly HeldExternalItem[],
  surfaces: readonly SurfaceRecord[],
  replyTarget?: { channel: string; threadTs?: string },
): { actions: ExecutionOutput['actions']; said: string[] } {
  const owed = outcomes.flatMap((outcome) => {
    const item = outcome.status === 'blocked' ? heldItemOfBlockedStep(outcome, plan, heldElsewhere) : undefined;
    return item ? [item] : [];
  });
  if (owed.length === 0) return { actions, said: [] };
  // The manager DM reports on the work; it is not where the person who asked reads.
  const toTheAsker = actions.filter((action) => {
    const parsed = parseSurfaceAction(action);
    const surface = parsed.ok ? surfaces.find((row) => row.slug === parsed.action.surface) : undefined;
    return !(parsed.ok && surface && isManagerDm(parsed.action, surface));
  });
  const findings = heldItemReplyFindings(toTheAsker, heldElsewhere, surfaces, owed).filter((finding) =>
    owed.includes(finding.item),
  );
  const answered = withHeldItemsSaid(toTheAsker, findings, surfaces, replyTarget) as ExecutionOutput['actions'];
  const next = actions.map((action) => {
    const at = toTheAsker.indexOf(action);
    return at === -1 ? action : answered[at]!;
  });
  return next.every((action, index) => action === actions[index])
    ? { actions, said: [] }
    : { actions: next, said: findings.map((finding) => finding.sentence) };
}

/** Author the one bounded closing action set from the persisted prerequisite ledger. */
export const authorDependentActions = internalAction({
  args: { workItemId: v.id('workItems'), runId: v.id('events') },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const claim = await ctx.runMutation(internal.work.claimDependentAuthoring, args);
    if (!claim.claimed) return { ok: false, reason: claim.reason };
    let initial: DependentAuthoringOutput | undefined;
    // The set the closing phase authored, kept on the row if a gate refuses
    // it: nothing in it reaches a surface, and the manager and the retry
    // both need to read it against the refusal. It is model-authored text
    // that never passes the apply path's scrub, so the owner's stored
    // values are resolved here and removed from it before the row keeps it.
    let authored: DependentExecutionOutput | undefined;
    let knownValues: readonly string[] = [];
    try {
      const item: Doc<'workItems'> | null = await ctx.runQuery(internal.work.getInternal, {
        workItemId: args.workItemId,
      });
      initial = item?.output as DependentAuthoringOutput | undefined;
      if (!item || !initial || initial.phase !== 'dependent-authoring') {
        throw new Error('dependent phase context is no longer available');
      }
      if (!item.skillId) throw new Error('dependent phase has no registered skill');
      const [charterRow, skills, agent, mockEnv, surfaces] = await Promise.all([
        ctx.runQuery(internal.charters.latestInternal, { agentId: item.agentId }),
        ctx.runQuery(internal.skills.registeredInternal, { agentId: item.agentId }),
        ctx.runQuery(internal.agents.getInternal, { agentId: item.agentId }),
        ctx.runQuery(internal.mock.snapshotInternal, { agentId: item.agentId }),
        loadSurfaces(ctx, item.agentId),
      ]);
      if (!charterRow) throw new Error('dependent phase has no charter');
      if (!agent) throw new Error('agent not found');
      const skill = skills.find((row: Doc<'skills'>): boolean => row._id === item.skillId);
      if (!skill) throw new Error('dependent phase skill is no longer registered');
      knownValues = await knownValuesForAgent(ctx, agent);
      const plan = item.plan as ExecutionPlan;
      const feedback = liveManagerFeedback(item.managerFeedback);
      const appliedCorrections = await executorCorrections(ctx, {
        agent,
        item,
        plan,
        runId: args.runId,
        knownValues,
      });
      let prerequisites = initial;
      const initialFailure = initial.resumedClosing ? undefined : initial.initialFailure;
      // Only a connected surface can be owed: an absent or ungranted one is
      // dropped from the list the gate holds, whatever the plan declares.
      const gateSurfaces = surfaces
        .filter((surface) => verdictFor(surface, Date.now()) === 'connected')
        .map((surface) => ({ slug: surface.slug, displayName: surface.displayName }));
      const groundingReads = await itemGroundingReads(ctx, args.workItemId);
      const readCheck = (candidateOutput: DependentExecutionOutput): PlanStepOutcomeCheck => ({
        plan,
        outcomes: candidateOutput.planStepOutcomes,
        initialActions: prerequisites.actions,
        initialLedger: prerequisites.applied,
        surfaces: gateSurfaces,
        managerFeedback: feedback,
        retryNote: item.managerFeedback?.kind === 'retry-note' ? feedback : undefined,
        candidate: rowToCandidate(item),
        groundingReads,
      });
      // A declared read the set carries itself is applied before the set is
      // judged (`applyCarriedReads`), once: the first authoring is not asked
      // to repair a gap no response can close.
      let carriedReadsOwed = true;
      const carriedBy = (candidateOutput: DependentExecutionOutput): MockAction[] =>
        carriedReadsOwed
          ? carriedDeclaredReads(unmetDeclaredReads(readCheck(candidateOutput)), candidateOutput.actions, surfaces)
          : [];
      const closingGate = (candidateOutput: DependentExecutionOutput): string[] => {
        const issues: string[] = [];
        try {
          validatePlanStepOutcomes(readCheck(candidateOutput));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const carried = carriedBy(candidateOutput).length > 0 &&
            unmetDeclaredReads(readCheck(candidateOutput)).map(missingReadReason).includes(reason);
          if (!carried) issues.push(reason);
        }
        const transitionRefusal = dependentTransitionRefusal({
          plan,
          actions: candidateOutput.actions,
          planStepOutcomes: candidateOutput.planStepOutcomes,
          initialFailure,
        });
        if (transitionRefusal) issues.push(transitionRefusal);
        return issues;
      };
      const step = { agentId: item.agentId, workItemId: args.workItemId, stage: 'closing' } as const;
      const heldElsewhere = await itemsHeldElsewhere(ctx, agent, args.workItemId, knownValues);
      const authorClosingSet = (): Promise<DependentExecutionOutput> => recordingModelCalls(ctx, step, () => runDependentSkill({
        skill: { name: skill.name, description: skill.description, body: skill.body },
        plan,
        candidate: rowToCandidate(item),
        charter: charterRow.body as Charter,
        mockEnv,
        surfaces,
        mode: 'real',
        autonomousActions: autonomousActionsOn(agent),
        managerFeedback: feedback,
        managerAnswers: managerAnswersOf(item),
        appliedCorrections,
        groundingReads,
        initialOutput: prerequisites,
        initialLedger: prerequisites.applied,
        initialFailure: prerequisites.initialFailure,
        resumedClosing: prerequisites.resumedClosing,
        refusedClosing: prerequisites.refusedClosing,
        landedWrites: prerequisites.landedWrites,
        heldElsewhere,
        closingGate,
        onAuditCorrection: async (removedIndices, reason) => {
          await ctx.runMutation(internal.events.log, {
            agentId: item.agentId, type: 'audit.corrected',
            payload: { workItemId: args.workItemId, runId: args.runId, removedIndices, reason },
          });
        },
      }));
      let output = await authorClosingSet();
      const cap = dependentActionCap(initial);
      // A set over the cap is refused below as it stands: nothing in it is applied first.
      const carriedReads = output.actions.length > cap ? [] : carriedBy(output);
      carriedReadsOwed = false;
      if (carriedReads.length > 0) {
        authored = output;
        initial = await applyCarriedReads(ctx, {
          workItemId: args.workItemId, runId: args.runId, agent, surfaces, knownValues, initial, reads: carriedReads,
        });
        prerequisites = initial;
        output = await authorClosingSet();
      }
      authored = output;
      if (output.actions.length > cap) {
        throw new Error(
          `dependent phase emitted ${output.actions.length} actions; cap is ${cap}`,
        );
      }
      // The gate the executor's one repair answered to, checked once more on
      // the set that came back.
      const gate = closingGate(output);
      if (gate.length > 0) throw new ClosingGateRefusal(gate, output);
      const repaired = await recordingModelCalls(ctx, step, () => repairedForHold(output, {
        surfaces,
        skill: { name: skill.name },
        candidate: rowToCandidate(item),
        onAdditionalModelCall: (): void => {},
      }));
      const leftSaid = withLeftStepsSaid(repaired.actions, repaired.planStepOutcomes, plan, heldElsewhere, surfaces, item.replyTarget);
      const held = leftSaid.said.length > 0 ? { ...repaired, actions: leftSaid.actions } : repaired;
      authored = held;
      const repairedTransitionRefusal = dependentTransitionRefusal({
        plan, actions: held.actions, planStepOutcomes: held.planStepOutcomes, initialFailure,
      });
      if (repairedTransitionRefusal) throw new ClosingGateRefusal([repairedTransitionRefusal], held);
      const leftToHolders = held.planStepOutcomes.flatMap((outcome) => {
        const holder = outcome.status === 'blocked' ? heldItemOfBlockedStep(outcome, plan, heldElsewhere) : undefined;
        // Kept on the row, so the holder's title passes the structural redaction the prompt rows pass.
        return holder ? [{ ...holder, title: redactTokenShapes(holder.title) }] : [];
      });
      const dependent: DependentPendingOutput = {
        ...held,
        phase: 'dependent',
        actionIndexOffset: initial.actions.length,
        initial,
        ...(leftToHolders.length > 0
          ? { leftToHolders: leftToHolders.filter((holder, at) => leftToHolders.findIndex((row) => row.externalId === holder.externalId) === at) }
          : {}),
      };
      const stop = closingStopReason({
        plan,
        outcomes: output.planStepOutcomes,
        initialActions: initial.actions,
        initialApplied: initial.applied,
        closingActions: held.actions,
        initialFailure: initial.resumedClosing ? undefined : initial.initialFailure,
        surfaces,
        heldElsewhere,
      });
      if (stop) {
        const offset = initial.actions.length;
        const withheld: AppliedAction[] = output.actions.map((action, index) => ({
          tool: action.tool,
          ok: true,
          held: true,
          reason: WITHHELD_ON_STOP,
          effect: describeAction(action),
          idempotencyKey: actionIdempotencyKey({
            workItemId: args.workItemId,
            runId: args.runId,
            actionIndex: offset + index,
          }),
        }));
        await ctx.runMutation(internal.work.setFailed, {
          workItemId: args.workItemId,
          runId: args.runId,
          reason: stop,
          output: flattenedDependentOutput(dependent, withheld),
        });
        return { ok: false, reason: stop };
      }
      if (leftSaid.said.length > 0) {
        await ctx.runMutation(internal.events.log, {
          agentId: item.agentId, type: 'audit.corrected',
          payload: { workItemId: args.workItemId, runId: args.runId, removedIndices: [], reason: `${HELD_ITEM_REPLY_COMPLETED}: ${leftSaid.said.join(' ')}` },
        });
      }
      // A question this run put to the manager, here or in phase one, that
      // nobody has answered: the writes the plan left to the answer wait.
      const asked = initial.actions.filter((_action, index) => initial!.applied[index]?.ok === true && initial!.applied[index]?.held !== true);
      const gated = withOpenQuestionHeld(dependent, {
        plan, surfaces, answered: managerHasAnswered(item, plan), askedEarlier: asked,
      });
      if (gated.actions.length === 0) {
        const finalOutput = flattenedDependentOutput(gated, []);
        const failure = (initial.resumedClosing ? undefined : initial.initialFailure) ??
          scrubKnownValues(openQuestionStop(gated), knownValues) ??
          blockedPlanReason(output.planStepOutcomes);
        const reason = failure ? (gateRefusalStop(finalOutput.actions, finalOutput.applied) ?? failure) : undefined;
        if (reason) {
          await ctx.runMutation(internal.work.setFailed, {
            workItemId: args.workItemId,
            runId: args.runId,
            reason,
            output: finalOutput,
          });
          return { ok: false, reason };
        }
        await ctx.runMutation(internal.work.setCompleted, {
          workItemId: args.workItemId,
          runId: args.runId,
          output: finalOutput,
        });
        return { ok: true };
      }
      const pending = await ctx.runMutation(internal.work.setActionsPending, {
        workItemId: args.workItemId,
        runId: args.runId,
        authoringAttemptId: claim.authoringAttemptId,
        output: gated,
      });
      if (!pending.pending) {
        throw new Error('the run moved on before its dependent actions reached the gate');
      }
      return {
        ok: true,
        reason:
          pending.phase === 'auto'
            ? 'dependent actions applying'
            : "dependent actions pending the manager's approval",
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A set the obligation gate refused after its one repair stops the run:
      // the prerequisites landed and stay on the row, the refused set beside
      // its reason, and Retry resumes at the closing phase from that ledger.
      const gateRefusal = error instanceof ClosingGateRefusal;
      const refused = gateRefusal ? error.output : authored;
      await ctx.runMutation(internal.work.setFailed, {
        workItemId: args.workItemId,
        runId: args.runId,
        reason,
        ...(initial ? { output: scrubKnownValues(withRefusedClosing(initial, refused, reason), knownValues) } : {}),
        ...(gateRefusal ? { stopped: true } : {}),
      });
      return { ok: false, reason };
    }
  },
});

/**
 * The prerequisite phase as the row keeps it after a closing gate refused
 * the authored set: the ledger whole, and the refused set beside its reason.
 * A previous attempt's refused set is replaced by this one.
 */
function withRefusedClosing(
  initial: DependentAuthoringOutput,
  authored: DependentExecutionOutput | undefined,
  reason: string,
): DependentAuthoringOutput {
  if (!authored) return initial;
  return {
    ...initial,
    refusedClosing: {
      actions: authored.actions,
      planStepOutcomes: authored.planStepOutcomes,
      draft: authored.draft,
      notes: authored.notes,
      reason,
      at: Date.now(),
      ...(authored.withheldActions && authored.withheldActions.length > 0
        ? { withheldActions: authored.withheldActions }
        : {}),
    },
  };
}

/**
 * The ledger the registry's earlier-rows rules read for this phase: the
 * writes earlier runs of this item landed, then this run's prerequisite
 * phase when there is one. A status change is never the only trace of who
 * acted, and the audit comment an earlier run landed on the ticket is that
 * trace: a retry that obeys the landed-writes rule and emits the Done alone
 * is right to, and the rule must see the comment it did not repeat.
 */
function priorPhasesLedger(
  output: LedgerOutput | DependentPendingOutput,
): { actions: readonly MockAction[]; applied: readonly AppliedAction[] } | undefined {
  const dependent = isDependentPendingOutput(output);
  const carried = (dependent ? output.initial.landedWrites : output.landedWrites) ?? [];
  if (carried.length === 0) return dependent ? output.initial : undefined;
  return {
    actions: [...carried.map((write) => write.action), ...(dependent ? output.initial.actions : [])],
    applied: [...carried.map((write) => write.applied), ...(dependent ? output.initial.applied : [])],
  };
}

/**
 * The rows this phase reuses instead of sending: on a resumed closing set,
 * the previous attempt's landed rows by payload or target; in any phase,
 * the writes earlier runs of this item landed, by target. This run's own
 * phase one is not a source: the closing phase authors from that ledger
 * and a second comment it puts on the same ticket is the plan's, as when
 * phase one landed a fixed-payload comment and the audit comment follows
 * the reads. The manager's note on the retry decides whether a change to
 * a landed comment goes through. A read is never reused: it is taken now,
 * because what it reads may have changed since, not least by the writes
 * before it in this set.
 */
async function reusedRows(
  ctx: ActionCtx,
  output: LedgerOutput | DependentPendingOutput,
  surfaces: readonly SurfaceRecord[],
  run: { workItemId: Id<'workItems'>; runId: Id<'events'>; actionIndexOffset: number },
): Promise<Array<AppliedAction | undefined>> {
  const dependent = isDependentPendingOutput(output);
  const earlier: LandedWrite[] = (dependent ? output.initial.landedWrites : output.landedWrites) ?? [];
  const resumed = dependent && output.initial.resumedClosing;
  if (earlier.length === 0 && !resumed) return output.actions.map(() => undefined);
  const item = await ctx.runQuery(internal.work.getInternal, { workItemId: run.workItemId });
  const options = { surfaces, managerFeedback: liveManagerFeedback(item?.managerFeedback) };
  const fromResume = resumed
    ? resumedClosingLedger(output.actions, {
        actions: [...output.initial.actions, ...(output.initial.previousClosing?.actions ?? [])],
        applied: [...output.initial.applied, ...(output.initial.previousClosing?.applied ?? [])],
      }, run, options)
    : output.actions.map(() => undefined);
  const fromEarlier = reusedLedger(output.actions, earlier, run, options);
  return output.actions.map((action, index) => (isRead(action) ? undefined : (fromResume[index] ?? fromEarlier[index])));
}

/** Whether an action is a surface read. */
function isRead(action: MockAction): boolean {
  const parsed = parseSurfaceAction(action);
  return parsed.ok && actionIntent(parsed.action) === 'read';
}

/**
 * Apply the approved actions of the current phase, with the run id the skill ran under.
 *
 * Scheduled by `work.setActionsPending` for the gate's auto rows and by
 * `work.approveActions` for the manager's. The claim records the apply
 * attempt exactly once, so a second schedule after a restart re-applies with
 * the same idempotency keys rather than alongside a first apply that is
 * still running. In the auto phase the held rows are deferred (a placeholder
 * in the ledger, no adapter call) and every row is re-checked against the
 * toggle as it is now: a read or the manager DM, or any row while autonomous
 * actions are on; in the approved phase the auto rows' ledger entries are
 * carried forward and the rows the manager left out are recorded as not
 * approved. Every applied row passes the registry's rules (authority,
 * comment before status, attribution, provenance) and then its adapter, and
 * records what authorised it.
 */
export const applyApprovedActions = internalAction({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const claim = await ctx.runMutation(internal.work.claimApprovedActions, {
      workItemId: args.workItemId,
    });
    if (!claim.claimed) return { ok: false, reason: claim.reason };
    try {
      const agent = await ctx.runQuery(internal.agents.getInternal, { agentId: claim.agentId });
      if (!agent) throw new Error('agent not found');
      // Resolved once, before any transport: a run with many outcomes
      // decrypts once, and a list that cannot be produced fails the run
      // here rather than after a write has landed.
      const knownValues = await knownValuesForAgent(ctx, agent);
      const surfaces = await loadSurfaces(ctx, claim.agentId);
      const grantRows: Doc<'permissionGrants'>[] = await ctx.runQuery(
        internal.agents.grantedScopes,
        { agentId: claim.agentId },
      );
      const output = claim.output as LedgerOutput;
      const actionIndexOffset =
        (claim.output as { phase?: unknown; actionIndexOffset?: unknown }).phase === 'dependent' &&
        typeof (claim.output as { actionIndexOffset?: unknown }).actionIndexOffset === 'number'
          ? ((claim.output as { actionIndexOffset: number }).actionIndexOffset ?? 0)
          : 0;
      const browserMcpUrl = process.env.DAY0_BROWSER_MCP_URL;
      const resumedLedger = await reusedRows(ctx, output, surfaces, {
        workItemId: args.workItemId, runId: claim.runId, actionIndexOffset,
      });
      const priorLedger = output.actions.map((_, index) => {
        const entry = claim.phase === 'approved' ? output.applied?.[index] : undefined;
        return entry && !entry.awaitingApproval ? entry : resumedLedger[index];
      });
      const run = {
        agentId: claim.agentId,
        agentName: agent.name,
        workItemId: args.workItemId,
        runId: claim.runId,
      };
      const deps = realAdapterDeps(
        authorityBeforeTransport(ctx, claim.agentId, claim.phase, browserMcpUrl),
        browserMcpUrl,
        knownValues,
      );
      const grants = new Set(grantRows.map((grant) => grant.scope));
      const applied = withArgumentRepairs(
        await applySurfaceActions(ctx, SURFACE_MODE, surfaces, run, output.actions ?? [], {
          deps,
          grants,
          approvedIndexes: new Set(claim.approvedIndexes),
          heldReasons: new Map(claim.heldReasons),
          deferredIndexes: claim.phase === 'auto' ? new Set(claim.heldIndexes) : undefined,
          priorLedger,
          ...(priorPhasesLedger(output) ? { prerequisiteLedger: priorPhasesLedger(output) } : {}),
          ...(isDependentPendingOutput(output) && output.initial.resumedClosing
            ? { resumedRunIds: ledgerRunIds(output.initial.applied) }
            : {}),
          idempotencyIndexOffset: actionIndexOffset,
          autoPhase: claim.phase === 'auto',
          autonomousActions: claim.autonomousActions,
          replyTarget: claim.replyTarget,
          ...(SURFACE_MODE === 'real' ? { claimHold: heldByAnotherWorkItem(ctx, args.workItemId) } : {}),
        }),
        output.argumentRepairs,
      );
      if (
        SURFACE_MODE === 'real' &&
        claim.phase === 'auto' &&
        !isDependentPendingOutput(output) &&
        repairableReadFailures(output.actions ?? [], applied, surfaces).length > 0
      ) {
        const item = await ctx.runQuery(internal.work.getInternal, { workItemId: args.workItemId });
        const skills: Doc<'skills'>[] = await ctx.runQuery(internal.skills.registeredInternal, {
          agentId: claim.agentId,
        });
        const skill = skills.find((row: Doc<'skills'>): boolean => row._id === item?.skillId);
        if (item && skill) {
          // Each repaired read is applied in a call of its own, so in a new
          // browser: it is given the run's earlier rows and this phase's rows
          // before it, as they stand after any earlier repair, so a browser
          // read is signed in again before it reads.
          const actionsSoFar = [...(output.actions ?? [])];
          const appliedSoFar = [...applied];
          const earlierPhases = priorPhasesLedger(output);
          const repaired = await repairFailedReads({
            actions: output.actions ?? [],
            applied,
            surfaces,
            skill: { name: skill.name },
            candidate: rowToCandidate(item),
            repair: repairToolArguments,
            apply: async (action, index): Promise<AppliedAction> => {
              const [row] = await applySurfaceActions(ctx, SURFACE_MODE, surfaces, run, [action], {
                deps,
                grants,
                approvedIndexes: new Set([0]),
                prerequisiteLedger: {
                  actions: [...(earlierPhases?.actions ?? []), ...actionsSoFar.slice(0, index)],
                  applied: [...(earlierPhases?.applied ?? []), ...appliedSoFar.slice(0, index)],
                },
                idempotencyIndexOffset: actionIndexOffset + index,
                autoPhase: true,
                autonomousActions: claim.autonomousActions,
                replyTarget: claim.replyTarget,
              });
              actionsSoFar[index] = action;
              appliedSoFar[index] = row!;
              return row!;
            },
          });
          return await finishRun(
            ctx,
            args.workItemId,
            claim,
            { ...output, actions: repaired.actions },
            repaired.applied,
            knownValues,
            surfaces,
          );
        }
      }
      return await finishRun(ctx, args.workItemId, claim, output, applied, knownValues, surfaces);
    } catch (err) {
      const reason = (err as Error).message;
      await ctx.runMutation(internal.work.recoverInterruptedApply, {
        workItemId: args.workItemId,
        pendingRunId: claim.pendingRunId,
        phase: claim.phase,
      });
      return { ok: false, reason };
    }
  },
});

/**
 * The external items other work items hold, as an executor prompt may show them.
 *
 * Read fresh before each authoring, so a closing phase sees a note the holder
 * landed since phase one. Real mode only: the mock path makes no call. The
 * titles are provider text, so the owner's exact values are scrubbed here and
 * the prompt lines apply the structural pass; the values are resolved only
 * when there is something to scrub.
 *
 * Args:
 *   ctx: Convex action context.
 *   agent: The authoring employee.
 *   workItemId: The work item about to be authored.
 *   knownValues: The owner's stored values, when the caller already holds them.
 *
 * Returns:
 *   The held items, scrubbed; empty in mock mode.
 */
async function itemsHeldElsewhere(
  ctx: ActionCtx,
  agent: Doc<'agents'>,
  workItemId: Id<'workItems'>,
  knownValues?: readonly string[],
): Promise<HeldExternalItem[]> {
  if (SURFACE_MODE !== 'real') return [];
  const held: HeldExternalItem[] = await ctx.runQuery(internal.work.itemsHeldElsewhere, { workItemId });
  if (held.length === 0) return held;
  return scrubKnownValues(held, knownValues ?? (await knownValuesForAgent(ctx, agent)));
}

/**
 * The apply path's read of the owner-wide claims, for the items a set writes.
 *
 * Args:
 *   ctx: Convex action context.
 *   workItemId: The work item whose set is being applied.
 *
 * Returns:
 *   The check `applySurfaceActions` makes before a write is sent.
 */
function heldByAnotherWorkItem(ctx: ActionCtx, workItemId: Id<'workItems'>): ClaimHold {
  // A page field is written by a fill and the control that submits it. Once
  // this apply has withheld a fill on a browser-driven surface, the writes
  // that follow it there (the Save) are withheld with it: a Save alone would
  // stamp the page's audit line for a value this work never entered. Reads,
  // and the sign-in before the fill, go on, so the work still reads the page.
  const withheldPages = new Map<string, string>();
  return async (parsed, surface): Promise<string | undefined> => {
    const browserDriven = surface.path === 'browser-driven';
    const earlier = browserDriven ? withheldPages.get(surface.slug) : undefined;
    const targets = writeTargetIds(parsed, surface);
    if (targets.length === 0) {
      return earlier !== undefined && actionIntent(parsed) === 'write' ? earlier : undefined;
    }
    const holder = await ctx.runQuery(internal.work.writeClaimHolder, {
      workItemId,
      surfaceSlug: surface.slug,
      targets,
    });
    if (!holder) return earlier;
    const reason = withheldByClaimReason(
      browserDriven ? { ...holder, target: `the page field "${holder.target}" on ${surface.slug}` } : holder,
    );
    if (browserDriven) withheldPages.set(surface.slug, reason);
    return reason;
  };
}

/**
 * Take the documented page fields this work item's approved plan writes,
 * before it authors, so the work beside it is told and reads the page.
 *
 * Args:
 *   ctx: Convex action context.
 *   workItemId: The work item about to author.
 *   plan: Its approved plan.
 *   surfaces: The agent's surfaces.
 *   mockEnv: The loaded documentation.
 */
async function claimPlannedWriteTargets(
  ctx: ActionCtx,
  workItemId: Id<'workItems'>,
  plan: Pick<ExecutionPlan, 'obligations'>,
  surfaces: readonly SurfaceRecord[],
  mockEnv: { howToGuides: ReadonlyArray<{ body: string }>; teamDocs: ReadonlyArray<{ body: string }> },
): Promise<void> {
  if (SURFACE_MODE !== 'real') return;
  const targets = plannedWriteTargets(plan.obligations, surfaces, [...mockEnv.howToGuides, ...mockEnv.teamDocs]);
  if (targets.length === 0) return;
  await ctx.runMutation(internal.work.takeWriteTargetClaims, { workItemId, targets });
}

/**
 * The runtime the real-mode adapters run in: credentials decrypted through
 * the credentials action, Mastra's MCP client, and the Node `fetch`.
 *
 * Returns:
 *   Adapter dependencies for this action runtime.
 */
function realAdapterDeps(
  beforeTransport?: BeforeSurfaceTransport,
  browserMcpUrl: string | undefined = process.env.DAY0_BROWSER_MCP_URL,
  knownValues: readonly string[] = [],
): RealAdapterDeps {
  return {
    decrypt: decryptCredential,
    createMcpClient: createMastraMcpClient,
    browserMcpUrl,
    fetch: (input: URL, init: RequestInit): Promise<Response> => fetch(input, init),
    beforeTransport,
    spanModel: SURFACE_MODE === 'real' ? spanModelFromEnv() : undefined,
    knownValues,
  };
}

/**
 * The owner's stored credential values for this action invocation.
 *
 * Only real mode holds credentials a provider could echo; the mock
 * environment reads nothing from outside the repository and its adapters
 * never see a decrypted value.
 */
async function knownValuesForAgent(ctx: ActionCtx, agent: Doc<'agents'>): Promise<readonly string[]> {
  if (SURFACE_MODE !== 'real' || !agent.userId) return [];
  return await ownerKnownValues(ctx, agent.userId);
}

/** Refuse a browser switch that changed after the apply action claimed it. */
export function browserTransportRefusal(
  path: string | undefined,
  claimedUrl: string | undefined,
  currentUrl: string | undefined,
): string | undefined {
  if (path !== 'browser-driven') return undefined;
  try {
    const claimed = browserComponent(claimedUrl);
    if (!claimed.present) return claimed.reason;
    const current = browserComponent(currentUrl);
    if (!current.present) return current.reason;
    return claimed.url.href === current.url.href
      ? undefined
      : 'browser component changed before transport';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function surfaceAuthorityShape(surface: SurfaceRecord): string {
  return JSON.stringify({
    slug: surface.slug,
    verdict: surface.verdict,
    credentialLanded: surface.credentialLanded,
    lastVerifiedAt: surface.lastVerifiedAt,
    path: surface.path,
    endpoint: surface.endpoint,
    toolAllowlist: [...(surface.toolAllowlist ?? [])].sort(),
    toolArguments: surface.toolArguments,
    credentialId: surface.credentialId,
    credentialKind: surface.credentialKind,
    managerDmChannelId: surface.managerDmChannelId,
    managerUserId: surface.managerUserId,
  });
}

/**
 * Re-read every mutable authority input immediately before provider transport.
 *
 * A replayed browser call (a sign-in repeated in a new invocation) is judged
 * under the authority its original row landed with, not this phase's rule:
 * a revoked scope blocks it whatever that authority was.
 */
function authorityBeforeTransport(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  phase: 'auto' | 'approved',
  browserMcpUrl: string | undefined,
): BeforeSurfaceTransport {
  return async (action, claimedSurface, replay): Promise<string | undefined> => {
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok) return parsed.reason;
    const authority = await ctx.runQuery(internal.work.transportAuthority, {
      agentId,
      surfaceSlug: parsed.action.surface,
    });
    if (!authority.agentExists) return 'agent not found';
    const surface = authority.surface;
    if (!surface) return UNKNOWN_SURFACE;
    if (surfaceAuthorityShape(surface) !== surfaceAuthorityShape(claimedSurface)) {
      return 'surface authority changed before transport';
    }
    const refusal =
      surfaceRefusal(surface, Date.now()) ??
      pathRefusal(parsed.action, surface) ??
      mcpEndpointRefusal(surface) ??
      toolRefusal(parsed.action, surface);
    if (refusal) return refusal;
    if (replay) {
      const replayRefusal = replayAuthorityRefusal(parsed.action, surface, replay.authority, {
        grants: new Set(authority.grants),
        autonomousActions: authority.autonomousActions,
        revokedScopes: new Set(authority.revokedScopes ?? []),
      });
      return (
        replayRefusal ??
        browserTransportRefusal(surface.path, browserMcpUrl, process.env.DAY0_BROWSER_MCP_URL)
      );
    }
    if (phase === 'auto' && !isAutomatic(parsed.action, surface, authority.autonomousActions)) {
      return NOT_AUTOMATIC;
    }
    // Approved writes use the manager's exact-action approval as authority,
    // even if the generic write grant was revoked after hold. Reads and the
    // manager DM still require their standing grant at this last checkpoint.
    if (needsStandingGrant(parsed.action, surface) || phase === 'auto') {
      const grant = grantRefusal(
        parsed.action,
        surface,
        new Set(authority.grants),
        phase === 'auto' && authority.autonomousActions,
        new Set(authority.revokedScopes ?? []),
      );
      if (grant) return grant;
    }
    return browserTransportRefusal(surface.path, browserMcpUrl, process.env.DAY0_BROWSER_MCP_URL);
  };
}

/**
 * Load the agent's surfaces as the executors read them.
 *
 * Args:
 *   ctx: Convex action context.
 *   agentId: The agent.
 *
 * Returns:
 *   Executor-facing surface records.
 */
/**
 * Load what a real-mode plan is drawn from: the agent's surfaces with their
 * verdicts and the same documentation the executor cites.
 *
 * Mock mode passes nothing, so the hosted demo's planner prompt stays as it
 * is; the mock environment already carries its own documents to the executor.
 *
 * Args:
 *   ctx: Convex action context.
 *   agentId: The agent whose surfaces and documentation are read.
 *   internalCaller: Whether the documentation is read without a caller, for a scheduled step.
 *
 * Returns:
 *   The planner's grounding, or an empty object outside real mode.
 */
async function planGrounding(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  internalCaller: boolean,
): Promise<Pick<DraftPlanArgs, 'surfaces' | 'documents'>> {
  if (SURFACE_MODE !== 'real') return {};
  const [surfaces, snapshot] = await Promise.all([
    loadSurfaces(ctx, agentId),
    internalCaller
      ? ctx.runQuery(internal.mock.snapshotInternal, { agentId })
      : readSurfaceSnapshot(ctx, agentId, 'mock', []),
  ]);
  return {
    surfaces,
    documents: { howToGuides: snapshot.howToGuides, teamDocs: snapshot.teamDocs },
  };
}

/**
 * The item's plan-grounding reads for the executor's evidence check: what
 * the ticket said when it was read for the plan, so a message may repeat
 * it. Real mode only; the mock executor runs no evidence check.
 *
 * Args:
 *   ctx: Convex action context.
 *   workItemId: The work item being executed.
 *
 * Returns:
 *   The reads as their events stored them, or undefined outside real mode.
 */
async function itemGroundingReads(
  ctx: ActionCtx,
  workItemId: Id<'workItems'>,
): Promise<GroundingRead[] | undefined> {
  if (SURFACE_MODE !== 'real') return undefined;
  return (await ctx.runQuery(internal.work.planGroundingReads, { workItemId })) as GroundingRead[];
}

/**
 * Read what the candidate points at before the plan is drafted: a ticket's
 * own record, or the thread a chat ask sits in.
 *
 * One standing-authority read through the same registry, rules and adapter as
 * an executed action, keyed on an event minted for it so the ledger row is on
 * the timeline. A failed read, including a provider error body, becomes
 * "unavailable" with the reason; nothing here stops the plan.
 *
 * Args:
 *   ctx: Convex action context.
 *   args: The work item, agent, candidate and surfaces.
 *
 * Returns:
 *   The record or its unavailability, or undefined when there is no record to read.
 */
async function readCandidateRecord(
  ctx: ActionCtx,
  args: {
    workItemId: Id<'workItems'>;
    agentId: Id<'agents'>;
    agentName: string;
    autonomousActions: boolean;
    candidate: WorkCandidate;
    surfaces: readonly SurfaceRecord[];
    /** The owner's stored values, resolved once by the calling action. */
    knownValues: readonly string[];
  },
): Promise<CandidateRecord | undefined> {
  const read = candidateRecordRead(args.candidate, args.surfaces, Date.now());
  if (!read) return undefined;
  try {
    const eventId = await ctx.runMutation(internal.work.beginPlanGroundingRead, {
      workItemId: args.workItemId,
      action: read.action,
    });
    const grantRows: Doc<'permissionGrants'>[] = await ctx.runQuery(
      internal.agents.grantedScopes,
      { agentId: args.agentId },
    );
    const browserMcpUrl = process.env.DAY0_BROWSER_MCP_URL;
    const [rawApplied] = await applySurfaceActions(
      ctx,
      SURFACE_MODE,
      args.surfaces,
      {
        agentId: args.agentId,
        agentName: args.agentName,
        workItemId: args.workItemId,
        runId: eventId,
      },
      [read.action],
      {
        deps: realAdapterDeps(
          authorityBeforeTransport(ctx, args.agentId, 'auto', browserMcpUrl),
          browserMcpUrl,
          args.knownValues,
        ),
        grants: new Set(grantRows.map((grant) => grant.scope)),
        approvedIndexes: new Set([0]),
        autoPhase: true,
        autonomousActions: args.autonomousActions,
      },
    );
    const applied = rawApplied
      ? await redactGroundingRead(rawApplied, spanModelFromEnv(), args.knownValues)
      : undefined;
    await ctx.runMutation(internal.work.finishPlanGroundingRead, { eventId, applied });
    const { surface, tool, subject } = read;
    if (!applied || !applied.ok || applied.held) {
      return { surface, tool, subject, unavailable: applied?.reason ?? 'the read did not land' };
    }
    return { surface, tool, subject, text: applied.effect ?? `(empty ${subject})` };
  } catch (error) {
    const { surface, tool, subject } = read;
    return { surface, tool, subject, unavailable: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The manager's corrections a later item is planned with: this employee's
 * active ones of the item's kind, selected in code and scrubbed for the
 * prompt. The scope judgement never reads them; scope is the charter's.
 *
 * Args:
 *   ctx: Convex action context.
 *   item: The work item about to be planned.
 *   knownValues: The owner's stored values, resolved once by the calling action.
 *
 * Returns:
 *   The prompt entries, and whether the scrub ran without the span model.
 */
async function plannerCorrections(
  ctx: ActionCtx,
  item: Doc<'workItems'>,
  knownValues: readonly string[],
): Promise<{ entries: PlannerCorrection[]; redaction?: 'structural-only' }> {
  const selected: Doc<'corrections'>[] = await ctx.runQuery(internal.corrections.selectedForCandidate, {
    agentId: item.agentId,
    sourceCategory: item.sourceCategory,
    sourceSystem: item.sourceSystem,
  });
  if (selected.length === 0) return { entries: [] };
  return await scrubbedCorrectionEntries(selected, { model: spanModelFromEnv(), known: knownValues });
}

/**
 * The corrections an approved plan applied, as its executor reads them:
 * the plan's own list, this employee's only, scrubbed at prompt assembly. A
 * correction kept from this same item whose words are already on the run as
 * its live manager feedback is not repeated. A scrub without the span model
 * is recorded on the timeline.
 *
 * Args:
 *   ctx: Convex action context.
 *   args: The agent, the work item, its approved plan, the run, and the
 *     owner's stored values when the caller already resolved them.
 *
 * Returns:
 *   The prompt entries; empty in mock mode or when the plan applied none.
 */
async function executorCorrections(
  ctx: ActionCtx,
  args: {
    agent: Doc<'agents'>;
    item: Doc<'workItems'>;
    plan: ExecutionPlan;
    runId: Id<'events'>;
    knownValues?: readonly string[];
  },
): Promise<PlannerCorrection[]> {
  const ids = SURFACE_MODE === 'real' ? (args.plan.appliedCorrections ?? []) : [];
  if (ids.length === 0) return [];
  const rows: Doc<'corrections'>[] = await ctx.runQuery(internal.corrections.forPlan, {
    agentId: args.item.agentId,
    ids,
  });
  const live = liveManagerFeedback(args.item.managerFeedback);
  const carried = rows.filter((row) => !(row.workItemId === args.item._id && row.text === live));
  if (carried.length === 0) return [];
  const scrubbed = await scrubbedCorrectionEntries(carried, {
    model: spanModelFromEnv(),
    known: args.knownValues ?? (await knownValuesForAgent(ctx, args.agent)),
  });
  if (scrubbed.redaction) {
    await ctx.runMutation(internal.events.log, {
      agentId: args.item.agentId,
      type: 'work.corrections-redaction-limited',
      payload: {
        workItemId: args.item._id,
        runId: args.runId,
        correctionIds: carried.map((row) => row._id),
      },
    });
  }
  return scrubbed.entries;
}

async function loadSurfaces(ctx: ActionCtx, agentId: Id<'agents'>): Promise<SurfaceRecord[]> {
  const rows: Doc<'surfaces'>[] = await ctx.runQuery(internal.orientationData.surfacesForAgent, {
    agentId,
  });
  return rows.map((row) => toSurfaceRecord(row));
}

/** What `finishRun` needs from the apply claim. */
interface FinishClaim {
  runId: Id<'events'>;
  applyAttemptId: Id<'events'>;
  phase: 'auto' | 'approved';
}

/** Why a deferred row stays unapplied when the auto phase fails. */
export const NOT_APPLIED_AFTER_FAILURE = 'not applied because an automatic action failed';

/**
 * Record the outcome of an applied phase.
 *
 * A run completes only when every action it emitted changed the work
 * environment or was held. "At least one applied" is not enough: the skills
 * are told to DM the manager alongside the primary mutation, so a failed
 * primary action plus a delivered "I did it" DM would report the work as done
 * when only the claim about it landed. After the auto phase a run that still
 * has rows awaiting the manager is parked rather than completed; a failure in
 * the auto phase fails the run and the deferred rows never reach the manager.
 *
 * Args:
 *   ctx: Convex action context.
 *   workItemId: The work item.
 *   claim: The run, the apply attempt and the phase.
 *   output: The skill's draft, notes and actions.
 *   applied: The ledger.
 *
 * Returns:
 *   Whether the phase ended well.
 */
async function finishRun(
  ctx: ActionCtx,
  workItemId: Id<'workItems'>,
  claim: FinishClaim,
  rawOutput: LedgerOutput | DependentPendingOutput,
  rawApplied: AppliedAction[],
  knownValues: readonly string[] = [],
  surfaces: readonly SurfaceRecord[] = [],
): Promise<{ ok: boolean; reason?: string }> {
  // The whole persisted record passes the exact-value layer once more here:
  // the adapters already applied it to provider text, and this covers every
  // other string the dashboard renders from the run, whatever wrote it.
  const output = scrubKnownValues(rawOutput, knownValues);
  // A read the gate refused is dropped with its ledger line and is no failure
  // of the run; a refused write still is.
  const applied = scrubKnownValues(withRefusedReadsDropped(rawOutput.actions ?? [], rawApplied), knownValues);
  const failures = applied.filter((action: AppliedAction): boolean => !action.ok && !action.held);
  const reason =
    applied.length === 0
      ? 'skill emitted no actions, so nothing in the work environment changed'
      : failures.length > 0
        ? `${failures.length} of ${applied.length} actions did not change the work environment: ${failures
            .map((failure: AppliedAction): string => `${failure.tool} (${failure.reason})`)
            .join('; ')}`
        : undefined;
  const settled = reason
    ? applied.map((entry) =>
        entry.awaitingApproval
          ? { ...entry, awaitingApproval: undefined, reason: NOT_APPLIED_AFTER_FAILURE }
          : entry,
      )
    : applied;
  if (isDependentPendingOutput(output)) {
    if (!reason && claim.phase === 'auto' && applied.some((entry) => entry.awaitingApproval)) {
      const parked = await ctx.runMutation(internal.work.setAwaitingApproval, {
        workItemId,
        runId: claim.runId,
        applyAttemptId: claim.applyAttemptId,
        output: { ...output, applied },
      });
      if (!parked.parked) {
        return {
          ok: false,
          reason: 'the run was moved on before its held actions could be parked',
        };
      }
      return {
        ok: true,
        reason: "automatic dependent actions applied; the rest await the manager's approval",
      };
    }
    const finalOutput = flattenedDependentOutput(output, settled);
    const finalReason =
      (output.initial.resumedClosing ? undefined : output.initial.initialFailure) ??
      reason ??
      openQuestionStop(output) ??
      blockedPlanReason(output.planStepOutcomes, {
        plan: (await ctx.runQuery(internal.work.getInternal, { workItemId }))?.plan as ExecutionPlan,
        actions: finalOutput.actions,
        applied: finalOutput.applied,
        // The holders the set was authored under stand, as a claim-withheld
        // row's line does. A set kept before they were recorded reads them now.
        heldElsewhere:
          output.leftToHolders ??
          (SURFACE_MODE === 'real' && output.planStepOutcomes.some((outcome) => outcome.status === 'blocked')
            ? scrubKnownValues(
                (await ctx.runQuery(internal.work.itemsHeldElsewhere, { workItemId })) as HeldExternalItem[],
                knownValues,
              )
            : undefined),
      });
    if (finalReason) {
      const ended = gateRefusalStop(finalOutput.actions, finalOutput.applied) ?? finalReason;
      await ctx.runMutation(internal.work.setFailed, {
        workItemId,
        reason: ended,
        runId: claim.runId,
        output: finalOutput,
      });
      return { ok: false, reason: ended };
    }
    await ctx.runMutation(internal.work.setCompleted, {
      workItemId,
      runId: claim.runId,
      output: finalOutput,
    });
    return { ok: true };
  }
  if (output.needsDependentPhase === true) {
    if (!reason && claim.phase === 'auto' && applied.some((entry) => entry.awaitingApproval)) {
      const parked = await ctx.runMutation(internal.work.setAwaitingApproval, {
        workItemId,
        runId: claim.runId,
        applyAttemptId: claim.applyAttemptId,
        output: { ...output, applied },
      });
      if (!parked.parked) {
        return {
          ok: false,
          reason: 'the run was moved on before its held actions could be parked',
        };
      }
      return {
        ok: true,
        reason: "automatic actions applied; the rest await the manager's approval",
      };
    }
    // A prerequisite failure with nothing landed leaves the closing phase
    // nothing to audit and the manager nothing to decide: the run stops here.
    if (reason && landedWork({ ...output, applied: settled }, surfaces).length === 0) {
      const ended = gateRefusalStop(output.actions, settled) ?? reason;
      await ctx.runMutation(internal.work.setFailed, {
        workItemId,
        reason: ended,
        runId: claim.runId,
        output: { ...output, applied: settled },
      });
      return { ok: false, reason: ended };
    }
    const prepared = await ctx.runMutation(internal.work.prepareDependentPhase, {
      workItemId,
      runId: claim.runId,
      applyAttemptId: claim.applyAttemptId,
      output: {
        ...output,
        phase: 'dependent-authoring',
        applied: settled,
        ...(reason ? { initialFailure: reason } : {}),
      } satisfies DependentAuthoringOutput,
    });
    if (!prepared.prepared) {
      return { ok: false, reason: 'the run moved on before its dependent phase was prepared' };
    }
    return {
      ok: true,
      reason: reason
        ? 'prerequisite actions failed; dependent failure report authoring'
        : 'prerequisite actions applied; dependent actions authoring',
    };
  }
  if (reason) {
    const ended = gateRefusalStop(output.actions, settled) ?? reason;
    await ctx.runMutation(internal.work.setFailed, {
      workItemId,
      reason: ended,
      runId: claim.runId,
      output: { ...output, applied: settled },
    });
    return { ok: false, reason: ended };
  }
  if (claim.phase === 'auto' && applied.some((entry) => entry.awaitingApproval)) {
    const parked = await ctx.runMutation(internal.work.setAwaitingApproval, {
      workItemId,
      runId: claim.runId,
      applyAttemptId: claim.applyAttemptId,
      output: { ...output, applied },
    });
    if (!parked.parked) {
      return { ok: false, reason: 'the run was moved on before its held actions could be parked' };
    }
    return { ok: true, reason: "automatic actions applied; the rest await the manager's approval" };
  }
  // The question went out and the writes that wait on its answer were
  // withheld: the run ends on the question, and Retry with a note answers it.
  const openQuestion = openQuestionStop(output);
  if (openQuestion) {
    await ctx.runMutation(internal.work.setFailed, {
      workItemId,
      reason: openQuestion,
      runId: claim.runId,
      output: { ...output, applied },
    });
    return { ok: false, reason: openQuestion };
  }
  await ctx.runMutation(internal.work.setCompleted, {
    workItemId,
    runId: claim.runId,
    output: { ...output, applied },
  });
  return { ok: true };
}

/**
 * Explain why an applied-action ledger cannot complete its work item.
 *
 * Args:
 *   applied: Evidence rows returned by the surface adapters.
 *
 * Returns:
 *   Failure reason, or undefined when every proposed action landed.
 */
export function completionFailure(applied: AppliedAction[]): string | undefined {
  const failures = applied.filter((action: AppliedAction): boolean => !action.ok);
  if (applied.length === 0) {
    return 'skill emitted no actions, so nothing in the work environment changed';
  }
  if (failures.length > 0) {
    return (
      `${failures.length} of ${applied.length} actions did not change the work environment: ` +
      failures
        .map((failure: AppliedAction): string => `${failure.tool} (${failure.reason})`)
        .join('; ')
    );
  }
  return undefined;
}
