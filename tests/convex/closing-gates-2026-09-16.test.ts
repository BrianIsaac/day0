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
  refreshOutcomes,
  refreshPlan,
  refreshPrerequisiteLedger,
  refreshPrerequisites,
  REVOPS_5_COMMENT,
  REVOPS_7_COMMENT,
  REVOPS_7_DM,
  RUN_3_REVOPS_7_COMMENT,
  run3RefreshClosing,
  run3RefreshPlan,
  run3RefreshPrerequisiteLedger,
  run3RefreshPrerequisites,
  TILE_AUDIT_LINE,
} from './fixtures/closing-gates-2026-09-16';
import {
  run4AuditNoteClosing,
  run4AuditNotePlan,
  run4RefreshClosing,
  run4RefreshPlan,
  run4RefreshPrerequisiteLedger,
  run4RefreshPrerequisites,
  run4SlackClosing,
  run4SlackPlan,
  run4SlackPrerequisiteLedger,
  run4SlackPrerequisites,
  run4AuditNotePhaseOne,
  run4TileSequence,
  RUN_4_LIST_ISSUES_EFFECT,
  RUN_4_REVOPS_5_COMMENT,
  RUN_4_REVOPS_5_PREWRITTEN_COMMENT,
  RUN_4_REVOPS_7_COMMENT,
  RUN_4_SLACK_CHANNEL,
  RUN_4_SLACK_ESCALATION,
  RUN_4_SLACK_REPLY,
  RUN_4_SLACK_THREAD_TS,
  RUN_4_TILE_READ_BACK,
} from './fixtures/plan-obligations-2026-09-16';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { HELD_WITHHELD_TRANSITION } from '../../src/surfaces/policy';
import { STOPPED_PREFIX } from '../../src/work/stop';
import { DEFERRALS_KEPT } from '../../src/work/execute-skill';
import { encrypt } from '../../src/lib/credential-crypto';
import { REDACTED } from '../../src/redaction/redact';
import { randomBytes } from 'node:crypto';

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
  initialReply: undefined as unknown,
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
    if (args.agent.name.endsWith('-initial') && recorded.initialReply) {
      return args.schema.parse(recorded.initialReply) as T;
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
                if (tool === 'browser_navigate') return text('- Page URL: http://looker-tile:8080/');
                if (tool === 'browser_snapshot') return text(TILE_SNAPSHOT);
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

/** The tile as the browser double snapshots it: the sign-in form, the figure and the audit line. */
const TILE_SNAPSHOT = [
  '- textbox "Username" [ref=e11]',
  '- textbox "Password" [ref=e14]',
  '- button "Sign in" [ref=e15]',
  '- textbox "Pipeline coverage" [ref=e21]',
  '- button "Save" [ref=e23]',
  '- generic [ref=e30]: visible figure 74%',
  `- generic [ref=e31]: ${TILE_AUDIT_LINE}`,
].join('\n');

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };
const CREDENTIAL_KEY = randomBytes(32).toString('base64');
/** The tile login the owner stores; a closing set that quotes it must not reach the row in clear. */
const TILE_PASSWORD = 'tile-pass-9x7Q';

interface Run {
  externalId: string;
  title: string;
  plan: ExecutionPlan;
  prerequisites: MockAction[];
  ledger: AppliedAction[];
  /** A chat ask instead of a ticket: the source and the thread the reply belongs in. */
  chat?: { sourceSystem: string; contentRefs: string[] };
}

/**
 * An agent with the run's three surfaces and one work item: at its closing
 * phase with phase one landed (the default), or at plan approval with
 * nothing run yet.
 */
async function seedAtClosing(harness: Harness, run: Run, at: 'closing' | 'plan-approved' = 'closing'): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'>; runId: Id<'events'> }> {
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
      agentId,
      sourceCategory: run.chat ? 'event-stream' : 'ticket-queue',
      sourceSystem: run.chat?.sourceSystem ?? 'linear',
      externalId: run.externalId, title: run.title,
      contentSummary: `${run.title} in the Q3 close project.`,
      contentRefs: run.chat?.contentRefs ?? [`ticket://${run.externalId}`], priority: 'Medium',
      state: at === 'closing' ? 'executing' : 'plan-approved', skillId, plan: run.plan,
      verdict: { decision: 'claim', value: 60, risk: 30, requiredPermissions: ['linear:read'] },
      observedAt: 1, createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId, type: 'work.executing', payload: { workItemId }, createdAt: Date.now(),
    });
    if (at === 'plan-approved') return { agentId, workItemId, runId };
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

const call = (surface: string, tool: string, args: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call', args: { surface, tool, toolArgsJson: JSON.stringify(args) },
});

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

/** Run the scheduled apply and authoring turns until the item comes to rest in one of the given states. */
async function settle(harness: Harness, workItemId: Id<'workItems'>, states: readonly string[]): Promise<Doc<'workItems'>> {
  for (let round = 0; round < 40; round += 1) {
    await harness.finishInProgressScheduledFunctions();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const row = await readItem(harness, workItemId);
    if (states.includes(row.state)) return row;
  }
  throw new Error(`the item did not settle in ${states.join(', ')}`);
}

const REVOPS_7: Run = {
  externalId: 'REVOPS-7', title: 'Refresh the Looker pipeline tile', plan: refreshPlan,
  prerequisites: refreshPrerequisites, ledger: refreshPrerequisiteLedger,
};
const REVOPS_5: Run = {
  externalId: 'REVOPS-5', title: 'Audit note', plan: auditNotePlan,
  prerequisites: auditNotePrerequisites, ledger: auditNotePrerequisiteLedger,
};
const REVOPS_7_RUN_3: Run = {
  externalId: 'REVOPS-7', title: 'Refresh the Looker pipeline tile', plan: run3RefreshPlan,
  prerequisites: run3RefreshPrerequisites, ledger: run3RefreshPrerequisiteLedger,
};
const REVOPS_7_RUN_4: Run = {
  externalId: 'REVOPS-7', title: 'Refresh the Looker pipeline tile', plan: run4RefreshPlan,
  prerequisites: run4RefreshPrerequisites, ledger: run4RefreshPrerequisiteLedger,
};
const SLACK_RUN_4: Run = {
  externalId: `${RUN_4_SLACK_CHANNEL}:${RUN_4_SLACK_THREAD_TS}`, title: 'Mention in #revops-asks', plan: run4SlackPlan,
  prerequisites: run4SlackPrerequisites, ledger: run4SlackPrerequisiteLedger,
  chat: { sourceSystem: 'slack', contentRefs: [`slack://${RUN_4_SLACK_CHANNEL}/${RUN_4_SLACK_THREAD_TS}`] },
};
const run4AuditNotePrerequisites: MockAction[] = [...run4TileSequence, call('linear', 'list_issues', { team: 'REVOPS', project: 'Q3 close' })];
const REVOPS_5_RUN_4: Run = {
  externalId: 'REVOPS-5', title: 'Add the close-summary audit note', plan: run4AuditNotePlan,
  prerequisites: run4AuditNotePrerequisites,
  ledger: run4AuditNotePrerequisites.map((action, index) => ({
    tool: action.tool, ok: true, authority: 'autonomous', idempotencyKey: `run-5d:${index}`,
    effect: index === 5 ? RUN_4_TILE_READ_BACK : index === 6 ? RUN_4_LIST_ISSUES_EFFECT : 'ok',
  })),
};

describe('the 16 September closing phases, replayed through the real gate', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', CREDENTIAL_KEY);
  });

  afterEach((): void => {
    recorded.mcp.length = 0;
    recorded.http.length = 0;
    recorded.model.length = 0;
    recorded.closingReply = undefined;
    vi.useRealTimers();
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

  it('keeps a refused closing set on the row and resumes the retry at the closing phase, not at phase one', async (): Promise<void> => {
    // The retry below also schedules the server's run of the plan; the test
    // drives each phase itself, so the scheduler's jobs never fire.
    vi.useFakeTimers();
    const t = convexTest(contractSchema(), allConvexModules());
    const { workItemId, runId } = await seedAtClosing(t, REVOPS_7);
    // The closing phase leaves out the Done the plan promised and calls every step satisfied.
    const withoutDone = {
      ...refreshClosing,
      actions: [refreshClosing.actions[0]!, refreshClosing.actions[2]!],
    };
    recorded.closingReply = withoutDone;
    const refusal = await t.action(internal.workActions.authorDependentActions, { workItemId, runId });
    expect(refusal).toEqual({ ok: false, reason: 'dependent phase omitted the approved ticket state transition without a blocked plan step' });
    // The gate put its refusal to the model once; the set came back the same, so the run stops with the set on the row.
    expect(recorded.model.map((call) => call.agent.split('-').pop())).toEqual(['dependent', 'dependent']);
    expect(recorded.model[1]!.user).toContain(refusal.reason);
    const failed = await readItem(t, workItemId);
    expect(failed.state).toBe('failed');
    expect(failed.skipReason).toBe(`${STOPPED_PREFIX}${refusal.reason}`);
    expect(failed.output).toMatchObject({
      phase: 'dependent-authoring',
      applied: refreshPrerequisiteLedger,
      refusedClosing: {
        actions: withoutDone.actions,
        planStepOutcomes: refreshOutcomes,
        draft: refreshClosing.draft,
        reason: refusal.reason,
      },
    });
    expect(recorded.mcp).toEqual([]);
    expect(recorded.http).toEqual([]);
    recorded.model.length = 0;

    // The browser writes landed, so the retry needs the provider reconciled; then it resumes at the closing phase.
    await t.withIdentity(OWNER).mutation(api.work.reconcileFailed, { workItemId, confirmed: true });
    await t.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId, feedback: 'Move it to Done as the plan says.' });
    await t.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const resumed = await readItem(t, workItemId);
    expect(resumed.output).toMatchObject({ phase: 'dependent-authoring', resumedClosing: true, initialFailure: refusal.reason });
    expect(recorded.model).toEqual([]);
    expect(recorded.mcp).toEqual([]);

    recorded.closingReply = refreshClosing;
    await expect(t.action(internal.workActions.authorDependentActions, { workItemId, runId: resumed.executionRunId! })).resolves.toEqual({
      ok: true, reason: 'dependent actions applying',
    });
    expect(recorded.model.map((call) => call.agent.split('-').pop())).toEqual(['dependent']);
    const prompt = recorded.model[0]!.user;
    expect(prompt).toContain(`Previous closing attempt failure (prerequisites succeeded; retry the closing set): ${refusal.reason}`);
    expect(prompt).toContain('Previous closing set, refused by the gate');
    expect(prompt).toContain(REVOPS_7_COMMENT);
    expect(prompt).toContain('Move it to Done as the plan says.');
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const held = await readItem(t, workItemId);
    await t.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId, pendingRunId: held.pendingRunId!, approvedIndexes: [0, 1],
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    expect((await readItem(t, workItemId)).state).toBe('completed');
    // The tile was not touched again: only the closing writes reached a provider.
    expect(recorded.mcp.map((call) => [call.server, call.tool])).toEqual([['linear', 'save_comment'], ['linear', 'save_issue']]);
  });

  it('scrubs a stored credential value out of the refused closing set before the row keeps it', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { workItemId, runId } = await seedAtClosing(t, REVOPS_7);
    await t.run(async (ctx) => {
      await ctx.db.insert('credentials', {
        userId: 'owner', kind: 'value', label: 'Looker password', source: 'entered', createdAt: 1,
        ...encrypt(TILE_PASSWORD, CREDENTIAL_KEY),
      });
    });
    // The closing comment quotes the login it saw in the runbook, and the set omits the promised Done, so the gate refuses it.
    recorded.closingReply = {
      ...refreshClosing,
      actions: [
        call('linear', 'save_comment', { issueId: 'REVOPS-7', body: `${REVOPS_7_COMMENT} Signed in as revops / ${TILE_PASSWORD}.` }),
        refreshClosing.actions[2]!,
      ],
    };
    const refusal = await t.action(internal.workActions.authorDependentActions, { workItemId, runId });
    expect(refusal.ok).toBe(false);
    const failed = await readItem(t, workItemId);
    const kept = JSON.stringify((failed.output as { refusedClosing: unknown }).refusedClosing);
    expect(kept).toContain(REVOPS_7_COMMENT);
    expect(kept).not.toContain(TILE_PASSWORD);
    expect(kept).toContain(REDACTED);
    expect(JSON.stringify(failed.output)).not.toContain(TILE_PASSWORD);
  });

  it('holds a Done the REVOPS-5 plan withholds for the manager, even with autonomous actions on', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId, runId } = await seedAtClosing(t, REVOPS_5);
    await t.run(async (ctx) => { await ctx.db.patch(agentId, { autonomousActions: true }); });
    // The closing phase moves the ticket the plan said to leave alone.
    recorded.closingReply = {
      ...auditNoteClosing,
      actions: [...auditNoteClosing.actions, call('linear', 'save_issue', { id: 'REVOPS-5', state: 'Done' })],
    };
    await expect(t.action(internal.workActions.authorDependentActions, { workItemId, runId })).resolves.toEqual({
      ok: true, reason: 'dependent actions applying',
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const held = await readItem(t, workItemId);
    expect(held.state).toBe('actions-pending');
    expect(held.actionVerdicts?.map((verdict) => verdict.disposition)).toEqual(['auto', 'held']);
    expect(held.actionVerdicts?.[1]?.reason).toBe(HELD_WITHHELD_TRANSITION);
    // The comment landed on its own; the Done did not.
    expect(recorded.mcp.map((call) => [call.server, call.tool])).toEqual([['linear', 'save_comment']]);
    await t.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId, pendingRunId: held.pendingRunId!, approvedIndexes: [1],
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    expect((await readItem(t, workItemId)).state).toBe('completed');
    expect(recorded.mcp.map((call) => [call.server, call.tool])).toEqual([['linear', 'save_comment'], ['linear', 'save_issue']]);
  });

  it('accepts the run 3 REVOPS-7 closing set: the read-back step 3 conditions on is of the tile, and Linear is the write target', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { workItemId, runId } = await seedAtClosing(t, REVOPS_7_RUN_3);
    recorded.closingReply = run3RefreshClosing;
    await expect(t.action(internal.workActions.authorDependentActions, { workItemId, runId })).resolves.toEqual({
      ok: true, reason: "dependent actions pending the manager's approval",
    });
    expect(recorded.model.map((call) => call.agent.split('-').pop())).toEqual(['dependent']);
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const held = await readItem(t, workItemId);
    expect(held.state).toBe('actions-pending');
    expect(recorded.mcp).toEqual([]);
    await t.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId, pendingRunId: held.pendingRunId!, approvedIndexes: [0, 1],
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const done = await readItem(t, workItemId);
    expect(done.state).toBe('completed');
    expect(done.skipReason).toBeUndefined();
    expect(recorded.mcp.map((call) => [call.server, call.tool])).toEqual([['linear', 'save_comment'], ['linear', 'save_issue']]);
    expect((recorded.mcp[0]!.args as { body: string }).body).toContain(RUN_3_REVOPS_7_COMMENT);
    expect(recorded.http).toEqual([]);
    const output = done.output as { planStepOutcomes: Array<{ status: string }>; refusedClosing?: unknown };
    expect(output.planStepOutcomes.map((row) => row.status)).toEqual(['satisfied', 'satisfied', 'satisfied']);
    expect(output.refusedClosing).toBeUndefined();
  });

  it('lands the run 3 REVOPS-7 comment and Done on their own under autonomy: "otherwise leave it in progress" is the alternative branch, not a withheld transition', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId, runId } = await seedAtClosing(t, REVOPS_7_RUN_3);
    await t.run(async (ctx) => { await ctx.db.patch(agentId, { autonomousActions: true }); });
    recorded.closingReply = run3RefreshClosing;
    await expect(t.action(internal.workActions.authorDependentActions, { workItemId, runId })).resolves.toEqual({
      ok: true, reason: 'dependent actions applying',
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const done = await readItem(t, workItemId);
    expect(done.state).toBe('completed');
    expect(recorded.mcp.map((call) => [call.server, call.tool])).toEqual([['linear', 'save_comment'], ['linear', 'save_issue']]);
    expect(recorded.http).toEqual([]);
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

describe('the 16 September run 4 closing phases, replayed through the real gate', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', CREDENTIAL_KEY);
  });

  afterEach((): void => {
    recorded.mcp.length = 0;
    recorded.http.length = 0;
    recorded.model.length = 0;
    recorded.closingReply = undefined;
    recorded.initialReply = undefined;
    vi.useRealTimers();
    restoreSurfaceMode();
  });

  it('lands the REVOPS-5 refresh, read and comment from phase one with the Done held: the deferral audit fails soft after its one repair', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seedAtClosing(t, REVOPS_5_RUN_4, 'plan-approved');
    await t.run(async (ctx) => { await ctx.db.patch(agentId, { autonomousActions: true }); });
    // Phase one as the run returned it, twice: the refresh, the read, a prewritten comment and the Done deferred on the manager's decision.
    recorded.initialReply = run4AuditNotePhaseOne;
    recorded.closingReply = run4AuditNoteClosing;
    await t.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const held = await settle(t, workItemId, ['actions-pending', 'failed', 'completed']);
    expect(held.skipReason).toBeUndefined();
    expect(held.state).toBe('actions-pending');
    // The audit put its issues to the model once, then corrected the response itself: the prewritten comment out, the deferral left to the closing phase.
    expect(recorded.model.map((call) => call.agent.split('-').pop())).toEqual(['initial', 'initial', 'dependent']);
    const events = await t.run(async (ctx) => await ctx.db.query('events').collect());
    expect(events.filter((event) => event.type === 'audit.corrected').map((event) => event.payload)).toMatchObject([
      { workItemId, removedIndices: [7], reason: 'prewritten closing actions' },
      { workItemId, removedIndices: [], reason: expect.stringContaining(`${DEFERRALS_KEPT}: deferred an action with no result dependency`) },
    ]);
    // Phase one landed the refresh and the read; the closing phase landed the comment; the Done waits for the manager.
    // The browser adapter snapshots the page around each step of its own accord; the sequence is read without those.
    expect(recorded.mcp.map((call) => call.tool).filter((tool) => tool !== 'browser_snapshot')).toEqual([
      'browser_navigate', 'browser_fill_form', 'browser_click', 'browser_fill_form', 'browser_click', 'list_issues', 'save_comment',
    ]);
    expect(recorded.mcp.some((call) => call.tool === 'browser_snapshot')).toBe(true);
    const comments = recorded.mcp.filter((call) => call.tool === 'save_comment').map((call) => (call.args as { body: string }).body);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(RUN_4_REVOPS_5_COMMENT);
    expect(comments[0]).not.toContain(RUN_4_REVOPS_5_PREWRITTEN_COMMENT);
    expect(held.actionVerdicts?.map((verdict) => verdict.disposition)).toEqual(['auto', 'held']);
    expect(held.actionVerdicts?.[1]?.reason).toBe(HELD_WITHHELD_TRANSITION);
    await t.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId, pendingRunId: held.pendingRunId!, approvedIndexes: [1],
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const done = await settle(t, workItemId, ['failed', 'completed']);
    expect(done.state).toBe('completed');
    expect(recorded.mcp.filter((call) => call.tool === 'save_issue').map((call) => call.args)).toEqual([{ id: 'REVOPS-5', state: 'Done' }]);
  });

  it('lands the REVOPS-7 comment and Done under autonomy: "Emit a save_comment on linear" is a write, the tile read landed', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId, runId } = await seedAtClosing(t, REVOPS_7_RUN_4);
    await t.run(async (ctx) => { await ctx.db.patch(agentId, { autonomousActions: true }); });
    recorded.closingReply = run4RefreshClosing;
    await expect(t.action(internal.workActions.authorDependentActions, { workItemId, runId })).resolves.toEqual({
      ok: true, reason: 'dependent actions applying',
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const done = await readItem(t, workItemId);
    expect(done.state).toBe('completed');
    expect(done.skipReason).toBeUndefined();
    expect(recorded.mcp.map((call) => [call.server, call.tool])).toEqual([['linear', 'save_comment'], ['linear', 'save_issue']]);
    expect((recorded.mcp[0]!.args as { body: string }).body).toContain(RUN_4_REVOPS_7_COMMENT);
    expect((done.output as { refusedClosing?: unknown }).refusedClosing).toBeUndefined();
  });

  it('lands the Slack reply that names Northstar CRM, an absent surface, and the escalation DM', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId, runId } = await seedAtClosing(t, SLACK_RUN_4);
    await t.run(async (ctx) => {
      await ctx.db.patch(agentId, { autonomousActions: true });
      await ctx.db.insert('surfaces', {
        agentId, slug: 'northstar-crm', displayName: 'Northstar CRM', class: 'crm', verdict: 'absent',
        credentialLanded: false, whereFound: [], createdAt: 1, discoveryEvidence: [],
      } as never);
    });
    recorded.closingReply = run4SlackClosing;
    await expect(t.action(internal.workActions.authorDependentActions, { workItemId, runId })).resolves.toEqual({
      ok: true, reason: 'dependent actions applying',
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const done = await readItem(t, workItemId);
    expect(done.state).toBe('completed');
    expect(done.skipReason).toBeUndefined();
    expect(recorded.mcp).toEqual([]);
    expect(recorded.http.map((call) => (call.body as { channel: string; text: string }).channel)).toEqual([RUN_4_SLACK_CHANNEL, 'D0MANAGER']);
    expect((recorded.http[0]!.body as { text: string }).text).toContain(RUN_4_SLACK_REPLY);
    expect((recorded.http[1]!.body as { text: string }).text).toContain(RUN_4_SLACK_ESCALATION);
  });

  it('lands the REVOPS-5 audit comment and holds the Done the plan conditions on the manager, autonomy on', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId, runId } = await seedAtClosing(t, REVOPS_5_RUN_4);
    await t.run(async (ctx) => { await ctx.db.patch(agentId, { autonomousActions: true }); });
    recorded.closingReply = run4AuditNoteClosing;
    await expect(t.action(internal.workActions.authorDependentActions, { workItemId, runId })).resolves.toEqual({
      ok: true, reason: 'dependent actions applying',
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const held = await readItem(t, workItemId);
    expect(held.state).toBe('actions-pending');
    expect(held.actionVerdicts?.map((verdict) => verdict.disposition)).toEqual(['auto', 'held']);
    expect(held.actionVerdicts?.[1]?.reason).toBe(HELD_WITHHELD_TRANSITION);
    expect(recorded.mcp.map((call) => [call.server, call.tool])).toEqual([['linear', 'save_comment']]);
    expect((recorded.mcp[0]!.args as { body: string }).body).toContain(RUN_4_REVOPS_5_COMMENT);
    await t.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId, pendingRunId: held.pendingRunId!, approvedIndexes: [1],
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const done = await readItem(t, workItemId);
    expect(done.state).toBe('completed');
    expect(recorded.mcp.map((call) => [call.server, call.tool])).toEqual([['linear', 'save_comment'], ['linear', 'save_issue']]);
  });

  it('stops at the closing gate when the audit comment is withheld: the Done goes with it, nothing reaches Linear, and the retry resumes at the closing phase', async (): Promise<void> => {
    // The retry below also schedules the server's run of the plan; the test
    // drives each phase itself, so the scheduler's jobs never fire.
    vi.useFakeTimers();
    const t = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId, runId } = await seedAtClosing(t, REVOPS_7_RUN_4);
    await t.run(async (ctx) => { await ctx.db.patch(agentId, { autonomousActions: true }); });
    const unsupported = call('linear', 'save_comment', { issueId: 'REVOPS-7', body: 'All three standup deals are reconciled and the Northstar ownership is confirmed.' });
    recorded.closingReply = { ...run4RefreshClosing, actions: [unsupported, run4RefreshClosing.actions[1]!] };
    const refusal = await t.action(internal.workActions.authorDependentActions, { workItemId, runId });
    // The comment was refused twice and withheld; the Done it was to follow is withheld with it, so the set that reaches the gate omits the transition the plan promised.
    expect(refusal).toEqual({ ok: false, reason: 'dependent phase omitted the approved ticket state transition without a blocked plan step' });
    expect(recorded.model.map((call) => call.agent.split('-').pop())).toEqual(['dependent', 'dependent']);
    const stopped = await readItem(t, workItemId);
    expect(stopped.state).toBe('failed');
    expect(stopped.skipReason).toBe(`${STOPPED_PREFIX}${refusal.reason}`);
    expect(stopped.output).toMatchObject({
      phase: 'dependent-authoring',
      refusedClosing: { actions: [], reason: refusal.reason },
    });
    const withheld = (stopped.output as { refusedClosing: { withheldActions?: Array<{ action: MockAction; reason: string }> } }).refusedClosing.withheldActions;
    expect(withheld?.map((row) => [row.action, row.reason])).toEqual([
      [unsupported, expect.stringContaining('All three standup deals are reconciled')],
      [run4RefreshClosing.actions[1], expect.stringContaining('the audit comment on REVOPS-7 it was to follow was withheld')],
    ]);
    expect(recorded.mcp).toEqual([]);
    const events = await t.run(async (ctx) => await ctx.db.query('events').collect());
    expect(events.filter((event) => event.type === 'audit.corrected').map((event) => event.payload)).toMatchObject([
      { workItemId, removedIndices: [0], reason: expect.stringContaining('All three standup deals are reconciled') },
      { workItemId, removedIndices: [0], reason: expect.stringContaining('the audit comment on REVOPS-7 it was to follow was withheld') },
    ]);
    recorded.model.length = 0;

    // Reconciled and retried, the item resumes at the closing phase; a supported set then lands under autonomy without touching the tile again.
    await t.withIdentity(OWNER).mutation(api.work.reconcileFailed, { workItemId, confirmed: true });
    await t.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });
    await t.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const resumed = await readItem(t, workItemId);
    expect(resumed.output).toMatchObject({ phase: 'dependent-authoring', resumedClosing: true, initialFailure: refusal.reason });
    recorded.closingReply = run4RefreshClosing;
    await expect(t.action(internal.workActions.authorDependentActions, { workItemId, runId: resumed.executionRunId! })).resolves.toEqual({
      ok: true, reason: 'dependent actions applying',
    });
    // The retry is told what was withheld and why, not only that the transition was omitted.
    expect(recorded.model[0]!.user).toContain('Actions the evidence check withheld from that set before the gate read it (2)');
    expect(recorded.model[0]!.user).toContain('All three standup deals are reconciled');
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    expect((await readItem(t, workItemId)).state).toBe('completed');
    expect(recorded.mcp.map((call) => [call.server, call.tool])).toEqual([['linear', 'save_comment'], ['linear', 'save_issue']]);
  });
});
