'use node';

import { v } from 'convex/values';
import { action } from './_generated/server';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgentAction } from './ownership';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { applySurfaceActions, readSurfaceSnapshot } from '../src/surfaces/registry';
import type { AppliedAction } from '../src/surfaces/types';
import type { MockAction } from '../src/work/types';
import { runBaselineAgent } from '../src/evaluation/baseline-agent';
import { EVALUATION_SCOPES } from '../src/evaluation/scopes';

const STUB_CHARTER = {
  whyThisHire: 'Evaluation control arm.',
  proposedFunction: 'Ordinary operations assistant.',
  evidence: [],
  shortTermGoals: { day30: '', day60: '', day90: '' },
  proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'evaluation', confidence: 'low' },
  openQuestions: [],
  source: 'evaluation control',
  version: 'evaluation-baseline',
};

export const deployBaseline = action({
  args: { bossEmail: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ agentId: Id<'agents'>; charterId: Id<'charters'> }> => {
    if (SURFACE_MODE !== 'mock') throw new Error('baseline evaluation requires mock mode');
    const agentId: Id<'agents'> = await ctx.runMutation(api.agents.deploy, {
      bossEmail: args.bossEmail,
      name: args.name ?? 'ordinary agent',
      arm: 'baseline',
    });
    await assertOwnsAgentAction(ctx, agentId);
    await ctx.runMutation(internal.mockSeed.seedMockEnvironment, { agentId });
    const charterId: Id<'charters'> = await ctx.runMutation(internal.charters.commit, {
      agentId,
      version: 'evaluation-baseline',
      body: STUB_CHARTER,
      workspaceFiles: [],
    });
    await ctx.runMutation(api.charters.approve, { charterId });
    await ctx.runMutation(api.agents.grantScopes, {
      agentId,
      scopes: [...EVALUATION_SCOPES],
    });
    return { agentId, charterId };
  },
});

export const executeTask = action({
  args: { workItemId: v.id('workItems') },
  handler: async (
    ctx,
    args,
  ): Promise<{
    ok: boolean;
    reason?: string;
    modelCalls?: number;
    toolCalls?: number;
  }> => {
    if (SURFACE_MODE !== 'mock') throw new Error('baseline evaluation requires mock mode');
    const item: Doc<'workItems'> | null = await ctx.runQuery(api.work.get, args);
    if (!item) throw new Error('workItem not found');
    const agent = await assertOwnsAgentAction(ctx, item.agentId);
    if (agent.arm !== 'baseline') throw new Error('work item does not belong to the baseline arm');
    const claim = await ctx.runMutation(internal.work.claimForBaseline, args);
    if (!claim.claimed) return { ok: false, reason: claim.reason, modelCalls: 0, toolCalls: 0 };

    const actions: MockAction[] = [];
    const applied: AppliedAction[] = [];
    let toolCalls = 0;
    try {
      const snapshot = await readSurfaceSnapshot(ctx, item.agentId, 'mock', []);
      const result = await runBaselineAgent({
        candidate: {
          id: item._id,
          sourceSystem: item.sourceSystem,
          sourceCategory: item.sourceCategory,
          externalId: item.externalId,
          title: item.title,
          contentSummary: item.contentSummary,
          contentRefs: item.contentRefs,
        },
        snapshot,
        onToolCall: () => {
          toolCalls += 1;
        },
        invokeAction: async (action): Promise<AppliedAction> => {
          const index = actions.length;
          actions.push(action);
          const [outcome] = await applySurfaceActions(
            ctx,
            'mock',
            [],
            {
              agentId: item.agentId,
              agentName: 'Ordinary agent',
              workItemId: item._id,
              runId: claim.runId,
            },
            [action],
            { idempotencyIndexOffset: index },
          );
          applied[index] = outcome;
          return outcome;
        },
      });
      const draft = result.draft;
      const output = {
        draft,
        notes: 'Ordinary-agent control: direct tool loop; no charter, plan, gate, or skill.',
        actions,
        applied,
      };
      if (applied.length === 0) {
        const reason = draft || 'ordinary agent finished without a write-tool call';
        await ctx.runMutation(internal.work.setFailed, {
          workItemId: item._id,
          runId: claim.runId,
          reason,
          output,
        });
        return { ok: false, reason, modelCalls: result.modelCalls, toolCalls };
      }
      const failures = applied.filter((row) => !row.ok);
      if (failures.length > 0) {
        const reason = failures
          .map((row) => `${row.tool}: ${row.reason ?? 'adapter write failed'}`)
          .join('; ');
        await ctx.runMutation(internal.work.setFailed, {
          workItemId: item._id,
          runId: claim.runId,
          reason,
          output,
        });
        return { ok: false, reason, modelCalls: result.modelCalls, toolCalls };
      }
      await ctx.runMutation(internal.work.setCompleted, {
        workItemId: item._id,
        runId: claim.runId,
        output,
      });
      return { ok: true, modelCalls: result.modelCalls, toolCalls };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.work.setFailed, {
        workItemId: item._id,
        runId: claim.runId,
        reason,
        output: {
          draft: '',
          notes: reason,
          actions,
          applied,
        },
      });
      return { ok: false, reason, toolCalls };
    }
  },
});
