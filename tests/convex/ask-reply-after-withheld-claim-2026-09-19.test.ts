/** @vitest-environment node */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { McpClientLike, McpClientOptions } from '../../src/surfaces/mcp';
import type { AppliedAction } from '../../src/surfaces/types';
import type { ExecutionPlan, MockAction, PlanStepOutcome } from '../../src/work/types';
import { TileDriver } from '../fixtures/browser-phase-split-2026-09-16';
import {
  OPS_REQUESTS_ASK_TITLE,
  REVOPS_ASKS_ASK,
  revopsAsksClosing,
  revopsAsksDraft,
  revopsAsksNotes,
  revopsAsksOutcomes,
  revopsAsksPhaseOne,
  revopsAsksPlan,
} from '../fixtures/work/full-run-4-2026-09-19-revops-asks';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * Finding W of the fourth full run (19 September): two asks of one employee,
 * one tile. The `#ops-requests` ask took the page-field claim while the
 * `#revops-asks` ask was between its phase one and its closing apply, so the
 * guard withheld the non-holder's fill and Save; its thread-reply step was
 * reported blocked, its DM said it had emitted the refresh, and the run
 * completed with no reply to the person who asked.
 *
 * The non-holder's plan, phase-one actions, closing set and plan-step
 * accounting are the run's own rows. The executor itself is real; only the
 * model behind it is scripted, so the prompts it was given can be read.
 */

const SLUG = 'looker-pipeline-tile';
const MANAGER_DM = 'D0BS5SXMXPZ';
const RUNBOOK = readFileSync(join(process.cwd(), 'bed/company/folder/revops/runbooks/how-to-refresh-the-tile.md'), 'utf8');

interface ClosingAnswer {
  draft: string;
  notes: string;
  actions: MockAction[];
  planStepOutcomes: PlanStepOutcome[];
}

/** A closing answer as the model returns it: the stored row keeps neither the basis of a ledger outcome nor an empty trail list. */
function closingAnswer(answer: ClosingAnswer): unknown {
  return {
    ...answer,
    procedureTrails: [],
    planStepOutcomes: answer.planStepOutcomes.map((outcome) => ({ basis: 'ledger', ...outcome })),
  };
}

const recorded = vi.hoisted(() => ({
  driver: undefined as undefined | import('../fixtures/browser-phase-split-2026-09-16').TileDriver,
  closingPrompts: [] as string[],
  closingAnswers: [] as unknown[],
  /** Runs while the closing model call is in flight, as the sibling's claim did on the day. */
  duringClosing: undefined as undefined | (() => Promise<void>),
  http: [] as Array<{ url: string; body: Record<string, unknown> }>,
}));

const tile = (tool: string, toolArgs: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call',
  args: { surface: SLUG, tool, toolArgsJson: JSON.stringify(toolArgs) },
});
const HOLDER_SEQUENCE: MockAction[] = [
  ...revopsAsksPhaseOne.slice(0, 3),
  tile('browser_fill_form', { fields: [{ name: 'Pipeline coverage', value: '74%' }] }),
  tile('browser_click', { element: 'Save' }),
  tile('browser_snapshot', {}),
];

vi.mock('../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async <T>(args: { agent: { name: string }; user: string; schema: { parse(value: unknown): unknown } }): Promise<T> => {
    const name = args.agent.name;
    if (name.endsWith('-dependent') && name.includes('c0c2u2ujutu')) {
      return args.schema.parse({
        draft: 'The tile was refreshed and read back in the same session.', notes: '', actions: [], procedureTrails: [],
        planStepOutcomes: [
          { step: 1, status: 'satisfied', basis: 'ledger', evidence: 'ledger rows 0 to 4: the documented sequence ran on the tile' },
          { step: 2, status: 'satisfied', basis: 'ledger', evidence: 'ledger row 5: the snapshot with the visible figure' },
        ],
      }) as T;
    }
    if (name.endsWith('-dependent')) {
      recorded.closingPrompts.push(args.user);
      const hook = recorded.duringClosing;
      recorded.duringClosing = undefined;
      await hook?.();
      const answer = recorded.closingAnswers.shift();
      if (!answer) throw new Error(`no scripted closing answer left for ${name}`);
      return args.schema.parse(answer) as T;
    }
    if (!name.endsWith('-initial')) throw new Error(`unscripted agent ${name}`);
    const holder = name.includes('c0c2u2ujutu');
    return args.schema.parse({
      draft: holder ? 'Signing in to the tile, entering 74%, saving and reading it back.' : 'Opening the tile and reading it before anything is written.',
      notes: '',
      needsDependentPhase: !holder,
      deferredActions: [],
      actions: holder ? HOLDER_SEQUENCE : revopsAsksPhaseOne,
      procedureTrails: [],
    }) as T;
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (_ctx: unknown, credentialId: string): Promise<string> => `plain-${credentialId}`,
}));

vi.mock('../../src/surfaces/mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/surfaces/mcp')>();
  return {
    ...original,
    createMastraMcpClient: (options: McpClientOptions): McpClientLike => {
      if (!recorded.driver) throw new Error('no driver double for this test');
      return recorded.driver.client(options.serverName);
    },
  };
});

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };

/** The run's closing answer: fill, Save, snapshot and the DM, with the thread reply reported blocked. */
const RUN_CLOSING = closingAnswer({
  draft: revopsAsksDraft,
  notes: revopsAsksNotes,
  actions: revopsAsksClosing,
  planStepOutcomes: revopsAsksOutcomes,
});

const holderPlan: ExecutionPlan = {
  summary: 'Refresh the Looker pipeline tile per the runbook and read it back.',
  steps: ['Run the documented sequence on looker-pipeline-tile in one browser session, entering 74%.', 'Read back the snapshot.'],
  expectedOutputType: 'message',
  riskNotes: '',
  reversibility: 'Re-enter the previous figure.',
  estimatedMinutes: 5,
  obligations: {
    steps: [
      { kind: 'write', reads: [], writes: [SLUG] },
      { kind: 'read', reads: [SLUG], writes: [] },
    ],
    transition: 'none',
    transitionStep: null,
    basis: 'judgement',
  },
};

interface Seeded { agentId: Id<'agents'>; ask: Id<'workItems'>; holder: Id<'workItems'> }

async function seed(harness: Harness): Promise<Seeded> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local', name: 'Priya', userId: 'owner', state: 'active', autonomousActions: true, createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId, version: 'v1', approved: true, approvedAt: 1, createdAt: 1,
      body: {
        proposedFunction: 'Own routine revenue operations work for the RevOps team.',
        proposedBoundaries: { willDo: ['Answer asks in #revops-asks and #ops-requests.', 'Keep the Looker pipeline tile at the approved figure.'], willNotDo: [], escalationTriggers: [] },
        approvalChain: { boss: 'boss@day0.local' },
      },
    });
    await ctx.db.insert('mockDocs', {
      agentId, slug: 'revops-runbooks-how-to-refresh-the-tile-md', title: 'How to refresh the Looker pipeline tile',
      category: 'how-to-guide', body: RUNBOOK, updatedAt: 1,
    } as never);
    await ctx.db.insert('skills', {
      agentId, name: 'chat-thread-reply', surfaceClass: 'chat', operation: 'thread-reply',
      description: 'Answer an ask in the thread it was made in, from what the connected surfaces show.',
      body: `# chat-thread-reply\nOn ${SLUG}: browser_navigate, browser_fill_form the login with {{secret}}, browser_click Sign in, browser_snapshot. Reply in the thread with chat.postMessage.`,
      requiredScopes: ['boss:message', 'slack:read', 'slack:write', `${SLUG}:read`, `${SLUG}:write`], targetSurface: 'slack',
      sourceType: 'agent-authored', state: 'registered', createdAt: 1, registeredAt: 1,
    } as never);
    for (const scope of ['boss:message', 'slack:read', 'slack:write', 'docs:read', `${SLUG}:read`, `${SLUG}:write`]) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    await ctx.db.insert('surfaces', {
      agentId, slug: SLUG, displayName: 'Looker pipeline tile', class: 'analytics', verdict: 'connected',
      endpoint: 'http://looker-tile:8080/', path: 'browser-driven',
      toolAllowlist: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form'],
      toolArguments: [
        { arguments: ['url'], tool: 'browser_navigate' },
        { arguments: ['boxes', 'depth', 'filename', 'target'], tool: 'browser_snapshot' },
        { arguments: ['button', 'doubleClick', 'element', 'modifiers', 'target'], tool: 'browser_click' },
        { arguments: ['element', 'slowly', 'submit', 'target', 'text'], tool: 'browser_type' },
        { arguments: ['fields'], tool: 'browser_fill_form' },
      ],
      credentialId: 'cred-looker', credentialKind: 'value', credentialLanded: true, lastVerifiedAt: Date.now(), whereFound: [], createdAt: 1,
      discoveryEvidence: [{ kind: 'documentation', ref: 'systems/looker-pipeline-tile.md', quote: 'The Looker pipeline tile holds the single pipeline coverage figure', current: true, firstSeenAt: 1, lastSeenAt: 1 }],
    } as never);
    await ctx.db.insert('surfaces', {
      agentId, slug: 'slack', displayName: 'Slack', class: 'chat', verdict: 'connected',
      endpoint: 'https://slack.com/api/', path: 'documented-api', toolAllowlist: ['chat.postMessage'],
      credentialId: 'cred-slack', credentialKind: 'value', credentialLanded: true, lastVerifiedAt: Date.now(), whereFound: [], createdAt: 1,
      managerDmChannelId: MANAGER_DM, managerUserId: 'U0MANAGER',
    } as never);
    const item = async (fields: Record<string, unknown>): Promise<Id<'workItems'>> =>
      await ctx.db.insert('workItems', {
        agentId, contentRefs: [], state: 'plan-approved', observedAt: 1, createdAt: 1,
        sourceCategory: 'event-stream', sourceSystem: 'slack',
        verdict: { decision: 'claim', value: 60, risk: 40, requiredPermissions: ['boss:message', 'slack:read'] },
        ...fields,
      } as never);
    const ask = await item({
      externalId: REVOPS_ASKS_ASK.externalId, externalClaimKey: REVOPS_ASKS_ASK.externalClaimKey, title: REVOPS_ASKS_ASK.title,
      contentSummary: REVOPS_ASKS_ASK.contentSummary, contentRefs: [...REVOPS_ASKS_ASK.contentRefs],
      replyTarget: { ...REVOPS_ASKS_ASK.replyTarget }, requester: REVOPS_ASKS_ASK.requester, plan: revopsAsksPlan,
    });
    const holder = await item({
      externalId: 'C0C2U2UJUTU:1789761553.312049', externalClaimKey: 'slack:T0BSQSQG0UU:C0C2U2UJUTU:1789761553.312049',
      title: OPS_REQUESTS_ASK_TITLE, contentSummary: '<@U0BTFK6FLNL> please refresh the pipeline tile to the standup figure.',
      replyTarget: { channel: 'C0C2U2UJUTU', threadTs: '1789761553.312049' }, plan: holderPlan,
    });
    return { agentId, ask, holder };
  });
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}
const outputOf = (row: Doc<'workItems'>): { actions?: MockAction[]; applied?: AppliedAction[] } => (row.output ?? {}) as never;
const saves = (): number => recorded.driver!.calls.filter((call) => call.tool === 'browser_click' && call.args.element === 'Save').length;
const posted = (): Array<Record<string, unknown>> => recorded.http.filter((call) => call.url.endsWith('/chat.postMessage')).map((call) => call.body);

/** Phase one of the work item: author, then apply; nothing scheduled runs until `settle`. */
async function runPhaseOne(harness: Harness, workItemId: Id<'workItems'>): Promise<void> {
  await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
  await harness.action(internal.workActions.applyApprovedActions, { workItemId });
}
async function authorClosing(harness: Harness, workItemId: Id<'workItems'>): Promise<void> {
  const row = await readItem(harness, workItemId);
  await harness.action(internal.workActions.authorDependentActions, { workItemId, runId: row.executionRunId! });
}
async function settle(harness: Harness): Promise<void> {
  await harness.finishAllScheduledFunctions(vi.runAllTimers);
}
/** The sibling ask begins executing, which is when it takes the page-field claim. */
async function holderBegins(harness: Harness, holder: Id<'workItems'>): Promise<void> {
  await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId: holder });
}

describe('an ask whose closing writes were withheld for a claim holder still answers (finding W, 19 September fourth run)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    vi.useFakeTimers();
    recorded.driver = new TileDriver('plain-cred-looker');
    recorded.closingPrompts.length = 0;
    recorded.closingAnswers.length = 0;
    recorded.http.length = 0;
    recorded.duringClosing = undefined;
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit): Promise<Response> => {
      recorded.http.push({ url: String(input), body: init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>) });
      return new Response(JSON.stringify({ ok: true, ts: `17897825${String(recorded.http.length).padStart(2, '0')}.000100` }), { status: 200 });
    });
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    recorded.driver = undefined;
    restoreSurfaceMode();
  });

  it("never completes silently on the run's own closing set: the claim is taken while the set is authored, the reply step is blocked, nothing answers the thread", async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { ask, holder } = await seed(t);
    recorded.closingAnswers.push(RUN_CLOSING);
    recorded.duringClosing = async (): Promise<void> => await holderBegins(t, holder);

    await runPhaseOne(t, ask);
    await settle(t);

    const row = await readItem(t, ask);
    const rows = outputOf(row).applied ?? [];
    expect(rows.filter((entry) => entry.reason?.startsWith("withheld for another work item's claim: the page field \"pipeline coverage\"")).length).toBeGreaterThanOrEqual(2);
    // The one Save is the holder's.
    expect(saves()).toBe(1);
    expect((outputOf(await readItem(t, holder)).applied ?? []).every((entry) => entry.ok && !entry.held)).toBe(true);
    expect(recorded.closingPrompts).toHaveLength(1);
    expect(posted().some((body) => body.channel === REVOPS_ASKS_ASK.replyTarget.channel)).toBe(false);
    // The day's row read `completed`, "2 changes landed", with nobody answered.
    expect(row.state).toBe('failed');
    expect(row.skipReason).toContain('approved plan step(s) remained blocked: step 3 (');
  }, 30_000);
});
