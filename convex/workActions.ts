'use node';

import { v } from 'convex/values';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { api, internal } from './_generated/api';
import {
  evaluateCandidate,
  inferRequiredPermissions,
  type EvaluateLookups,
} from '../src/work/evaluate';
import { draftExecutionPlan, type DraftPlanArgs } from '../src/work/plan';
import { runDependentSkill, runSkill } from '../src/work/execute-skill';
import type { Charter } from '../src/agent/charter';
import {
  DEPENDENT_ACTION_CAP,
  type DependentExecutionOutput,
  type ExecutionPlan,
  type PlanStepOutcome,
  type WorkCandidate,
  type WorkSourceCategory,
} from '../src/work/types';
import { replyTargetFor } from '../src/work/reply-target';
import type { Doc, Id } from './_generated/dataModel';
import { asAgentId } from '../src/lib/ids';
import {
  applySurfaceActions,
  readSurfaceSnapshot,
  type RealAdapterDeps,
} from '../src/surfaces/registry';
import type { AppliedAction, BeforeSurfaceTransport, SurfaceRecord } from '../src/surfaces/types';
import { decryptCredential } from '../src/surfaces/credentials';
import { createMastraMcpClient } from '../src/surfaces/mcp';
import { toSurfaceRecord } from '../src/surfaces/records';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { browserComponent } from '../src/surfaces/browser';
import type { ExecutionOutput } from '../src/work/types';
import { autonomousActionsOn } from '../src/work/autonomy';
import {
  grantRefusal,
  actionIntent,
  isAutomatic,
  isAuditComment,
  isStatusChange,
  needsStandingGrant,
  NOT_AUTOMATIC,
  mcpEndpointRefusal,
  parseSurfaceAction,
  pathRefusal,
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
}

interface MatchableSkill {
  name: string;
  description: string;
  requiredScopes?: readonly string[];
  targetSurface?: string;
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

export function findMatchingSkillForCandidate<T extends MatchableSkill>(
  candidate: SkillMatchCandidate,
  skills: readonly T[],
): T | undefined {
  const source = candidate.sourceSystem.toLowerCase();
  const sourceTokens = tokens(candidate.sourceSystem);
  const candidateTokens = new Set(
    tokens(`${candidate.title} ${candidate.contentSummary}`).filter((token) => token.length >= 4),
  );
  let best: T | undefined;
  let bestScore = 0;

  for (const skill of skills) {
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
    replyTarget: replyTargetFor(row),
  };
}

function buildLookups(args: {
  ctx: ActionCtx;
  agentId: Id<'agents'>;
  registeredSkills: SimpleSkillRow[];
  grantedScopes: Set<string>;
}): EvaluateLookups {
  return {
    hasGrantForScope: async (scope) => args.grantedScopes.has(scope),
    findExistingClaim: async (sourceSystem, externalId) => {
      return await args.ctx.runQuery(api.work.findExistingClaim, {
        agentId: args.agentId,
        sourceSystem,
        externalId,
      });
    },
    countOpenClaims: async () => {
      return await args.ctx.runQuery(api.work.countOpenForAgent, { agentId: args.agentId });
    },
    findMatchingSkill: async (candidate, charter) => {
      void charter;
      const skill = findMatchingSkillForCandidate(candidate, args.registeredSkills);
      return skill ? { name: skill.name, description: skill.description } : null;
    },
  };
}

export const evaluateWorkItem = action({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ decision: string }> => {
    const item: Doc<'workItems'> | null = await ctx.runQuery(api.work.get, {
      workItemId: args.workItemId,
    });
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
    const charterRow = await ctx.runQuery(api.charters.latest, {
      agentId,
    });
    if (!charterRow || !charterRow.approved) {
      throw new Error('cannot evaluate: charter not approved');
    }
    const charter = charterRow.body as Charter;
    const [agent, agentsMd, skillRows, grantRows, surfaceConfig, surfaces] = await Promise.all([
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
    const registeredSkills: SimpleSkillRow[] = skillRows.map((s: Doc<'skills'>) => ({
      _id: s._id,
      name: s.name,
      description: s.description,
      body: s.body,
      requiredScopes: s.requiredScopes,
      targetSurface: s.targetSurface,
    }));
    const grantedScopes = new Set<string>(grantRows.map((g) => g.scope));

    const lookups = buildLookups({
      ctx,
      agentId,
      registeredSkills,
      grantedScopes,
    });
    const candidate = rowToCandidate(item);
    const verdict = await evaluateCandidate(
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
      },
      lookups,
    );
    const storedVerdict: { decision: string } = await ctx.runMutation(internal.work.setVerdict, {
      workItemId: args.workItemId,
      verdict,
    });

    // For needs-skill, propose a new skill row immediately.
    if (storedVerdict.decision === 'needs-skill' && verdict.decision === 'needs-skill') {
      const required = inferRequiredPermissions(candidate);
      const writeScope = `${candidate.sourceSystem}:write`;
      const requiredScopes = [...new Set([...required, writeScope])];
      const skillId = await ctx.runMutation(internal.skills.propose, {
        agentId,
        workItemId: args.workItemId,
        name: verdict.suggestedSkillName,
        description: `Skill proposed to handle ${candidate.sourceSystem} work like "${candidate.title}".`,
        rationale: verdict.suggestedSkillRationale,
        requiredScopes,
      });
      await ctx.runMutation(internal.work.setProposedSkill, {
        workItemId: args.workItemId,
        skillId,
      });
    }

    return { decision: storedVerdict.decision };
  },
});

export const draftPlan = action({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const item: Doc<'workItems'> | null = await ctx.runQuery(api.work.get, {
      workItemId: args.workItemId,
    });
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
    const charterRow = await ctx.runQuery(api.charters.latest, {
      agentId,
    });
    if (!charterRow) return { ok: false, reason: 'no charter' };
    const agent = await ctx.runQuery(api.agents.get, { agentId });
    const plan = await draftExecutionPlan({
      candidate: rowToCandidate(item),
      charter: charterRow.body as Charter,
      autonomousActions: autonomousActionsOn(agent),
      surfaceMode: SURFACE_MODE,
      ...(await planGrounding(ctx, agentId)),
    });
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
      return await executeApprovedPlanHandler(ctx, args);
    }
    return { ok: true };
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
  const pickedSkill = findMatchingSkillForCandidate(candidate, skills);
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
  return await holdDay0Actions(ctx, {
    workItemId: args.workItemId,
    agentId,
    runId: claim.runId,
    skill: pickedSkill,
    plan,
    candidate,
    charter,
    internalCaller,
    managerFeedback: item.managerFeedback?.reason,
  });
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
    agentId: Id<'agents'>;
    runId: Id<'events'>;
    skill: SimpleSkillRow;
    plan: Awaited<ReturnType<typeof draftExecutionPlan>>;
    candidate: WorkCandidate;
    charter: Charter;
    internalCaller: boolean;
    /** The manager's reason for rejecting the previous attempt, if this is a retry. */
    managerFeedback?: string;
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
      onAdditionalModelCall: () => {
        additionalModelCalls += 1;
      },
    });
    const stagedOutput =
      SURFACE_MODE === 'real'
        ? prerequisiteOutput(output, args.plan)
        : { ...output, needsDependentPhase: false };
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

/** A ledger as the row carries it between the two phases. */
type LedgerOutput = ExecutionOutput & { applied?: Array<AppliedAction | undefined> };

interface DependentAuthoringOutput extends ExecutionOutput {
  phase: 'dependent-authoring';
  applied: AppliedAction[];
  initialFailure?: string;
}

interface DependentPendingOutput extends DependentExecutionOutput {
  phase: 'dependent';
  actionIndexOffset: number;
  initial: DependentAuthoringOutput;
  applied?: AppliedAction[];
}

function isDependentPendingOutput(
  output: LedgerOutput | DependentPendingOutput,
): output is DependentPendingOutput {
  return (output as { phase?: unknown }).phase === 'dependent';
}

const RESULT_STEP =
  /\b(read|read-back|check|identify|inspect|verify|validate|find|look up|snapshot|evidence|result)\b/gi;
const CLOSE_STEP = /\b(close|closed|complete|completed|done|resolve|resolved)\b/gi;
const CLAUSE_BOUNDARY = /\b(?:after|before|but|once|then|until)\b|[.;\n]/gi;
const NEGATED_INSTRUCTION = /\b(?:defer|do not|don't|hold|never|not|wait for|without|withhold)\b/i;
/** A term that names a period is a noun phrase ("close week", "close of quarter"), not a verb. */
const PERIOD_NOUN = /^\s*(?:of\s+(?:the\s+)?)?(?:day|week|month|quarter|year|period|cycle|date)s?\b/i;
/** A term after a determiner or "end" is a noun ("the close", "month-end close"), not a verb. */
const NOUN_MARKER = /\b(?:the|a|an|our|its|their|this|that|each|every|end|of)\s+$/i;
/** A span in double quotation marks cites a title or a message; it is not an instruction. */
const QUOTED_SPAN = /"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g;

/**
 * The part of a plan step that instructs, with every quoted span blanked.
 *
 * A step that says `locate the "Refresh the dashboard tile" request` names a
 * ticket, and the words inside the quotes belong to that ticket's title, not
 * to the step: they promise no read, name no surface and close nothing.
 *
 * Args:
 *   step: One approved plan step.
 *
 * Returns:
 *   The step with each quoted span replaced by a space.
 */
function instructionText(step: string): string {
  return step.replace(QUOTED_SPAN, ' ');
}

/**
 * Whether at least one occurrence is an instruction to act rather than to
 * withhold. A term inside a hyphenated compound on either side ("read-back",
 * "close-week"), after a determiner or "end", or followed by a period noun is
 * vocabulary, not an instruction.
 */
function affirmedStepTerm(rawStep: string, terms: RegExp): boolean {
  const step = instructionText(rawStep);
  terms.lastIndex = 0;
  for (let match = terms.exec(step); match; match = terms.exec(step)) {
    if (step[match.index - 1] === '-') continue;
    const after = step.slice(match.index + match[0].length);
    if (after.startsWith('-') || PERIOD_NOUN.test(after)) continue;
    const prefix = step.slice(0, match.index);
    if (NOUN_MARKER.test(prefix)) continue;
    CLAUSE_BOUNDARY.lastIndex = 0;
    let boundary = 0;
    for (
      let separator = CLAUSE_BOUNDARY.exec(prefix);
      separator;
      separator = CLAUSE_BOUNDARY.exec(prefix)
    ) {
      boundary = CLAUSE_BOUNDARY.lastIndex;
    }
    if (!NEGATED_INSTRUCTION.test(prefix.slice(boundary))) return true;
  }
  return false;
}

function promisesResult(step: string): boolean {
  return affirmedStepTerm(step, RESULT_STEP);
}

function promisesClose(step: string): boolean {
  return affirmedStepTerm(step, CLOSE_STEP);
}

/** Whether the approved plan or emitted prerequisites require one result-aware turn. */
export function needsDependentPhase(output: ExecutionOutput, plan: ExecutionPlan): boolean {
  return output.needsDependentPhase === true || plan.steps.some(promisesResult);
}

/** Keep result-independent prerequisites; every later literal is re-authored from the ledger. */
export function prerequisiteOutput(output: ExecutionOutput, plan: ExecutionPlan): ExecutionOutput {
  const dependent = needsDependentPhase(output, plan);
  if (!dependent) return { ...output, needsDependentPhase: false };
  let lastRead = -1;
  output.actions.forEach((action, index): void => {
    const parsed = parseSurfaceAction(action);
    if (parsed.ok && actionIntent(parsed.action) === 'read') lastRead = index;
  });
  return {
    ...output,
    needsDependentPhase: true,
    actions: lastRead < 0 ? [] : output.actions.slice(0, lastRead + 1),
  };
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

function namedInStep(step: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(step);
}

/**
 * Refuse a silent omission when an approved step explicitly promised a surface read.
 *
 * A step names a surface by its slug or by its display name: a plan says
 * "the Looker pipeline tile", not "looker-pipeline-tile".
 */
export function validatePlanStepOutcomes(args: {
  plan: ExecutionPlan;
  outcomes: readonly PlanStepOutcome[];
  initialActions: readonly ExecutionOutput['actions'][number][];
  initialLedger: readonly AppliedAction[];
  surfaces: ReadonlyArray<{ slug: string; displayName: string }>;
}): void {
  const ordered = [...args.outcomes].sort((a, b) => a.step - b.step);
  if (
    ordered.length !== args.plan.steps.length ||
    ordered.some((outcome, index) => outcome.step !== index + 1)
  ) {
    throw new Error('dependent phase did not account for every approved plan step exactly once');
  }
  const reads = successfulReadSurfaces(args.initialActions, args.initialLedger);
  for (const [index, rawStep] of args.plan.steps.entries()) {
    if (!promisesResult(rawStep)) continue;
    const step = instructionText(rawStep);
    const named = args.surfaces.filter(
      (surface) => namedInStep(step, surface.slug) || namedInStep(step, surface.displayName),
    );
    for (const surface of named) {
      if (reads.has(surface.slug.toLowerCase())) continue;
      const outcome = ordered[index];
      if (outcome.status !== 'blocked' || outcome.evidence.trim() === '') {
        throw new Error(
          `approved plan step ${index + 1} promised a ${surface.displayName} read, but no landed read or blocking ledger reason was recorded`,
        );
      }
    }
  }
}

/**
 * Why a closing action set may not stand, judged against the plan it closes.
 *
 * After a failed prerequisite no ticket state may change. Otherwise a
 * ticket-update plan that promised a close must either carry the transition
 * or account for its absence: a phase that withholds Done because a
 * prerequisite was held, or the evidence was wrong, records the step as
 * blocked, and that record is honoured rather than refused.
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
    !args.plan.steps.some(promisesClose) ||
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
): ExecutionOutput & { applied: AppliedAction[]; planStepOutcomes: PlanStepOutcome[] } {
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
    applied: readonly (AppliedAction | undefined)[];
  },
): string | undefined {
  const blocked = outcomes.filter((outcome) => outcome.status === 'blocked');
  if (blocked.length === 0) return undefined;
  if (run && run.actions.length > 0) {
    const landed = (index: number): boolean => {
      const row = run.applied[index];
      return row?.ok === true && row.held !== true;
    };
    const everyActionLanded = run.actions.every((_action, index) => landed(index));
    const closePromised =
      run.plan.expectedOutputType === 'ticket-update' && run.plan.steps.some(promisesClose);
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

/** Author the one bounded closing action set from the persisted prerequisite ledger. */
export const authorDependentActions = internalAction({
  args: { workItemId: v.id('workItems'), runId: v.id('events') },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const claim = await ctx.runMutation(internal.work.claimDependentAuthoring, args);
    if (!claim.claimed) return { ok: false, reason: claim.reason };
    let initial: DependentAuthoringOutput | undefined;
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
      const plan = item.plan as ExecutionPlan;
      const output = await runDependentSkill({
        skill: { name: skill.name, description: skill.description, body: skill.body },
        plan,
        candidate: rowToCandidate(item),
        charter: charterRow.body as Charter,
        mockEnv,
        surfaces,
        mode: 'real',
        autonomousActions: autonomousActionsOn(agent),
        managerFeedback: item.managerFeedback?.reason,
        initialOutput: initial,
        initialLedger: initial.applied,
        initialFailure: initial.initialFailure,
      });
      if (output.actions.length > DEPENDENT_ACTION_CAP) {
        throw new Error(
          `dependent phase emitted ${output.actions.length} actions; cap is ${DEPENDENT_ACTION_CAP}`,
        );
      }
      validatePlanStepOutcomes({
        plan,
        outcomes: output.planStepOutcomes,
        initialActions: initial.actions,
        initialLedger: initial.applied,
        surfaces: surfaces.map((surface) => ({
          slug: surface.slug,
          displayName: surface.displayName,
        })),
      });
      const transitionRefusal = dependentTransitionRefusal({
        plan,
        actions: output.actions,
        planStepOutcomes: output.planStepOutcomes,
        initialFailure: initial.initialFailure,
      });
      if (transitionRefusal) throw new Error(transitionRefusal);
      const dependent: DependentPendingOutput = {
        ...output,
        phase: 'dependent',
        actionIndexOffset: initial.actions.length,
        initial,
      };
      if (dependent.actions.length === 0) {
        const finalOutput = flattenedDependentOutput(dependent, []);
        const reason = initial.initialFailure ?? blockedPlanReason(output.planStepOutcomes);
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
        output: dependent,
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
      await ctx.runMutation(internal.work.setFailed, {
        workItemId: args.workItemId,
        runId: args.runId,
        reason,
        ...(initial ? { output: initial } : {}),
      });
      return { ok: false, reason };
    }
  },
});

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
      const priorLedger =
        claim.phase === 'approved'
          ? (output.applied ?? []).map((entry) =>
              entry && !entry.awaitingApproval ? entry : undefined,
            )
          : undefined;
      const applied = await applySurfaceActions(
        ctx,
        SURFACE_MODE,
        surfaces,
        {
          agentId: claim.agentId,
          agentName: agent.name,
          workItemId: args.workItemId,
          runId: claim.runId,
        },
        output.actions ?? [],
        {
          deps: realAdapterDeps(
            authorityBeforeTransport(ctx, claim.agentId, claim.phase, browserMcpUrl),
            browserMcpUrl,
          ),
          grants: new Set(grantRows.map((grant) => grant.scope)),
          approvedIndexes: new Set(claim.approvedIndexes),
          heldReasons: new Map(claim.heldReasons),
          deferredIndexes: claim.phase === 'auto' ? new Set(claim.heldIndexes) : undefined,
          priorLedger,
          idempotencyIndexOffset: actionIndexOffset,
          autoPhase: claim.phase === 'auto',
          autonomousActions: claim.autonomousActions,
          replyTarget: claim.replyTarget,
        },
      );
      return await finishRun(ctx, args.workItemId, claim, output, applied);
    } catch (err) {
      const reason = (err as Error).message;
      await ctx.runMutation(internal.work.recoverInterruptedApply, {
        workItemId: args.workItemId,
        pendingRunId: claim.runId,
        phase: claim.phase,
      });
      return { ok: false, reason };
    }
  },
});

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
): RealAdapterDeps {
  return {
    decrypt: decryptCredential,
    createMcpClient: createMastraMcpClient,
    browserMcpUrl,
    fetch: (input: URL, init: RequestInit): Promise<Response> => fetch(input, init),
    beforeTransport,
  };
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

/** Re-read every mutable authority input immediately before provider transport. */
function authorityBeforeTransport(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  phase: 'auto' | 'approved',
  browserMcpUrl: string | undefined,
): BeforeSurfaceTransport {
  return async (action, claimedSurface): Promise<string | undefined> => {
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
 *
 * Returns:
 *   The planner's grounding, or an empty object outside real mode.
 */
async function planGrounding(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
): Promise<Pick<DraftPlanArgs, 'surfaces' | 'documents'>> {
  if (SURFACE_MODE !== 'real') return {};
  const [surfaces, snapshot] = await Promise.all([
    loadSurfaces(ctx, agentId),
    readSurfaceSnapshot(ctx, agentId, 'mock', []),
  ]);
  return {
    surfaces,
    documents: { howToGuides: snapshot.howToGuides, teamDocs: snapshot.teamDocs },
  };
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
  output: LedgerOutput | DependentPendingOutput,
  applied: AppliedAction[],
): Promise<{ ok: boolean; reason?: string }> {
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
      output.initial.initialFailure ??
      reason ??
      blockedPlanReason(output.planStepOutcomes, {
        plan: (await ctx.runQuery(internal.work.getInternal, { workItemId }))?.plan as ExecutionPlan,
        actions: finalOutput.actions,
        applied: finalOutput.applied,
      });
    if (finalReason) {
      await ctx.runMutation(internal.work.setFailed, {
        workItemId,
        reason: finalReason,
        runId: claim.runId,
        output: finalOutput,
      });
      return { ok: false, reason: finalReason };
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
    await ctx.runMutation(internal.work.setFailed, {
      workItemId,
      reason,
      runId: claim.runId,
      output: { ...output, applied: settled },
    });
    return { ok: false, reason };
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
