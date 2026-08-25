'use node';

import { v } from 'convex/values';
import { action, type ActionCtx } from './_generated/server';
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
import { applySurfaceActions, readSurfaceSnapshot } from '../src/surfaces/registry';
import type { AppliedAction } from '../src/surfaces/types';

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
