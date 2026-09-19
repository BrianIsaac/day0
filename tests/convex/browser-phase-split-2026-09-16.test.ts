/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { McpClientLike, McpClientOptions } from '../../src/surfaces/mcp';
import type { AppliedAction } from '../../src/surfaces/types';
import type { ExecutionPlan } from '../../src/work/types';
import { MANAGER_DM, slackPlan, TileDriver } from '../fixtures/browser-phase-split-2026-09-16';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * The 16 September 21:07 UTC failure, replayed through the real chain:
 * `applyApprovedActions` -> `finishRun` -> `prepareDependentPhase` ->
 * `authorDependentActions` -> `setActionsPending` -> `applyApprovedActions`.
 *
 * The browser driver double is stateful the way the pinned driver is under
 * `--isolated`: one tile server behind it, and every new MCP client a new
 * browser context that starts at `about:blank`, signed out. The Slack
 * mention signs in and reads 68% in phase one, REVOPS-7 refreshes the tile to
 * 74% in its own run, and then the Slack mention's closing set - the model's
 * own, with no navigate and no sign-in - is applied in a new invocation.
 */

const recorded = vi.hoisted(() => ({
  driver: undefined as undefined | import('../fixtures/browser-phase-split-2026-09-16').TileDriver,
  http: [] as Array<{ url: string; body: unknown }>,
  /** How many times the Slack mention's closing set has been authored. */
  slackClosings: 0,
}));

/** What the mention's second closing authoring answers: the reply, from the read-back now in its ledger. */
const REPLY_TEXT = 'Pipeline coverage reads 74% on the Looker tile, per its audit line (Last updated by revops).';

const r7Plan: ExecutionPlan = {
  summary: 'Refresh the Looker pipeline tile to the approved 74%, read it back and tell the manager.',
  steps: [
    'In one browser session on the looker surface, sign in, fill Pipeline coverage with 74% and click Save.',
    'Read the tile back with browser_snapshot and confirm the figure and the audit line.',
    'DM the manager the read-back.',
  ],
  expectedOutputType: 'message',
  riskNotes: '',
  reversibility: 'Re-enter the previous figure.',
  estimatedMinutes: 5,
  obligations: {
    steps: [
      { kind: 'write', reads: [], writes: ['looker'] },
      { kind: 'read', reads: ['looker'], writes: [] },
      { kind: 'write', reads: [], writes: ['slack'] },
    ],
    transition: 'none',
    transitionStep: null,
    basis: 'judgement',
  },
};

vi.mock('../../src/lib/mastra', async () => {
  const fixture = await import('../fixtures/browser-phase-split-2026-09-16');
  return {
    MODEL_CONFIG: 'openai/mock',
    MODEL_PROVIDER_MAX_RETRIES: 2,
    makeAgent: (name: string): { name: string } => ({ name }),
    agentJson: async <T>(args: {
      agent: { name: string };
      schema: { parse(value: unknown): unknown };
    }): Promise<T> => {
      const name = args.agent.name;
      const slack = name.includes('chat-thread-reply');
      const reply = ((): unknown => {
        if (name.endsWith('-initial')) {
          return {
            draft: slack
              ? 'Opening the Looker tile, signing in and reading the visible figure before deciding on the refresh.'
              : 'Signing in to the tile, entering 74%, saving and reading it back.',
            notes: '',
            needsDependentPhase: true,
            deferredActions: [],
            actions: slack ? fixture.slackPhaseOne : fixture.revops7PhaseOne,
            procedureTrails: [],
          };
        }
        if (name.endsWith('-dependent')) {
          if (slack) {
            recorded.slackClosings += 1;
            if (recorded.slackClosings === 1) return fixture.slackClosingReply;
            return {
              draft: 'The read-back is in the ledger now, so the thread is answered from it.',
              notes: '',
              actions: [
                {
                  tool: 'http.request',
                  args: {
                    surface: 'slack',
                    method: 'POST',
                    path: '/chat.postMessage',
                    headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
                    body: JSON.stringify({ channel: 'C0BSF04TZ19', thread_ts: '1787746453.202809', text: REPLY_TEXT }),
                  },
                },
              ],
              procedureTrails: [],
              planStepOutcomes: fixture.slackClosingReply.planStepOutcomes.map((outcome) =>
                outcome.step === 3
                  ? { ...outcome, status: 'satisfied', evidence: 'ledger row 6: visible figure 74% and the audit line; the reply in this response quotes them' }
                  : outcome,
              ),
            };
          }
          return {
            draft: 'The tile reads 74% with the audit line; the manager has the read-back.',
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
                    channel: fixture.MANAGER_DM,
                    text: 'REVOPS-7: the Looker tile now reads 74% with its audit line.',
                  }),
                },
              },
            ],
            procedureTrails: [],
            planStepOutcomes: [
              { step: 1, status: 'satisfied', basis: 'ledger', evidence: 'ledger rows 0 to 5 landed on the tile' },
              { step: 2, status: 'satisfied', basis: 'ledger', evidence: 'ledger row 6: visible figure 74% and the audit line' },
              { step: 3, status: 'satisfied', basis: 'ledger', evidence: 'the manager DM in this response' },
            ],
          };
        }
        throw new Error(`unscripted agent ${name}`);
      })();
      return args.schema.parse(reply) as T;
    },
    agentText: async (): Promise<string> => '',
  };
});

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (_ctx: unknown, credentialId: string): Promise<string> =>
    `plain-${credentialId}`,
}));

vi.mock('../../src/surfaces/mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/surfaces/mcp')>();
  return {
    ...original,
    // One new browser context per client, blank and signed out, like the
    // pinned driver under `--isolated`; the tile behind it is one server.
    createMastraMcpClient: (options: McpClientOptions): McpClientLike => {
      if (!recorded.driver) throw new Error('no driver double for this test');
      return recorded.driver.client(options.serverName);
    },
  };
});

vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit): Promise<Response> => {
  recorded.http.push({ url: String(input), body: JSON.parse(String(init?.body)) });
  return new Response(JSON.stringify({ ok: true, ts: '1789592857.505309' }), { status: 200 });
});

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };

async function seed(harness: Harness): Promise<{ slack: Id<'workItems'>; revops7: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'ops worker',
      userId: 'owner',
      state: 'active',
      autonomousActions: true,
      createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId,
      version: 'v1',
      approved: true,
      approvedAt: 1,
      createdAt: 1,
      body: {
        proposedFunction: 'Own routine revenue operations work for the RevOps team.',
        proposedBoundaries: {
          willDo: ['Keep the Looker pipeline tile at the approved figure.', 'Answer RevOps asks in Slack.'],
          willNotDo: ['Post to public channels without approval.'],
          escalationTriggers: ['Unclear ownership'],
        },
        approvalChain: { boss: 'boss@day0.local' },
      },
    });
    await ctx.db.insert('skills', {
      agentId,
      name: 'chat-thread-reply',
      description: 'Reply in the Slack thread a request came from, after doing the work it asks for.',
      body: [
        '# Reply in the Slack thread',
        'Do the work the ask names on its connected surfaces, then reply in the thread with slack chat.postMessage and DM the manager when something needs them.',
      ].join('\n'),
      requiredScopes: ['boss:message', 'slack:read', 'slack:write'],
      targetSurface: 'slack',
      sourceType: 'agent-authored',
      state: 'registered',
      createdAt: 1,
      registeredAt: 1,
    });
    await ctx.db.insert('skills', {
      agentId,
      name: 'refresh-looker-pipeline-tile',
      description: 'Refresh the Looker pipeline tile from a Linear ticket and record the result.',
      body: [
        '# Refresh the Looker pipeline tile',
        'On looker: browser_navigate, browser_fill_form the login with {{secret}}, browser_click Sign in, browser_fill_form Pipeline coverage 74%, browser_click Save, browser_snapshot. Then DM the manager the read-back.',
      ].join('\n'),
      requiredScopes: ['boss:message', 'linear:read', 'looker:read', 'looker:write'],
      targetSurface: 'looker',
      sourceType: 'agent-authored',
      state: 'registered',
      createdAt: 1,
      registeredAt: 1,
    });
    for (const scope of [
      'linear:write',
      'boss:message',
      'slack:read',
      'slack:write',
      'looker:read',
      'linear:read',
      'docs:read',
      'looker:write',
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
          ref: 'looker-pipeline-tile.md',
          quote: 'The Looker pipeline tile is refreshed by hand',
          current: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
        },
      ],
    };
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'looker',
      displayName: 'Looker',
      class: 'analytics',
      verdict: 'connected',
      endpoint: 'http://looker-tile:8080/',
      path: 'browser-driven',
      toolAllowlist: [
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
        'browser_type',
        'browser_fill_form',
      ],
      toolArguments: [
        { arguments: ['url'], tool: 'browser_navigate' },
        { arguments: ['boxes', 'depth', 'filename', 'target'], tool: 'browser_snapshot' },
        { arguments: ['button', 'doubleClick', 'element', 'modifiers', 'target'], tool: 'browser_click' },
        { arguments: ['element', 'slowly', 'submit', 'target', 'text'], tool: 'browser_type' },
        { arguments: ['fields'], tool: 'browser_fill_form' },
      ],
      credentialId: 'cred-looker',
      credentialKind: 'value',
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
      toolAllowlist: ['auth.test', 'conversations.replies', 'chat.postMessage'],
      credentialId: 'cred-slack',
      credentialKind: 'value',
      managerDmChannelId: MANAGER_DM,
      managerUserId: 'U0BTFHN6MKJ',
      ...live,
    } as never);
    const slack = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'event-stream',
      sourceSystem: 'slack',
      externalId: 'C0BSF04TZ19:1787746453.202809',
      title: 'Slack mention in #revops-asks',
      contentSummary:
        '<@U0BTFK6FLNL> can you confirm pipeline coverage for the three Friday standup deals before the Q3 close summary goes out?',
      contentRefs: [
        'https://app.slack.com/client/T0BSQSQG0UU/C0BSF04TZ19/thread/C0BSF04TZ19-1787746453202809',
      ],
      replyTarget: { channel: 'C0BSF04TZ19', channelName: 'revops-asks', threadTs: '1787746453.202809' },
      state: 'plan-approved',
      plan: slackPlan,
      verdict: { decision: 'claim', value: 60, risk: 40, requiredPermissions: ['boss:message', 'slack:read'] },
      observedAt: 1,
      createdAt: 1,
    } as never);
    const revops7 = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-7',
      title: 'Refresh the Looker pipeline tile',
      contentSummary: 'Refresh the Looker pipeline tile with the approved 74% and record the audit line.',
      contentRefs: ['https://linear.app/day00/issue/REVOPS-7/refresh-the-looker-pipeline-tile'],
      state: 'plan-approved',
      plan: r7Plan,
      verdict: { decision: 'claim', value: 70, risk: 30, requiredPermissions: ['boss:message', 'linear:read'] },
      observedAt: 1,
      createdAt: 1,
    } as never);
    return { slack, revops7 };
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

/** Apply one work item's pending phase with the double attributing its calls to that item. */
async function applyAs(harness: Harness, label: string, workItemId: Id<'workItems'>): Promise<void> {
  recorded.driver!.label = label;
  await harness.action(internal.workActions.applyApprovedActions, { workItemId });
  recorded.driver!.label = undefined;
}

describe('a browser sequence split across a run\'s two phases (16 September 21:07 UTC)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    vi.useFakeTimers();
    recorded.driver = new TileDriver('plain-cred-looker');
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    recorded.driver = undefined;
    recorded.http.length = 0;
    recorded.slackClosings = 0;
    restoreSurfaceMode();
  });

  // Without the session replay the closing fill and Save find "nothing named
  // on the page" and the snapshot reads about:blank, exactly as the 16
  // September ledger shows.
  it('lands the closing fill and Save in a signed-in page, with REVOPS-7 in its own browser', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { slack, revops7 } = await seed(t);

    // The Slack mention's phase one: navigate, sign in, read 68%.
    await t.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId: slack });
    await applyAs(t, 'slack', slack);
    const authoring = await readItem(t, slack);
    expect(authoring.output).toMatchObject({ phase: 'dependent-authoring' });
    expect(ledger(authoring).map((row) => row.ok)).toEqual([true, true, true, true]);
    expect(ledger(authoring)[3]!.effect).toContain('visible figure 68%');
    const runId = authoring.executionRunId!;

    // REVOPS-7 refreshes the tile to 74% in its own run.
    await t.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId: revops7 });
    await applyAs(t, 'revops-7', revops7);

    // The Slack mention's closing set, authored from its ledger and applied
    // by a new invocation.
    await t.action(internal.workActions.authorDependentActions, { workItemId: slack, runId });
    await applyAs(t, 'slack', slack);
    // Its reply step was blocked for a read-back that only this apply
    // produced, so the closing set is authored once more from the ledger
    // (finding W, 19 September), and that set is applied.
    expect((await readItem(t, slack)).output).toMatchObject({ phase: 'dependent-authoring', closingRound: { reason: 'reply-owed', prerequisiteCount: 4 } });
    await t.action(internal.workActions.authorDependentActions, { workItemId: slack, runId });
    await applyAs(t, 'slack', slack);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const slackRow = await readItem(t, slack);
    const slackLedger = ledger(slackRow);
    expect(slackLedger).toHaveLength(9);
    // 1. The closing fill and Save landed, the fill after the run's own
    //    navigate, credential fill and Sign in were replayed in its browser.
    expect(slackLedger[4]).toMatchObject({ ok: true });
    expect(slackLedger[5]).toMatchObject({ ok: true });
    expect(
      slackLedger[4]!.sessionRestore?.steps.map((step) => [
        step.ok,
        step.idempotencyKey,
        step.replayOf,
        step.authority,
      ]),
    ).toEqual([0, 1, 2].map((index) => [
      true,
      `${slack}:${runId}:4.session-${index}`,
      `${slack}:${runId}:${index}`,
      'autonomous',
    ]));
    expect(slackLedger[5]).not.toHaveProperty('sessionRestore');
    // 2. The closing snapshot reads the refreshed figure and the audit line,
    //    and nothing anywhere read a blank page.
    expect(slackLedger[6]!.effect).toContain('visible figure 74%');
    expect(slackLedger[6]!.effect).toContain('Last updated by revops at');
    const revops7Row = await readItem(t, revops7);
    expect(JSON.stringify([slackRow.output, revops7Row.output])).not.toContain('about:blank');
    // 3. The Slack item did not fail, and the person who asked is answered:
    //    on the day it completed with its reply step blocked and no reply.
    const events = await t.run(async (ctx) => await ctx.db.query('events').collect());
    const mine = events.filter((event) => (event.payload as { workItemId?: string }).workItemId === slack);
    expect(mine.filter((event) => event.type === 'work.failed')).toEqual([]);
    expect(mine.filter((event) => event.type === 'work.closing-reauthored')).toHaveLength(1);
    expect(slackRow.state).toBe('completed');
    expect(slackLedger.every((row) => row.ok && !row.held)).toBe(true);
    expect(recorded.slackClosings).toBe(2);
    expect(
      recorded.http.map((call) => call.body as { channel?: string; thread_ts?: string; text?: string })
        .filter((body) => body.channel === 'C0BSF04TZ19' && body.thread_ts === '1787746453.202809' && body.text?.startsWith(REPLY_TEXT)),
    ).toHaveLength(1);
    expect((slackRow.output as { prerequisiteCount?: number }).prerequisiteCount).toBe(4);
    // 4. REVOPS-7 landed every browser row, in a browser that served no
    //    Slack call.
    expect(ledger(revops7Row).slice(0, 7).every((row) => row.ok && !row.held)).toBe(true);
    const revops7Contexts = recorded.driver!.contextsServing('revops-7');
    const slackContexts = recorded.driver!.contextsServing('slack');
    expect(revops7Contexts.size).toBeGreaterThan(0);
    for (const context of revops7Contexts) expect(slackContexts.has(context)).toBe(false);
    expect(recorded.driver!.tile.value).toBe('74%');
  }, 30_000);
});
