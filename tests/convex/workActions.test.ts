/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveSpanModel } from '../fixtures/redaction-double';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  blockedPlanReason,
  browserTransportRefusal,
  closingStopReason,
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
import { STOPPED_PREFIX, WITHHELD_ON_STOP } from '../../src/work/stop';
import { actionIdempotencyKey } from '../../src/work/idempotency';
import {
  CLOSING_SET_CAP,
  type PlanObligations,
  type DependentExecutionOutput,
  type ExecutionOutput,
  type PlanStepOutcome,
} from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import {
  auditNoteClosing,
  auditNoteObligations,
  auditNoteOutcomes,
  auditNotePlan,
  auditNotePrerequisiteLedger,
  auditNotePrerequisites,
  refreshClosing,
  refreshOutcomes,
  refreshPlan,
  refreshPrerequisiteLedger,
  refreshPrerequisites,
  REVOPS_5_STEP_5,
  run3RefreshClosing,
  run3RefreshOutcomes,
  run3RefreshPlan,
  run3RefreshPrerequisiteLedger,
  run3RefreshPrerequisites,
} from './fixtures/closing-gates-2026-09-16';
import {
  run4AuditNoteClosing,
  run4AuditNoteOutcomes,
  run4AuditNotePlan,
  run4RefreshClosing,
  run4RefreshOutcomes,
  run4RefreshPlan,
  run4RefreshPrerequisiteLedger,
  run4RefreshPrerequisites,
  run4SlackClosing,
  run4SlackOutcomes,
  run4SlackPlan,
  run4SlackPrerequisiteLedger,
  run4SlackPrerequisites,
  run4TileSequence,
  RUN_4_LIST_ISSUES_EFFECT,
  RUN_4_TILE_READ_BACK,
} from './fixtures/plan-obligations-2026-09-16';
import { slackPhaseOne, TileDriver, type TileDriverCall } from '../fixtures/browser-phase-split-2026-09-16';

// The redaction component the actions reach through DAY0_REDACTOR_URL, served
// in-process from the recorded span model.
let redactorDouble: { url: string; close: () => Promise<void> } | undefined;
beforeAll(async (): Promise<void> => {
  redactorDouble = await serveSpanModel();
  process.env.DAY0_REDACTOR_URL = redactorDouble.url;
});
afterAll(async (): Promise<void> => {
  delete process.env.DAY0_REDACTOR_URL;
  await redactorDouble?.close();
});


const recorded = vi.hoisted(() => ({
  mcp: [] as Array<{ server: string; tool: string; args: unknown; bearer: string }>,
  http: [] as Array<{ url: string; method?: string; authorization: string | undefined; body: unknown }>,
  failMcpAfterRequest: false,
  failedMcpTool: undefined as string | undefined,
  issueRecordText: undefined as string | undefined,
  afterCredentialRead: undefined as (() => Promise<void>) | undefined,
  afterToolList: undefined as (() => Promise<void>) | undefined,
  skillRuns: 0,
  skillModes: [] as Array<string | undefined>,
  skillAnswers: [] as unknown[],
  skillSwitches: [] as Array<boolean | undefined>,
  skillFeedback: [] as Array<string | undefined>,
  dependentFeedback: [] as Array<string | undefined>,
  dependentSwitches: [] as Array<boolean | undefined>,
  planSwitches: [] as boolean[],
  planContexts: [] as Array<{ surfaces?: string[]; documents?: string[] }>,
  planRecords: [] as unknown[],
  skillOutput: undefined as ExecutionOutput | undefined,
  dependentOutput: undefined as DependentExecutionOutput | undefined,
  dependentRuns: 0,
  additionalModelCalls: 0,
  /** What the mocked argument repair answers; undefined means the model produced nothing usable. */
  repairedToolArgsJson: undefined as string | undefined,
  repairRequests: [] as Array<{ tool: string; reason: string }>,
  /** A stateful browser driver for the looker surface; absent, every client sees the fixed page. */
  tileDriver: undefined as undefined | import('../fixtures/browser-phase-split-2026-09-16').TileDriver,
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

/** Declared obligations for a seeded plan, the way the judgement would have filled them. */
function obligations(
  steps: Array<{ kind: PlanObligations['steps'][number]['kind']; reads?: string[]; writes?: string[] }>,
  transition: PlanObligations['transition'] = 'none',
  transitionStep: number | null = null,
): PlanObligations {
  return {
    steps: steps.map((step) => ({ kind: step.kind, reads: step.reads ?? [], writes: step.writes ?? [] })),
    transition,
    transitionStep,
    basis: 'judgement',
  };
}

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
        { surfaceClass: 'chat', operation: 'thread-reply' },
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
        { surfaceClass: 'chat', operation: 'thread-reply' },
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
    expect(
      findMatchingSkillForCandidate(slackMention, [proposedByEvaluator], {
        surfaceClass: 'analytics',
        operation: 'refresh-value',
      }),
    ).toBe(proposedByEvaluator);
  });

  it('refuses a row that declares only a foreign surface, even when its name matches the source', (): void => {
    const foreignOnly = {
      name: 'slack-action-c0abc123',
      description: 'Skill proposed to handle slack work.',
      targetSurface: 'looker',
      requiredScopes: ['looker:read', 'looker:write'],
    };
    expect(
      findMatchingSkillForCandidate(slackMention, [foreignOnly], {
        surfaceClass: 'analytics',
        operation: 'refresh-value',
      }),
    ).toBeUndefined();
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
        { surfaceClass: 'docs', operation: 'answer-from-docs' },
      ),
    ).toBe(builtinDocs);
    expect(
      findMatchingSkillForCandidate(
        { sourceSystem: 'linear', title: 'Close REVOPS-5', contentSummary: 'Close the issue.' },
        [builtinDocs],
        { surfaceClass: 'kanban', operation: 'comment-and-close' },
      ),
    ).toBeUndefined();
  });
});

describe('skill selection by shape', (): void => {
  const tileSkill = {
    name: 'analytics-refresh-value',
    description: 'Value refresh on an analytics surface, parameterised from each work item and its runbook.',
    targetSurface: 'looker-pipeline-tile',
    requiredScopes: ['boss:message', 'linear:read', 'looker-pipeline-tile:read', 'looker-pipeline-tile:write'],
    surfaceClass: 'analytics',
    operation: 'refresh-value',
  };
  const chatSkill = {
    name: 'chat-thread-reply',
    description: 'Threaded reply on a chat surface, parameterised from each work item and its runbook.',
    targetSurface: 'slack',
    requiredScopes: ['boss:message', 'slack:read', 'slack:write'],
    surfaceClass: 'chat',
    operation: 'thread-reply',
  };
  const legacyTicketSkill = {
    name: 'linear-action-revops-7',
    description: 'Skill proposed to handle linear work like "Refresh the Looker pipeline tile".',
    targetSurface: 'looker-pipeline-tile',
    requiredScopes: ['boss:message', 'linear:read', 'looker-pipeline-tile:write'],
  };
  const secondRefresh = {
    sourceSystem: 'linear',
    title: 'Refresh the Looker pipeline tile',
    contentSummary: 'Set the coverage figure to 68% for REVOPS-11 and record the audit line.',
  };

  it('reuses the registered skill for a second refresh with a different figure and ticket', (): void => {
    expect(
      findMatchingSkillForCandidate(secondRefresh, [chatSkill, tileSkill], {
        surfaceClass: 'analytics',
        operation: 'refresh-value',
      }),
    ).toBe(tileSkill);
  });

  it('reuses the chat skill for an ask in a different thread', (): void => {
    expect(
      findMatchingSkillForCandidate(
        {
          sourceSystem: 'slack',
          title: 'Mention in #revops-asks',
          contentSummary: 'Which coverage figure are we quoting this week?',
        },
        [tileSkill, chatSkill],
        { surfaceClass: 'chat', operation: 'thread-reply' },
      ),
    ).toBe(chatSkill);
  });

  it('finds nothing for a shape no registered skill covers', (): void => {
    expect(
      findMatchingSkillForCandidate(
        {
          sourceSystem: 'linear',
          title: 'Append the close row to the Close tracker',
          contentSummary: 'Add this week\'s close figures as a new row.',
        },
        [tileSkill, chatSkill],
        { surfaceClass: 'spreadsheet', operation: 'append-row' },
      ),
    ).toBeUndefined();
  });

  it('never matches a shaped skill by token overlap', (): void => {
    expect(
      findMatchingSkillForCandidate(
        {
          sourceSystem: 'linear',
          title: 'Refresh the value on the analytics surface',
          contentSummary: 'analytics refresh value runbook work item',
        },
        [tileSkill],
        { surfaceClass: 'kanban', operation: 'comment-and-close' },
      ),
    ).toBeUndefined();
  });

  it('does not use a legacy write procedure for a read-only shape', () => {
    expect(findMatchingSkillForCandidate({
      ...secondRefresh, title: 'Read the Looker pipeline tile',
      contentSummary: 'Report the figure; do not change anything.',
    }, [legacyTicketSkill, tileSkill], { surfaceClass: 'analytics', operation: 'read' })).toBeUndefined();
  });

  it('keeps serving a legacy per-ticket row through the token path when no shaped skill covers the shape', (): void => {
    expect(
      findMatchingSkillForCandidate(secondRefresh, [legacyTicketSkill], {
        surfaceClass: 'analytics',
        operation: 'refresh-value',
      }),
    ).toBe(legacyTicketSkill);
    expect(
      findMatchingSkillForCandidate(secondRefresh, [legacyTicketSkill, tileSkill], {
        surfaceClass: 'analytics',
        operation: 'refresh-value',
      }),
    ).toBe(tileSkill);
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
      managerAnswers?: unknown;
      managerFeedback?: string;
      onAdditionalModelCall?: () => void;
    }): Promise<ExecutionOutput> => {
      recorded.skillRuns += 1;
      recorded.skillModes.push(args.mode);
      recorded.skillAnswers.push(args.managerAnswers);
      recorded.skillSwitches.push(args.autonomousActions);
      recorded.skillFeedback.push(args.managerFeedback);
      for (let call = 0; call < recorded.additionalModelCalls; call += 1) {
        args.onAdditionalModelCall?.();
      }
      return recorded.skillOutput ?? skillOutput;
    },
    repairToolArguments: async (args: {
      row: { call: { surface: string; tool: string }; reason: string };
      onAdditionalModelCall?: () => void;
    }): Promise<ExecutionOutput['actions'][number] | undefined> => {
      recorded.repairRequests.push({ tool: args.row.call.tool, reason: args.row.reason });
      args.onAdditionalModelCall?.();
      if (!recorded.repairedToolArgsJson) return undefined;
      return {
        tool: 'mcp.call',
        args: {
          surface: args.row.call.surface,
          tool: args.row.call.tool,
          toolArgsJson: recorded.repairedToolArgsJson,
        },
      };
    },
    runDependentSkill: async (args: {
      autonomousActions?: boolean;
      managerFeedback?: string;
      plan: { steps: string[] };
    }): Promise<DependentExecutionOutput> => {
      recorded.dependentRuns += 1;
      recorded.dependentSwitches.push(args.autonomousActions);
      recorded.dependentFeedback.push(args.managerFeedback);
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
      record?: unknown;
    }) => {
      recorded.planSwitches.push(args.autonomousActions);
      recorded.planContexts.push({
        surfaces: args.surfaces?.map((surface) => surface.slug).sort(),
        documents: args.documents ? Object.keys(args.documents).sort() : undefined,
      });
      recorded.planRecords.push(args.record);
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
    createMastraMcpClient: (options: McpClientOptions): McpClientLike =>
      recorded.tileDriver && options.serverName === 'looker'
        ? recorded.tileDriver.client(options.serverName)
        : {
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
                    if (tool === 'get_issue' && 'issueId' in (args as Record<string, unknown>)) {
                      return {
                        isError: false,
                        content: [
                          {
                            type: 'text',
                            text: JSON.stringify({
                              error: true,
                              message: 'Tool input validation failed: unknown argument issueId',
                            }),
                          },
                        ],
                      };
                    }
                    if (tool === 'get_issue' && recorded.issueRecordText !== undefined) {
                      return { content: [{ type: 'text', text: recorded.issueRecordText }] };
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
          },
  };
});

const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit): Promise<Response> => {
  // The redaction component is reached over the same global; its calls are its own.
  if (redactorDouble && String(input).startsWith(redactorDouble.url)) return realFetch(input, init);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  recorded.http.push({
    url: String(input),
    method: init?.method,
    authorization: headers.Authorization,
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  });
  if (String(input).includes('/conversations.replies')) {
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [
          { ts: '1787746453.202809', text: '<@U0DAY0> are the three Q3 deals covered in the tracker?', user: 'U0MANAGER' },
          { ts: '1787746500.000100', text: 'Context: the Friday standup figure was 74%.', user: 'U0MANAGER' },
        ],
      }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ ok: true, ts: '1787654400.000200' }), { status: 200 });
});

afterEach((): void => {
  recorded.mcp.length = 0;
  recorded.http.length = 0;
  recorded.failMcpAfterRequest = false;
  recorded.failedMcpTool = undefined;
  recorded.issueRecordText = undefined;
  recorded.afterCredentialRead = undefined;
  recorded.afterToolList = undefined;
  recorded.skillSwitches.length = 0;
  recorded.dependentSwitches.length = 0;
  recorded.planSwitches.length = 0;
  recorded.planContexts.length = 0;
  recorded.planRecords.length = 0;
  recorded.skillRuns = 0;
  recorded.skillModes.length = 0;
  recorded.skillAnswers.length = 0;
  recorded.skillFeedback.length = 0;
  recorded.dependentFeedback.length = 0;
  recorded.skillOutput = undefined;
  recorded.dependentOutput = undefined;
  recorded.dependentRuns = 0;
  recorded.additionalModelCalls = 0;
  recorded.repairedToolArgsJson = undefined;
  recorded.repairRequests.length = 0;
  recorded.tileDriver = undefined;
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

async function scheduledNames(harness: Harness): Promise<string[]> {
  return (
    await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
  )
    .map((row) => row.name)
    .sort();
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

  it('keeps every audited phase-one action, the browser batch and its snapshot included, wherever the last read sits', (): void => {
    const browser = (tool: string, toolArgsJson: string): ExecutionOutput['actions'][number] => ({
      tool: 'mcp.call',
      args: { surface: 'looker', tool, toolArgsJson },
    });
    const read: ExecutionOutput['actions'][number] = {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-7"}' },
    };
    // The 2 September batch: the read, then the six-step tile sequence ending in the snapshot.
    const batch = [
      read,
      browser('browser_navigate', '{"url":"http://looker-tile:8080/"}'),
      browser('browser_fill_form', '{"fields":[{"name":"Username","value":"revops"},{"name":"Password","value":"{{secret}}"}]}'),
      browser('browser_click', '{"element":"Sign in"}'),
      browser('browser_fill_form', '{"fields":[{"name":"Pipeline coverage","value":"74%"}]}'),
      browser('browser_click', '{"element":"Save"}'),
      browser('browser_snapshot', '{}'),
    ];
    const plan = {
      summary: 'Refresh the tile, read it back, then close the ticket.',
      steps: ['Refresh the tile', 'Read back the figure and the audit line', 'Comment and close REVOPS-7'],
      expectedOutputType: 'ticket-update' as const,
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 1,
      obligations: obligations([{ kind: 'write', writes: ['looker'] }, { kind: 'read', reads: ['looker'] }, { kind: 'write', writes: ['linear'] }], 'promised', 3),
    };
    const staged = prerequisiteOutput(
      { draft: 'd', notes: '', needsDependentPhase: true, actions: batch },
      plan,
    );
    expect(staged.needsDependentPhase).toBe(true);
    expect(staged.actions).toEqual(batch);
    // The audit, not the position of the last read, decides what phase one carries:
    // a sequence whose snapshot is not its last action is kept whole too.
    const snapshotFirst = [read, batch[6], ...batch.slice(1, 6)];
    expect(
      prerequisiteOutput(
        { draft: 'd', notes: '', needsDependentPhase: false, actions: snapshotFirst },
        plan,
      ),
    ).toEqual({ draft: 'd', notes: '', needsDependentPhase: true, actions: snapshotFirst });
    // A plan that declares no read and an output that asked for no closing phase stay single-phase.
    expect(
      prerequisiteOutput(
        { draft: 'd', notes: '', needsDependentPhase: false, actions: [read] },
        { ...plan, steps: ['Comment on REVOPS-7'], obligations: obligations([{ kind: 'write', writes: ['linear'] }]) },
      ).needsDependentPhase,
    ).toBe(false);
    expect(
      prerequisiteOutput(
        { draft: 'd', notes: '', needsDependentPhase: false, actions: [read] },
        { ...plan, obligations: undefined },
      ).needsDependentPhase,
    ).toBe(false);
    // Obligations asked for and not settled are read as reading: the closing phase stays, and the gates owe nothing they cannot see.
    expect(
      prerequisiteOutput(
        { draft: 'd', notes: '', needsDependentPhase: false, actions: [read] },
        { ...plan, obligations: undefined, obligationsFailedOpen: 'timeout' },
      ).needsDependentPhase,
    ).toBe(true);
    expect(
      prerequisiteOutput(
        { draft: 'd', notes: '', needsDependentPhase: false, actions: [read] },
        { ...plan, steps: ['Comment on REVOPS-7'] },
      ).needsDependentPhase,
    ).toBe(true);
  });

  it('refuses to call a declared Linear read satisfied when no such ledger row landed', (): void => {
    expect(() =>
      validatePlanStepOutcomes({
        plan: {
          summary: 'Check Linear.',
          steps: ['Check the three deals with Linear reads'],
          expectedOutputType: 'message',
          riskNotes: '',
          reversibility: '',
          estimatedMinutes: 1,
          obligations: obligations([{ kind: 'read', reads: ['linear'] }]),
        },
        outcomes: [{ step: 1, status: 'satisfied', evidence: 'Assumed from docs.' }],
        initialActions: [],
        initialLedger: [],
        surfaces: [
          { slug: 'linear', displayName: 'Linear' },
          { slug: 'slack', displayName: 'Slack' },
        ],
      }),
    ).toThrow('approved plan step 1 declares a read of Linear, but no landed Linear read or blocking ledger reason was recorded');
  });

  it('owes a declared read only of a surface the gate holds, by slug whatever the case, and never reads the step', (): void => {
    const check = (reads: string[]): void =>
      validatePlanStepOutcomes({
        plan: {
          summary: 'Read the tile back.',
          steps: ['Capture the Looker pipeline tile read-back evidence'],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: '',
          estimatedMinutes: 1,
          obligations: obligations([{ kind: 'read', reads }]),
        },
        outcomes: [{ step: 1, status: 'satisfied', evidence: 'The tile shows 74%.' }],
        initialActions: [],
        initialLedger: [],
        surfaces: [{ slug: 'looker', displayName: 'Looker pipeline tile' }],
      });
    expect(() => check(['Looker'])).toThrow('declares a read of Looker pipeline tile');
    expect(() => check(['northstar-crm'])).not.toThrow();
    expect(() => check([])).not.toThrow();
  });

  it('accepts a step satisfied on the manager\'s word only when the run carries their feedback', (): void => {
    const plan = {
      summary: 'Confirm the owner, then comment and close.',
      steps: ['Confirm REVOPS-7 has an owner.', 'Comment on the ticket and close it.'],
      expectedOutputType: 'ticket-update' as const,
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 1,
      obligations: obligations([{ kind: 'read' }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
    };
    const surfaces = [{ slug: 'linear', displayName: 'Linear' }];
    const outcomes: PlanStepOutcome[] = [
      {
        step: 1,
        status: 'satisfied',
        evidence: 'Manager: REVOPS-7 is owned by Priya.',
        basis: 'manager-feedback',
      },
      { step: 2, status: 'satisfied', evidence: 'comment and Done' },
    ];
    expect(() =>
      validatePlanStepOutcomes({
        plan,
        outcomes,
        initialActions: [],
        initialLedger: [],
        surfaces,
        managerFeedback: 'REVOPS-7 is owned by Priya.',
      }),
    ).not.toThrow();
    expect(() =>
      validatePlanStepOutcomes({ plan, outcomes, initialActions: [], initialLedger: [], surfaces }),
    ).toThrow('step 1 cites manager feedback the run does not carry');
    // The manager's word settles a fact; it never stands in for a read the plan declares.
    expect(() =>
      validatePlanStepOutcomes({
        plan: { ...plan, obligations: obligations([{ kind: 'read', reads: ['linear'] }, { kind: 'write', writes: ['linear'] }], 'promised', 2) },
        outcomes,
        initialActions: [],
        initialLedger: [],
        surfaces,
        managerFeedback: 'REVOPS-7 is owned by Priya.',
      }),
    ).toThrow('declares a read of Linear');
  });

  it('accepts a not-verifiable outcome with evidence for a declared read, and never lets it withhold the close or fail the run', (): void => {
    const plan = {
      summary: 'Confirm, then comment and close.',
      steps: [
        'Check REVOPS-7 in Linear is owned and prioritized.',
        'Comment on the ticket and close it.',
      ],
      expectedOutputType: 'ticket-update' as const,
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 1,
      obligations: obligations([{ kind: 'read', reads: ['linear'] }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
    };
    const surfaces = [{ slug: 'linear', displayName: 'Linear' }];
    const outcomes = [
      { step: 1, status: 'not-verifiable' as const, evidence: 'get_issue carries no assignee field' },
      { step: 2, status: 'satisfied' as const, evidence: 'comment and Done' },
    ];
    expect(() =>
      validatePlanStepOutcomes({ plan, outcomes, initialActions: [], initialLedger: [], surfaces }),
    ).not.toThrow();
    expect(() =>
      validatePlanStepOutcomes({
        plan,
        outcomes: [{ ...outcomes[0], evidence: ' ' }, outcomes[1]],
        initialActions: [],
        initialLedger: [],
        surfaces,
      }),
    ).toThrow('declares a read of Linear');
    const comment = skillOutput.actions[0];
    const done = skillOutput.actions[1];
    expect(
      dependentTransitionRefusal({ plan, actions: [comment, done], planStepOutcomes: outcomes }),
    ).toBeUndefined();
    expect(
      dependentTransitionRefusal({ plan, actions: [comment], planStepOutcomes: outcomes }),
    ).toContain('omitted the approved ticket state transition');
    expect(blockedPlanReason(outcomes)).toBeUndefined();
  });

  it('reads the transition from the declared fields, never from the wording of a step', (): void => {
    const comment = skillOutput.actions[0];
    const satisfied = [
      { step: 1, status: 'satisfied' as const, evidence: 'ledger row 0' },
      { step: 2, status: 'satisfied' as const, evidence: 'DM auto-applied' },
    ];
    for (const wording of [
      'Draft a manager DM summarising any Sales-Finance or close-week impact; hold it for approval.',
      'Close the ticket once the comment lands.',
      'Move REVOPS-7 to Done.',
    ]) {
      const plan = {
        summary: 'Comment, then brief the manager.',
        steps: ['Comment on the ticket with the triage notes.', wording],
        expectedOutputType: 'ticket-update' as const,
        riskNotes: '',
        reversibility: '',
        estimatedMinutes: 1,
        obligations: obligations([{ kind: 'write', writes: ['linear'] }, { kind: 'report' }], 'none'),
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
      // A plan with no declared obligations owes no transition either.
      expect(
        dependentTransitionRefusal({ plan: { ...plan, obligations: undefined }, actions: [comment], planStepOutcomes: satisfied }),
        wording,
      ).toBeUndefined();
    }
    const closing = {
      summary: 'Comment, then close.',
      steps: ['Comment on the ticket.', 'Note the month-end close status in the DM.'],
      expectedOutputType: 'ticket-update' as const,
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 1,
      obligations: obligations([{ kind: 'write', writes: ['linear'] }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
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
      obligations: obligations([{ kind: 'read' }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
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

describe('stopping blocked work with only a manager message left', (): void => {
  const slack = {
    slug: 'slack', displayName: 'Slack', class: 'chat', verdict: 'connected', credentialLanded: true,
    lastVerifiedAt: 1, path: 'documented-api', endpoint: 'https://slack.com/api/',
    toolAllowlist: ['chat.postMessage'], managerDmChannelId: 'D0MANAGER',
  } as const;
  const dm = (text: string) => ({
    tool: 'http.request' as const,
    args: {
      surface: 'slack', method: 'POST', path: '/chat.postMessage',
      headersJson: '{"Authorization":"Bearer {{secret}}"}',
      body: JSON.stringify({ channel: 'D0MANAGER', text }),
    },
  });
  const run = (text: string) => ({
    plan: {
      summary: 'Confirm the owner, then add the audit note and close.',
      steps: ['Confirm REVOPS-7 has an owner', 'Comment and close REVOPS-7'],
      expectedOutputType: 'ticket-update' as const, riskNotes: '', reversibility: 'reversible', estimatedMinutes: 5,
    },
    outcomes: [
      { step: 1, status: 'blocked' as const, evidence: 'get_issue shows no assignee.' },
      { step: 2, status: 'blocked' as const, evidence: 'Nothing to close without an owner.' },
    ],
    initialActions: [{ tool: 'mcp.call' as const, args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"iss-1"}' } }],
    initialApplied: [{ tool: 'mcp.call', ok: true, idempotencyKey: 'wi:run:0' }],
    closingActions: [dm(text)],
    surfaces: [slack as never],
  });

  it('lets a question or an ask for a decision through', (): void => {
    expect(closingStopReason(run('Who should own REVOPS-7 so I can continue?'))).toBeUndefined();
    expect(closingStopReason(run('Please assign REVOPS-7 an owner and I will pick it up.'))).toBeUndefined();
  });

  it('still stops on a note that asks the manager nothing', (): void => {
    expect(closingStopReason(run('REVOPS-7 has no owner, so nothing was changed and I stopped.'))).toContain('blocked');
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
      ],
    };
    // A comment written before the read-back exists never reaches the gate:
    // the executor's deferral audit refuses it and the closing phase authors it.
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
          obligations: obligations([{ kind: 'write', writes: ['looker'] }, { kind: 'read', reads: ['looker'] }, { kind: 'write', writes: ['linear'] }], 'promised', 3),
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

  it('lets the closing phase carry the whole closing set, and a deferred sequence only when phase one declared one', async (): Promise<void> => {
    useSurfaceMode('real');
    const linearRead = (tool: string): ExecutionOutput['actions'][number] => ({
      tool: 'mcp.call',
      args: { surface: 'linear', tool, toolArgsJson: JSON.stringify({ id: 'iss-1' }) },
    });
    const closingSet: ExecutionOutput['actions'] = [
      skillOutput.actions[0],
      skillOutput.actions[1],
      skillOutput.actions[2],
      linearRead('list_comments'),
      linearRead('get_issue'),
    ];
    expect(closingSet).toHaveLength(CLOSING_SET_CAP);
    const closing = (actions: ExecutionOutput['actions']): DependentExecutionOutput => ({
      draft: 'Closing the ticket from the read-back.',
      notes: '',
      actions,
      planStepOutcomes: [
        { step: 1, status: 'satisfied', evidence: 'ledger row 0' },
        { step: 2, status: 'satisfied', evidence: 'the comment and Done in this response' },
      ],
    });
    const prepare = async (initial: ExecutionOutput): Promise<{ workItemId: Id<'workItems'>; runId: Id<'events'>; harness: Harness }> => {
      recorded.skillOutput = initial;
      const harness = convexTest(contractSchema(), allConvexModules());
      const { workItemId } = await seed(harness, 'real');
      await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
      await harness.action(internal.workActions.applyApprovedActions, { workItemId });
      const prepared = await readItem(harness, workItemId);
      expect((prepared.output as { phase?: string }).phase).toBe('dependent-authoring');
      const runId = prepared.executionRunId;
      if (!runId) throw new Error('execution run missing');
      return { workItemId, runId, harness };
    };
    const undeclared: ExecutionOutput = {
      draft: 'Reading the ticket first.',
      notes: '',
      needsDependentPhase: true,
      actions: [linearRead('get_issue')],
    };

    // The closing set fits without any declared deferral. The auto rows are
    // applied here rather than left to the scheduler, so no call from this
    // run lands in a later test.
    recorded.dependentOutput = closing(closingSet);
    let run = await prepare(undeclared);
    await expect(
      run.harness.action(internal.workActions.authorDependentActions, { workItemId: run.workItemId, runId: run.runId }),
    ).resolves.toEqual({ ok: true, reason: 'dependent actions applying' });
    await run.harness.action(internal.workActions.applyApprovedActions, { workItemId: run.workItemId });
    expect((await readItem(run.harness, run.workItemId)).state).toBe('actions-pending');

    // A sixth closing action needs the allowance phase one did not declare.
    recorded.dependentOutput = closing([...closingSet, linearRead('get_issue')]);
    run = await prepare(undeclared);
    await expect(
      run.harness.action(internal.workActions.authorDependentActions, { workItemId: run.workItemId, runId: run.runId }),
    ).resolves.toEqual({ ok: false, reason: `dependent phase emitted 6 actions; cap is ${CLOSING_SET_CAP}` });
    expect((await readItem(run.harness, run.workItemId)).state).toBe('failed');

    // Phase one declared a deferral against its read: the closing phase may carry it.
    run = await prepare({
      ...undeclared,
      deferredActions: [
        {
          description: 'the documented tile sequence, whose figure the record read returns',
          reason: 'the fill value is the figure in the record',
          dependsOnActionIndex: 0,
          dependsOnField: 'record',
        },
      ],
    });
    await expect(
      run.harness.action(internal.workActions.authorDependentActions, { workItemId: run.workItemId, runId: run.runId }),
    ).resolves.toEqual({ ok: true, reason: 'dependent actions applying' });
    await run.harness.action(internal.workActions.applyApprovedActions, { workItemId: run.workItemId });
    expect((await readItem(run.harness, run.workItemId)).state).toBe('actions-pending');
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
          obligations: obligations([{ kind: 'read', reads: ['looker'] }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
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
      pendingRunId: pending.pendingRunId!,
      approvedIndexes: [0, 1],
    });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    expect((await readItem(harness, workItemId)).state).toBe('completed');
    expect(
      recorded.mcp.filter((call) => call.server === 'linear').map((call) => call.tool),
    ).toEqual(['save_comment', 'save_issue']);
  });

  it('stops without a second decision when the manager left the prerequisite out, and withholds the closing comment', async (): Promise<void> => {
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
          obligations: obligations([{ kind: 'write', reads: ['looker'], writes: ['looker'] }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
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
    // The manager already decided the Save; nothing landed and no approval of
    // the closing comment could complete the plan, so the run stops with the
    // comment on the record rather than asking a second time.
    const failed = await readItem(harness, workItemId);
    expect(failed.state).toBe('failed');
    expect(failed.skipReason?.startsWith(STOPPED_PREFIX)).toBe(true);
    expect(failed.skipReason).toContain('2 approved plan step(s) remained blocked');
    expect(failed.skipReason).toContain('browser_click Save was held and not approved.');
    expect(recorded.mcp.map((call) => call.tool)).toEqual([]);
    expect(ledger(failed).map((entry) => [entry.tool, entry.ok, entry.held ?? false])).toEqual([
      ['mcp.call', true, true],
      ['mcp.call', true, true],
      ['mcp.call', true, true],
    ]);
    expect(ledger(failed)[2].reason).toBe(WITHHELD_ON_STOP);
    expect((failed.output as ExecutionOutput).actions?.map((action) => action.args.tool)).toEqual([
      'browser_click',
      'browser_snapshot',
      'save_comment',
    ]);
    const stops = (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
      (event) => event.type === 'work.failed',
    );
    expect(stops.map((event) => (event.payload as { stopped?: boolean }).stopped)).toEqual([true]);
  });

  it('stops on a failed snapshot before any closing action, with the failure on the record', async (): Promise<void> => {
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
          obligations: obligations([{ kind: 'read', reads: ['looker'] }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
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

    // A provider failure with nothing landed leaves nothing to audit and
    // nothing to decide: the run stops here, without a closing phase.
    const failed = await readItem(harness, workItemId);
    expect(failed.state).toBe('failed');
    expect(failed.skipReason?.startsWith(STOPPED_PREFIX)).toBe(true);
    expect(failed.skipReason).toContain('browser_snapshot failed: snapshot timed out');
    expect(recorded.dependentRuns).toBe(0);
    expect(recorded.mcp.filter((call) => call.server === 'linear')).toEqual([]);
    expect(JSON.stringify(recorded.mcp)).not.toContain('"state":"Done"');
    expect(ledger(failed).map((entry) => [entry.tool, entry.ok])).toEqual([['mcp.call', false]]);
    expect(await scheduledNames(harness)).not.toContain('workActions:authorDependentActions');
  });

  it('records why promised Linear reads were not made instead of silently answering the Slack ask', async (): Promise<void> => {
    useSurfaceMode('real');
    // The executor emitted no read and set no closing phase; a reply written
    // before the promised reads is refused by the deferral audit, so nothing
    // reaches the gate from phase one. The plan's promised reads give the run
    // its closing phase regardless.
    recorded.skillOutput = {
      draft: 'The Slack reply is ready.',
      notes: '',
      needsDependentPhase: false,
      actions: [],
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
          obligations: obligations([{ kind: 'read', reads: ['linear'] }, { kind: 'read', reads: ['linear'] }, { kind: 'write', writes: ['slack'] }]),
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
      `${STOPPED_PREFIX}3 approved plan step(s) remained blocked: step 1 (No Linear list or get action exists in the ledger.); step 2 (No Linear read exists in the ledger.); step 3 (The evidence prerequisite was not met.)`,
    );
    expect(recorded.mcp.filter((call) => call.server === 'linear')).toHaveLength(0);
    expect(recorded.http).toHaveLength(0);
    expect((failed.output as { planStepOutcomes?: PlanStepOutcome[] }).planStepOutcomes).toEqual(
      recorded.dependentOutput.planStepOutcomes,
    );
  });

  it('completes a ticket update whose plan says read but whose evidence is the ticket itself', async (): Promise<void> => {
    useSurfaceMode('real');
    // The plan promises a read, so the run has a closing phase whatever the
    // executor said; the comment and Done are authored there, never in phase one.
    recorded.skillOutput = {
      draft: 'Adding the audit note.',
      notes: '',
      needsDependentPhase: false,
      actions: [],
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
          obligations: obligations([{ kind: 'read' }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
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

  it('applies a batch approval per item through the gate, each with its own idempotency keys', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId: first } = await seed(harness, 'real');
    const second = await harness.run(async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'iss-2',
        title: 'Add the second audit note',
        contentSummary: 'linear ticket work',
        contentRefs: [],
        state: 'plan-approved',
        plan: { summary: 'Comment then close.', steps: ['comment', 'close'], expectedOutputType: 'ticket-update', riskNotes: '', reversibility: 'reversible', estimatedMinutes: 5 },
        observedAt: 1,
        createdAt: 1,
      }),
    );
    for (const workItemId of [first, second]) {
      await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
      await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    }
    const parked = await Promise.all([readItem(harness, first), readItem(harness, second)]);
    expect(parked.map((row) => row.state)).toEqual(['actions-pending', 'actions-pending']);
    const members = parked.map((row) => {
      if (!row.pendingRunId) throw new Error('pending run missing');
      const verdicts = row.actionVerdicts ?? [];
      return {
        workItemId: row._id,
        pendingRunId: row.pendingRunId,
        approvedIndexes: verdicts.flatMap((verdict, index) => (verdict.disposition === 'held' ? [index] : [])),
      };
    });
    expect(members.map((member) => member.approvedIndexes)).toEqual([[0, 1, 3], [0, 1, 3]]);
    recorded.mcp.length = 0;

    // The batch schedules one apply per member; let those start and finish
    // rather than racing them by hand.
    await harness.withIdentity(OWNER).mutation(api.work.approveActionsBatch, { members });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.finishInProgressScheduledFunctions();

    const done = await Promise.all([readItem(harness, first), readItem(harness, second)]);
    expect(done.map((row) => [row.state, row.skipReason])).toEqual([
      ['completed', undefined],
      ['completed', undefined],
    ]);
    for (const [row, member] of [
      [done[0], members[0]],
      [done[1], members[1]],
    ] as const) {
      expect(ledger(row).map((entry) => entry.idempotencyKey)).toEqual(
        [0, 1, 2, 3].map((actionIndex) => actionIdempotencyKey({ workItemId: row._id, runId: member.pendingRunId, actionIndex })),
      );
      expect(ledger(row).map((entry) => [entry.ok, entry.held ?? false])).toEqual([
        [true, false],
        [true, false],
        [true, false],
        [true, false],
      ]);
    }
    // Both items' literal payloads reached the provider, once each.
    expect(recorded.mcp.filter((call) => call.tool === 'save_comment').map((call) => call.args)).toEqual([
      { issueId: 'iss-1', body: expect.stringContaining('Prepared the close summary.') },
      { issueId: 'iss-1', body: expect.stringContaining('Prepared the close summary.') },
    ]);
    expect(recorded.mcp.filter((call) => call.tool === 'save_issue')).toHaveLength(2);
  });

  it('stops a blocked closing phase with its comment and DM withheld, and sends nothing', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      draft: 'Reading the ticket first.',
      notes: '',
      needsDependentPhase: true,
      actions: [
        {
          tool: 'mcp.call',
          args: { surface: 'linear', tool: 'get_issue', toolArgsJson: JSON.stringify({ id: 'iss-1' }) },
        },
      ],
    };
    recorded.dependentOutput = {
      draft: 'REVOPS-7 has no owner, so I cannot close it.',
      notes: '',
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'save_comment',
            toolArgsJson: JSON.stringify({ issueId: 'iss-1', body: 'Blocked: no owner is set.' }),
          },
        },
        skillOutput.actions[2],
      ],
      planStepOutcomes: [
        { step: 1, status: 'blocked', evidence: 'get_issue shows no assignee.' },
        { step: 2, status: 'blocked', evidence: 'Nothing to close without an owner.' },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        plan: {
          summary: 'Confirm the owner, then add the audit note and close.',
          steps: ['Confirm REVOPS-7 has an owner', 'Comment and close REVOPS-7'],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: 'reversible',
          estimatedMinutes: 5,
          obligations: obligations([{ kind: 'read', reads: ['linear'] }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
        },
      });
    });

    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    const prepared = await readItem(harness, workItemId);
    expect((prepared.output as { phase?: string }).phase).toBe('dependent-authoring');
    const runId = prepared.executionRunId;
    if (!runId) throw new Error('execution run missing');
    await expect(
      harness.action(internal.workActions.authorDependentActions, { workItemId, runId }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('remained blocked') });

    // The read landed, but a read is not work: the run stops, the comment
    // never reaches the manager for a decision and the DM is never sent.
    const stopped = await readItem(harness, workItemId);
    expect(stopped.state).toBe('failed');
    expect(stopped.skipReason?.startsWith(STOPPED_PREFIX)).toBe(true);
    expect(stopped.skipReason).toContain('step 1 (get_issue shows no assignee.)');
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['get_issue']);
    expect(recorded.http.filter((call) => call.url.endsWith('/chat.postMessage'))).toEqual([]);
    expect(ledger(stopped).map((entry) => [entry.tool, entry.ok, entry.held ?? false, entry.reason])).toEqual([
      ['mcp.call', true, false, undefined],
      ['mcp.call', true, true, WITHHELD_ON_STOP],
      ['http.request', true, true, WITHHELD_ON_STOP],
    ]);
    expect((stopped.output as { planStepOutcomes?: PlanStepOutcome[] }).planStepOutcomes).toEqual(
      recorded.dependentOutput.planStepOutcomes,
    );
    const types = (await harness.run(async (ctx) => await ctx.db.query('events').collect())).map(
      (event) => event.type,
    );
    expect(types.filter((type) => type === 'work.actions-pending')).toEqual([]);
    expect(await scheduledNames(harness)).not.toContain('managerChannelActions:requestDecision');
  });

  it('delivers an escalation-only closing set when the plan remains blocked', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      draft: 'Reading the ticket first.',
      notes: '',
      needsDependentPhase: true,
      actions: [
        {
          tool: 'mcp.call',
          args: { surface: 'linear', tool: 'get_issue', toolArgsJson: JSON.stringify({ id: 'iss-1' }) },
        },
      ],
    };
    recorded.dependentOutput = {
      draft: 'REVOPS-7 has no owner, so I cannot close it.',
      notes: '',
      actions: [{
        tool: 'http.request', args: {
          surface: 'slack', method: 'POST', path: '/chat.postMessage',
          headersJson: '{"Authorization":"Bearer {{secret}}"}',
          body: JSON.stringify({ channel: 'D0MANAGER', text: 'Who should own REVOPS-7 so I can continue?' }),
        },
      }],
      planStepOutcomes: [
        { step: 1, status: 'blocked', evidence: 'get_issue shows no assignee.' },
        { step: 2, status: 'blocked', evidence: 'Nothing to close without an owner.' },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        plan: {
          summary: 'Confirm the owner, then add the audit note and close.',
          steps: ['Confirm REVOPS-7 has an owner', 'Comment and close REVOPS-7'],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: 'reversible',
          estimatedMinutes: 5,
          obligations: obligations([{ kind: 'read', reads: ['linear'] }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
        },
      });
    });

    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    const prepared = await readItem(harness, workItemId);
    expect((prepared.output as { phase?: string }).phase).toBe('dependent-authoring');
    const runId = prepared.executionRunId;
    if (!runId) throw new Error('execution run missing');
    await expect(
      harness.action(internal.workActions.authorDependentActions, { workItemId, runId }),
    ).resolves.toMatchObject({ ok: true });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    expect(recorded.http.filter(call => call.url.endsWith('/chat.postMessage'))).toHaveLength(1);
    expect(recorded.mcp.map(call => call.tool)).toEqual(['get_issue']);
    expect((await readItem(harness, workItemId)).state).toBe('failed');
  });

  it('completes a retry whose note settles a plan step, on the manager\'s word and in the record', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      draft: 'Adding the audit note.',
      notes: '',
      needsDependentPhase: true,
      actions: skillOutput.actions.slice(0, 3),
    };
    recorded.dependentOutput = {
      draft: 'Audit note added and the issue closed.',
      notes: '',
      actions: skillOutput.actions.slice(0, 3),
      planStepOutcomes: [
        {
          step: 1,
          status: 'satisfied',
          evidence: 'Manager: REVOPS-7 is owned by Priya.',
          basis: 'manager-feedback',
        },
        { step: 2, status: 'satisfied', evidence: 'save_comment and save_issue emitted.' },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real', undefined, { autonomousActions: true });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        plan: {
          summary: 'Confirm the owner, then add the audit note and close.',
          steps: ['Confirm REVOPS-7 has an owner', 'Add the audit note and close the ticket'],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: 'reversible',
          estimatedMinutes: 5,
          obligations: obligations([{ kind: 'read' }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
        },
        managerFeedback: { reason: 'REVOPS-7 is owned by Priya.', at: 2, kind: 'retry-note' },
      });
    });

    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    const prepared = await readItem(harness, workItemId);
    expect((prepared.output as { phase?: string }).phase).toBe('dependent-authoring');
    const runId = prepared.executionRunId;
    if (!runId) throw new Error('execution run missing');
    await harness.action(internal.workActions.authorDependentActions, { workItemId, runId });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });

    const done = await readItem(harness, workItemId);
    expect(done.state).toBe('completed');
    expect(recorded.skillFeedback).toEqual(['REVOPS-7 is owned by Priya.']);
    expect(recorded.dependentFeedback).toEqual(['REVOPS-7 is owned by Priya.']);
    expect((done.output as { planStepOutcomes: PlanStepOutcome[] }).planStepOutcomes).toEqual(
      recorded.dependentOutput.planStepOutcomes,
    );
    expect(done.managerFeedback).toMatchObject({
      reason: 'REVOPS-7 is owned by Priya.',
      kind: 'retry-note',
      addressedAt: expect.any(Number),
    });
  });

  it('refuses a closing phase that cites manager feedback the run does not carry', async (): Promise<void> => {
    useSurfaceMode('real');
    // Phase one keeps every action it emits now, so the ticket writes belong
    // to the closing set here: the refusal must land nothing.
    recorded.skillOutput = {
      draft: 'Adding the audit note.',
      notes: '',
      needsDependentPhase: true,
      actions: skillOutput.actions.slice(2, 3),
    };
    recorded.dependentOutput = {
      draft: 'Audit note added.',
      notes: '',
      actions: skillOutput.actions.slice(0, 3),
      planStepOutcomes: [
        { step: 1, status: 'satisfied', evidence: 'Manager said so.', basis: 'manager-feedback' },
        { step: 2, status: 'satisfied', evidence: 'save_comment and save_issue emitted.' },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real', undefined, { autonomousActions: true });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        plan: {
          summary: 'Confirm the owner, then add the audit note and close.',
          steps: ['Confirm REVOPS-7 has an owner', 'Add the audit note and close the ticket'],
          expectedOutputType: 'ticket-update',
          riskNotes: '',
          reversibility: 'reversible',
          estimatedMinutes: 5,
          obligations: obligations([{ kind: 'read' }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
        },
      });
    });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    const runId = (await readItem(harness, workItemId)).executionRunId;
    if (!runId) throw new Error('execution run missing');
    await expect(
      harness.action(internal.workActions.authorDependentActions, { workItemId, runId }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('cites manager feedback') });
    expect((await readItem(harness, workItemId)).state).toBe('failed');
    expect(recorded.mcp.filter((call) => call.server === 'linear').map((call) => call.tool)).toEqual([]);
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

  describe('the grounding read before the plan', (): void => {
    const toClaimed = async (
      harness: Harness,
      workItemId: Id<'workItems'>,
      patch: Partial<Doc<'workItems'>> = {},
    ): Promise<void> => {
      await harness.run(async (ctx) => {
        await ctx.db.patch(workItemId, { state: 'claimed', plan: undefined, ...patch });
      });
    };
    const groundingEvents = async (harness: Harness) =>
      (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
        (event) => event.type === 'work.plan-grounding-read',
      );

    it('reads the ticket once under standing authority, writes nothing, and hands the record to the planner', async (): Promise<void> => {
      useSurfaceMode('real');
      const harness = convexTest(contractSchema(), allConvexModules());
      const { workItemId } = await seed(harness, 'real');
      await toClaimed(harness, workItemId);
      await expect(
        harness.withIdentity(OWNER).action(api.workActions.draftPlan, { workItemId }),
      ).resolves.toEqual({ ok: true });
      expect(recorded.mcp.map((call) => [call.tool, call.args])).toEqual([
        ['get_issue', { id: 'iss-1' }],
      ]);
      // The decision notice and its public acknowledgement go over Slack once the
      // plan is pending; the read itself writes nothing to any surface.
      expect(recorded.http.filter((call) => !call.url.endsWith('/chat.postMessage'))).toEqual([]);
      expect(recorded.planRecords).toEqual([
        { surface: 'linear', tool: 'get_issue', subject: 'record', text: 'get_issue on linear · {"id":"get_issue-id"}' },
      ]);
      const events = await groundingEvents(harness);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        workItemId,
        action: { tool: 'mcp.call', args: { tool: 'get_issue', toolArgsJson: '{"id":"iss-1"}' } },
        applied: { ok: true, authority: 'standing', tool: 'mcp.call' },
      });
      expect((await readItem(harness, workItemId)).state).toBe('plan-pending');
    });

    it('redacts ticket credentials before persisting the grounding ledger or handing off the record', async () => {
      useSurfaceMode('real');
      const password = 'Zq9!vT2#kL8mNp4rXs7wYb3e';
      recorded.issueRecordText = JSON.stringify({
        id: 'iss-1', description: `Refresh the tile.\nService password: ${password}`,
      });
      const harness = convexTest(contractSchema(), allConvexModules());
      const { workItemId } = await seed(harness, 'real');
      await toClaimed(harness, workItemId);
      await harness.withIdentity(OWNER).action(api.workActions.draftPlan, { workItemId });
      const events = await groundingEvents(harness);
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(password);
      expect(JSON.stringify(recorded.planRecords)).not.toContain(password);
      expect(events[0]!.payload).toMatchObject({ applied: { ok: true, authority: 'standing' } });
    });

    const asMention = async (harness: Harness, workItemId: Id<'workItems'>): Promise<void> => {
      await toClaimed(harness, workItemId, {
        sourceCategory: 'event-stream',
        sourceSystem: 'slack',
        externalId: 'C0PUBLIC:1787746453.202809',
        title: 'Slack mention in #revops-asks',
        contentSummary: '<@U0DAY0> are the three Q3 deals covered in the tracker?',
        replyTarget: { channel: 'C0PUBLIC', channelName: 'revops-asks', threadTs: '1787746453.202809' },
      });
    };
    const allowThreadRead = async (harness: Harness, agentId: Id<'agents'>): Promise<void> => {
      await harness.run(async (ctx) => {
        const slack = (await ctx.db.query('surfaces').collect()).find((row) => row.slug === 'slack');
        if (!slack) throw new Error('slack surface missing');
        await ctx.db.patch(slack._id, {
          toolAllowlist: ['chat.postMessage', 'conversations.history', 'conversations.replies'],
        });
        void agentId;
      });
    };

    it('reads a chat ask\'s thread once under standing authority and hands it to the planner as a thread', async (): Promise<void> => {
      useSurfaceMode('real');
      const harness = convexTest(contractSchema(), allConvexModules());
      const { agentId, workItemId } = await seed(harness, 'real');
      await allowThreadRead(harness, agentId);
      await asMention(harness, workItemId);
      await expect(
        harness.withIdentity(OWNER).action(api.workActions.draftPlan, { workItemId }),
      ).resolves.toEqual({ ok: true });
      expect(recorded.mcp).toHaveLength(0);
      const reads = recorded.http.filter((call) => call.url.includes('/conversations.replies'));
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({ method: 'GET', authorization: 'Bearer plain-cred-slack', body: undefined });
      expect(new URL(reads[0]!.url).searchParams.get('channel')).toBe('C0PUBLIC');
      expect(new URL(reads[0]!.url).searchParams.get('ts')).toBe('1787746453.202809');
      expect(new URL(reads[0]!.url).searchParams.get('limit')).toBe('50');
      expect(recorded.planRecords).toEqual([
        {
          surface: 'slack',
          tool: 'conversations.replies',
          subject: 'thread',
          text: expect.stringContaining('are the three Q3 deals covered in the tracker?'),
        },
      ]);
      const events = await groundingEvents(harness);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        workItemId,
        action: { tool: 'http.request', args: { method: 'GET', surface: 'slack' } },
        applied: { ok: true, authority: 'standing', tool: 'http.request' },
      });
      expect(JSON.stringify(events[0]!.payload)).not.toContain('plain-cred-slack');
      expect((await readItem(harness, workItemId)).state).toBe('plan-pending');
    });

    it('reads nothing for a chat ask whose surface documents no thread tool, and says so in no record', async (): Promise<void> => {
      useSurfaceMode('real');
      const harness = convexTest(contractSchema(), allConvexModules());
      const { workItemId } = await seed(harness, 'real');
      await asMention(harness, workItemId);
      await expect(
        harness.withIdentity(OWNER).action(api.workActions.draftPlan, { workItemId }),
      ).resolves.toEqual({ ok: true });
      expect(recorded.http.filter((call) => call.method === 'GET')).toEqual([]);
      expect(recorded.planRecords).toEqual([undefined]);
      expect(await groundingEvents(harness)).toHaveLength(0);
    });

    it('reads nothing for an inbox candidate', async (): Promise<void> => {
      useSurfaceMode('real');
      const harness = convexTest(contractSchema(), allConvexModules());
      const { workItemId } = await seed(harness, 'real');
      await toClaimed(harness, workItemId, {
        sourceCategory: 'inbox',
        sourceSystem: 'slack',
        externalId: 'C0PUBLIC:1787.0001',
      });
      await expect(
        harness.withIdentity(OWNER).action(api.workActions.draftPlan, { workItemId }),
      ).resolves.toEqual({ ok: true });
      expect(recorded.mcp).toHaveLength(0);
      expect(recorded.planRecords).toEqual([undefined]);
      expect(await groundingEvents(harness)).toHaveLength(0);
    });

    it('still drafts the plan when the read fails, with the reason in the record section', async (): Promise<void> => {
      useSurfaceMode('real');
      recorded.failedMcpTool = 'get_issue';
      const harness = convexTest(contractSchema(), allConvexModules());
      const { workItemId } = await seed(harness, 'real');
      await toClaimed(harness, workItemId);
      await expect(
        harness.withIdentity(OWNER).action(api.workActions.draftPlan, { workItemId }),
      ).resolves.toEqual({ ok: true });
      expect(recorded.mcp.map((call) => call.tool)).toEqual(['get_issue']);
      expect(recorded.planRecords).toEqual([
        { surface: 'linear', tool: 'get_issue', subject: 'record', unavailable: 'get_issue failed: snapshot timed out' },
      ]);
      const events = await groundingEvents(harness);
      expect(events[0]!.payload).toMatchObject({ applied: { ok: false } });
      expect((await readItem(harness, workItemId)).state).toBe('plan-pending');
    });

    it('reports an ungranted read as unavailable without calling the provider', async (): Promise<void> => {
      useSurfaceMode('real');
      const harness = convexTest(contractSchema(), allConvexModules());
      const { workItemId } = await seed(harness, 'real', ['boss:message', 'linear:write', 'slack:read']);
      await toClaimed(harness, workItemId);
      await expect(
        harness.withIdentity(OWNER).action(api.workActions.draftPlan, { workItemId }),
      ).resolves.toEqual({ ok: true });
      expect(recorded.mcp).toHaveLength(0);
      expect(recorded.planRecords).toEqual([
        { surface: 'linear', tool: 'get_issue', subject: 'record', unavailable: 'no grant (linear:read)' },
      ]);
    });
  });

  it('hands the manager\'s answers at approval to the executor as approved evidence, and nothing when there were none', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        managerAnswers: [
          { question: 'Who owns the Looker pipeline tile.', answer: 'Priya owns it.', answeredAt: 2 },
          { question: 'Which figure if the deck and the sheet disagree?', answer: 'Use the sheet figure.', answeredAt: 2 },
        ],
      });
    });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    // The auto phase is applied here so the scheduled apply finds nothing to claim.
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    expect(recorded.skillAnswers).toEqual([
      [
        { question: 'Who owns the Looker pipeline tile.', answer: 'Priya owns it.' },
        { question: 'Which figure if the deck and the sheet disagree?', answer: 'Use the sheet figure.' },
      ],
    ]);
    recorded.skillAnswers.length = 0;
    const plain = convexTest(contractSchema(), allConvexModules());
    const seeded = await seed(plain, 'real');
    await plain.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId: seeded.workItemId });
    await plain.action(internal.workActions.applyApprovedActions, { workItemId: seeded.workItemId });
    expect(recorded.skillAnswers).toEqual([undefined]);
  });

  it('hands live manager feedback to the run and keeps addressed feedback out of it', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        managerFeedback: { reason: 'REVOPS-7 is owned by Priya.', at: 2, kind: 'retry-note' },
      });
    });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    // Take the apply this run scheduled, so it does not run into a later test.
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    expect(recorded.skillFeedback).toEqual(['REVOPS-7 is owned by Priya.']);

    const { workItemId: finished } = await seed(harness, 'real');
    await harness.run(async (ctx) => {
      await ctx.db.patch(finished, {
        managerFeedback: {
          reason: 'Rewrite this as a close summary.',
          at: 2,
          kind: 'rejection',
          addressedAt: 3,
        },
      });
    });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId: finished });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId: finished });
    expect(recorded.skillFeedback).toEqual(['REVOPS-7 is owned by Priya.', undefined]);
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
        method: 'POST',
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

  describe('a held write repaired once before the hold', (): void => {
    const WRONG = JSON.stringify({ issueId: 'iss-1', comment: 'Prepared the close summary.' });
    const RIGHT = JSON.stringify({ issueId: 'iss-1', body: 'Prepared the close summary.' });
    const wrongKeyOutput: ExecutionOutput = {
      ...skillOutput,
      actions: [
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_comment', toolArgsJson: WRONG } },
        skillOutput.actions[1],
        skillOutput.actions[2],
      ],
    };
    const probeSaveComment = async (harness: Harness): Promise<void> => {
      await harness.run(async (ctx) => {
        const linear = (await ctx.db.query('surfaces').collect()).find((row) => row.slug === 'linear');
        if (!linear) throw new Error('linear surface missing');
        await ctx.db.patch(linear._id, {
          toolArguments: [{ tool: 'save_comment', arguments: ['issueId', 'body'] }],
        });
      });
    };

    it('holds a save_comment with a wrong key as its corrected payload, applies nothing in the repair, and shows the attempt in the ledger', async (): Promise<void> => {
      useSurfaceMode('real');
      recorded.skillOutput = wrongKeyOutput;
      recorded.repairedToolArgsJson = RIGHT;
      const harness = convexTest(contractSchema(), allConvexModules());
      const { workItemId } = await seed(harness, 'real');
      await probeSaveComment(harness);
      const result = await harness
        .withIdentity(OWNER)
        .action(api.workActions.executeApprovedPlan, { workItemId });
      expect(result).toEqual({ ok: true, reason: 'automatic actions applying', additionalModelCalls: 1 });
      expect(recorded.repairRequests).toEqual([
        { tool: 'save_comment', reason: expect.stringContaining('unknown argument comment for save_comment on linear') },
      ]);
      // The repair re-authored the payload; nothing reached Linear.
      expect(recorded.mcp).toHaveLength(0);
      await harness.action(internal.workActions.applyApprovedActions, { workItemId });
      const pending = await readItem(harness, workItemId);
      expect(pending.state).toBe('actions-pending');
      const held = pending.output as ExecutionOutput;
      expect(held.actions[0]!.args.toolArgsJson).toBe(RIGHT);
      expect(held.argumentRepairs).toEqual([
        {
          index: 0,
          reason: expect.stringContaining('the schema accepts issueId, body'),
          toolArgsJson: WRONG,
          repaired: true,
        },
      ]);
      expect(pending.actionVerdicts![0]).toEqual({ disposition: 'held', reason: HELD_MUTATION });
      expect(recorded.mcp).toHaveLength(0);
      const runId = pending.pendingRunId;
      if (!runId) throw new Error('pending run missing');
      await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [0, 1],
      });
      await expect(
        harness.action(internal.workActions.applyApprovedActions, { workItemId }),
      ).resolves.toEqual({ ok: true });
      const row = await readItem(harness, workItemId);
      expect(row.state).toBe('completed');
      expect(recorded.mcp.map((call) => call.tool)).toEqual(['save_comment', 'save_issue']);
      expect(recorded.mcp[0]!.args).toMatchObject({
        issueId: 'iss-1',
        body: expect.stringContaining('Prepared the close summary.'),
      });
      expect(recorded.mcp[0]!.args).not.toHaveProperty('comment');
      expect(ledger(row)[0]).toMatchObject({
        ok: true,
        authority: 'manager',
        repair: { reason: expect.stringContaining('unknown argument comment'), toolArgsJson: WRONG },
      });
      expect(ledger(row)[1]!.repair).toBeUndefined();
      expect(ledger(row)[2]!.repair).toBeUndefined();
    });

    it('holds the first attempt and records that the repair failed when the model produces nothing usable', async (): Promise<void> => {
      useSurfaceMode('real');
      recorded.skillOutput = wrongKeyOutput;
      recorded.repairedToolArgsJson = undefined;
      const harness = convexTest(contractSchema(), allConvexModules());
      const { workItemId } = await seed(harness, 'real');
      await probeSaveComment(harness);
      await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
      await harness.action(internal.workActions.applyApprovedActions, { workItemId });
      const pending = await readItem(harness, workItemId);
      expect(recorded.repairRequests).toHaveLength(1);
      const held = pending.output as ExecutionOutput;
      expect(held.actions[0]!.args.toolArgsJson).toBe(WRONG);
      expect(held.argumentRepairs).toEqual([
        { index: 0, reason: expect.stringContaining('unknown argument comment'), toolArgsJson: WRONG, repaired: false },
      ]);
    });

    it('makes no attempt when the write matches its probed names or the tool was never probed', async (): Promise<void> => {
      useSurfaceMode('real');
      const harness = convexTest(contractSchema(), allConvexModules());
      const { workItemId } = await seed(harness, 'real');
      await probeSaveComment(harness);
      const result = await harness
        .withIdentity(OWNER)
        .action(api.workActions.executeApprovedPlan, { workItemId });
      expect(result).toEqual({ ok: true, reason: 'automatic actions applying' });
      expect(recorded.repairRequests).toEqual([]);
      await harness.action(internal.workActions.applyApprovedActions, { workItemId });
      expect((await readItem(harness, workItemId)).output).not.toHaveProperty('argumentRepairs');
    });
  });

  it('repairs a read the provider refused for its arguments once, under standing authority', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      ...skillOutput,
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'get_issue',
            toolArgsJson: JSON.stringify({ issueId: 'iss-1' }),
          },
        },
        skillOutput.actions[2],
      ],
    };
    recorded.repairedToolArgsJson = JSON.stringify({ id: 'iss-1' });
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toEqual({ ok: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    expect(recorded.repairRequests).toEqual([
      { tool: 'get_issue', reason: 'Tool input validation failed: unknown argument issueId' },
    ]);
    expect(recorded.mcp.map((call) => [call.tool, call.args])).toEqual([
      ['get_issue', { issueId: 'iss-1' }],
      ['get_issue', { id: 'iss-1' }],
    ]);
    expect(ledger(row)[0]).toMatchObject({
      ok: true,
      authority: 'standing',
      repair: {
        reason: 'Tool input validation failed: unknown argument issueId',
        toolArgsJson: '{"issueId":"iss-1"}',
      },
    });
    expect((row.output as { actions: Array<{ args: { toolArgsJson?: string } }> }).actions[0].args.toolArgsJson).toBe(
      '{"id":"iss-1"}',
    );
    expect(ledger(row)[1]).toMatchObject({ ok: true, authority: 'standing' });
    expect(ledger(row)[1].held).toBeUndefined();
  });

  it('keeps the refused read as a failed row when the repair produces nothing', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      ...skillOutput,
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'get_issue',
            toolArgsJson: JSON.stringify({ issueId: 'iss-1' }),
          },
        },
        skillOutput.actions[2],
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await expect(
      harness.action(internal.workActions.applyApprovedActions, { workItemId }),
    ).resolves.toMatchObject({ ok: false });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(row.skipReason).toContain('Tool input validation failed: unknown argument issueId');
    expect(recorded.repairRequests).toHaveLength(1);
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['get_issue']);
    expect(ledger(row)[0]).toMatchObject({ ok: false });
    expect(ledger(row)[0].repair).toBeUndefined();
  });

  // Red until the read repair passes the run's earlier rows: today the
  // repaired snapshot is applied by a call of its own, in a new browser that
  // never signed in, and reads about:blank.
  it.fails('reads the signed-in page when it repairs a browser snapshot the driver refused', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    const refuseFullPage = (call: TileDriverCall): string | undefined =>
      call.tool === 'browser_snapshot' && 'fullPage' in call.args
        ? 'Tool input validation failed: unknown argument fullPage'
        : undefined;
    recorded.tileDriver = new TileDriver('plain-cred-looker', refuseFullPage);
    recorded.skillOutput = {
      draft: 'Signing in to the tile and reading the figure.',
      notes: '',
      actions: [
        ...slackPhaseOne.slice(0, 3),
        {
          tool: 'mcp.call',
          args: { surface: 'looker', tool: 'browser_snapshot', toolArgsJson: '{"fullPage":true}' },
        },
      ],
    };
    recorded.repairedToolArgsJson = '{}';
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(
      harness,
      'real',
      ['boss:message', 'linear:read', 'linear:write', 'slack:read', 'slack:write', 'looker:read', 'looker:write'],
      { autonomousActions: true },
    );
    await harness.run(async (ctx) => {
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker',
        displayName: 'Looker',
        class: 'analytics',
        verdict: 'connected',
        endpoint: 'http://looker-tile:8080/',
        path: 'browser-driven',
        toolAllowlist: ['browser_navigate', 'browser_fill_form', 'browser_click', 'browser_snapshot'],
        credentialId: 'cred-looker',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      } as never);
    });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId });
    const row = await readItem(harness, workItemId);
    expect(recorded.repairRequests).toEqual([
      { tool: 'browser_snapshot', reason: 'Tool input validation failed: unknown argument fullPage' },
    ]);
    expect(ledger(row)[3]).toMatchObject({
      ok: true,
      effect: 'browser_snapshot on looker · visible figure 68%',
      repair: { toolArgsJson: '{"fullPage":true}' },
    });
    expect(JSON.stringify(row.output)).not.toContain('about:blank');
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

  it.each([undefined, 'not a valid URL'])('preserves intentionally repeated append-row effects with redactor setting %s', async (redactorUrl): Promise<void> => {
    useSurfaceMode('mock');
    if (redactorUrl) vi.stubEnv('DAY0_REDACTOR_URL', redactorUrl);
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
describe('a registered skill serves every later work item of its shape', (): void => {
  beforeEach((): void => {
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
  });

  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  async function seedShapedSkills(
    harness: Harness,
    agentId: Id<'agents'>,
    seededItem: Id<'workItems'>,
  ): Promise<void> {
    await harness.run(async (ctx): Promise<void> => {
      // The seeded item holds the one supervised slot, and the seeded legacy
      // row would match any Linear item by its name alone; the registry here
      // is shaped skills only, evaluated against an empty queue.
      await ctx.db.patch(seededItem, { state: 'completed' });
      for (const legacy of await ctx.db.query('skills').collect()) {
        await ctx.db.patch(legacy._id, { state: 'rejected' });
      }
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker-pipeline-tile',
        displayName: 'Looker pipeline tile',
        class: 'analytics',
        verdict: 'connected',
        endpoint: 'http://looker-tile:8080/',
        path: 'browser-driven',
        toolAllowlist: ['browser_navigate', 'browser_fill_form', 'browser_click', 'browser_snapshot'],
        credentialId: 'cred-looker',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      } as never);
      for (const [scope] of [['looker-pipeline-tile:read'], ['looker-pipeline-tile:write']]) {
        await ctx.db.insert('permissionGrants', { agentId, scope: scope!, createdAt: 1 });
      }
      for (const skill of [
        {
          name: 'analytics-refresh-value',
          description: 'Value refresh on an analytics surface, parameterised from each work item and its runbook.',
          targetSurface: 'looker-pipeline-tile',
          surfaceClass: 'analytics',
          operation: 'refresh-value',
          requiredScopes: ['boss:message', 'linear:read', 'looker-pipeline-tile:read', 'looker-pipeline-tile:write'],
        },
        {
          name: 'chat-thread-reply',
          description: 'Threaded reply on a chat surface, parameterised from each work item and its runbook.',
          targetSurface: 'slack',
          surfaceClass: 'chat',
          operation: 'thread-reply',
          requiredScopes: ['boss:message', 'slack:read', 'slack:write'],
        },
      ]) {
        await ctx.db.insert('skills', {
          agentId,
          ...skill,
          body: '# Procedure\n## Inputs\n- <record-id>\n',
          sourceType: 'agent-authored',
          state: 'registered',
          createdAt: 1,
          registeredAt: 1,
        });
      }
    });
  }

  async function discoveredItem(
    harness: Harness,
    agentId: Id<'agents'>,
    item: Partial<Doc<'workItems'>> & Pick<Doc<'workItems'>, 'sourceSystem' | 'externalId' | 'title' | 'contentSummary'>,
  ): Promise<Id<'workItems'>> {
    return await harness.run(
      async (ctx): Promise<Id<'workItems'>> =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          contentRefs: [],
          priority: 'P1',
          requesterLabel: 'Manager',
          state: 'discovered',
          observedAt: Date.now(),
          createdAt: Date.now(),
          ...item,
        }),
    );
  }

  async function proposedSkills(harness: Harness): Promise<string[]> {
    return (await harness.run(async (ctx) => await ctx.db.query('skills').collect()))
      .filter((skill) => skill.state === 'proposed')
      .map((skill) => skill.name);
  }

  it('claims a second tile refresh with a different figure and ticket without a proposal', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId: seededItem } = await seed(harness, 'real');
    await seedShapedSkills(harness, agentId, seededItem);
    const workItemId = await discoveredItem(harness, agentId, {
      sourceSystem: 'linear',
      externalId: 'REVOPS-11',
      title: 'Refresh the Looker pipeline tile',
      contentSummary: 'Set the pipeline coverage figure to 68% and record the audit line on REVOPS-11.',
      contentRefs: ['ticket://REVOPS-11'],
    });

    await harness.withIdentity(OWNER).action(api.workActions.evaluateWorkItem, { workItemId });
    const row = await readItem(harness, workItemId);
    expect(row.verdict).toMatchObject({ decision: 'claim' });
    expect(row.state).toBe('claimed');
    expect(await proposedSkills(harness)).toEqual([]);
  });

  it('claims a chat ask in a different thread through the chat skill', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId: seededItem } = await seed(harness, 'real');
    await seedShapedSkills(harness, agentId, seededItem);
    const workItemId = await discoveredItem(harness, agentId, {
      sourceCategory: 'event-stream',
      sourceSystem: 'slack',
      externalId: 'C0BSF04TZ19:1789000500.000200',
      title: 'Mention in #revops-asks',
      contentSummary: 'Which coverage figure are we quoting in the Friday standup this week?',
      replyTarget: { channel: 'C0BSF04TZ19', threadTs: '1789000500.000200' },
    });

    await expect(
      harness.withIdentity(OWNER).action(api.workActions.evaluateWorkItem, { workItemId }),
    ).resolves.toEqual({ decision: 'claim' });
    expect(await proposedSkills(harness)).toEqual([]);
  });

  it('still proposes a skill for a shape nothing registered covers', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId: seededItem } = await seed(harness, 'real');
    await seedShapedSkills(harness, agentId, seededItem);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'close-tracker',
        displayName: 'Close tracker',
        class: 'spreadsheet',
        verdict: 'connected',
        endpoint: 'https://sheets.example.test/close-tracker',
        path: 'documented-api',
        toolAllowlist: [],
        credentialId: 'cred-sheet',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      } as never);
    });
    const workItemId = await discoveredItem(harness, agentId, {
      sourceSystem: 'linear',
      externalId: 'REVOPS-12',
      title: 'Append this week to the Close tracker',
      contentSummary: 'Add the week 37 close figures as a new row in the Close tracker.',
      contentRefs: ['ticket://REVOPS-12'],
    });

    await expect(
      harness.withIdentity(OWNER).action(api.workActions.evaluateWorkItem, { workItemId }),
    ).resolves.toEqual({ decision: 'needs-skill' });
    expect(await proposedSkills(harness)).toEqual(['spreadsheet-append-row']);
    const proposed = (await harness.run(async (ctx) => await ctx.db.query('skills').collect())).find(
      (skill) => skill.name === 'spreadsheet-append-row',
    );
    expect(proposed).toMatchObject({
      surfaceClass: 'spreadsheet',
      operation: 'append-row',
      targetSurface: 'close-tracker',
      description: 'Row append on a spreadsheet surface, parameterised from each work item and its runbook.',
    });
    expect(proposed?.rationale).not.toContain('REVOPS-12');
    expect(proposed?.rationale).not.toContain('Charter');
  });
});

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

  it('admits a real-mode item on the lexical inputs and records it when the charter judgement is unavailable', async (): Promise<void> => {
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

    await expect(
      harness.withIdentity(OWNER).action(api.workActions.evaluateWorkItem, { workItemId }),
    ).resolves.toEqual({ decision: 'claim' });
    const unavailable = (
      await harness.run(
        async (ctx) =>
          await ctx.db.query('events').withIndex('by_agent', (q) => q.eq('agentId', agentId)).collect(),
      )
    ).filter((event) => event.type === 'work.scope-judgement-unavailable');
    expect(unavailable.map((event) => event.payload)).toEqual([
      { workItemId, cause: 'model unavailable in tests' },
    ]);
  });

  it('re-evaluates an out-of-scope skip the manager retried without the eligibility rule and records the decision', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'mock');
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        state: 'discovered',
        plan: undefined,
        title: 'Book the offsite venue',
        contentSummary: 'Reserve the venue and confirm the catering headcount.',
      });
    });
    const events = async (type: string): Promise<unknown[]> =>
      (
        await harness.run(
          async (ctx) =>
            await ctx.db.query('events').withIndex('by_agent', (q) => q.eq('agentId', agentId)).collect(),
        )
      )
        .filter((event) => event.type === type)
        .map((event) => event.payload);

    await expect(
      harness.withIdentity(OWNER).action(api.workActions.evaluateWorkItem, { workItemId }),
    ).resolves.toEqual({ decision: 'skip' });
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'skipped',
      verdict: { decision: 'skip', reason: 'out-of-scope: no charter or current documented-system overlap' },
    });

    await expect(
      harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId }),
    ).resolves.toEqual({ ok: true, resumeState: 'discovered' });
    expect(await events('work.retry')).toEqual([
      { workItemId, resumeState: 'discovered', fromState: 'skipped', waived: 'scope' },
    ]);

    await expect(
      harness.withIdentity(OWNER).action(api.workActions.evaluateWorkItem, { workItemId }),
    ).resolves.toEqual({ decision: 'claim' });
    const retried = await readItem(harness, workItemId);
    expect(retried.state).toBe('claimed');
    expect(typeof retried.scopeWaivedAt).toBe('number');
    expect(retried.qualityFitWaivedAt).toBeUndefined();
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
  const surfaces = [
    { slug: 'linear', displayName: 'Linear' },
    { slug: 'slack', displayName: 'Slack' },
    { slug: 'looker-pipeline-tile', displayName: 'Looker pipeline tile' },
  ];
  const getIssue = { tool: 'mcp.call' as const, args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-7"}' } };
  const landedRead: AppliedAction = { tool: 'mcp.call', ok: true, effect: 'read issue', idempotencyKey: 'read' };

  it('enforces a declared read whatever the step says, and never reads the step', (): void => {
    const step =
      'Hold all non-read writes, including any #revops-asks reply or Linear audit/status update, until the manager gives literal approval because autonomous actions are OFF.';
    const plan = (declared?: PlanObligations) => ({
      summary: 'Hold writes.', steps: [step], expectedOutputType: 'message' as const, riskNotes: '', reversibility: '', estimatedMinutes: 1,
      ...(declared ? { obligations: declared } : {}),
    });
    const outcomes = [{ step: 1, status: 'satisfied' as const, evidence: 'Every write was held.' }];
    expect(() => validatePlanStepOutcomes({ plan: plan(), outcomes, initialActions: [], initialLedger: [], surfaces })).not.toThrow();
    expect(() => validatePlanStepOutcomes({ plan: plan(obligations([{ kind: 'report' }])), outcomes, initialActions: [], initialLedger: [], surfaces })).not.toThrow();
    expect(() =>
      validatePlanStepOutcomes({ plan: plan(obligations([{ kind: 'read', reads: ['linear'] }])), outcomes, initialActions: [], initialLedger: [], surfaces }),
    ).toThrow('approved plan step 1 declares a read of Linear, but no landed Linear read or blocking ledger reason was recorded');
    // The landed read satisfies the declaration; a blocked step with a reason accounts for its absence.
    expect(() =>
      validatePlanStepOutcomes({ plan: plan(obligations([{ kind: 'read', reads: ['linear'] }])), outcomes, initialActions: [getIssue], initialLedger: [landedRead], surfaces }),
    ).not.toThrow();
    expect(() =>
      validatePlanStepOutcomes({
        plan: plan(obligations([{ kind: 'read', reads: ['linear'] }])),
        outcomes: [{ step: 1, status: 'blocked', evidence: 'Linear refused the read.' }], initialActions: [], initialLedger: [], surfaces,
      }),
    ).not.toThrow();
  });

  it('enforces a declared transition whatever the step says', (): void => {
    const plan = (step: string, transition: PlanObligations['transition']) => ({
      summary: 'Complete the ticket.', steps: [step], expectedOutputType: 'ticket-update' as const, riskNotes: '', reversibility: '', estimatedMinutes: 1,
      obligations: obligations([{ kind: 'write', writes: ['linear'] }], transition, transition === 'none' ? null : 1),
    });
    const outcomes: PlanStepOutcome[] = [{ step: 1, status: 'satisfied', evidence: 'No transition landed.' }];
    for (const step of ['Move the ticket to "Done".', 'Do not close or update the ticket; post only the audit comment.']) {
      expect(dependentTransitionRefusal({ plan: plan(step, 'promised'), actions: [], planStepOutcomes: outcomes }), step).toContain('omitted the approved ticket state transition');
      expect(dependentTransitionRefusal({ plan: plan(step, 'conditional-on-manager'), actions: [], planStepOutcomes: outcomes }), step).toContain('omitted the approved ticket state transition');
      expect(dependentTransitionRefusal({ plan: plan(step, 'withheld'), actions: [], planStepOutcomes: outcomes }), step).toBeUndefined();
      expect(dependentTransitionRefusal({ plan: plan(step, 'none'), actions: [], planStepOutcomes: outcomes }), step).toBeUndefined();
    }
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
      obligations: obligations([{ kind: 'read', reads: ['linear'] }, { kind: 'write', writes: ['linear'] }]),
    };
    expect(blockedPlanReason(outcomes, { plan, actions: [comment], applied: [landed] })).toBeUndefined();
    expect(blockedPlanReason(outcomes)).toContain('1 approved plan step(s) remained blocked');
    expect(blockedPlanReason(outcomes, { plan, actions: [], applied: [] })).toContain(
      '1 approved plan step(s) remained blocked',
    );
    expect(
      blockedPlanReason(outcomes, { plan, actions: [comment], applied: [{ ...landed, held: true }] }),
    ).toContain('remained blocked');
    const closing = {
      ...plan,
      steps: ['Post the audit comment', 'Move the ticket to Done'],
      obligations: obligations([{ kind: 'write', writes: ['linear'] }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
    };
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
      obligations: obligations([{ kind: 'write', writes: ['linear'] }, { kind: 'write', writes: ['linear'] }], 'promised', 2),
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

  it('never fails a landed comment for a transition the plan withholds or does not declare, whatever the step says', (): void => {
    const landed: AppliedAction = {
      tool: 'mcp.call',
      ok: true,
      effect: 'comment landed',
      idempotencyKey: 'item:run:0',
    };
    const cases: Array<[string, PlanObligations | undefined]> = [
      ['Comment on the “Close the books review” ticket with the figures read from the tracker.', obligations([{ kind: 'write', writes: ['linear'] }])],
      ['Do not close or update the ticket; post only the audit comment.', obligations([{ kind: 'write', writes: ['linear'] }], 'withheld', 1)],
      ['Close the ticket after the comment.', undefined],
    ];
    for (const [step, declared] of cases) {
      const plan = {
        summary: 'Add context to the ticket.',
        steps: [step],
        expectedOutputType: 'ticket-update' as const,
        riskNotes: '',
        reversibility: '',
        estimatedMinutes: 1,
        ...(declared ? { obligations: declared } : {}),
      };
      expect(
        blockedPlanReason(
          [{ step: 1, status: 'blocked', evidence: 'No transition was planned or emitted.' }],
          { plan, actions: [skillOutput.actions[0]], applied: [landed] },
        ),
        step,
      ).toBeUndefined();
    }
  });
});

describe('the closing gates against the 16 September plans', (): void => {
  const surfaces = [
    { slug: 'linear', displayName: 'Linear' },
    { slug: 'slack', displayName: 'Slack' },
    { slug: 'looker-pipeline-tile', displayName: 'Looker pipeline tile' },
  ];

  it('honours a plan whose declared transition is withheld, whatever another step says', (): void => {
    const plan = {
      summary: 'Run the checks and record the note.',
      steps: [
        'Complete the three checks in checklist order and quote the evidence.',
        'Add an audit comment on REVOPS-5 via linear save_comment with the three checks.',
        REVOPS_5_STEP_5,
      ],
      expectedOutputType: 'ticket-update' as const,
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 1,
      obligations: obligations([{ kind: 'report' }, { kind: 'write', writes: ['linear'] }, { kind: 'report' }], 'withheld', 3),
    };
    const satisfied: PlanStepOutcome[] = [
      { step: 1, status: 'satisfied', evidence: 'the three checks in the comment' },
      { step: 2, status: 'satisfied', evidence: 'the audit comment in this response' },
      { step: 3, status: 'satisfied', evidence: 'no status change emitted, as the plan says' },
    ];
    expect(
      dependentTransitionRefusal({ plan, actions: auditNoteClosing.actions, planStepOutcomes: satisfied }),
    ).toBeUndefined();
    // A withheld transition is not a missing one when a step stays blocked either.
    expect(
      blockedPlanReason([{ ...satisfied[0]!, status: 'blocked', evidence: 'check 2 had no source' }, satisfied[1]!, satisfied[2]!], {
        plan,
        actions: auditNoteClosing.actions,
        applied: [{ tool: 'mcp.call', ok: true, effect: 'comment-16', idempotencyKey: 'run:0' }],
      }),
    ).toBeUndefined();
    // With the transition declared as promised the same closing set is refused.
    expect(
      dependentTransitionRefusal({
        plan: { ...plan, obligations: obligations([{ kind: 'report' }, { kind: 'write', writes: ['linear'] }, { kind: 'write', writes: ['linear'] }], 'promised', 3) },
        actions: auditNoteClosing.actions,
        planStepOutcomes: satisfied,
      }),
    ).toContain('omitted the approved ticket state transition');
  });

  it('accepts the run 3 REVOPS-7 closing set: step 3 declares Linear as a write target and the tile read landed', (): void => {
    expect(() =>
      validatePlanStepOutcomes({
        plan: run3RefreshPlan,
        outcomes: run3RefreshOutcomes,
        initialActions: run3RefreshPrerequisites,
        initialLedger: run3RefreshPrerequisiteLedger,
        surfaces,
      }),
    ).not.toThrow();
    expect(
      dependentTransitionRefusal({
        plan: run3RefreshPlan,
        actions: run3RefreshClosing.actions,
        planStepOutcomes: run3RefreshOutcomes,
      }),
    ).toBeUndefined();
    // With no tile action landed, the tile read step 1 declares is what is missing, named by its step and its surface.
    expect(() =>
      validatePlanStepOutcomes({
        plan: run3RefreshPlan,
        outcomes: run3RefreshOutcomes,
        initialActions: [],
        initialLedger: [],
        surfaces,
      }),
    ).toThrow(
      'approved plan step 1 declares a read of Looker pipeline tile, but no landed Looker pipeline tile read or blocking ledger reason was recorded',
    );
  });

  it('still refuses the run 2 REVOPS-5 closing set when the Linear read step 2 declares did not land', (): void => {
    const withoutLinear = auditNotePrerequisites.flatMap((action, index) =>
      action.args.surface === 'linear' ? [] : [{ action, entry: auditNotePrerequisiteLedger[index]! }],
    );
    expect(() =>
      validatePlanStepOutcomes({
        plan: auditNotePlan,
        outcomes: auditNoteOutcomes,
        initialActions: withoutLinear.map((row) => row.action),
        initialLedger: withoutLinear.map((row) => row.entry),
        surfaces,
      }),
    ).toThrow('approved plan step 2 declares a read of Linear, but no landed Linear read or blocking ledger reason was recorded');
  });

  it('owes no read of an absent surface, and nothing from a plan with no declared obligations', (): void => {
    const outcomes: PlanStepOutcome[] = [{ step: 1, status: 'satisfied', evidence: 'in this response' }];
    const plan = (declared?: PlanObligations) => ({
      summary: 'Reconcile the deals.', steps: ['Read the three deals in Northstar CRM and comment on REVOPS-6.'],
      expectedOutputType: 'ticket-update' as const, riskNotes: '', reversibility: '', estimatedMinutes: 1,
      ...(declared ? { obligations: declared } : {}),
    });
    // The judgement never lists an absent surface; a persisted declaration that does is ignored by the gate, which holds connected surfaces only.
    expect(() =>
      validatePlanStepOutcomes({ plan: plan(obligations([{ kind: 'read', reads: ['northstar-crm'], writes: ['linear'] }])), outcomes, initialActions: [], initialLedger: [], surfaces }),
    ).not.toThrow();
    expect(() =>
      validatePlanStepOutcomes({ plan: plan(), outcomes, initialActions: [], initialLedger: [], surfaces }),
    ).not.toThrow();
    expect(dependentTransitionRefusal({ plan: plan(), actions: [], planStepOutcomes: outcomes })).toBeUndefined();
    expect(blockedPlanReason([{ step: 1, status: 'blocked', evidence: 'nothing landed' }], {
      plan: plan(), actions: [skillOutput.actions[0]], applied: [{ tool: 'mcp.call', ok: true, effect: 'comment', idempotencyKey: 'run:0' }],
    })).toBeUndefined();
  });

  it('accepts the run 2 REVOPS-7 closing set: step 3 declares Linear as a write, the snapshot read the tile', (): void => {
    expect(() =>
      validatePlanStepOutcomes({
        plan: refreshPlan,
        outcomes: refreshOutcomes,
        initialActions: refreshPrerequisites,
        initialLedger: refreshPrerequisiteLedger,
        surfaces,
      }),
    ).not.toThrow();
    expect(
      dependentTransitionRefusal({
        plan: refreshPlan,
        actions: refreshClosing.actions,
        planStepOutcomes: refreshOutcomes,
      }),
    ).toBeUndefined();
  });

  it('accepts the run 2 REVOPS-5 closing set: both declared reads landed and the plan withholds Done', (): void => {
    expect(auditNoteObligations.transition).toBe('withheld');
    expect(() =>
      validatePlanStepOutcomes({
        plan: auditNotePlan,
        outcomes: auditNoteOutcomes,
        initialActions: auditNotePrerequisites,
        initialLedger: auditNotePrerequisiteLedger,
        surfaces,
      }),
    ).not.toThrow();
    expect(
      dependentTransitionRefusal({
        plan: auditNotePlan,
        actions: auditNoteClosing.actions,
        planStepOutcomes: auditNoteOutcomes,
      }),
    ).toBeUndefined();
    expect(
      closingStopReason({
        plan: auditNotePlan,
        outcomes: auditNoteOutcomes,
        initialActions: auditNotePrerequisites,
        initialApplied: auditNotePrerequisiteLedger,
        closingActions: auditNoteClosing.actions,
        surfaces: surfaces.map((surface) => ({
          ...surface,
          class: surface.slug === 'linear' ? 'kanban' : surface.slug === 'slack' ? 'chat' : 'analytics',
          verdict: 'connected',
          credentialLanded: true,
          lastVerifiedAt: 1,
          path: surface.slug === 'looker-pipeline-tile' ? 'browser-driven' : surface.slug === 'slack' ? 'documented-api' : 'mcp',
          endpoint: 'https://example.test/',
          toolAllowlist: [],
        })),
      }),
    ).toBeUndefined();
  });

  it('accepts the run 4 REVOPS-7 closing set: "Emit a save_comment on linear" declares no Linear read', (): void => {
    expect(() =>
      validatePlanStepOutcomes({
        plan: run4RefreshPlan,
        outcomes: run4RefreshOutcomes,
        initialActions: run4RefreshPrerequisites,
        initialLedger: run4RefreshPrerequisiteLedger,
        surfaces,
      }),
    ).not.toThrow();
    expect(
      dependentTransitionRefusal({ plan: run4RefreshPlan, actions: run4RefreshClosing.actions, planStepOutcomes: run4RefreshOutcomes }),
    ).toBeUndefined();
    // The transition is conditional on the evidence: a set that leaves the Done out with every step satisfied is still refused.
    expect(
      dependentTransitionRefusal({ plan: run4RefreshPlan, actions: run4RefreshClosing.actions.slice(0, 1), planStepOutcomes: run4RefreshOutcomes }),
    ).toContain('omitted the approved ticket state transition');
  });

  it('accepts the run 4 Slack closing set: Northstar CRM in the text of the message is no obligation', (): void => {
    const withNorthstar = [...surfaces, { slug: 'northstar-crm', displayName: 'Northstar CRM' }];
    expect(() =>
      validatePlanStepOutcomes({
        plan: run4SlackPlan,
        outcomes: run4SlackOutcomes,
        initialActions: run4SlackPrerequisites,
        initialLedger: run4SlackPrerequisiteLedger,
        surfaces: withNorthstar,
      }),
    ).not.toThrow();
    expect(
      dependentTransitionRefusal({ plan: run4SlackPlan, actions: run4SlackClosing.actions, planStepOutcomes: run4SlackOutcomes }),
    ).toBeUndefined();
  });

  it('accepts the run 4 REVOPS-5 closing set and demands the Done the plan conditions on the manager', (): void => {
    const prerequisites = [...run4TileSequence, { tool: 'mcp.call' as const, args: { surface: 'linear', tool: 'list_issues', toolArgsJson: '{"team":"REVOPS","project":"Q3 close"}' } }];
    const ledger: AppliedAction[] = prerequisites.map((action, index) => ({
      tool: action.tool, ok: true, idempotencyKey: `run-5d:${index}`,
      effect: index === 5 ? RUN_4_TILE_READ_BACK : index === 6 ? RUN_4_LIST_ISSUES_EFFECT : 'ok',
    }));
    expect(() =>
      validatePlanStepOutcomes({ plan: run4AuditNotePlan, outcomes: run4AuditNoteOutcomes, initialActions: prerequisites, initialLedger: ledger, surfaces }),
    ).not.toThrow();
    expect(
      dependentTransitionRefusal({ plan: run4AuditNotePlan, actions: run4AuditNoteClosing.actions, planStepOutcomes: run4AuditNoteOutcomes }),
    ).toBeUndefined();
    // Conditional on the manager: the Done must be in the set (the gate holds it) or the step blocked.
    expect(
      dependentTransitionRefusal({ plan: run4AuditNotePlan, actions: run4AuditNoteClosing.actions.slice(0, 1), planStepOutcomes: run4AuditNoteOutcomes }),
    ).toContain('omitted the approved ticket state transition');
    expect(
      dependentTransitionRefusal({
        plan: run4AuditNotePlan, actions: run4AuditNoteClosing.actions.slice(0, 1),
        planStepOutcomes: [...run4AuditNoteOutcomes.slice(0, 4), { step: 5, status: 'blocked', evidence: 'the manager has not decided' }],
      }),
    ).toBeUndefined();
  });
});
