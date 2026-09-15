/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { McpClientLike, McpClientOptions } from '../../src/surfaces/mcp';
import type { AppliedAction } from '../../src/surfaces/types';
import type { ExecutionPlan, MockAction } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import {
  auditNoteClosing,
  auditNotePlan,
  auditNotePrerequisiteLedger,
  auditNotePrerequisites,
  refreshClosing,
  refreshPlan,
  refreshPrerequisiteLedger,
  refreshPrerequisites,
  REVOPS_5_COMMENT,
  REVOPS_7_COMMENT,
  REVOPS_7_DM,
  TILE_AUDIT_LINE,
} from './fixtures/closing-gates-2026-09-16';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * The 16 September second run's two closing phases, replayed from the point
 * the run reached them: phase one has landed (its ledger is the fixture's),
 * the closing model answers with the set the run authored, and everything
 * from there is the real gate, the real apply and the real retry.
 */

const recorded = vi.hoisted(() => ({
  mcp: [] as Array<{ server: string; tool: string; args: unknown }>,
  http: [] as Array<{ url: string; body: unknown }>,
  model: [] as Array<{ agent: string; user: string }>,
  closingReply: undefined as unknown,
}));

vi.mock('../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async <T>(args: {
    agent: { name: string };
    user: string;
    schema: { parse(value: unknown): unknown };
  }): Promise<T> => {
    recorded.model.push({ agent: args.agent.name, user: args.user });
    if (args.agent.name.endsWith('-dependent') && recorded.closingReply) {
      return args.schema.parse(recorded.closingReply) as T;
    }
    throw new Error(`unscripted agent ${args.agent.name}`);
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (_ctx: unknown, credentialId: string): Promise<string> => `plain-${credentialId}`,
}));

vi.mock('../../src/surfaces/mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/surfaces/mcp')>();
  const text = (value: string): { content: Array<{ type: string; text: string }> } => ({
    content: [{ type: 'text', text: value }],
  });
  return {
    ...original,
    createMastraMcpClient: (options: McpClientOptions): McpClientLike => ({
      listTools: async () =>
        Object.fromEntries(
          ['get_issue', 'list_issues', 'save_comment', 'save_issue', 'browser_navigate', 'browser_fill_form', 'browser_click', 'browser_snapshot'].map((tool) => [
            `${options.serverName}_${tool}`,
            {
              execute: async (args: unknown): Promise<unknown> => {
                recorded.mcp.push({ server: options.serverName, tool, args });
                if (tool === 'save_comment') return text(JSON.stringify({ id: 'comment-16' }));
                if (tool === 'save_issue') return text(JSON.stringify({ id: 'lin-5', state: { name: 'Done' } }));
                if (tool === 'browser_snapshot') return text(`- generic [ref=e30]: visible figure 74%\n- generic [ref=e31]: ${TILE_AUDIT_LINE}`);
                return text('ok');
              },
            },
          ]),
        ),
      disconnect: async (): Promise<void> => {},
    }),
  };
});

vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit): Promise<Response> => {
  recorded.http.push({ url: String(input), body: JSON.parse(String(init?.body)) });
  return new Response(JSON.stringify({ ok: true, ts: '1789000000.000100' }), { status: 200 });
});

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };

interface Run {
  externalId: string;
  title: string;
  plan: ExecutionPlan;
  prerequisites: MockAction[];
  ledger: AppliedAction[];
}

/** An agent with the run's three surfaces and one work item that has landed its phase one and awaits its closing phase. */
async function seedAtClosing(harness: Harness, run: Run): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local', name: 'Priya', userId: 'owner', state: 'active', autonomousActions: false, createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId, version: 'v1', approved: true, approvedAt: 1, createdAt: 1,
      body: {
        proposedFunction: 'Move routine Q3 close revenue operations work from Linear tickets with a clear audit trail.',
        proposedBoundaries: {
          willDo: ['Handle Q3 close tickets in Linear with an audit comment on each.'],
          willNotDo: ['Post to public channels without approval.'],
          escalationTriggers: ['Unclear ownership'],
        },
        approvalChain: { boss: 'boss@day0.local' },
      },
    });
    const skillId = await ctx.db.insert('skills', {
      agentId, name: 'kanban-comment-and-close',
      description: 'Record an audit comment on a Linear ticket from the read-back and close it when the plan says so.',
      body: '# Kanban comment and close\nRead the evidence from the connected surfaces, then comment on linear with save_comment and move the issue with save_issue when the plan says so.',
      requiredScopes: ['boss:message', 'linear:write'], targetSurface: 'linear', sourceType: 'agent-authored',
      state: 'registered', createdAt: 1, registeredAt: 1,
    });
    for (const scope of ['boss:message', 'linear:read', 'linear:write', 'slack:read', 'looker-pipeline-tile:read', 'looker-pipeline-tile:write']) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    const live = {
      credentialLanded: true, lastVerifiedAt: Date.now(), whereFound: [], createdAt: 1,
      discoveryEvidence: [{ kind: 'documentation', ref: 'onboarding.md', quote: 'Linear is the formal work queue', current: true, firstSeenAt: 1, lastSeenAt: 1 }],
    };
    await ctx.db.insert('surfaces', {
      agentId, slug: 'linear', displayName: 'Linear', class: 'kanban', verdict: 'connected',
      endpoint: 'https://mcp.linear.app/mcp', path: 'mcp',
      toolAllowlist: ['get_issue', 'list_issues', 'save_comment', 'save_issue'],
      toolArguments: [
        { tool: 'get_issue', arguments: ['id'] },
        { tool: 'list_issues', arguments: ['team', 'project'] },
        { tool: 'save_comment', arguments: ['issueId', 'body', 'id', 'parentId'] },
        { tool: 'save_issue', arguments: ['id', 'state', 'title', 'description'] },
      ],
      credentialId: 'cred-linear', ...live,
    } as never);
    await ctx.db.insert('surfaces', {
      agentId, slug: 'slack', displayName: 'Slack', class: 'chat', verdict: 'connected',
      endpoint: 'https://slack.com/api/', path: 'documented-api', toolAllowlist: ['chat.postMessage'],
      credentialId: 'cred-slack', managerDmChannelId: 'D0MANAGER', managerUserId: 'UMANAGER', ...live,
    } as never);
    await ctx.db.insert('surfaces', {
      agentId, slug: 'looker-pipeline-tile', displayName: 'Looker pipeline tile', class: 'analytics', verdict: 'connected',
      endpoint: 'http://looker-tile:8080/', path: 'browser-driven',
      toolAllowlist: ['browser_navigate', 'browser_fill_form', 'browser_click', 'browser_snapshot'],
      credentialId: 'cred-looker', ...live,
    } as never);
    const workItemId = await ctx.db.insert('workItems', {
      agentId, sourceCategory: 'ticket-queue', sourceSystem: 'linear', externalId: run.externalId, title: run.title,
      contentSummary: `${run.title} in the Q3 close project.`, contentRefs: [`ticket://${run.externalId}`], priority: 'Medium',
      state: 'executing', skillId, plan: run.plan,
      verdict: { decision: 'claim', value: 60, risk: 30, requiredPermissions: ['linear:read'] },
      observedAt: 1, createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId, type: 'work.executing', payload: { workItemId }, createdAt: Date.now(),
    });
    await ctx.db.patch(workItemId, {
      executionRunId: runId,
      output: {
        phase: 'dependent-authoring', draft: 'Phase one landed.', notes: '', needsDependentPhase: true,
        deferredActions: [], procedureTrails: [],
        actions: run.prerequisites, applied: run.ledger,
      },
    });
    return { agentId, workItemId, runId };
  });
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

const REVOPS_7: Run = {
  externalId: 'REVOPS-7', title: 'Refresh the Looker pipeline tile', plan: refreshPlan,
  prerequisites: refreshPrerequisites, ledger: refreshPrerequisiteLedger,
};
const REVOPS_5: Run = {
  externalId: 'REVOPS-5', title: 'Audit note', plan: auditNotePlan,
  prerequisites: auditNotePrerequisites, ledger: auditNotePrerequisiteLedger,
};

describe('the 16 September closing phases, replayed through the real gate', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
  });

  afterEach((): void => {
    recorded.mcp.length = 0;
    recorded.http.length = 0;
    recorded.model.length = 0;
    recorded.closingReply = undefined;
    restoreSurfaceMode();
  });

  it('holds the REVOPS-7 comment and Done from the read-back, then lands them on approval', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { workItemId, runId } = await seedAtClosing(t, REVOPS_7);
    recorded.closingReply = refreshClosing;
    // The manager DM applies under standing authority; the comment and Done wait.
    await expect(t.action(internal.workActions.authorDependentActions, { workItemId, runId })).resolves.toEqual({
      ok: true, reason: 'dependent actions applying',
    });
    expect(recorded.model.map((call) => call.agent.split('-').pop())).toEqual(['dependent']);
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const held = await readItem(t, workItemId);
    expect(held.state).toBe('actions-pending');
    expect(recorded.http.map((call) => (call.body as { text: string }).text.startsWith(REVOPS_7_DM))).toEqual([true]);
    await t.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId, pendingRunId: held.pendingRunId!, approvedIndexes: [0, 1],
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const done = await readItem(t, workItemId);
    expect(done.state).toBe('completed');
    expect(recorded.mcp.map((call) => [call.server, call.tool])).toEqual([['linear', 'save_comment'], ['linear', 'save_issue']]);
    expect((recorded.mcp[0]!.args as { body: string }).body).toContain(REVOPS_7_COMMENT);
    expect((done.output as { planStepOutcomes: Array<{ status: string }> }).planStepOutcomes.map((row) => row.status)).toEqual(['satisfied', 'satisfied', 'satisfied', 'satisfied']);
  });

  it('holds the REVOPS-5 audit comment without a transition, as the plan says, then lands it on approval', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { workItemId, runId } = await seedAtClosing(t, REVOPS_5);
    recorded.closingReply = auditNoteClosing;
    await expect(t.action(internal.workActions.authorDependentActions, { workItemId, runId })).resolves.toEqual({
      ok: true, reason: "dependent actions pending the manager's approval",
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const held = await readItem(t, workItemId);
    expect(held.state).toBe('actions-pending');
    await t.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId, pendingRunId: held.pendingRunId!, approvedIndexes: [0],
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const done = await readItem(t, workItemId);
    expect(done.state).toBe('completed');
    expect(recorded.mcp.map((call) => [call.server, call.tool])).toEqual([['linear', 'save_comment']]);
    expect((recorded.mcp[0]!.args as { body: string }).body).toContain(REVOPS_5_COMMENT);
    expect(recorded.http).toEqual([]);
  });
});
