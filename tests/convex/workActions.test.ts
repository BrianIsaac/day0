/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  blockedPlanReason,
  browserTransportRefusal,
  completionFailure,
  dependentTransitionRefusal,
  findMatchingSkillForCandidate,
  prerequisiteOutput,
  validatePlanStepOutcomes,
} from '../../convex/workActions';
import { BROWSER_DRIVER_ABSENT } from '../../src/surfaces/browser';
import { INTERRUPTED_APPLY_REASON } from '../../convex/work';
import type { McpClientLike, McpClientOptions } from '../../src/surfaces/mcp';
import {
  AWAITING_APPROVAL,
  HELD_MUTATION,
  HELD_NOT_APPROVED,
  HELD_PUBLIC_POST,
  HELD_WRITE,
} from '../../src/surfaces/policy';
import type { AppliedAction } from '../../src/surfaces/types';
import type {
  DependentExecutionOutput,
  ExecutionOutput,
  PlanStepOutcome,
} from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

const recorded = vi.hoisted(() => ({
  mcp: [] as Array<{ server: string; tool: string; args: unknown; bearer: string }>,
  http: [] as Array<{ url: string; authorization: string; body: unknown }>,
  failMcpAfterRequest: false,
  failedMcpTool: undefined as string | undefined,
  afterCredentialRead: undefined as (() => Promise<void>) | undefined,
  afterToolList: undefined as (() => Promise<void>) | undefined,
  skillRuns: 0,
  skillModes: [] as Array<string | undefined>,
  skillSwitches: [] as Array<boolean | undefined>,
  dependentSwitches: [] as Array<boolean | undefined>,
  planSwitches: [] as boolean[],
  planContexts: [] as Array<{ surfaces?: string[]; documents?: string[] }>,
  skillOutput: undefined as ExecutionOutput | undefined,
  dependentOutput: undefined as DependentExecutionOutput | undefined,
  dependentRuns: 0,
  additionalModelCalls: 0,
}));

const skillOutput: ExecutionOutput = {
  draft: 'Prepared the synthetic close summary.',
  notes: '',
  actions: [
    {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: JSON.stringify({ issueId: 'iss-1', body: 'Prepared the close summary.' }),
      },
    },
    {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_issue',
        toolArgsJson: JSON.stringify({ id: 'iss-1', state: 'Done' }),
      },
    },
    {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'POST',
        path: '/chat.postMessage',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
        body: JSON.stringify({ channel: 'D0MANAGER', text: 'Draft complete.' }),
      },
    },
    {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'POST',
        path: '/chat.postMessage',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
        body: JSON.stringify({ channel: 'C0PUBLIC', text: 'Drafting for the manager.' }),
      },
    },
  ],
};

describe('skill selection surface boundary', (): void => {
  const spreadsheetSkill = {
    name: 'update-spreadsheet-eval-write-01',
    description: 'Update a spreadsheet and prepare a team handoff.',
    targetSurface: 'spreadsheet',
    requiredScopes: ['spreadsheet:read', 'spreadsheet:write'],
  };

  it('refuses a content-overlap match on a different source surface', (): void => {
    expect(
      findMatchingSkillForCandidate(
        {
          sourceSystem: 'slack',
          title: 'Post the team handoff',
          contentSummary: 'Write the team handoff for the next shift.',
        },
        [spreadsheetSkill],
      ),
    ).toBeUndefined();
  });

  it('selects only a source-compatible skill before scoring content overlap', (): void => {
    const slackSkill = {
      name: 'slack-action-eval-write-04',
      description: 'Post a team handoff in Slack.',
      targetSurface: 'slack',
      requiredScopes: ['slack:read', 'slack:write'],
    };
    expect(
      findMatchingSkillForCandidate(
        {
          sourceSystem: 'slack',
          title: 'Post the team handoff',
          contentSummary: 'Write the team handoff for the next shift.',
        },
        [spreadsheetSkill, slackSkill],
      ),
    ).toBe(slackSkill);
  });
});

describe('skill selection for real-mode target surfaces', (): void => {
  const slackMention = {
    sourceSystem: 'slack',
    title: 'Refresh the Looker pipeline tile',
    contentSummary: 'Please refresh the Looker pipeline tile and confirm in the thread.',
  };

  it('keeps a skill proposed for a foreign target surface when the source read scope is declared', (): void => {
    const proposedByEvaluator = {
      name: 'slack-action-c0abc123',
      description: 'Skill proposed to handle slack work like "Refresh the Looker pipeline tile".',
      targetSurface: 'looker',
      requiredScopes: ['boss:message', 'slack:read', 'looker:read', 'looker:write'],
    };
    expect(findMatchingSkillForCandidate(slackMention, [proposedByEvaluator])).toBe(
      proposedByEvaluator,
    );
  });

  it('refuses a row that declares only a foreign surface, even when its name matches the source', (): void => {
    const foreignOnly = {
      name: 'slack-action-c0abc123',
      description: 'Skill proposed to handle slack work.',
      targetSurface: 'looker',
      requiredScopes: ['looker:read', 'looker:write'],
    };
    expect(findMatchingSkillForCandidate(slackMention, [foreignOnly])).toBeUndefined();
  });

  it('matches a builtin or legacy row without surface metadata by the source name alone', (): void => {
    const builtinDocs = {
      name: 'see-internal-docs',
      description: 'Look up and cite internal documentation.',
    };
    expect(
      findMatchingSkillForCandidate(
        { sourceSystem: 'docs', title: 'Team cadence', contentSummary: 'When is standup?' },
        [builtinDocs],
      ),
    ).toBe(builtinDocs);
    expect(
      findMatchingSkillForCandidate(
        { sourceSystem: 'linear', title: 'Close REVOPS-5', contentSummary: 'Close the issue.' },
        [builtinDocs],
      ),
    ).toBeUndefined();
  });
});

describe('browser authority at provider transport', (): void => {
  it('refuses an absent or changed component after the adapter claim', (): void => {
    const claimed = 'http://playwright-mcp:8931/mcp';
    expect(browserTransportRefusal('mcp', claimed, undefined)).toBeUndefined();
    expect(browserTransportRefusal('browser-driven', claimed, undefined)).toContain(
      BROWSER_DRIVER_ABSENT,
    );
    expect(
      browserTransportRefusal('browser-driven', claimed, 'http://other-driver:8931/mcp'),
    ).toContain('changed before transport');
    expect(browserTransportRefusal('browser-driven', claimed, claimed)).toBeUndefined();
  });
});

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/work/execute-skill', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/work/execute-skill')>();
  return {
    ...original,
    runSkill: async (args: {
      mode?: string;
      autonomousActions?: boolean;
      onAdditionalModelCall?: () => void;
    }): Promise<ExecutionOutput> => {
      recorded.skillRuns += 1;
      recorded.skillModes.push(args.mode);
      recorded.skillSwitches.push(args.autonomousActions);
      for (let call = 0; call < recorded.additionalModelCalls; call += 1) {
        args.onAdditionalModelCall?.();
      }
      return recorded.skillOutput ?? skillOutput;
    },
    runDependentSkill: async (args: {
      autonomousActions?: boolean;
      plan: { steps: string[] };
    }): Promise<DependentExecutionOutput> => {
      recorded.dependentRuns += 1;
      recorded.dependentSwitches.push(args.autonomousActions);
      return (
        recorded.dependentOutput ?? {
          draft: 'No further action needed.',
          notes: '',
          actions: [],
          planStepOutcomes: args.plan.steps.map((_, index) => ({
            step: index + 1,
            status: 'satisfied' as const,
            evidence: 'The applied ledger accounts for this step.',
          })),
        }
      );
    },
  };
});

vi.mock('../../src/work/plan', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/work/plan')>();
  return {
    ...original,
    draftExecutionPlan: async (args: {
      autonomousActions: boolean;
      surfaces?: Array<{ slug: string }>;
      documents?: { howToGuides: unknown[]; teamDocs: unknown[] };
    }) => {
      recorded.planSwitches.push(args.autonomousActions);
      recorded.planContexts.push({
        surfaces: args.surfaces?.map((surface) => surface.slug).sort(),
        documents: args.documents ? Object.keys(args.documents).sort() : undefined,
      });
      return {
        summary: 'Comment then close.',
        steps: ['comment', 'close'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 5,
      };
    },
  };
});

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (_ctx: unknown, credentialId: string): Promise<string> => {
    await recorded.afterCredentialRead?.();
    return `plain-${credentialId}`;
  },
}));

vi.mock('../../src/surfaces/mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/surfaces/mcp')>();
  return {
    ...original,
    createMastraMcpClient: (options: McpClientOptions): McpClientLike => ({
      listTools: async () => {
        await recorded.afterToolList?.();
        return Object.fromEntries(
          [
            'save_comment',
            'save_issue',
            'get_issue',
            'list_comments',
            'browser_navigate',
            'browser_fill_form',
            'browser_click',
            'browser_snapshot',
          ].map((tool) => [
            `${options.serverName}_${tool}`,
            {
              execute: async (args: unknown): Promise<unknown> => {
                recorded.mcp.push({
                  server: options.serverName,
                  tool,
                  args,
                  bearer: options.bearer ?? '',
                });
                if (recorded.failMcpAfterRequest) {
                  throw new Error('socket closed after provider accepted the request');
                }
                if (recorded.failedMcpTool === tool) {
                  return {
                    isError: true,
                    content: [{ type: 'text', text: `${tool} failed: snapshot timed out` }],
                  };
                }
                const text =
                  tool === 'browser_navigate'
                    ? '- Page URL: http://looker-tile:8080/'
                    : tool === 'browser_snapshot'
                      ? [
                          '- textbox "Username" [ref=e11]',
                          '- textbox "Password" [ref=e14]',
                          '- button "Sign in" [ref=e15]',
                          '- textbox "Pipeline coverage" [ref=e21]',
                          '- button "Save" [ref=e23]',
                          '- generic [ref=e30]: visible figure 74%',
                          '- generic [ref=e31]: Last updated by revops at 2026-08-29 17:24:02 UTC',
                        ].join('\n')
                      : JSON.stringify({ id: `${tool}-id` });
                return { content: [{ type: 'text', text }] };
              },
            },
          ]),
        );
      },
      disconnect: async (): Promise<void> => {},
    }),
  };
});

vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit): Promise<Response> => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  recorded.http.push({
    url: String(input),
    authorization: headers.Authorization,
    body: JSON.parse(String(init?.body)),
  });
  return new Response(JSON.stringify({ ok: true, ts: '1787654400.000200' }), { status: 200 });
});

afterEach((): void => {
  recorded.mcp.length = 0;
  recorded.http.length = 0;
  recorded.failMcpAfterRequest = false;
  recorded.failedMcpTool = undefined;
  recorded.afterCredentialRead = undefined;
  recorded.afterToolList = undefined;
  recorded.skillSwitches.length = 0;
  recorded.dependentSwitches.length = 0;
  recorded.planSwitches.length = 0;
  recorded.planContexts.length = 0;
  recorded.skillRuns = 0;
  recorded.skillModes.length = 0;
  recorded.skillOutput = undefined;
  recorded.dependentOutput = undefined;
  recorded.dependentRuns = 0;
  recorded.additionalModelCalls = 0;
  restoreSurfaceMode();
});

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };

interface Seeded {
  agentId: Id<'agents'>;
  workItemId: Id<'workItems'>;
}

/**
 * Seed everything the executor needs: an owned agent with an approved charter,
 * a registered skill that matches the work, grants, and in real mode two
 * connected surfaces with the contract's credential fields.
 *
 * Args:
 *   harness: Convex test harness.
 *   mode: Which surfaces and channels to seed.
 *
 * Returns:
 *   The agent and the plan-approved work item.
 */
interface SeedOptions {
  /** The agent's autonomous-actions switch; absent seeds a row without the field, which is off. */
  autonomousActions?: boolean;
}

async function seed(
  harness: Harness,
  mode: 'mock' | 'real',
  grants: string[] = ['boss:message', 'linear:read', 'linear:write', 'slack:read', 'slack:write'],
  options: SeedOptions = {},
): Promise<Seeded> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      ...(options.autonomousActions !== undefined
        ? { autonomousActions: options.autonomousActions }
        : {}),
      createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId,
      version: 'v1',
      approved: true,
      approvedAt: 1,
      createdAt: 1,
      body: {
        proposedFunction: 'RevOps analyst',
        proposedBoundaries: { willDo: ['close summaries'], willNotDo: [], escalationTriggers: [] },
        approvalChain: { boss: 'boss@day0.local' },
      },
    });
    await ctx.db.insert('skills', {
      agentId,
      name: 'update-linear-ticket',
      description: 'Comment on and close a linear ticket.',
      body: 'Comment, then close.',
      sourceType: 'agent-authored',
      state: 'registered',
      createdAt: 1,
      registeredAt: 1,
    });
    for (const scope of grants) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    if (mode === 'real') {
      const live = {
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      };
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'connected',
        endpoint: 'https://mcp.linear.app/mcp',
        path: 'mcp',
        toolAllowlist: ['save_comment', 'save_issue', 'get_issue', 'list_comments'],
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
        ...live,
      } as never);
    } else {
      await ctx.db.insert('mockSlackChannels', {
        agentId,
        slug: 'dm-manager',
        displayName: 'Manager DM',
        kind: 'dm',
        createdAt: 1,
      });
    }
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'iss-1',
      title: 'Add the close-summary audit note',
      contentSummary: 'linear ticket work',
      contentRefs: [],
      state: 'plan-approved',
      plan: {
        summary: 'Comment then close.',
        steps: ['comment', 'close'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 5,
      },
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

describe('work action completion evidence', (): void => {
  it('refuses an empty ledger', (): void => {
    expect(completionFailure([])).toContain('nothing in the work environment changed');
  });

  it('names every failed adapter result', (): void => {
    const applied: AppliedAction[] = [
      { tool: 'ticket.update', ok: false, reason: 'no ticket', idempotencyKey: 'run:0' },
      { tool: 'slack.postMessage', ok: true, effect: 'sent', idempotencyKey: 'run:1' },
    ];
    expect(completionFailure(applied)).toBe(
      '1 of 2 actions did not change the work environment: ticket.update (no ticket)',
    );
  });

  it('accepts only a non-empty all-success ledger', (): void => {
    expect(
      completionFailure([
        { tool: 'ticket.update', ok: true, effect: 'updated', idempotencyKey: 'run:0' },
      ]),
    ).toBeUndefined();
  });

  it('treats held rows as accounted for', (): void => {
    expect(
      completionFailure([
        {
          tool: 'http.request',
          ok: true,
          held: true,
          reason: HELD_PUBLIC_POST,
          idempotencyKey: 'run:0',
        },
      ]),
    ).toBeUndefined();
  });

  it('removes a prewritten closing comment after the last prerequisite read', (): void => {
    const snapshot: ExecutionOutput['actions'][number] = {
      tool: 'mcp.call',
      args: { surface: 'looker', tool: 'browser_snapshot', toolArgsJson: '{}' },
    };
    const stale = skillOutput.actions[0];
    expect(
      prerequisiteOutput(
        {
          draft: 'd',
          notes: '',
          needsDependentPhase: true,
          actions: [snapshot, stale],
        },
        {
          summary: 'Read then close.',
          steps: ['Read the evidence', 'Close the ticket'],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: '',
          estimatedMinutes: 1,
        },
      ).actions,
    ).toEqual([snapshot]);
  });

  it('refuses to call a promised Linear read satisfied when no such ledger row landed', (): void => {
    expect(() =>
      validatePlanStepOutcomes({
        plan: {
          summary: 'Check Linear.',
          steps: ['Check the three deals with Linear reads'],
          expectedOutputType: 'message',
          riskNotes: '',
          reversibility: '',
          estimatedMinutes: 1,
        },
        outcomes: [{ step: 1, status: 'satisfied', evidence: 'Assumed from docs.' }],
        initialActions: [],
        initialLedger: [],
        surfaces: [
          { slug: 'linear', displayName: 'Linear' },
          { slug: 'slack', displayName: 'Slack' },
        ],
      }),
    ).toThrow('promised a Linear read');
  });

  it('recognises a promised read by the surface display name, not only its slug', (): void => {
    expect(() =>
      validatePlanStepOutcomes({
        plan: {
          summary: 'Read the tile back.',
          steps: ['Capture the Looker pipeline tile read-back evidence'],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: '',
          estimatedMinutes: 1,
        },
        outcomes: [{ step: 1, status: 'satisfied', evidence: 'The tile shows 74%.' }],
        initialActions: [],
        initialLedger: [],
        surfaces: [{ slug: 'looker', displayName: 'Looker pipeline tile' }],
      }),
    ).toThrow('promised a Looker pipeline tile read');
  });

  it('does not read a compound noun such as close-week as a promise to close the ticket', (): void => {
    const comment = skillOutput.actions[0];
    const satisfied = [
      { step: 1, status: 'satisfied' as const, evidence: 'ledger row 0' },
      { step: 2, status: 'satisfied' as const, evidence: 'DM auto-applied' },
    ];
    for (const wording of [
      'Draft a manager DM summarising any Sales-Finance or close-week impact; hold it for approval.',
      'Draft a manager DM flagging close week risks; hold it for approval.',
      'Note the month-end close status in the DM.',
    ]) {
      const plan = {
        summary: 'Comment, then brief the manager.',
        steps: ['Comment on the ticket with the triage notes.', wording],
        expectedOutputType: 'ticket-update' as const,
        riskNotes: '',
        reversibility: '',
        estimatedMinutes: 1,
      };
      expect(
        dependentTransitionRefusal({ plan, actions: [comment], planStepOutcomes: satisfied }),
        wording,
      ).toBeUndefined();
      expect(
        blockedPlanReason(
          [{ step: 1, status: 'blocked', evidence: 'No ticket read landed before the comment.' }],
          { plan, actions: [comment], applied: [{ tool: 'mcp.call', ok: true, effect: 'commented', idempotencyKey: 'run:0' }] },
        ),
        wording,
      ).toBeUndefined();
    }
    const closing = {
      summary: 'Comment, then close.',
      steps: ['Comment on the ticket.', 'Close the ticket once the comment lands.'],
      expectedOutputType: 'ticket-update' as const,
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 1,
    };
    expect(
      dependentTransitionRefusal({ plan: closing, actions: [comment], planStepOutcomes: satisfied }),
    ).toContain('omitted the approved ticket state transition');
  });

  it('lets a closing phase withhold the transition it accounted for as blocked', (): void => {
    const plan = {
      summary: 'Read then close.',
      steps: ['Capture the read-back', 'Comment and close REVOPS-7'],
      expectedOutputType: 'ticket-update' as const,
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 1,
    };
    const comment = skillOutput.actions[0];
    const done = skillOutput.actions[1];
    const satisfied = [
      { step: 1, status: 'satisfied' as const, evidence: 'ledger row 0' },
      { step: 2, status: 'satisfied' as const, evidence: 'comment and Done' },
    ];
    expect(
      dependentTransitionRefusal({ plan, actions: [comment, done], planStepOutcomes: satisfied }),
    ).toBeUndefined();
    expect(
      dependentTransitionRefusal({ plan, actions: [comment], planStepOutcomes: satisfied }),
    ).toContain('omitted the approved ticket state transition');
    expect(
      dependentTransitionRefusal({
        plan,
        actions: [comment],
        planStepOutcomes: [
          satisfied[0],
          { step: 2, status: 'blocked', evidence: 'The Save step was not approved.' },
        ],
      }),
    ).toBeUndefined();
    expect(
      dependentTransitionRefusal({
        plan,
        actions: [comment, done],
        planStepOutcomes: satisfied,
        initialFailure: 'browser_snapshot timed out',
      }),
    ).toContain('cannot change ticket state after a prerequisite failure');
  });
});

describe('executing an approved plan through the gate', (): void => {
  it('authors ticket closure only after the browser read-back exists', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    recorded.skillOutput = {
      draft: 'Refreshing the tile.',
      notes: '',
      needsDependentPhase: true,
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'looker',
            tool: 'browser_navigate',
            toolArgsJson: JSON.stringify({ url: 'http://looker-tile:8080/' }),
          },
        },
        {
          tool: 'mcp.call',
          args: {
            surface: 'looker',
            tool: 'browser_fill_form',
            toolArgsJson: JSON.stringify({
              fields: [
                { name: 'Username', value: 'revops' },
                { name: 'Password', value: '{{secret}}' },
              ],
            }),
          },
        },
        {
          tool: 'mcp.call',
          args: {
            surface: 'looker',
            tool: 'browser_click',
            toolArgsJson: JSON.stringify({ element: 'Sign in' }),
          },
        },
        {
          tool: 'mcp.call',
          args: {
            surface: 'looker',
            tool: 'browser_fill_form',
            toolArgsJson: JSON.stringify({
              fields: [{ name: 'Pipeline coverage', value: '74%' }],
            }),
          },
        },
        {
          tool: 'mcp.call',
          args: {
            surface: 'looker',
            tool: 'browser_click',
            toolArgsJson: JSON.stringify({ element: 'Save' }),
          },
        },
        {
          tool: 'mcp.call',
          args: { surface: 'looker', tool: 'browser_snapshot', toolArgsJson: '{}' },
        },
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'save_comment',
            toolArgsJson: JSON.stringify({
              issueId: 'iss-1',
              body: 'The evidence is not yet available, so I am not moving the issue to Done.',
            }),
          },
        },
      ],
    };
    const auditLine = 'visible figure 74% · Last updated by revops at 2026-08-29 17:24:02 UTC';
    recorded.dependentOutput = {
      draft: `The tile was read back as ${auditLine} and REVOPS-7 is ready to close.`,
      notes: '',
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'save_comment',
            toolArgsJson: JSON.stringify({
              issueId: 'iss-1',
              body: `Refreshed the Looker tile and verified ${auditLine}.`,
            }),
          },
        },
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'save_issue',
            toolArgsJson: JSON.stringify({ id: 'iss-1', state: 'Done' }),
          },
        },
      ],
      planStepOutcomes: [
        { step: 1, status: 'satisfied', evidence: 'The browser Save action landed.' },
        { step: 2, status: 'satisfied', evidence: auditLine },
        {
          step: 3,
          status: 'satisfied',
          evidence: 'The dependent comment and Done action close the ticket.',
        },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(
      harness,
      'real',
      ['linear:read', 'linear:write', 'looker:read', 'looker:write'],
      { autonomousActions: true },
    );
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        externalId: 'REVOPS-7',
        title: 'Refresh the Looker pipeline tile',
        contentSummary: 'Refresh the approved Friday standup figure to 74% and close the ticket.',
        plan: {
          summary: 'Refresh the tile, read it back, then update the ticket.',
          steps: [
            'Refresh the Looker tile',
            'Capture the read-back evidence',
            'Comment and close REVOPS-7',
          ],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: 'Re-run with an approved replacement figure.',
          estimatedMinutes: 45,
        },
      });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker',
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
        ],
        credentialId: 'cred-looker',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      } as never);
    });

    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    const prepared = await readItem(harness, workItemId);
    expect((prepared.output as { phase?: string }).phase).toBe('dependent-authoring');
    const runId = prepared.executionRunId;
    if (!runId) throw new Error('execution run missing');
    await harness.action(internal.workActions.authorDependentActions, { workItemId, runId });
    await expect(
      harness.action(internal.workActions.authorDependentActions, { workItemId, runId }),
    ).resolves.toEqual({ ok: false, reason: 'dependent phase is not awaiting authoring' });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });

    const linearCalls = recorded.mcp.filter((call) => call.server === 'linear');
    expect(linearCalls.map((call) => call.tool)).toEqual(['save_comment', 'save_issue']);
    expect(linearCalls[0].args).toMatchObject({
      issueId: 'iss-1',
      body: expect.stringContaining(auditLine),
    });
    expect(JSON.stringify(linearCalls[0].args)).not.toContain('evidence is not yet available');
    expect(linearCalls[1].args).toEqual({ id: 'iss-1', state: 'Done' });
    const completed = await readItem(harness, workItemId);
    expect(completed.state).toBe('completed');
    expect(ledger(completed).map((entry) => entry.idempotencyKey)).toEqual(
      Array.from({ length: 8 }, (_, index) => `${workItemId}:${runId}:${index}`),
    );
    expect(recorded.dependentRuns).toBe(1);
  });

  it('holds the dependent comment and Done transition together under one supervised decision', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    const auditLine = 'visible figure 74% · Last updated by revops at 2026-08-29 17:24:02 UTC';
    recorded.skillOutput = {
      draft: 'Reading the refreshed tile back.',
      notes: '',
      needsDependentPhase: true,
      actions: [
        {
          tool: 'mcp.call',
          args: { surface: 'looker', tool: 'browser_snapshot', toolArgsJson: '{}' },
        },
      ],
    };
    recorded.dependentOutput = {
      draft: `Verified ${auditLine}.`,
      notes: '',
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'save_comment',
            toolArgsJson: JSON.stringify({ issueId: 'iss-1', body: `Verified ${auditLine}.` }),
          },
        },
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'save_issue',
            toolArgsJson: JSON.stringify({ id: 'iss-1', state: 'Done' }),
          },
        },
      ],
      planStepOutcomes: [
        { step: 1, status: 'satisfied', evidence: auditLine },
        { step: 2, status: 'satisfied', evidence: 'Comment and Done await one decision.' },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real', [
      'boss:message',
      'linear:read',
      'linear:write',
      'looker:read',
      'looker:write',
    ]);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        externalId: 'REVOPS-7',
        plan: {
          summary: 'Read the tile back, then close the ticket.',
          steps: ['Capture the Looker read-back evidence', 'Comment and close REVOPS-7'],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: 'Re-run with an approved replacement figure.',
          estimatedMinutes: 45,
        },
      });
      const slack = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
        .unique();
      if (!slack) throw new Error('Slack fixture missing');
      await ctx.db.patch(slack._id, { managerUserId: 'UMANAGER' });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker',
        displayName: 'Looker pipeline tile',
        class: 'analytics',
        verdict: 'connected',
        endpoint: 'http://looker-tile:8080/',
        path: 'browser-driven',
        toolAllowlist: ['browser_snapshot'],
        credentialId: 'cred-looker',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      } as never);
    });

    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    const prepared = await readItem(harness, workItemId);
    const runId = prepared.executionRunId;
    if (!runId) throw new Error('execution run missing');
    await harness.action(internal.workActions.authorDependentActions, { workItemId, runId });

    let pending = await readItem(harness, workItemId);
    expect(pending.state).toBe('actions-pending');
    expect(pending.actionVerdicts).toEqual([
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_MUTATION },
    ]);
    expect((pending.output as ExecutionOutput).actions?.map((action) => action.args.tool)).toEqual([
      'save_comment',
      'save_issue',
    ]);
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'actions',
    });
    pending = await readItem(harness, workItemId);
    expect(pending.decision?.id).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/);
    expect(pending.decision?.kind).toBe('actions');
    const requesting = (await events(harness, agentId)).filter(
      (event) => event.type === 'work.decision-requesting',
    );
    expect(requesting).toHaveLength(1);

    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0, 1],
    });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    expect((await readItem(harness, workItemId)).state).toBe('completed');
    expect(
      recorded.mcp.filter((call) => call.server === 'linear').map((call) => call.tool),
    ).toEqual(['save_comment', 'save_issue']);
  });

  it('applies a truthful closing comment and withholds Done when the manager left a prerequisite out', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    recorded.skillOutput = {
      draft: 'Saving the figure, then reading the tile back.',
      notes: '',
      needsDependentPhase: true,
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'looker',
            tool: 'browser_click',
            toolArgsJson: JSON.stringify({ element: 'Save' }),
          },
        },
        {
          tool: 'mcp.call',
          args: { surface: 'looker', tool: 'browser_snapshot', toolArgsJson: '{}' },
        },
      ],
    };
    recorded.dependentOutput = {
      draft: 'The Save step was not approved, so the tile is unchanged and REVOPS-7 stays open.',
      notes: '',
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'save_comment',
            toolArgsJson: JSON.stringify({
              issueId: 'iss-1',
              body: 'The Save step was not approved; the tile is unchanged and this issue stays open.',
            }),
          },
        },
      ],
      planStepOutcomes: [
        { step: 1, status: 'blocked', evidence: 'browser_click Save was held and not approved.' },
        { step: 2, status: 'blocked', evidence: 'No refreshed figure exists to close on.' },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real', [
      'boss:message',
      'linear:read',
      'linear:write',
      'looker:read',
      'looker:write',
    ]);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        externalId: 'REVOPS-7',
        plan: {
          summary: 'Save the figure, read it back, then close the ticket.',
          steps: ['Save the figure and capture the read-back', 'Comment and close REVOPS-7'],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: 'Re-run with an approved replacement figure.',
          estimatedMinutes: 45,
        },
      });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker',
        displayName: 'Looker pipeline tile',
        class: 'analytics',
        verdict: 'connected',
        endpoint: 'http://looker-tile:8080/',
        path: 'browser-driven',
        toolAllowlist: ['browser_click', 'browser_snapshot'],
        credentialId: 'cred-looker',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      } as never);
    });

    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    const parked = await readItem(harness, workItemId);
    expect(parked.state).toBe('actions-pending');
    const runId = parked.executionRunId;
    if (!runId) throw new Error('execution run missing');
    // The manager approves nothing: the Save click stays held.
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [],
    });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    expect((await readItem(harness, workItemId)).output).toMatchObject({
      phase: 'dependent-authoring',
    });
    await harness.action(internal.workActions.authorDependentActions, { workItemId, runId });
    // With the switch off the closing comment is itself held; the manager sends it.
    const closing = await readItem(harness, workItemId);
    expect(closing.state).toBe('actions-pending');
    expect((closing.output as ExecutionOutput).actions?.map((action) => action.args.tool)).toEqual([
      'save_comment',
    ]);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0],
    });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });

    const failed = await readItem(harness, workItemId);
    expect(failed.state).toBe('failed');
    expect(failed.skipReason).toContain('2 approved plan step(s) remained blocked');
    expect(failed.skipReason).toContain('browser_click Save was held and not approved.');
    // The snapshot shares the browser session with the held Save, so neither
    // reached the provider; only the truthful closing comment did.
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['save_comment']);
    expect(ledger(failed).map((entry) => [entry.tool, entry.ok, entry.held ?? false])).toEqual([
      ['mcp.call', true, true],
      ['mcp.call', true, true],
      ['mcp.call', true, false],
    ]);
  });

  it('reports a failed snapshot truthfully and never emits the Done transition', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    recorded.failedMcpTool = 'browser_snapshot';
    recorded.skillOutput = {
      draft: 'Reading the refreshed tile back.',
      notes: '',
      needsDependentPhase: true,
      actions: [
        {
          tool: 'mcp.call',
          args: { surface: 'looker', tool: 'browser_snapshot', toolArgsJson: '{}' },
        },
      ],
    };
    recorded.dependentOutput = {
      draft: 'The tile could not be verified because the browser snapshot timed out.',
      notes: 'REVOPS-7 must remain open.',
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'save_comment',
            toolArgsJson: JSON.stringify({
              issueId: 'iss-1',
              body: 'The Looker read-back failed because browser_snapshot timed out. REVOPS-7 remains open.',
            }),
          },
        },
      ],
      planStepOutcomes: [
        { step: 1, status: 'blocked', evidence: 'browser_snapshot failed: snapshot timed out' },
        {
          step: 2,
          status: 'blocked',
          evidence: 'No read-back evidence exists, so Done is unsafe.',
        },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(
      harness,
      'real',
      ['linear:read', 'linear:write', 'looker:read', 'looker:write'],
      { autonomousActions: true },
    );
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        externalId: 'REVOPS-7',
        plan: {
          summary: 'Read the tile back, then close the ticket only with evidence.',
          steps: ['Capture the Looker read-back evidence', 'Comment and close REVOPS-7'],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: 'Re-run with an approved replacement figure.',
          estimatedMinutes: 45,
        },
      });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker',
        displayName: 'Looker pipeline tile',
        class: 'analytics',
        verdict: 'connected',
        endpoint: 'http://looker-tile:8080/',
        path: 'browser-driven',
        toolAllowlist: ['browser_snapshot'],
        credentialId: 'cred-looker',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      } as never);
    });

    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    const prepared = await readItem(harness, workItemId);
    const runId = prepared.executionRunId;
    if (!runId) throw new Error('execution run missing');
    expect((prepared.output as { initialFailure?: string }).initialFailure).toContain(
      'browser_snapshot failed: snapshot timed out',
    );
    await harness.action(internal.workActions.authorDependentActions, { workItemId, runId });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });

    const failed = await readItem(harness, workItemId);
    expect(failed.state).toBe('failed');
    expect(failed.skipReason).toContain('browser_snapshot failed: snapshot timed out');
    const linearCalls = recorded.mcp.filter((call) => call.server === 'linear');
    expect(linearCalls.map((call) => call.tool)).toEqual(['save_comment']);
    expect(linearCalls[0].args).toMatchObject({
      body: expect.stringContaining('browser_snapshot timed out'),
    });
    expect(JSON.stringify(linearCalls)).not.toContain('save_issue');
    expect(JSON.stringify(linearCalls)).not.toContain('"state":"Done"');
    expect((failed.output as { planStepOutcomes?: unknown[] }).planStepOutcomes).toHaveLength(2);
  });

  it('records why promised Linear reads were not made instead of silently answering the Slack ask', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      draft: 'The Slack reply is ready.',
      notes: '',
      needsDependentPhase: false,
      actions: [
        {
          tool: 'http.request',
          args: {
            surface: 'slack',
            method: 'POST',
            path: '/chat.postMessage',
            headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
            body: JSON.stringify({
              channel: 'C0PUBLIC',
              thread_ts: '1787746453.202809',
              text: 'The three deals are covered.',
            }),
          },
        },
      ],
    };
    recorded.dependentOutput = {
      draft: 'I could not answer because the promised Linear reads were never emitted.',
      notes: 'No Slack reply was sent.',
      actions: [],
      planStepOutcomes: [
        {
          step: 1,
          status: 'blocked',
          evidence: 'No Linear list or get action exists in the ledger.',
        },
        { step: 2, status: 'blocked', evidence: 'No Linear read exists in the ledger.' },
        { step: 3, status: 'blocked', evidence: 'The evidence prerequisite was not met.' },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(
      harness,
      'real',
      ['linear:read', 'slack:read', 'slack:write'],
      { autonomousActions: true },
    );
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('skills', {
        agentId,
        name: 'answer-slack-from-linear',
        description: 'Read Linear evidence and answer the originating Slack message.',
        body: 'Read the evidence before replying.',
        sourceType: 'agent-authored',
        state: 'registered',
        requiredScopes: ['linear:read', 'slack:read', 'slack:write'],
        targetSurface: 'slack',
        createdAt: 1,
        registeredAt: 1,
      });
      await ctx.db.patch(workItemId, {
        sourceCategory: 'event-stream',
        sourceSystem: 'slack',
        externalId: 'C0PUBLIC:1787746453.202809',
        title: 'Slack mention in #revops-asks',
        replyTarget: {
          channel: 'C0PUBLIC',
          channelName: 'revops-asks',
          threadTs: '1787746453.202809',
        },
        plan: {
          summary: 'Check Linear before answering the Slack ask.',
          steps: [
            'Identify the three deals with Linear reads',
            'Check in Linear whether the ask is already tracked',
            'Draft the Slack reply from the evidence',
          ],
          expectedOutputType: 'message',
          riskNotes: '',
          reversibility: 'Do not post until the evidence exists.',
          estimatedMinutes: 20,
        },
      });
    });

    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const prepared = await readItem(harness, workItemId);
    const runId = prepared.executionRunId;
    if (!runId) throw new Error('execution run missing');
    expect((prepared.output as { phase?: string }).phase).toBe('dependent-authoring');
    expect((prepared.output as { initialFailure?: string }).initialFailure).toBeUndefined();
    await harness.action(internal.workActions.authorDependentActions, { workItemId, runId });

    const failed = await readItem(harness, workItemId);
    expect(failed.state).toBe('failed');
    expect(failed.skipReason).toBe(
      '3 approved plan step(s) remained blocked: step 1 (No Linear list or get action exists in the ledger.); step 2 (No Linear read exists in the ledger.); step 3 (The evidence prerequisite was not met.)',
    );
    expect(recorded.mcp.filter((call) => call.server === 'linear')).toHaveLength(0);
    expect(recorded.http).toHaveLength(0);
    expect((failed.output as { planStepOutcomes?: PlanStepOutcome[] }).planStepOutcomes).toEqual(
      recorded.dependentOutput.planStepOutcomes,
    );
  });

  it('completes a ticket update whose plan says read but whose evidence is the ticket itself', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      draft: 'Adding the audit note.',
      notes: '',
      needsDependentPhase: false,
      actions: skillOutput.actions.slice(0, 3),
    };
    recorded.dependentOutput = {
      draft: 'Audit note added and the issue closed.',
      notes: '',
      actions: skillOutput.actions.slice(0, 3),
      planStepOutcomes: [
        { step: 1, status: 'satisfied', evidence: 'The candidate body carries the ticket.' },
        { step: 2, status: 'satisfied', evidence: 'save_comment and save_issue emitted.' },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real', undefined, { autonomousActions: true });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        plan: {
          summary: 'Read the ticket, then add the audit note and close it.',
          steps: ['Read the ticket and the runbook', 'Add the audit note and close the ticket'],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: 'reversible',
          estimatedMinutes: 5,
        },
      });
    });

    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const prepared = await readItem(harness, workItemId);
    const runId = prepared.executionRunId;
    if (!runId) throw new Error('execution run missing');
    expect(prepared.state).toBe('executing');
    expect((prepared.output as { phase?: string }).phase).toBe('dependent-authoring');
    expect((prepared.output as { initialFailure?: string }).initialFailure).toBeUndefined();
    await harness.action(internal.workActions.authorDependentActions, { workItemId, runId });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });

    const done = await readItem(harness, workItemId);
    expect(done.state).toBe('completed');
    expect(recorded.mcp.filter((call) => call.server === 'linear').map((call) => call.tool)).toEqual([
      'save_comment',
      'save_issue',
    ]);
    expect(ledger(done).map((entry) => entry.idempotencyKey)).toEqual([
      `${workItemId}:${runId}:0`,
      `${workItemId}:${runId}:1`,
      `${workItemId}:${runId}:2`,
    ]);
  });

  it('continues a channel-approved real plan without a browser identity', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');

    await expect(
      harness.action(internal.workActions.executeApprovedPlanInternal, { workItemId }),
    ).resolves.toEqual({ ok: true, reason: 'automatic actions applying' });
    expect((await readItem(harness, workItemId)).state).toBe('executing');
    expect(recorded.skillRuns).toBe(1);
    // The internal continuation tells the executor the live mode it read, like the browser path.
    expect(recorded.skillModes).toEqual(['real']);
    expect(recorded.skillSwitches).toEqual([false]);
  });

  it('refuses the internal continuation outside real mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'mock');
    await expect(
      harness.action(internal.workActions.executeApprovedPlanInternal, { workItemId }),
    ).resolves.toEqual({ ok: false, reason: 'manager-channel execution is real-mode only' });
    expect((await readItem(harness, workItemId)).state).toBe('plan-approved');
    expect(recorded.skillRuns).toBe(0);
  });

  it('drafts under the switch, then either continues without a click or asks the channel', async (): Promise<void> => {
    useSurfaceMode('real');
    const scheduled = async (harness: Harness): Promise<string[]> =>
      (
        await harness.run(
          async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
        )
      )
        .map((row) => row.name)
        .sort();
    const toClaimed = async (harness: Harness, workItemId: Id<'workItems'>): Promise<void> => {
      await harness.run(async (ctx) => {
        await ctx.db.patch(workItemId, { state: 'claimed', plan: undefined });
        const slack = await ctx.db
          .query('surfaces')
          .filter((q) => q.eq(q.field('slug'), 'slack'))
          .unique();
        if (slack) await ctx.db.patch(slack._id, { managerUserId: 'UMANAGER' });
      });
    };

    // On: the plan is stored, approved with no click, and the same call runs the executor
    // with the switch it read; nothing is asked in the channel.
    const on = convexTest(contractSchema(), allConvexModules());
    const seededOn = await seed(on, 'real', undefined, { autonomousActions: true });
    await toClaimed(on, seededOn.workItemId);
    await expect(
      on.withIdentity(OWNER).action(api.workActions.draftPlan, { workItemId: seededOn.workItemId }),
    ).resolves.toEqual({ ok: true, reason: 'automatic actions applying' });
    expect(recorded.planSwitches).toEqual([true]);
    // The planner plans from the same evidence the executor acts on: the
    // agent's surfaces with their verdicts and the loaded documentation.
    expect(recorded.planContexts).toEqual([
      { surfaces: ['linear', 'slack'], documents: ['howToGuides', 'teamDocs'] },
    ]);
    expect(recorded.skillSwitches).toEqual([true]);
    const approvals = (await on.run(async (ctx) => await ctx.db.query('events').collect())).filter(
      (event) => event.type === 'work.plan-approved',
    );
    expect(approvals.map((event) => event.payload)).toEqual([
      { workItemId: seededOn.workItemId, by: 'autonomous' },
    ]);
    expect(await scheduled(on)).not.toContain('managerChannelActions:requestDecision');
    expect((await readItem(on, seededOn.workItemId)).state).toBe('executing');

    // Off: the plan parks, the executor does not run, and the one request is scheduled.
    recorded.planSwitches.length = 0;
    recorded.planContexts.length = 0;
    recorded.skillSwitches.length = 0;
    const off = convexTest(contractSchema(), allConvexModules());
    const seededOff = await seed(off, 'real');
    await toClaimed(off, seededOff.workItemId);
    await expect(
      off
        .withIdentity(OWNER)
        .action(api.workActions.draftPlan, { workItemId: seededOff.workItemId }),
    ).resolves.toEqual({ ok: true });
    expect(recorded.planSwitches).toEqual([false]);
    expect(recorded.skillSwitches).toEqual([]);
    const row = await readItem(off, seededOff.workItemId);
    expect(row.state).toBe('plan-pending');
    expect(row.plan).toMatchObject({ summary: 'Comment then close.' });
    expect(await scheduled(off)).toContain('managerChannelActions:requestDecision');
  });

  it('pauses a real-mode run at actions-pending with nothing but the DM applied', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real');
    const result = await harness
      .withIdentity(OWNER)
      .action(api.workActions.executeApprovedPlan, { workItemId });
    expect(result).toEqual({ ok: true, reason: 'automatic actions applying' });
    // No switch on the row is supervised: the DM applies on its own; the
    // comment, the state change and the public post wait for the manager,
    // write grants or not.
    const held = await readItem(harness, workItemId);
    expect(held.actionVerdicts).toEqual([
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_PUBLIC_POST },
    ]);
    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toEqual({
      ok: true,
      reason: "automatic actions applied; the rest await the manager's approval",
    });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('actions-pending');
    expect(row.pendingRunId).toBeDefined();
    expect((row.output as ExecutionOutput).actions).toEqual(skillOutput.actions);
    expect(
      ledger(row).map((entry) => [
        entry.ok,
        entry.held ?? false,
        entry.awaitingApproval ?? false,
        entry.authority,
      ]),
    ).toEqual([
      [true, true, true, undefined],
      [true, true, true, undefined],
      [true, false, false, 'standing'],
      [true, true, true, undefined],
    ]);
    expect(recorded.mcp).toHaveLength(0);
    expect(recorded.http.map((call) => (call.body as { channel: string }).channel)).toEqual([
      'D0MANAGER',
    ]);
    const events = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(events.map((event) => event.type)).toEqual([
      'work.execution-claimed',
      'work.actions-auto-applying',
      'work.actions-applying',
      'work.actions-pending',
    ]);
    expect(row.pendingRunId).toBe(events[0]._id);
  });

  it('applies the approved actions with the preserved run id, holds the rest, and completes', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    // The row is what survives a backend restart: state, run id and actions are
    // persisted, and approval reads only them.
    const { runId } = await park(harness, workItemId);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0, 1],
    });
    const applied = await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    expect(applied).toEqual({ ok: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    expect(ledger(row).map((entry) => entry.idempotencyKey)).toEqual(
      [0, 1, 2, 3].map((index) => `${workItemId}:${runId}:${index}`),
    );
    // The DM landed in the auto phase on its standing grant; the manager's rows carry their approval.
    expect(ledger(row).map((entry) => [entry.ok, entry.held ?? false, entry.authority])).toEqual([
      [true, false, 'manager'],
      [true, false, 'manager'],
      [true, false, 'standing'],
      [true, true, undefined],
    ]);
    expect(ledger(row)[0].providerId).toBe('save_comment-id');
    expect(ledger(row)[2].providerId).toBe('1787654400.000200');
    expect(ledger(row)[3].reason).toBe(HELD_NOT_APPROVED);
    expect(recorded.mcp).toEqual([
      {
        server: 'linear',
        tool: 'save_comment',
        args: {
          issueId: 'iss-1',
          body: `Prepared the close summary.\n\n-- Priya (Day0) · run ${workItemId}/${runId}`,
        },
        bearer: 'plain-cred-linear',
      },
      {
        server: 'linear',
        tool: 'save_issue',
        args: { id: 'iss-1', state: 'Done' },
        bearer: 'plain-cred-linear',
      },
    ]);
    expect(recorded.http).toEqual([
      {
        url: 'https://slack.com/api/chat.postMessage',
        authorization: 'Bearer plain-cred-slack',
        body: {
          channel: 'D0MANAGER',
          text: `Draft complete.\n\n-- Priya (Day0) · run ${workItemId}/${runId}`,
          username: 'Priya (Day0)',
          icon_emoji: ':briefcase:',
        },
      },
    ]);
    expect(JSON.stringify(row.output)).not.toContain('plain-cred');
    expect(recorded.skillRuns).toBe(1);
    expect(recorded.skillModes.at(-1)).toBe('real');
    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toEqual({
      ok: false,
      reason: 'workItem state is completed; expected actions-pending',
    });
  });

  it('applies a pending row written before dispositions, reply targets and the switch existed', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      ...skillOutput,
      actions: [skillOutput.actions[0], skillOutput.actions[3]],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const pending = await readItem(harness, workItemId);
    const runId = pending.pendingRunId;
    if (!runId) throw new Error('pending run missing');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        actionVerdicts: [{ held: false }, { held: true, reason: HELD_PUBLIC_POST }],
        replyTarget: undefined,
      });
    });

    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0],
    });
    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toEqual({ ok: true });

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    expect(ledger(row)[0]).toMatchObject({ ok: true, authority: 'manager' });
    expect(ledger(row)[1]).toMatchObject({
      ok: true,
      held: true,
      reason: HELD_PUBLIC_POST,
    });
    expect(recorded.mcp).toHaveLength(1);
    expect(recorded.http).toHaveLength(0);
  });

  it('holds unapproved indexes and fails a status change whose comment was held', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    const { runId } = await park(harness, workItemId);
    await harness
      .withIdentity(OWNER)
      .mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [1] });
    const applied = await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    expect(applied.ok).toBe(false);
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(ledger(row).map((entry) => [entry.ok, entry.held ?? false, entry.reason])).toEqual([
      [true, true, HELD_NOT_APPROVED],
      [false, false, 'status change without audit comment'],
      [true, false, undefined],
      [true, true, HELD_NOT_APPROVED],
    ]);
    expect(recorded.mcp).toHaveLength(0);
    expect(recorded.http).toHaveLength(1);
  });

  it('carries the manager DM on boss:message alone and lets the manager authorise a public post without slack:write', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real', [
      'boss:message',
      'linear:read',
      'linear:write',
      'slack:read',
    ]);
    const { row: pending, runId } = await park(harness, workItemId);
    expect(pending.actionVerdicts).toEqual([
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_PUBLIC_POST },
    ]);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0, 1, 3],
    });
    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toEqual({ ok: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    expect(ledger(row).map((entry) => [entry.ok, entry.held ?? false, entry.reason])).toEqual([
      [true, false, undefined],
      [true, false, undefined],
      [true, false, undefined],
      [true, false, undefined],
    ]);
    expect(ledger(row)[2].providerId).toBe('1787654400.000200');
    expect(recorded.http.map((call) => (call.body as { channel: string }).channel)).toEqual([
      'D0MANAGER',
      'C0PUBLIC',
    ]);
  });

  it('refuses an ungranted read and the DM without boss:message from the moment the run is held', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      ...skillOutput,
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'get_issue',
            toolArgsJson: JSON.stringify({ id: 'iss-1' }),
          },
        },
        skillOutput.actions[0],
        skillOutput.actions[2],
        skillOutput.actions[3],
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real', ['linear:write', 'slack:read']);
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const pending = await readItem(harness, workItemId);
    const runId = pending.pendingRunId;
    if (!runId) throw new Error('pending run missing');
    expect(pending.actionVerdicts).toEqual([
      { disposition: 'refused', reason: 'no grant (linear:read)' },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'refused', reason: 'no grant (boss:message)' },
      { disposition: 'held', reason: HELD_PUBLIC_POST },
    ]);
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [0, 1, 2, 3],
      }),
    ).rejects.toThrow('action 1 is refused (no grant (linear:read))');
    await harness
      .withIdentity(OWNER)
      .mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [1] });
    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toEqual({ ok: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    expect(ledger(row).map((entry) => [entry.ok, entry.held ?? false, entry.reason])).toEqual([
      [true, true, 'no grant (linear:read)'],
      [true, false, undefined],
      [true, true, 'no grant (boss:message)'],
      [true, true, HELD_NOT_APPROVED],
    ]);
    expect(recorded.mcp).toHaveLength(1);
    expect(recorded.http).toHaveLength(0);
  });

  it('refuses retry when a provider transport fails after an approved request was sent', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    const { runId } = await park(harness, workItemId);
    await harness
      .withIdentity(OWNER)
      .mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0] });
    recorded.failMcpAfterRequest = true;

    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toMatchObject({ ok: false });
    const failed = await readItem(harness, workItemId);
    expect(failed.state).toBe('failed');
    expect(ledger(failed)[0]).toMatchObject({
      ok: false,
      outcomeUnknown: true,
      reason: 'socket closed after provider accepted the request',
    });
    expect(recorded.mcp).toHaveLength(1);
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId }),
    ).rejects.toThrow('reconcile the provider first');
  });

  it('fences every failure after an approved apply has been claimed', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real');
    const { runId } = await park(harness, workItemId);
    await harness
      .withIdentity(OWNER)
      .mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0] });
    await harness.run(async (ctx) => await ctx.db.delete(agentId));

    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toEqual({ ok: false, reason: 'agent not found' });
    const failed = await readItem(harness, workItemId);
    expect(failed).toMatchObject({
      state: 'failed',
      skipReason: INTERRUPTED_APPLY_REASON,
    });
    expect(ledger(failed)[0]).toMatchObject({
      ok: false,
      reason: 'outcome unknown after interrupted apply - verify provider before retry',
    });
  });

  it('runs the skill again with a fresh run id after a rejection and retry', async (): Promise<void> => {
    useSurfaceMode('real');
    // Without the DM nothing applies on its own, so a rejection leaves no landed row to fence the retry.
    recorded.skillOutput = {
      ...skillOutput,
      actions: [skillOutput.actions[0], skillOutput.actions[1], skillOutput.actions[3]],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const first = (await readItem(harness, workItemId)).pendingRunId;
    if (!first) throw new Error('pending run missing');
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, {
      workItemId,
      pendingRunId: first,
      reason: 'not yet',
    });
    await harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const second = (await readItem(harness, workItemId)).pendingRunId;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(recorded.skillRuns).toBe(2);
    expect(recorded.mcp).toHaveLength(0);
  });

  it('preserves intentionally repeated append-row effects for exact-action approval', async (): Promise<void> => {
    useSurfaceMode('mock');
    const repeatedRow = {
      tool: 'spreadsheet.appendRow' as const,
      args: {
        sheetSlug: 'attendance-log',
        tabName: 'entries',
        cells: [
          { header: 'Employee', value: 'Aman' },
          { header: 'Status', value: 'present' },
        ],
      },
    };
    recorded.skillOutput = {
      draft: 'Record both attendance events.',
      notes: '',
      actions: [repeatedRow, repeatedRow],
    };
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'mock');
    await harness.run(
      async (ctx) =>
        await ctx.db.insert('mockSpreadsheets', {
          agentId,
          slug: 'attendance-log',
          title: 'Attendance log',
          tabs: [
            {
              name: 'entries',
              headers: ['Employee', 'Status'],
            },
          ],
          updatedAt: 1,
        }),
    );

    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const held = await readItem(harness, workItemId);
    if (!held.pendingRunId) throw new Error('pending run missing');
    expect((held.output as ExecutionOutput).actions).toEqual([repeatedRow, repeatedRow]);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: held.pendingRunId,
      approvedIndexes: [0, 1],
    });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });

    const rows = await harness.run(
      async (ctx) => await ctx.db.query('mockSpreadsheetRows').collect(),
    );
    expect(rows.map((row) => row.cells)).toEqual([
      { Employee: 'Aman', Status: 'present' },
      { Employee: 'Aman', Status: 'present' },
    ]);
  });

  it('does not hide repeated proposals from the exact-action gate', async (): Promise<void> => {
    useSurfaceMode('mock');
    recorded.skillOutput = {
      draft: 'Escalate the boundary decision.',
      notes: '',
      actions: [
        {
          tool: 'slack.postMessage',
          args: {
            channelSlug: 'dm-manager',
            body: 'This is outside my charter; please decide.',
            cells: [{ header: 'Account', value: 'Acme' }],
          },
        },
        {
          tool: 'slack.postMessage',
          args: {
            channelSlug: 'dm-manager',
            body: 'This is outside my charter; please decide.',
            cells: [{ header: 'Account', value: 'Beta Corp' }],
          },
        },
      ],
    };
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'mock');

    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const held = await readItem(harness, workItemId);

    expect((held.output as ExecutionOutput).actions).toEqual(recorded.skillOutput.actions);
    expect(held.actionVerdicts).toEqual([
      { disposition: 'held', reason: HELD_WRITE },
      { disposition: 'held', reason: HELD_WRITE },
    ]);
  });

  it('holds day0 mock writes until the manager approves the literal action', async (): Promise<void> => {
    useSurfaceMode('mock');
    recorded.additionalModelCalls = 1;
    recorded.skillOutput = {
      draft: 'Draft.',
      notes: '',
      actions: [
        {
          tool: 'slack.postMessage',
          args: { channelSlug: 'dm-manager', body: 'Draft ready for review.' },
        },
      ],
    };
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'mock');
    const result = await harness
      .withIdentity(OWNER)
      .action(api.workActions.executeApprovedPlan, { workItemId });
    expect(result).toEqual({
      ok: true,
      reason: "actions pending the manager's approval",
      additionalModelCalls: 1,
    });
    const held = await readItem(harness, workItemId);
    expect(held.state).toBe('actions-pending');
    expect(held.pendingRunId).toBeDefined();
    expect(held.actionVerdicts).toEqual([{ disposition: 'held', reason: HELD_WRITE }]);
    expect(ledger(held)).toEqual([]);
    expect(
      await harness.run(async (ctx) => await ctx.db.query('mockSlackMessages').collect()),
    ).toEqual([]);
    if (!held.pendingRunId) throw new Error('pending run missing');
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: held.pendingRunId,
      approvedIndexes: [0],
    });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });

    const completed = await readItem(harness, workItemId);
    expect(completed.state).toBe('completed');
    expect(completed.pendingRunId).toBeUndefined();
    expect(ledger(completed)).toEqual([
      expect.objectContaining({ tool: 'slack.postMessage', ok: true, authority: 'manager' }),
    ]);
    const messages = await harness.run(
      async (ctx) => await ctx.db.query('mockSlackMessages').collect(),
    );
    expect(messages.map((message) => message.body)).toEqual(['Draft ready for review.']);
  });
});

/** The demo run: two reads, the audit comment on the item, the manager DM, and a threaded public reply. */
const ladderOutput: ExecutionOutput = {
  draft: 'Checked coverage.',
  notes: '',
  actions: [
    {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'get_issue', toolArgsJson: JSON.stringify({ id: 'iss-1' }) },
    },
    {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'list_comments',
        toolArgsJson: JSON.stringify({ issueId: 'iss-1' }),
      },
    },
    skillOutput.actions[0],
    skillOutput.actions[2],
    {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'POST',
        path: '/chat.postMessage',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
        body: JSON.stringify({
          channel: 'C0PUBLIC',
          thread_ts: '1787746453.202809',
          text: 'Covered.',
        }),
      },
    },
  ],
};

/**
 * Run the approved plan and, when the gate applied anything on its own, let
 * that auto phase finish so the run parks at `actions-pending`.
 *
 * Args:
 *   harness: Convex test harness.
 *   workItemId: The plan-approved work item.
 *
 * Returns:
 *   The parked row and its pending run id.
 */
async function park(
  harness: Harness,
  workItemId: Id<'workItems'>,
): Promise<{ row: Doc<'workItems'>; runId: Id<'events'> }> {
  await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
  const held = await readItem(harness, workItemId);
  if (held.state === 'executing' && held.applyPhase === 'auto') {
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
  }
  const row = await readItem(harness, workItemId);
  expect(row.state).toBe('actions-pending');
  if (!row.pendingRunId) throw new Error('pending run missing');
  return { row, runId: row.pendingRunId };
}

async function events(harness: Harness, agentId: Id<'agents'>): Promise<Doc<'events'>[]> {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .collect(),
  );
}
describe('the autonomous-actions switch through the gate', (): void => {
  it('defers queued work with the revoked read scope named in its verdict', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real');
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        state: 'discovered',
        plan: undefined,
        title: 'Triage the Linear close summary',
        contentSummary: 'Triage this Linear close summary revenue operations hand-off.',
      });
    });
    await harness.withIdentity(OWNER).mutation(api.agents.revokeScope, {
      agentId,
      scope: 'linear:read',
      reason: 'containment trial',
    });

    await expect(
      harness.withIdentity(OWNER).action(api.workActions.evaluateWorkItem, { workItemId }),
    ).resolves.toEqual({ decision: 'defer' });
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'deferred',
      verdict: {
        decision: 'defer',
        reason: 'awaiting-permission',
        missingPermissions: ['linear:read'],
      },
    });
  });

  it('refuses manager-approved reads and DMs whose standing grants were revoked', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real');
    const runId = await harness.run(async (ctx): Promise<Id<'events'>> => {
      const id = await ctx.db.insert('events', {
        agentId,
        type: 'work.execution-claimed',
        payload: { workItemId },
        createdAt: 2,
      });
      await ctx.db.patch(workItemId, {
        state: 'actions-pending',
        executionRunId: id,
        pendingRunId: id,
        output: {
          draft: 'Read then report.',
          notes: '',
          actions: [
            {
              tool: 'mcp.call',
              args: {
                surface: 'linear',
                tool: 'get_issue',
                toolArgsJson: '{"id":"iss-1"}',
              },
            },
            skillOutput.actions[2],
          ],
        },
        actionVerdicts: [
          { disposition: 'held', reason: HELD_MUTATION },
          { disposition: 'held', reason: HELD_MUTATION },
        ],
      });
      return id;
    });
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.agents.revokeScope, { agentId, scope: 'linear:read' });
    await owner.mutation(api.agents.revokeScope, { agentId, scope: 'boss:message' });
    await owner.mutation(api.agents.revokeScope, { agentId, scope: 'slack:write' });
    await owner.mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0, 1],
    });

    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toMatchObject({ ok: false });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(ledger(row).map((entry) => entry.reason)).toEqual([
      'no grant (linear:read)',
      'no grant (boss:message)',
    ]);
    expect(recorded.mcp).toHaveLength(0);
    expect(recorded.http).toHaveLength(0);
  });

  it('refuses an in-flight automatic read when its grant is revoked before transport', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      ...skillOutput,
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'get_issue',
            toolArgsJson: '{"id":"iss-1"}',
          },
        },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real', ['linear:read'], {
      autonomousActions: true,
    });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    recorded.afterCredentialRead = async (): Promise<void> => {
      await harness.withIdentity(OWNER).mutation(api.agents.revokeScope, {
        agentId,
        scope: 'linear:read',
        reason: 'mid-flight containment trial',
      });
      recorded.afterCredentialRead = undefined;
    };

    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('no grant (linear:read)'),
    });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(ledger(row)[0]).toMatchObject({ ok: false, reason: 'no grant (linear:read)' });
    expect(recorded.mcp).toHaveLength(0);
  });

  it("keeps the manager's exact write approval valid after the generic write grant is revoked", async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = { ...skillOutput, actions: [skillOutput.actions[0]] };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real');
    const { runId } = await park(harness, workItemId);
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.agents.revokeScope, {
      agentId,
      scope: 'linear:write',
      reason: 'generic writes off',
    });
    await owner.mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [0],
    });

    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toEqual({ ok: true });
    expect(ledger(await readItem(harness, workItemId))[0]).toMatchObject({
      ok: true,
      authority: 'manager',
    });
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['save_comment']);
  });

  it('off: applies the reads and the DM, parks the comment and the public reply, then sends the reply in its thread once approved', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = ladderOutput;
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real');
    const result = await harness
      .withIdentity(OWNER)
      .action(api.workActions.executeApprovedPlan, { workItemId });
    expect(result).toEqual({ ok: true, reason: 'automatic actions applying' });
    const held = await readItem(harness, workItemId);
    expect(held.state).toBe('executing');
    expect(held.applyPhase).toBe('auto');
    expect(held.approvedIndexes).toEqual([0, 1, 3]);
    expect(held.actionVerdicts).toEqual([
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_PUBLIC_POST },
    ]);
    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toEqual({
      ok: true,
      reason: "automatic actions applied; the rest await the manager's approval",
    });
    const parked = await readItem(harness, workItemId);
    expect(parked.state).toBe('actions-pending');
    expect(parked.approvedIndexes).toBeUndefined();
    expect(parked.applyPhase).toBeUndefined();
    expect(
      ledger(parked).map((entry) => [
        entry.ok,
        entry.held ?? false,
        entry.awaitingApproval ?? false,
        entry.reason,
        entry.authority,
      ]),
    ).toEqual([
      [true, false, false, undefined, 'standing'],
      [true, false, false, undefined, 'standing'],
      [true, true, true, AWAITING_APPROVAL, undefined],
      [true, false, false, undefined, 'standing'],
      [true, true, true, AWAITING_APPROVAL, undefined],
    ]);
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['get_issue', 'list_comments']);
    expect(recorded.http).toHaveLength(1);
    const pendingEvent = (await events(harness, agentId)).find(
      (event) => event.type === 'work.actions-pending',
    );
    expect(pendingEvent?.payload).toMatchObject({
      autoIndexes: [0, 1, 3],
      heldIndexes: [2, 4],
      refusedIndexes: [],
      autoApplied: true,
    });
    const runId = parked.pendingRunId;
    if (!runId) throw new Error('pending run missing');

    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId,
      pendingRunId: runId,
      approvedIndexes: [2, 4],
    });
    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toEqual({ ok: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    // The auto rows' ledger entries are carried forward unchanged; the comment and the reply landed under the manager's approval.
    expect([0, 1, 3].map((index) => ledger(row)[index])).toEqual(
      [0, 1, 3].map((index) => ledger(parked)[index]),
    );
    expect(ledger(row)[2]).toMatchObject({ ok: true, authority: 'manager' });
    expect(ledger(row)[4]).toMatchObject({
      ok: true,
      providerId: '1787654400.000200',
      authority: 'manager',
      idempotencyKey: `${workItemId}:${runId}:4`,
    });
    expect(ledger(row)[4].held).toBeUndefined();
    expect(recorded.mcp.map((call) => call.tool)).toEqual([
      'get_issue',
      'list_comments',
      'save_comment',
    ]);
    expect(recorded.http.map((call) => call.body)).toEqual([
      expect.objectContaining({ channel: 'D0MANAGER' }),
      expect.objectContaining({
        channel: 'C0PUBLIC',
        thread_ts: '1787746453.202809',
        text: `Covered.\n\n-- Priya (Day0) · run ${workItemId}/${runId}`,
      }),
    ]);
    const types = (await events(harness, agentId)).map((event) => event.type);
    expect(types.filter((type) => type.startsWith('skill.') || type.startsWith('agent.'))).toEqual(
      [],
    );
  });

  it('off: lands nothing more when the held rows are rejected, keeps the auto rows, and fences retry', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = ladderOutput;
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    const { row: parked, runId } = await park(harness, workItemId);
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, {
      workItemId,
      pendingRunId: runId,
      reason: 'not in that thread',
    });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(row.skipReason).toBe('rejected by the manager: not in that thread');
    expect([0, 1, 3].map((index) => ledger(row)[index])).toEqual(
      [0, 1, 3].map((index) => ledger(parked)[index]),
    );
    expect(ledger(row)[2]).toMatchObject({
      ok: true,
      held: true,
      reason: 'rejected by the manager: not in that thread',
    });
    expect(ledger(row)[4]).toMatchObject({
      ok: true,
      held: true,
      reason: 'rejected by the manager: not in that thread',
    });
    expect(ledger(row)[4].awaitingApproval).toBeUndefined();
    expect(recorded.http).toHaveLength(1);
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['get_issue', 'list_comments']);
    await expect(
      harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId }),
    ).rejects.toThrow('reconcile the provider first');
  });

  it('on: applies the whole run without a stop, the public reply and the state change included, with no click and no write grant', async (): Promise<void> => {
    useSurfaceMode('real');
    // The comment, then the state change on the same issue, then the DM and the threaded reply.
    recorded.skillOutput = {
      ...ladderOutput,
      actions: [
        ladderOutput.actions[0],
        ladderOutput.actions[2],
        skillOutput.actions[1],
        ladderOutput.actions[3],
        ladderOutput.actions[4],
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'delete_issue',
            toolArgsJson: JSON.stringify({ id: 'iss-1' }),
          },
        },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(
      harness,
      'real',
      ['boss:message', 'linear:read', 'slack:read'],
      { autonomousActions: true },
    );
    const result = await harness
      .withIdentity(OWNER)
      .action(api.workActions.executeApprovedPlan, { workItemId });
    expect(result).toEqual({ ok: true, reason: 'automatic actions applying' });
    const held = await readItem(harness, workItemId);
    expect(held.state).toBe('executing');
    expect(held.applyPhase).toBe('auto');
    expect(held.approvedIndexes).toEqual([0, 1, 2, 3, 4]);
    expect(held.actionVerdicts).toEqual([
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'refused', reason: 'tool not in the surface allowlist (delete_issue)' },
    ]);
    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toEqual({ ok: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    expect(row.approvedIndexes).toBeUndefined();
    expect(row.applyPhase).toBeUndefined();
    // Every applied row records the switch as its authority; the refused row stays refused with its reason.
    expect(
      ledger(row).map((entry) => [entry.ok, entry.held ?? false, entry.reason, entry.authority]),
    ).toEqual([
      [true, false, undefined, 'autonomous'],
      [true, false, undefined, 'autonomous'],
      [true, false, undefined, 'autonomous'],
      [true, false, undefined, 'autonomous'],
      [true, false, undefined, 'autonomous'],
      [true, true, 'tool not in the surface allowlist (delete_issue)', undefined],
    ]);
    expect(recorded.mcp.map((call) => [call.tool, call.args])).toEqual([
      ['get_issue', { id: 'iss-1' }],
      [
        'save_comment',
        { issueId: 'iss-1', body: expect.stringContaining('-- Priya (Day0) · run ') },
      ],
      ['save_issue', { id: 'iss-1', state: 'Done' }],
    ]);
    expect(recorded.http.map((call) => call.body)).toEqual([
      expect.objectContaining({ channel: 'D0MANAGER' }),
      expect.objectContaining({
        channel: 'C0PUBLIC',
        thread_ts: '1787746453.202809',
        text: expect.stringContaining('Covered.'),
      }),
    ]);
    const types = (await events(harness, agentId)).map((event) => event.type);
    expect(types).toEqual([
      'work.execution-claimed',
      'work.actions-auto-applying',
      'work.actions-applying',
      'work.completed',
    ]);
    expect(types).not.toContain('work.actions-pending');
    expect(
      (await events(harness, agentId)).find((event) => event.type === 'work.actions-auto-applying')
        ?.payload,
    ).toMatchObject({
      autonomousActions: true,
      refusedIndexes: [5],
    });
  });

  it('on: refuses a reply outside the source channel before provider transport', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      draft: 'Covered.',
      notes: '',
      actions: [
        {
          tool: 'http.request',
          args: {
            surface: 'slack',
            method: 'POST',
            path: '/chat.postMessage',
            headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
            body: JSON.stringify({
              channel: 'C0OTHER',
              thread_ts: '1787746453.202809',
              text: 'Covered.',
            }),
          },
        },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real', ['slack:read'], {
      autonomousActions: true,
    });
    await harness.run(async (ctx) => {
      await ctx.db.insert('skills', {
        agentId,
        name: 'answer-slack-message',
        description: 'Answer the originating Slack message.',
        body: 'Reply only to the originating message.',
        sourceType: 'agent-authored',
        state: 'registered',
        requiredScopes: ['slack:read', 'slack:write'],
        targetSurface: 'slack',
        createdAt: 1,
        registeredAt: 1,
      });
      await ctx.db.patch(workItemId, {
        sourceCategory: 'event-stream',
        sourceSystem: 'slack',
        externalId: 'C0PUBLIC:1787746453.202809',
        title: 'Slack mention in #revops-asks',
        replyTarget: {
          channel: 'C0OTHER',
          channelName: 'revops-asks',
          threadTs: '1787000000.000001',
        },
      });
    });

    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('actions-pending');
    expect(row.actionVerdicts).toEqual([
      { disposition: 'refused', reason: 'chat reply does not match the work item reply target' },
    ]);
    expect(recorded.http).toHaveLength(0);
  });

  it('re-reads the switch after credential access and before an autonomous provider write', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = { ...skillOutput, actions: [skillOutput.actions[0]] };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real', ['linear:read'], {
      autonomousActions: true,
    });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    recorded.afterCredentialRead = async (): Promise<void> => {
      await harness.run(async (ctx) => await ctx.db.patch(agentId, { autonomousActions: false }));
      recorded.afterCredentialRead = undefined;
    };

    const result = await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not an automatic action'),
    });
    expect(recorded.mcp).toHaveLength(0);
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(ledger(row)[0]).toMatchObject({ ok: false, reason: 'not an automatic action' });
    expect(ledger(row)[0].authority).toBeUndefined();
  });

  it('refuses an autonomous write revoked after the first authority read but before the MCP call', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = { ...skillOutput, actions: [skillOutput.actions[0]] };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(
      harness,
      'real',
      ['linear:read', 'linear:write'],
      { autonomousActions: true },
    );
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    recorded.afterToolList = async (): Promise<void> => {
      await harness.withIdentity(OWNER).mutation(api.agents.revokeScope, {
        agentId,
        scope: 'linear:write',
        reason: 'revoked while the MCP catalogue was loading',
      });
      recorded.afterToolList = undefined;
    };

    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('no grant (linear:write)'),
    });
    expect(recorded.mcp).toHaveLength(0);
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(ledger(row)[0]).toMatchObject({ ok: false, reason: 'no grant (linear:write)' });
    const metrics = await harness.withIdentity(OWNER).query(api.metrics.forAgent, { agentId });
    expect(metrics.actions.blockedAfterRevocation).toBe(1);
  });

  it('re-reads the browser component switch after credential access and before transport', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    recorded.skillOutput = {
      draft: 'Read the browser-only tile.',
      notes: '',
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'looker',
            tool: 'browser_navigate',
            toolArgsJson: '{"url":"http://looker-tile:8080/"}',
          },
        },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real', ['looker:read'], {
      autonomousActions: true,
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker',
        displayName: 'Looker',
        class: 'analytics',
        verdict: 'connected',
        endpoint: 'http://looker-tile:8080/',
        path: 'browser-driven',
        toolAllowlist: ['browser_navigate'],
        credentialId: 'cred-looker',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      } as never);
    });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    recorded.afterCredentialRead = async (): Promise<void> => {
      vi.stubEnv('DAY0_BROWSER_MCP_URL', '');
      recorded.afterCredentialRead = undefined;
    };

    const result = await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining(BROWSER_DRIVER_ABSENT),
    });
    expect(recorded.mcp).toHaveLength(0);
    expect(ledger(await readItem(harness, workItemId))[0]).toMatchObject({
      ok: false,
      reason: expect.stringContaining(BROWSER_DRIVER_ABSENT),
    });
  });

  it('does not write after the agent row disappears between claim and transport', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = { ...skillOutput, actions: [skillOutput.actions[0]] };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real', ['linear:read'], {
      autonomousActions: true,
    });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    recorded.afterCredentialRead = async (): Promise<void> => {
      await harness.run(async (ctx) => await ctx.db.delete(agentId));
      recorded.afterCredentialRead = undefined;
    };

    const result = await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('agent not found') });
    expect(recorded.mcp).toHaveLength(0);
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(ledger(row)[0]).toMatchObject({ ok: false, reason: 'agent not found' });
    expect(ledger(row)[0].authority).toBeUndefined();
  });

  it('on: still refuses a read without its grant, a forged trailer and a mock verb', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      ...ladderOutput,
      actions: [
        ladderOutput.actions[0],
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'save_comment',
            toolArgsJson: JSON.stringify({
              issueId: 'iss-1',
              body: 'x\n\n-- Someone Else (Day0) · run a/b',
            }),
          },
        },
        { tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'x' } },
        ladderOutput.actions[3],
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real', ['boss:message'], {
      autonomousActions: true,
    });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const held = await readItem(harness, workItemId);
    expect(held.actionVerdicts).toEqual([
      { disposition: 'refused', reason: 'no grant (linear:read)' },
      { disposition: 'refused', reason: 'skill-supplied provenance trailer refused' },
      { disposition: 'refused', reason: expect.stringContaining('mock verb refused in real mode') },
      { disposition: 'auto' },
    ]);
    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toEqual({ ok: true });
    expect((await readItem(harness, workItemId)).state).toBe('completed');
    expect(recorded.mcp).toHaveLength(0);
    expect(recorded.http.map((call) => (call.body as { channel: string }).channel)).toEqual([
      'D0MANAGER',
    ]);
  });

  it('off: classifies a comment and a state change on the working item as held, not automatic', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      ...skillOutput,
      actions: [skillOutput.actions[0], skillOutput.actions[1]],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('actions-pending');
    expect(row.actionVerdicts).toEqual([
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_MUTATION },
    ]);
    expect(recorded.mcp).toHaveLength(0);
  });
});

describe('work action surface enablement', (): void => {
  it('loads persisted surfaces and stores an awaiting-connection verdict', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules()).withIdentity({ subject: 'owner' });
    const { workItemId } = await harness.run(
      async (
        ctx,
      ): Promise<{
        workItemId: Id<'workItems'>;
      }> => {
        const agentId = await ctx.db.insert('agents', {
          bossEmail: 'manager@day0.local',
          name: 'Connection gate test',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
        await ctx.db.insert('charters', {
          agentId,
          version: 'v1',
          approved: true,
          approvedAt: 1,
          createdAt: 1,
          body: {
            version: 'v1',
            source: 'day-1 manager 1:1',
            whyThisHire: 'Keep revenue operations hand-offs moving.',
            proposedFunction: 'Revenue operations triage and follow-through',
            evidence: [],
            shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
            proposedBoundaries: {
              willDo: ['Triage revenue operations requests.'],
              willNotDo: [],
              escalationTriggers: [],
            },
            namedCollaborators: [],
            namedSystems: [
              { name: 'Linear', class: 'kanban', whereMentioned: 'Work is in Linear.' },
            ],
            priorityReading: [],
            adjacentRoles: [],
            approvalChain: { boss: 'Manager', confidence: 'high' },
            openQuestions: [],
            createdAt: '2026-08-26T00:00:00.000Z',
          },
        });
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'linear',
          displayName: 'Linear',
          class: 'kanban',
          verdict: 'absent',
          whereFound: [],
          credentialLanded: false,
          reason: 'No approved Linear surface was documented.',
          createdAt: 1,
        });
        const workItemId = await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-1',
          title: 'Triage this revenue operations request',
          contentSummary: 'Keep this revenue operations hand-off moving.',
          contentRefs: [],
          observedAt: Date.now(),
          priority: 'P1',
          requesterLabel: 'Manager',
          state: 'discovered',
          createdAt: Date.now(),
        });
        return { workItemId };
      },
    );

    await expect(harness.action(api.workActions.evaluateWorkItem, { workItemId })).resolves.toEqual(
      { decision: 'defer' },
    );
    const stored = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(stored).toMatchObject({
      state: 'deferred',
      verdict: {
        decision: 'defer',
        reason: 'awaiting-connection',
        missingSurface: 'linear',
      },
    });
  });

  it.each([
    {
      label: 'supervised',
      autonomousActions: false,
      openClaims: 1,
      expectedDecision: 'queue',
      expectedReason: 'WIP cap reached: supervised cold-start limit is 1',
    },
    {
      label: 'autonomous',
      autonomousActions: true,
      openClaims: 2,
      expectedDecision: 'claim',
      expectedReason: undefined,
    },
  ])(
    'reads the $label switch when applying the production WIP cap',
    async ({ autonomousActions, openClaims, expectedDecision, expectedReason }): Promise<void> => {
      useSurfaceMode('mock');
      const rootHarness = convexTest(contractSchema(), allConvexModules());
      const harness = rootHarness.withIdentity(OWNER);
      const { agentId, workItemId } = await seed(rootHarness, 'mock', undefined, {
        autonomousActions,
      });
      await rootHarness.run(async (ctx): Promise<void> => {
        await ctx.db.patch(workItemId, {
          state: 'discovered',
          title: 'Prepare close summaries',
          contentSummary: 'Prepare close summaries for this Linear ticket.',
          plan: undefined,
        });
        for (let index = 0; index < openClaims; index += 1) {
          await ctx.db.insert('workItems', {
            agentId,
            sourceCategory: 'ticket-queue',
            sourceSystem: 'linear',
            externalId: `open-${index}`,
            title: `Existing item ${index}`,
            contentSummary: 'Already in progress.',
            contentRefs: [],
            state: 'claimed',
            observedAt: 1,
            createdAt: 1,
          });
        }
      });

      await expect(
        harness.action(api.workActions.evaluateWorkItem, { workItemId }),
      ).resolves.toEqual({ decision: expectedDecision });
      const row = await readItem(rootHarness, workItemId);
      expect(row.verdict).toMatchObject({
        decision: expectedDecision,
        ...(expectedReason ? { reason: expectedReason } : {}),
      });
    },
  );
});

describe('plan-step accounting after the loop ran live', (): void => {
  it('does not read a hold instruction as a promised surface read', (): void => {
    expect(() =>
      validatePlanStepOutcomes({
        plan: {
          summary: 'Hold writes.',
          steps: [
            'Hold all non-read writes, including any #revops-asks reply or Linear audit/status update, until the manager gives literal approval because autonomous actions are OFF.',
          ],
          expectedOutputType: 'message',
          riskNotes: '',
          reversibility: '',
          estimatedMinutes: 1,
        },
        outcomes: [{ step: 1, status: 'satisfied', evidence: 'Every write was held.' }],
        initialActions: [],
        initialLedger: [],
        surfaces: [
          { slug: 'linear', displayName: 'Linear' },
          { slug: 'slack', displayName: 'Slack' },
        ],
      }),
    ).not.toThrow();
  });

  it('does not read a surface named inside a quoted title as a promised read', (): void => {
    expect(() =>
      validatePlanStepOutcomes({
        plan: {
          summary: 'Confirm the originating issue.',
          steps: [
            'Read the connected Linear queue to locate the “Refresh the Looker pipeline tile” request and confirm its issue id; flag the "Looker pipeline tile" mismatch if unresolved.',
          ],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: '',
          estimatedMinutes: 1,
        },
        outcomes: [{ step: 1, status: 'satisfied', evidence: 'The Linear read confirmed the id.' }],
        initialActions: [
          {
            tool: 'mcp.call',
            args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-7"}' },
          },
        ],
        initialLedger: [{ tool: 'mcp.call', ok: true, effect: 'read issue', idempotencyKey: 'read' }],
        surfaces: [
          { slug: 'linear', displayName: 'Linear' },
          { slug: 'looker-pipeline-tile', displayName: 'Looker pipeline tile' },
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    'Read Linear, then hold every write for literal approval.',
    'Hold the public reply until you read Linear for the exact issue state.',
  ])('still enforces a promised read in a mixed instruction: %s', (step): void => {
    expect(() =>
      validatePlanStepOutcomes({
        plan: {
          summary: 'Read before holding writes.',
          steps: [step],
          expectedOutputType: 'message',
          riskNotes: '',
          reversibility: '',
          estimatedMinutes: 1,
        },
        outcomes: [{ step: 1, status: 'satisfied', evidence: 'No provider read was recorded.' }],
        initialActions: [],
        initialLedger: [],
        surfaces: [{ slug: 'linear', displayName: 'Linear' }],
      }),
    ).toThrow('promised a Linear read');
  });

  it('completes a run whose every action landed even though the closing phase marked steps blocked', (): void => {
    const outcomes: PlanStepOutcome[] = [
      { step: 1, status: 'blocked', evidence: 'No Linear read in the ledger.' },
      { step: 2, status: 'satisfied', evidence: 'The comment landed.' },
    ];
    const comment = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: JSON.stringify({ issueId: 'REVOPS-7', body: 'Refreshed the tile.' }),
      },
    } as const;
    const transition = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_issue',
        toolArgsJson: JSON.stringify({ id: 'REVOPS-7', state: 'Done' }),
      },
    } as const;
    const landed: AppliedAction = {
      tool: 'mcp.call',
      ok: true,
      effect: 'save_comment on linear',
      idempotencyKey: 'item:run:0',
    };
    const plan = {
      summary: 'Refresh the tile.',
      steps: ['Open the originating ticket', 'Post the audit comment'],
      expectedOutputType: 'ticket-update' as const,
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 1,
    };
    expect(blockedPlanReason(outcomes, { plan, actions: [comment], applied: [landed] })).toBeUndefined();
    expect(blockedPlanReason(outcomes)).toContain('1 approved plan step(s) remained blocked');
    expect(blockedPlanReason(outcomes, { plan, actions: [], applied: [] })).toContain(
      '1 approved plan step(s) remained blocked',
    );
    expect(
      blockedPlanReason(outcomes, { plan, actions: [comment], applied: [{ ...landed, held: true }] }),
    ).toContain('remained blocked');
    const closing = { ...plan, steps: ['Post the audit comment', 'Move the ticket to Done'] };
    expect(
      blockedPlanReason(outcomes, { plan: closing, actions: [comment], applied: [landed] }),
    ).toContain('remained blocked');
    expect(
      blockedPlanReason(outcomes, {
        plan: closing,
        actions: [comment, transition],
        applied: [landed, { ...landed, effect: 'save_issue on linear', idempotencyKey: 'item:run:1' }],
      }),
    ).toBeUndefined();
  });

  it('fails when a ticket plan omitted its primary effect and only a secondary manager DM landed', (): void => {
    const plan = {
      summary: 'Update the originating ticket.',
      steps: ['Post the approved audit comment to the ticket'],
      expectedOutputType: 'ticket-update' as const,
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 1,
    };
    const managerDm = skillOutput.actions[2];
    const landed: AppliedAction = {
      tool: 'http.request',
      ok: true,
      effect: 'sent manager DM',
      idempotencyKey: 'item:run:0',
    };

    expect(
      blockedPlanReason(
        [{ step: 1, status: 'blocked', evidence: 'The ticket write was never emitted.' }],
        { plan, actions: [managerDm], applied: [landed] },
      ),
    ).toContain('remained blocked');
  });

  it('still fails an emitted gate refusal and a partial applied batch', (): void => {
    const plan = {
      summary: 'Update the originating ticket.',
      steps: ['Post the audit comment', 'Move the ticket to Done'],
      expectedOutputType: 'ticket-update' as const,
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 1,
    };
    const outcomes: PlanStepOutcome[] = [
      { step: 1, status: 'satisfied', evidence: 'The comment landed.' },
      { step: 2, status: 'blocked', evidence: 'The gate refused the transition.' },
    ];
    const landed: AppliedAction = {
      tool: 'mcp.call',
      ok: true,
      effect: 'comment landed',
      idempotencyKey: 'item:run:0',
    };
    const refused: AppliedAction = {
      tool: 'mcp.call',
      ok: false,
      reason: 'no grant (linear:write)',
      idempotencyKey: 'item:run:1',
    };

    expect(
      blockedPlanReason(outcomes, {
        plan,
        actions: [skillOutput.actions[0], skillOutput.actions[1]],
        applied: [landed, refused],
      }),
    ).toContain('remained blocked');
  });

  it('does not read a quoted title as a close instruction', (): void => {
    const plan = {
      summary: 'Add context to the ticket.',
      steps: ['Comment on the “Close the books review” ticket with the figures read from the tracker.'],
      expectedOutputType: 'ticket-update' as const,
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 1,
    };
    const landed: AppliedAction = {
      tool: 'mcp.call',
      ok: true,
      effect: 'comment landed',
      idempotencyKey: 'item:run:0',
    };

    expect(
      blockedPlanReason(
        [{ step: 1, status: 'blocked', evidence: 'No transition was planned or emitted.' }],
        { plan, actions: [skillOutput.actions[0]], applied: [landed] },
      ),
    ).toBeUndefined();
  });

  it('does not turn a negative state-change instruction into a promised close', (): void => {
    const plan = {
      summary: 'Leave the ticket open and add context.',
      steps: ['Do not close or update the ticket; post only the audit comment.'],
      expectedOutputType: 'ticket-update' as const,
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 1,
    };
    const landed: AppliedAction = {
      tool: 'mcp.call',
      ok: true,
      effect: 'comment landed',
      idempotencyKey: 'item:run:0',
    };

    expect(
      blockedPlanReason(
        [{ step: 1, status: 'blocked', evidence: 'The state change was deliberately not emitted.' }],
        { plan, actions: [skillOutput.actions[0]], applied: [landed] },
      ),
    ).toBeUndefined();
  });
});
