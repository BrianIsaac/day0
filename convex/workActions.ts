'use node';

import { v } from 'convex/values';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { api, internal } from './_generated/api';
import {
  evaluateCandidate,
  inferRequiredPermissions,
  type EvaluateLookups,
} from '../src/work/evaluate';
import { draftExecutionPlan } from '../src/work/plan';
import { runSkill } from '../src/work/execute-skill';
import type { Charter } from '../src/agent/charter';
import type { WorkCandidate, WorkSourceCategory } from '../src/work/types';
import type { Doc, Id } from './_generated/dataModel';
import { asAgentId } from '../src/lib/ids';
import {
  applySurfaceActions,
  readSurfaceSnapshot,
  type RealAdapterDeps,
} from '../src/surfaces/registry';
import type { AppliedAction, SurfaceRecord } from '../src/surfaces/types';
import { decryptCredential } from '../src/surfaces/credentials';
import { createMastraMcpClient } from '../src/surfaces/mcp';
import { toSurfaceRecord } from '../src/surfaces/records';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import type { ExecutionOutput } from '../src/work/types';

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
      const tokenise = (s: string) =>
        new Set(
          s
            .toLowerCase()
            .split(/\W+/)
            .filter((t) => t.length >= 4),
        );
      const candidateTokens = tokenise(`${candidate.title} ${candidate.contentSummary}`);
      const sourceTokens = candidate.sourceSystem.toLowerCase().split(/\W+/).filter(Boolean);
      let best: SimpleSkillRow | null = null;
      let bestScore = 0;
      for (const skill of args.registeredSkills) {
        const skillTokens = tokenise(`${skill.name} ${skill.description}`);
        let score = 0;
        for (const t of candidateTokens) if (skillTokens.has(t)) score += 1;
        for (const t of sourceTokens) if (skillTokens.has(t)) score += 4;
        if (score > bestScore) {
          best = skill;
          bestScore = score;
        }
      }
      // Require either a sourceSystem hit (4 pts) or several content overlaps.
      if (!best || bestScore < 3) return null;
      return { name: best.name, description: best.description };
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
    const [agentsMd, skillRows, grantRows, surfaceConfig, surfaces] = await Promise.all([
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
        surfaceMode: surfaceConfig.mode,
        surfaces,
      },
      lookups,
    );
    await ctx.runMutation(internal.work.setVerdict, {
      workItemId: args.workItemId,
      verdict,
    });

    // For needs-skill, propose a new skill row immediately.
    if (verdict.decision === 'needs-skill') {
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

    return { decision: verdict.decision };
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
    const plan = await draftExecutionPlan({
      candidate: rowToCandidate(item),
      charter: charterRow.body as Charter,
    });
    const stored = await ctx.runMutation(internal.work.setPlan, {
      workItemId: args.workItemId,
      plan,
    });
    if (!stored.stored) {
      return { ok: false, reason: 'another draft stored a plan for this work item first' };
    }
    return { ok: true };
  },
});

export const executeApprovedPlan = action({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const item: Doc<'workItems'> | null = await ctx.runQuery(api.work.get, {
      workItemId: args.workItemId,
    });
    if (!item) return { ok: false, reason: 'workItem not found' };
    const agentId = item.agentId;
    // Cheap early-out for the common case; `claimForExecution` below is what
    // actually decides, because only a mutation can read and move the state
    // without another caller slipping between the two.
    if (item.state !== 'plan-approved') {
      return { ok: false, reason: `state is ${item.state}; expected plan-approved` };
    }
    const charterRow = await ctx.runQuery(api.charters.latest, {
      agentId,
    });
    if (!charterRow) return { ok: false, reason: 'no charter' };
    const charter = charterRow.body as Charter;
    const plan = item.plan as Awaited<ReturnType<typeof draftExecutionPlan>>;
    const candidate = rowToCandidate(item);

    const skills: Doc<'skills'>[] = await ctx.runQuery(api.skills.registered, {
      agentId,
    });
    // Use the same token-scoring as the evaluator's findMatchingSkill so
    // the executor picks the matched skill rather than blindly falling
    // back to skills[0]. Source-system tokens count 4× content tokens.
    const tokenise = (s: string): Set<string> =>
      new Set(
        s
          .toLowerCase()
          .split(/\W+/)
          .filter((t) => t.length >= 4),
      );
    const candidateTokens = tokenise(`${candidate.title} ${candidate.contentSummary}`);
    const sourceTokens = candidate.sourceSystem.toLowerCase().split(/\W+/).filter(Boolean);
    let pickedSkill: Doc<'skills'> | undefined;
    let pickedScore = 0;
    for (const skill of skills) {
      const skillTokens = tokenise(`${skill.name} ${skill.description}`);
      let score = 0;
      for (const t of candidateTokens) if (skillTokens.has(t)) score += 1;
      for (const t of sourceTokens) if (skillTokens.has(t)) score += 4;
      if (score > pickedScore) {
        pickedSkill = skill;
        pickedScore = score;
      }
    }
    // Last-resort fallback only if nothing scored at all.
    if (!pickedSkill) pickedSkill = skills[0];
    if (!pickedSkill) {
      await ctx.runMutation(internal.work.setFailed, {
        workItemId: args.workItemId,
        reason: 'no registered skill available',
      });
      return { ok: false, reason: 'no registered skill available' };
    }
    // Nothing above this line touches a model or an adapter, so a caller that
    // loses the claim costs a handful of reads and stops here.
    const claim = await ctx.runMutation(internal.work.claimForExecution, {
      workItemId: args.workItemId,
      skillId: pickedSkill._id,
    });
    if (!claim.claimed) return { ok: false, reason: claim.reason };
    if (SURFACE_MODE === 'real') {
      return await holdRealActions(ctx, {
        workItemId: args.workItemId,
        agentId,
        runId: claim.runId,
        skill: pickedSkill,
        plan,
        candidate,
        charter,
      });
    }
    try {
      const mockEnv = await readSurfaceSnapshot(ctx, agentId, 'mock', []);
      const output = await runSkill({
        skill: {
          name: pickedSkill.name,
          description: pickedSkill.description,
          body: pickedSkill.body,
        },
        plan,
        candidate,
        charter,
        mockEnv,
      });
      const applied = await applySurfaceActions(
        ctx,
        'mock',
        [],
        {
          agentId,
          workItemId: args.workItemId,
          runId: claim.runId,
        },
        output.actions ?? [],
      );
      // A run completes only when every action it emitted changed the work
      // environment. "At least one applied" is not enough: the skills are told
      // to DM the manager alongside the primary mutation, so a failed primary
      // action plus a delivered "I did it" DM would report the work as done
      // when only the claim about it landed.
      const reason = completionFailure(applied);
      if (reason) {
        await ctx.runMutation(internal.work.setFailed, {
          workItemId: args.workItemId,
          reason,
          output: { ...output, applied },
        });
        return { ok: false, reason };
      }
      await ctx.runMutation(internal.work.setCompleted, {
        workItemId: args.workItemId,
        output: { ...output, applied },
      });
      return { ok: true };
    } catch (err) {
      const reason = (err as Error).message;
      await ctx.runMutation(internal.work.setFailed, {
        workItemId: args.workItemId,
        reason,
      });
      return { ok: false, reason };
    }
  },
});

/**
 * Run a real-surface skill and stop it at the exact-action gate.
 *
 * Args:
 *   ctx: Convex action context.
 *   args: Work, run, skill and evaluation context.
 *
 * Returns:
 *   The pending result, or the fenced failure.
 */
async function holdRealActions(
  ctx: ActionCtx,
  args: {
    workItemId: Id<'workItems'>;
    agentId: Id<'agents'>;
    runId: Id<'events'>;
    skill: SimpleSkillRow;
    plan: Awaited<ReturnType<typeof draftExecutionPlan>>;
    candidate: WorkCandidate;
    charter: Charter;
  },
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const mockEnv = await readSurfaceSnapshot(ctx, args.agentId, 'mock', []);
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
      surfaces: await loadSurfaces(ctx, args.agentId),
      mode: 'real',
    });
    const pending = await ctx.runMutation(internal.work.setActionsPending, {
      workItemId: args.workItemId,
      runId: args.runId,
      output,
    });
    if (!pending.pending) {
      return { ok: false, reason: 'the run was moved on before its actions could be held' };
    }
    return {
      ok: true,
      reason:
        pending.phase === 'auto'
          ? 'automatic actions applying'
          : "actions pending the manager's approval",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await ctx.runMutation(internal.work.setFailed, {
      workItemId: args.workItemId,
      reason,
      runId: args.runId,
    });
    return { ok: false, reason };
  }
}

/** A ledger as the row carries it between the two phases. */
type LedgerOutput = ExecutionOutput & { applied?: Array<AppliedAction | undefined> };

/**
 * Apply the approved actions of the current phase, with the run id the skill ran under.
 *
 * Scheduled by `work.setActionsPending` for the ladder's auto rows and by
 * `work.approveActions` for the manager's. The claim records the apply
 * attempt exactly once, so a second schedule after a restart re-applies with
 * the same idempotency keys rather than alongside a first apply that is
 * still running. In the auto phase the held rows are deferred (a placeholder
 * in the ledger, no adapter call) and every row is re-checked to be a read,
 * the manager DM or a working-target comment; in the approved phase the auto
 * rows' ledger entries are carried forward and the rows the manager left out
 * are recorded as not approved. Every applied row passes the registry's
 * rules (grant, comment before status, attribution, provenance) and then its
 * adapter.
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
      const priorLedger =
        claim.phase === 'approved'
          ? (output.applied ?? []).map((entry) => (entry && !entry.awaitingApproval ? entry : undefined))
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
          deps: realAdapterDeps(),
          grants: new Set(grantRows.map((grant) => grant.scope)),
          approvedIndexes: new Set(claim.approvedIndexes),
          heldReasons: new Map(claim.heldReasons),
          deferredIndexes: claim.phase === 'auto' ? new Set(claim.heldIndexes) : undefined,
          priorLedger,
          autoTargets: claim.phase === 'auto' ? claim.targets : undefined,
        },
      );
      return await finishRun(ctx, args.workItemId, claim, output, applied);
    } catch (err) {
      const reason = (err as Error).message;
      await ctx.runMutation(internal.work.recoverInterruptedApply, {
        workItemId: args.workItemId,
        pendingRunId: claim.runId,
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
function realAdapterDeps(): RealAdapterDeps {
  return {
    decrypt: decryptCredential,
    createMcpClient: createMastraMcpClient,
    fetch: (input: URL, init: RequestInit): Promise<Response> => fetch(input, init),
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
  output: ExecutionOutput,
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
  if (reason) {
    const settled = applied.map((entry) =>
      entry.awaitingApproval
        ? { ...entry, awaitingApproval: undefined, reason: NOT_APPLIED_AFTER_FAILURE }
        : entry,
    );
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
