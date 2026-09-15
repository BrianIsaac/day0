/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { McpClientLike, McpClientOptions } from '../../src/surfaces/mcp';
import type { AppliedAction } from '../../src/surfaces/types';
import { dependentActionCap } from '../../src/work/execute-skill';
import { CLOSING_SET_CAP, type ExecutionOutput, type ExecutionPlan } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * A scripted replay of the 14 September run-through: REVOPS-7 (Looker tile
 * refresh from a Linear ticket) under the charter wording "owned, prioritized
 * Linear tickets", against a Linear double that returns an unassigned issue
 * and refuses `issueId` on `get_issue`, and a browser-driven tile double.
 *
 * The model is scripted per agent: the planner first gates on ownership, then
 * plans the runbook; phase one emits the read with the wrong key and the
 * whole tile sequence; the argument repair answers `id`; the closing phase
 * authors the comment from the read-back. Everything between those replies
 * is the real gate.
 */

const VALIDATION = 'Tool input validation failed: unknown argument issueId; expected id';
const UNASSIGNED_ISSUE = {
  id: 'lin-7f3a',
  identifier: 'REVOPS-7',
  title: 'Refresh the Looker pipeline tile',
  state: { name: 'Todo' },
  priority: 3,
  description: '',
};
const SNAPSHOT = [
  '- textbox "Username" [ref=e11]',
  '- textbox "Password" [ref=e14]',
  '- button "Sign in" [ref=e15]',
  '- textbox "Pipeline coverage" [ref=e21]',
  '- button "Save" [ref=e23]',
  '- generic [ref=e30]: visible figure 74%',
  '- generic [ref=e31]: Last updated by revops at 2026-09-14 12:41:02 UTC',
].join('\n');

const recorded = vi.hoisted(() => ({
  mcp: [] as Array<{ server: string; tool: string; args: unknown }>,
  http: [] as Array<{ url: string; body: unknown }>,
  model: [] as Array<{ agent: string; user: string }>,
  instructions: [] as Array<{ agent: string; instructions: string }>,
  planCalls: 0,
  prewritten: false,
  repairClosing: false,
}));

const gatedPlan = {
  summary: 'Confirm the ticket, refresh the tile, record the result.',
  steps: [
    'Open REVOPS-7 in connected Linear to confirm it is owned and prioritized.',
    'Sign in to the Looker pipeline tile, set the figure to 74%, save it.',
    'Read back the visible figure and the audit line from the Looker pipeline tile.',
    'Comment on REVOPS-7 quoting the read-back, move it to Done, and DM the manager.',
  ],
  expectedOutputType: 'ticket-update',
  riskNotes: '',
  reversibility: 'Re-enter the previous figure.',
  estimatedMinutes: 5,
};
const cleanPlan = {
  ...gatedPlan,
  summary: 'Refresh the tile as the runbook says and record the result.',
  steps: gatedPlan.steps.slice(1),
  riskNotes: 'REVOPS-7 carries no assignee; the manager may want to assign it before or after.',
};

const browser = (tool: string, toolArgsJson: string) => ({
  tool: 'mcp.call' as const,
  args: { surface: 'looker-pipeline-tile', tool, toolArgsJson },
});
const phaseOne = {
  draft: 'Reading REVOPS-7, then signing in to the tile, entering 74%, saving and reading it back.',
  notes: '',
  needsDependentPhase: true,
  deferredActions: [],
  actions: [
    {
      tool: 'mcp.call' as const,
      args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"issueId":"REVOPS-7"}' },
    },
    browser('browser_navigate', '{"url":"http://looker-tile:8080/"}'),
    browser(
      'browser_fill_form',
      '{"fields":[{"name":"Username","value":"revops"},{"name":"Password","value":"{{secret}}"}]}',
    ),
    browser('browser_click', '{"element":"Sign in"}'),
    browser('browser_fill_form', '{"fields":[{"name":"Pipeline coverage","value":"74%"}]}'),
    browser('browser_click', '{"element":"Save"}'),
    browser('browser_snapshot', '{}'),
  ],
  procedureTrails: [],
};
const closing = {
  draft: 'The tile shows 74% with the audit line; REVOPS-7 is commented and closed.',
  notes: '',
  actions: [
    {
      tool: 'mcp.call' as const,
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: JSON.stringify({
          issueId: 'REVOPS-7',
          body: 'Refreshed the Looker pipeline tile to 74%. Read back: visible figure 74% · Last updated by revops at 2026-09-14 12:41:02 UTC.',
        }),
      },
    },
    {
      tool: 'mcp.call' as const,
      args: {
        surface: 'linear',
        tool: 'save_issue',
        toolArgsJson: JSON.stringify({ id: 'REVOPS-7', state: 'Done' }),
      },
    },
    {
      tool: 'http.request' as const,
      args: {
        surface: 'slack',
        method: 'POST' as const,
        path: '/chat.postMessage',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
        body: JSON.stringify({
          channel: 'D0MANAGER',
          text: 'REVOPS-7 done: tile at 74%, audit line read back, comment and Done held for you.',
        }),
      },
    },
  ],
  procedureTrails: [],
  planStepOutcomes: [
    {
      step: 1,
      status: 'satisfied',
      basis: 'ledger',
      evidence: 'ledger rows 1 to 5 landed on the tile',
    },
    {
      step: 2,
      basis: 'ledger',
      status: 'satisfied',
      evidence: 'ledger row 6: visible figure 74% and the audit line',
    },
    {
      step: 3,
      status: 'satisfied',
      basis: 'ledger',
      evidence: 'the comment, Done and DM in this response',
    },
  ],
};

vi.mock('../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  makeAgent: (name: string, instructions: string): { name: string } => {
    recorded.instructions.push({ agent: name, instructions });
    return { name };
  },
  agentJson: async <T>(args: {
    agent: { name: string };
    user: string;
    schema: { parse(value: unknown): unknown };
  }): Promise<T> => {
    recorded.model.push({ agent: args.agent.name, user: args.user });
    const name = args.agent.name;
    const reply = (): unknown => {
      if (name === 'day0-plan') {
        recorded.planCalls += 1;
        return (recorded.planCalls === 1 ? gatedPlan : cleanPlan) as T;
      }
      if (recorded.repairClosing && name.endsWith('-argument-repair'))
        return { toolArgsJson: '{"issueId":"REVOPS-7","body":"Checked and finished."}' } as T;
      if (name.endsWith('-argument-repair')) return { toolArgsJson: '{"id":"REVOPS-7"}' } as T;
      if (name.endsWith('-dependent')) return closing as T;
      if (recorded.repairClosing && name.endsWith('-initial'))
        return {
          ...phaseOne,
          actions: [
            {
              tool: 'mcp.call',
              args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-7"}' },
            },
            {
              tool: 'mcp.call',
              args: {
                surface: 'linear',
                tool: 'save_comment',
                toolArgsJson: '{"issueId":"REVOPS-7","comment":"Checked and finished."}',
              },
            },
          ],
        } as T;
      if (name.endsWith('-initial'))
        return (
          recorded.prewritten
            ? {
                ...phaseOne,
                actions: [
                  {
                    ...phaseOne.actions[0],
                    args: {
                      surface: 'linear',
                      tool: 'get_issue',
                      toolArgsJson: '{"id":"REVOPS-7"}',
                    },
                  },
                  {
                    tool: 'mcp.call',
                    args: {
                      surface: 'linear',
                      tool: 'save_comment',
                      toolArgsJson: JSON.stringify({
                        issueId: 'REVOPS-7',
                        body: 'Done after checking the result.',
                      }),
                    },
                  },
                  closing.actions[1],
                ],
              }
            : phaseOne
        ) as T;
      throw new Error(`unscripted agent ${name}`);
    };
    return args.schema.parse(reply()) as T;
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (_ctx: unknown, credentialId: string): Promise<string> =>
    `plain-${credentialId}`,
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
          [
            'get_issue',
            'save_comment',
            'save_issue',
            'browser_navigate',
            'browser_fill_form',
            'browser_click',
            'browser_snapshot',
          ].map((tool) => [
            `${options.serverName}_${tool}`,
            {
              execute: async (args: unknown): Promise<unknown> => {
                recorded.mcp.push({ server: options.serverName, tool, args });
                const record = args as Record<string, unknown>;
                if (tool === 'get_issue') {
                  return 'issueId' in record
                    ? {
                        isError: false,
                        ...text(JSON.stringify({ error: true, message: VALIDATION })),
                      }
                    : text(JSON.stringify(UNASSIGNED_ISSUE));
                }
                if (tool === 'save_comment') return text(JSON.stringify({ id: 'comment-91' }));
                if (tool === 'save_issue') {
                  return text(JSON.stringify({ id: 'lin-7f3a', state: { name: 'Done' } }));
                }
                if (tool === 'browser_navigate')
                  return text('- Page URL: http://looker-tile:8080/');
                if (tool === 'browser_snapshot') return text(SNAPSHOT);
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

async function seed(
  harness: Harness,
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      autonomousActions: false,
      createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId,
      version: 'v1',
      approved: true,
      approvedAt: 1,
      createdAt: 1,
      body: {
        proposedFunction:
          'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
        proposedBoundaries: {
          willDo: ['Handle owned, prioritized Linear tickets in the Q3 close project.'],
          willNotDo: ['Post to public channels without approval.'],
          escalationTriggers: ['Unclear ownership'],
        },
        approvalChain: { boss: 'boss@day0.local' },
      },
    });
    await ctx.db.insert('skills', {
      agentId,
      name: 'refresh-looker-pipeline-tile',
      description: 'Refresh the Looker pipeline tile from a Linear ticket and record the result.',
      body: [
        '# Refresh the Looker pipeline tile',
        'Read the issue on linear with get_issue. On looker-pipeline-tile: browser_navigate, browser_fill_form the login with {{secret}}, browser_click Sign in, browser_fill_form Pipeline coverage 74%, browser_click Save, browser_snapshot.',
        'Then comment on linear quoting the read-back and move the issue to Done.',
      ].join('\n'),
      requiredScopes: ['boss:message', 'linear:read', 'looker-pipeline-tile:write'],
      targetSurface: 'looker-pipeline-tile',
      sourceType: 'agent-authored',
      state: 'registered',
      createdAt: 1,
      registeredAt: 1,
    });
    for (const scope of [
      'boss:message',
      'linear:read',
      'linear:write',
      'slack:read',
      'looker-pipeline-tile:read',
      'looker-pipeline-tile:write',
    ]) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    const live = {
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      whereFound: [],
      createdAt: 1,
      discoveryEvidence: [
        {
          kind: 'documentation',
          ref: 'onboarding.md',
          quote: 'Linear is the formal work queue',
          current: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
        },
      ],
    };
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'connected',
      endpoint: 'https://mcp.linear.app/mcp',
      path: 'mcp',
      toolAllowlist: ['get_issue', 'save_comment', 'save_issue'],
      toolArguments: [
        {
          tool: 'get_issue',
          arguments: ['id', 'includeCustomerNeeds', 'includeRelations', 'includeReleases'],
        },
        { tool: 'save_comment', arguments: ['issueId', 'body', 'id', 'parentId'] },
        { tool: 'save_issue', arguments: ['id', 'state', 'title', 'description'] },
      ],
      credentialId: 'cred-linear',
      ...live,
    } as never);
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      endpoint: 'https://slack.com/api/',
      path: 'documented-api',
      toolAllowlist: ['chat.postMessage'],
      credentialId: 'cred-slack',
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
      ...live,
    } as never);
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'looker-pipeline-tile',
      displayName: 'Looker pipeline tile',
      class: 'analytics',
      verdict: 'connected',
      endpoint: 'http://looker-tile:8080/',
      path: 'browser-driven',
      toolAllowlist: [
        'browser_navigate',
        'browser_fill_form',
        'browser_click',
        'browser_snapshot',
        'browser_hover',
      ],
      credentialId: 'cred-looker',
      ...live,
    } as never);
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-7',
      title: 'Refresh the Looker pipeline tile',
      contentSummary:
        'Refresh the Looker pipeline tile with the Friday standup coverage figure (74%) and record the audit line on this issue.',
      contentRefs: ['ticket://REVOPS-7'],
      priority: 'Medium',
      state: 'claimed',
      verdict: { decision: 'claim', value: 60, risk: 30, requiredPermissions: ['linear:read'] },
      observedAt: 1,
      createdAt: 1,
    });
    return { agentId, workItemId };
  });
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

function ledger(row: Doc<'workItems'>): AppliedAction[] {
  return ((row.output ?? {}) as { applied?: AppliedAction[] }).applied ?? [];
}

describe('the 14 September sequence, replayed through the real gate', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
  });

  afterEach((): void => {
    recorded.mcp.length = 0;
    recorded.http.length = 0;
    recorded.model.length = 0;
    recorded.instructions.length = 0;
    recorded.planCalls = 0;
    recorded.prewritten = false;
    recorded.repairClosing = false;
    restoreSurfaceMode();
  });

  it('runs phase one again when a prerequisite did not land', async () => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(t);
    await t.run(async ctx => {
      await ctx.db.patch(workItemId, {
        state: 'failed', plan: cleanPlan, skipReason: 'snapshot failed',
        output: {
          ...phaseOne, actions: [...phaseOne.actions, ...closing.actions],
          applied: phaseOne.actions.map(action => ({ tool: action.tool, ok: false, reason: 'snapshot failed' })),
          planStepOutcomes: closing.planStepOutcomes,
        },
      });
    });

    await t.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });
    await t.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await new Promise(resolve => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
    expect(recorded.model.some(call => call.agent.endsWith('-initial'))).toBe(true);
    expect(recorded.model.some(call => call.agent.endsWith('-dependent'))).toBe(false);
  });

  it('resumes the 16 September closing failure after reconciliation without another browser session', async () => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(t);
    const prerequisites = [
      ...phaseOne.actions.slice(1, 4),
      browser('browser_snapshot', '{}'),
      { tool: 'mcp.call' as const, args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-7"}' } },
    ];
    const applied = prerequisites.map(action => ({ tool: action.tool, ok: true, effect: SNAPSHOT }));
    await t.run(async ctx => {
      await ctx.db.patch(workItemId, {
        state: 'failed', plan: cleanPlan,
        skipReason: 'Failed to connect to MCP server linear',
        output: {
          draft: '', notes: '', needsDependentPhase: false,
          actions: [...prerequisites, ...closing.actions],
          applied: [...applied,
            { tool: 'mcp.call', ok: false, reason: 'Failed to connect to MCP server linear' },
            { tool: 'mcp.call', ok: false, reason: 'status change without audit comment' },
            { tool: 'http.request', ok: false, reason: 'not applied' }],
          planStepOutcomes: closing.planStepOutcomes,
        },
      });
    });
    await t.withIdentity(OWNER).mutation(api.work.reconcileFailed, { workItemId, confirmed: true });
    await t.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId, feedback: 'Retry the closing note from the recorded read-back.' });
    await t.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const resumed = await readItem(t, workItemId);
    expect(resumed.output).toMatchObject({ phase: 'dependent-authoring', applied, initialFailure: 'Failed to connect to MCP server linear' });
    expect(recorded.model).toEqual([]);
    await t.action(internal.workActions.authorDependentActions, { workItemId, runId: resumed.executionRunId! });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const held = await readItem(t, workItemId);
    await t.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId, pendingRunId: held.pendingRunId!, approvedIndexes: [0, 1],
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    expect((await readItem(t, workItemId)).state).toBe('completed');
    expect(recorded.mcp.map(call => call.tool)).toEqual(['save_comment', 'save_issue']);
    expect(recorded.model).toHaveLength(1);
    expect(recorded.model[0]!.user).toContain('Retry the closing note');
    expect(recorded.model[0]!.user).toContain('Failed to connect to MCP server linear');
  });

  it('records the audit correction and keeps a prewritten Done out of phase one under autonomy', async () => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(t);
    recorded.prewritten = true;
    await t.run(async (ctx) => {
      await ctx.db.patch(agentId, { autonomousActions: true });
      await ctx.db.patch(workItemId, {
        state: 'plan-approved',
        plan: {
          ...cleanPlan,
          steps: [
            'Read the Linear issue.',
            'After the read-back, move the Linear issue to "Done".',
          ],
        },
      });
    });
    await t.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
    expect(recorded.mcp.filter((call) => call.tool === 'save_issue')).toEqual([]);
    const events = await t.run(ctx => ctx.db.query('events').collect());
    expect(events.filter(event => event.type === 'audit.corrected')).toMatchObject([
      { payload: { workItemId, removedIndices: [1, 2], reason: 'prewritten closing actions' } },
    ]);
    expect(recorded.model.filter((call) => call.agent.endsWith('-initial'))).toHaveLength(2);
  }, 30_000);

  it('audits a closing comment revealed by key repair before autonomy can apply it', async () => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(t);
    recorded.repairClosing = true;
    await t.run(async (ctx) => {
      await ctx.db.patch(agentId, { autonomousActions: true });
      await ctx.db.patch(workItemId, {
        state: 'plan-approved',
        plan: {
          ...cleanPlan,
          steps: ['Read the Linear issue.', 'Comment on Linear with the result.'],
        },
      });
    });
    await t.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
    expect(recorded.mcp.filter((call) => call.tool === 'save_comment')).toEqual([]);
    expect((await readItem(t, workItemId)).skipReason).toContain('prewrote a closing action');
  }, 30_000);

  it('plans without the ownership gate, holds the tile batch in phase one, repairs the read once, and closes from the read-back', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness);

    // Plan: the record is read first with the probed key, the planner sees an
    // unassigned issue, gates on ownership once, and is asked once for the
    // runbook plan instead.
    await expect(
      harness.withIdentity(OWNER).action(api.workActions.draftPlan, { workItemId }),
    ).resolves.toEqual({ ok: true });
    expect(recorded.mcp.map((call) => [call.tool, call.args])).toEqual([
      ['get_issue', { id: 'REVOPS-7' }],
    ]);
    const planPrompts = recorded.model.filter((call) => call.agent === 'day0-plan');
    expect(planPrompts).toHaveLength(2);
    expect(planPrompts[0]!.user).toContain(
      '--- Candidate record, read from linear (get_issue) ---',
    );
    expect(planPrompts[0]!.user).toContain('"identifier":"REVOPS-7"');
    expect(planPrompts[0]!.user).not.toContain('assignee');
    expect(planPrompts[1]!.user).toContain("step 1 checks the candidate's ownership");
    const plannerInstructions = recorded.instructions.find((row) => row.agent === 'day0-plan');
    expect(plannerInstructions?.instructions).toContain('it does not add verification steps');
    const planned = await readItem(harness, workItemId);
    expect(planned.state).toBe('plan-pending');
    const plan = planned.plan as ExecutionPlan;
    expect(plan.steps).toEqual(cleanPlan.steps);
    expect(plan.steps.join(' ')).not.toMatch(/owned|prioritized/);
    expect(plan.advisorySteps).toBeUndefined();
    expect(plan.riskNotes).toContain('no assignee');
    const groundingEvents = (
      await harness.run(async (ctx) => await ctx.db.query('events').collect())
    ).filter((event) => event.type === 'work.plan-grounding-read');
    expect(groundingEvents[0]?.payload).toMatchObject({
      applied: { ok: true, authority: 'standing' },
    });

    // The manager approves the plan; phase one holds the whole tile sequence
    // behind the read.
    await harness.withIdentity(OWNER).mutation(api.work.approvePlan, { workItemId });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const executorPrompt = recorded.model.find((call) => call.agent.endsWith('-initial'));
    expect(executorPrompt?.user).toContain(
      `Plan steps: ${cleanPlan.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`,
    );
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.retryFailed, {
        workItemId,
        feedback: 'Repeat the current work',
      }),
    ).rejects.toThrow('expected one of failed, skipped, cancelled, completed');
    const held = await readItem(harness, workItemId);
    expect(held.actionVerdicts?.map((verdict) => verdict.disposition)).toEqual([
      'auto',
      'held',
      'held',
      'held',
      'held',
      'held',
      'held',
    ]);

    // Auto phase: the read with the wrong key is refused by the provider,
    // repaired once with the probed names, and lands under standing authority.
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    const parked = await readItem(harness, workItemId);
    expect(parked.state).toBe('actions-pending');
    const repairPrompt = recorded.model.find((call) => call.agent.endsWith('-argument-repair'));
    expect(repairPrompt?.user).toContain(`Provider message: ${VALIDATION}`);
    expect(repairPrompt?.user).toContain(
      'Probed argument names: id, includeCustomerNeeds, includeRelations, includeReleases',
    );
    expect(recorded.mcp.slice(1).map((call) => [call.tool, call.args])).toEqual([
      ['get_issue', { issueId: 'REVOPS-7' }],
      ['get_issue', { id: 'REVOPS-7' }],
    ]);
    expect(ledger(parked)[0]).toMatchObject({
      ok: true,
      authority: 'standing',
      repair: { reason: VALIDATION, toolArgsJson: '{"issueId":"REVOPS-7"}' },
    });
    expect(
      ledger(parked)
        .slice(1)
        .every((row) => row.held && row.awaitingApproval),
    ).toBe(true);
    const runId = parked.executionRunId;
    if (!runId) throw new Error('execution run missing');

    // The manager approves the six browser actions; they land in one session
    // and the snapshot carries the read-back.
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [1, 2, 3, 4, 5, 6],
    });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    const authoring = await readItem(harness, workItemId);
    expect(authoring.output).toMatchObject({ phase: 'dependent-authoring' });
    expect(
      recorded.mcp
        .filter((call) => call.server === 'looker-pipeline-tile')
        .map((call) => call.tool),
    ).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_fill_form',
      'browser_snapshot',
      'browser_click',
      'browser_snapshot',
      'browser_fill_form',
      'browser_snapshot',
      'browser_click',
      'browser_snapshot',
    ]);
    const snapshotRow = ledger(authoring)[6]!;
    expect(snapshotRow.effect).toContain('visible figure 74%');
    expect(snapshotRow.effect).toContain('Last updated by revops at 2026-09-14 12:41:02 UTC');

    // Closing phase: authored from the ledger, the comment quotes the read-back.
    await expect(
      harness.action(internal.workActions.authorDependentActions, { workItemId, runId }),
    ).resolves.toEqual({ ok: true, reason: 'dependent actions applying' });
    // The closing set's auto phase: the manager DM lands, the comment and the
    // Done transition wait for the manager.
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    const closingPrompt = recorded.model.find((call) => call.agent.endsWith('-dependent'));
    expect(closingPrompt?.user).toContain('visible figure 74%');
    expect(closingPrompt?.user).toContain('arguments repaired once after the provider refused');
    const closingHeld = await readItem(harness, workItemId);
    expect(closingHeld.state).toBe('actions-pending');
    expect(recorded.http.map((call) => (call.body as { channel: string }).channel)).toEqual([
      'D0MANAGER',
    ]);
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [1],
      }),
    ).rejects.toThrow('pending run changed');
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: closingHeld.pendingRunId!,
      approvedIndexes: [0, 1],
    });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });

    const done = await readItem(harness, workItemId);
    expect(done.state).toBe('completed');
    const linearCalls = recorded.mcp.filter((call) => call.server === 'linear');
    expect(linearCalls.map((call) => call.tool)).toEqual([
      'get_issue',
      'get_issue',
      'get_issue',
      'save_comment',
      'save_issue',
    ]);
    const commentBody = (linearCalls[3]!.args as { body: string }).body;
    expect(commentBody).toContain('visible figure 74%');
    expect(commentBody).toContain('Last updated by revops at 2026-09-14 12:41:02 UTC');
    expect(commentBody).toContain('Priya');
    expect((linearCalls[4]!.args as { state: string }).state).toBe('Done');
    const finalOutput = done.output as ExecutionOutput & {
      planStepOutcomes: Array<{ step: number; status: string }>;
    };
    expect(finalOutput.planStepOutcomes.map((row) => row.status)).toEqual([
      'satisfied',
      'satisfied',
      'satisfied',
    ]);
    expect(ledger(done).filter((row) => row.ok && !row.held)).toHaveLength(10);
    // The closing set (comment, Done, DM) fits the runbook closing-set cap
    // without the deferred-sequence allowance, which this phase one never declared.
    expect(closing.actions.length).toBeLessThanOrEqual(CLOSING_SET_CAP);
    expect(dependentActionCap(phaseOne)).toBe(CLOSING_SET_CAP);
    // One more model call than the happy path: the planner repair and the
    // argument repair, and no third attempt at anything.
    expect(
      recorded.model.map((call) =>
        call.agent.replace(/^day0-skill-.*-(initial|dependent|argument-repair)$/, '$1'),
      ),
    ).toEqual(['day0-plan', 'day0-plan', 'initial', 'argument-repair', 'dependent']);
  }, 30_000);
});
