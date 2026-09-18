/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { McpClientLike, McpClientOptions } from '../../src/surfaces/mcp';
import type { AppliedAction } from '../../src/surfaces/types';
import { STOPPED_PREFIX } from '../../src/work/stop';
import type { MockAction } from '../../src/work/types';
import { MANAGER_DM, slackPlan, TileDriver } from '../fixtures/browser-phase-split-2026-09-16';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import {
  FIRST_FAILURE_2026_09_17,
  FIRST_RUN_2026_09_17,
  firstAttempt2026_09_17,
} from './fixtures/resume-rereads-2026-09-17';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * A retry that resumes at the closing phase reads the carried reads again
 * before the closing set is authored.
 *
 * On 17 September the Slack mention's retry resumed from its first attempt's
 * ledger, where the tile read 68%, and replied in the thread that the tile
 * "currently shows 68%" four minutes after REVOPS-7 had saved 74%. The chain
 * here is the real one - `retryFailed`, `executeApprovedPlan`,
 * `authorDependentActions`, `applyApprovedActions` - over the stateful tile
 * double, in which every new MCP client is a new blank browser context.
 */

const recorded = vi.hoisted(() => ({
  driver: undefined as undefined | import('../fixtures/browser-phase-split-2026-09-16').TileDriver,
  http: [] as Array<{ url: string; body: Record<string, unknown> }>,
  model: [] as Array<{ agent: string; user: string }>,
  /** The closing set a resumed closing phase answers with; by default a reply quoting the ledger's last figure. */
  resumedClosing: undefined as unknown,
}));

const REPLY_CHANNEL = 'C0BSF04TZ19';
const REPLY_THREAD = '1787746453.202809';

/** The closing phase's view of the ledger: the section the prompt renders it in, to the end. */
function ledgerSection(prompt: string): string {
  return prompt.slice(prompt.indexOf('--- Applied prerequisite ledger ---'));
}

vi.mock('../../src/lib/mastra', async () => {
  const fixture = await import('../fixtures/browser-phase-split-2026-09-16');
  const threadReply = (text: string): MockAction => ({
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'POST',
      path: '/chat.postMessage',
      headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
      body: JSON.stringify({ channel: 'C0BSF04TZ19', thread_ts: '1787746453.202809', text }),
    },
  });
  // What the recorded retry did: quote the last figure its ledger shows.
  const figureReply = (user: string): unknown => {
    const section = user.slice(user.indexOf('--- Applied prerequisite ledger ---'));
    const figure = [...section.matchAll(/visible figure (\d+%)/g)].map((match) => match[1]).at(-1) ?? 'no figure';
    return {
      draft: `The Looker pipeline tile reads ${figure}.`,
      notes: '',
      actions: [threadReply(`Coverage check (ref C0BSF04TZ19:1787746453.202809): the Looker pipeline tile currently shows ${figure}.`)],
      procedureTrails: [],
      planStepOutcomes: [
        { step: 1, status: 'satisfied', basis: 'ledger', evidence: `The ledger's tile read shows visible figure ${figure}.` },
        { step: 2, status: 'satisfied', basis: 'ledger', evidence: `The tile read shows ${figure}; the conditional refresh is decided on that read.` },
        { step: 3, status: 'satisfied', basis: 'ledger', evidence: 'Action 0 in this response: the thread reply quoting the figure.' },
        { step: 4, status: 'satisfied', basis: 'ledger', evidence: 'This response records the outcome.' },
      ],
    };
  };
  return {
    MODEL_CONFIG: 'openai/mock',
    MODEL_PROVIDER_MAX_RETRIES: 2,
    makeAgent: (name: string): { name: string } => ({ name }),
    agentJson: async <T>(args: {
      agent: { name: string };
      user: string;
      schema: { parse(value: unknown): unknown };
    }): Promise<T> => {
      recorded.model.push({ agent: args.agent.name, user: args.user });
      const reply = ((): unknown => {
        if (args.agent.name.endsWith('-initial')) {
          return {
            draft: 'Opening the Looker tile, signing in and reading the visible figure before deciding on the refresh.',
            notes: '',
            needsDependentPhase: true,
            deferredActions: [],
            actions: fixture.slackPhaseOne,
            procedureTrails: [],
          };
        }
        if (args.agent.name.endsWith('-dependent')) {
          if (!args.user.includes('Previous closing attempt failure')) return fixture.slackClosingReply;
          return recorded.resumedClosing ?? figureReply(args.user);
        }
        throw new Error(`unscripted agent ${args.agent.name}`);
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
    createMastraMcpClient: (options: McpClientOptions): McpClientLike => {
      if (!recorded.driver) throw new Error('no driver double for this test');
      return recorded.driver.client(options.serverName);
    },
  };
});

vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit): Promise<Response> => {
  recorded.http.push({ url: String(input), body: JSON.parse(String(init?.body)) });
  return new Response(JSON.stringify({ ok: true, ts: '1789593190.239329' }), { status: 200 });
});

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };

/** The tile's container, stopped and started by the test. */
let tileDown = false;

async function seed(harness: Harness, item: Record<string, unknown> = {}): Promise<Id<'workItems'>> {
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
    for (const scope of ['boss:message', 'slack:read', 'slack:write', 'looker:read', 'looker:write']) {
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
      toolAllowlist: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fill_form'],
      toolArguments: [
        { arguments: ['url'], tool: 'browser_navigate' },
        { arguments: ['boxes', 'depth', 'filename', 'target'], tool: 'browser_snapshot' },
        { arguments: ['button', 'doubleClick', 'element', 'modifiers', 'target'], tool: 'browser_click' },
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
    return await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'event-stream',
      sourceSystem: 'slack',
      externalId: `${REPLY_CHANNEL}:${REPLY_THREAD}`,
      title: 'Slack mention in #revops-asks',
      contentSummary:
        '<@U0BTFK6FLNL> can you confirm pipeline coverage for the three Friday standup deals before the Q3 close summary goes out?',
      contentRefs: [
        'https://app.slack.com/client/T0BSQSQG0UU/C0BSF04TZ19/thread/C0BSF04TZ19-1787746453202809',
      ],
      replyTarget: { channel: REPLY_CHANNEL, channelName: 'revops-asks', threadTs: REPLY_THREAD },
      state: 'plan-approved',
      plan: slackPlan,
      verdict: { decision: 'claim', value: 60, risk: 40, requiredPermissions: ['boss:message', 'slack:read'] },
      observedAt: 1,
      createdAt: 1,
      ...item,
    } as never);
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

/** REVOPS-7's save, as the tile server records it. */
function saveSeventyFour(): void {
  recorded.driver!.tile.value = '74%';
  recorded.driver!.tile.updatedBy = 'revops';
  recorded.driver!.tile.updatedAt = '2026-09-16 21:11:02';
}

/** Phase one lands at 68%; the closing set then fails because the tile's container is down. */
async function failAtClosingWithTheTileDown(t: Harness, workItemId: Id<'workItems'>): Promise<Id<'events'>> {
  await t.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
  await t.action(internal.workActions.applyApprovedActions, { workItemId });
  const authoring = await readItem(t, workItemId);
  expect(ledger(authoring)[3]!.effect).toContain('visible figure 68%');
  const runId = authoring.executionRunId!;
  await t.action(internal.workActions.authorDependentActions, { workItemId, runId });
  tileDown = true;
  await t.action(internal.workActions.applyApprovedActions, { workItemId });
  tileDown = false;
  expect((await readItem(t, workItemId)).state).toBe('failed');
  return runId;
}

/** Reconcile the landed sign-in and Retry: the item resumes at the closing phase under a new run. */
async function retryAtClosing(t: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  await t.withIdentity(OWNER).mutation(api.work.reconcileFailed, { workItemId, confirmed: true });
  await t.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });
  recorded.model.length = 0;
  await t.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
  return await readItem(t, workItemId);
}

const repliesInThread = (): string[] =>
  recorded.http
    .filter((post) => post.body.channel === REPLY_CHANNEL)
    .map((post) => String(post.body.text));

describe('evidence is read again when a retry resumes at the closing phase', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    vi.useFakeTimers();
    tileDown = false;
    recorded.driver = new TileDriver('plain-cred-looker', () =>
      tileDown ? 'net::ERR_CONNECTION_REFUSED' : undefined,
    );
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    recorded.driver = undefined;
    recorded.http.length = 0;
    recorded.model.length = 0;
    recorded.resumedClosing = undefined;
    restoreSurfaceMode();
  });

  it.fails('reads the tile again under the new run, and the closing reply quotes 74%, not the 68% read before the retry', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const workItemId = await seed(t);
    const firstRun = await failAtClosingWithTheTileDown(t, workItemId);
    saveSeventyFour();

    const resumed = await retryAtClosing(t, workItemId);
    const secondRun = resumed.executionRunId!;
    expect(secondRun).not.toBe(firstRun);
    expect(resumed.output).toMatchObject({ phase: 'dependent-authoring', resumedClosing: true });
    // The carried snapshot is read again in a new browser, signed in by
    // replaying the first attempt's landed sign-in, under the new run's key.
    const reread = ledger(resumed)[3]!;
    expect(reread).toMatchObject({
      ok: true,
      authority: 'autonomous',
      idempotencyKey: `${workItemId}:${secondRun}:3`,
      refreshed: {
        previous: {
          idempotencyKey: `${workItemId}:${firstRun}:3`,
          effect: expect.stringContaining('visible figure 68%'),
        },
        at: expect.any(Number),
      },
    });
    expect(reread.effect).toContain('visible figure 74%');
    expect(reread.sessionRestore?.steps.map((step) => [step.ok, step.idempotencyKey, step.replayOf])).toEqual(
      [0, 1, 2].map((index) => [
        true,
        `${workItemId}:${secondRun}:3.session-${index}`,
        `${workItemId}:${firstRun}:${index}`,
      ]),
    );
    // Nothing but the read went out before the closing set was authored.
    expect(recorded.model).toEqual([]);
    expect(repliesInThread()).toEqual([]);

    await t.action(internal.workActions.authorDependentActions, { workItemId, runId: secondRun });
    const prompt = ledgerSection(recorded.model.at(-1)!.user);
    expect(prompt).toMatch(/visible figure 74%[^\n]* · re-read on resume at \d{4}-\d\d-\d\dT/);
    expect(prompt).not.toContain('68%');

    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const replies = repliesInThread();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('the Looker pipeline tile currently shows 74%.');
    expect(replies[0]).not.toContain('68%');
    expect((await readItem(t, workItemId)).state).toBe('completed');
  }, 30_000);

  // The 17 September ledger: the first attempt's closing snapshot landed on
  // a blank page, so the last carried snapshot is that one, and the 68% read
  // before it is marked as read before the retry.
  it.fails('re-reads the last carried snapshot of the 17 September ledger, and the reply no longer quotes 68%', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const workItemId = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        state: 'failed',
        skipReason: FIRST_FAILURE_2026_09_17,
        output: firstAttempt2026_09_17(workItemId),
      });
    });
    saveSeventyFour();

    const resumed = await retryAtClosing(t, workItemId);
    const secondRun = resumed.executionRunId!;
    const carried = ledger(resumed);
    expect(carried.map((row) => row.idempotencyKey)).toEqual([
      `${workItemId}:${FIRST_RUN_2026_09_17}:0`,
      `${workItemId}:${FIRST_RUN_2026_09_17}:1`,
      `${workItemId}:${FIRST_RUN_2026_09_17}:2`,
      `${workItemId}:${FIRST_RUN_2026_09_17}:3`,
      `${workItemId}:${secondRun}:4`,
      `${workItemId}:${FIRST_RUN_2026_09_17}:7`,
    ]);
    expect(carried[4]).toMatchObject({
      ok: true,
      refreshed: {
        previous: {
          idempotencyKey: `${workItemId}:${FIRST_RUN_2026_09_17}:6`,
          effect: expect.stringContaining('about:blank'),
        },
      },
    });
    expect(carried[4]!.effect).toContain('visible figure 74%');

    await t.action(internal.workActions.authorDependentActions, { workItemId, runId: secondRun });
    const prompt = ledgerSection(recorded.model.at(-1)!.user);
    expect(prompt).toMatch(/visible figure 68%[^\n]* · read before the retry; row 4 is the current reading/);
    expect(prompt).toMatch(/visible figure 74%[^\n]* · re-read on resume at /);
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const [reply] = repliesInThread();
    expect(reply).toContain('currently shows 74%');
    expect(reply).not.toContain('68%');
  }, 30_000);

  it('stops the resumed run when the re-read cannot be made, and nothing of the closing set is written', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const workItemId = await seed(t);
    await failAtClosingWithTheTileDown(t, workItemId);
    const before = await readItem(t, workItemId);
    const postsBefore = recorded.http.length;
    const callsBefore = recorded.driver!.calls.length;

    await t.withIdentity(OWNER).mutation(api.work.reconcileFailed, { workItemId, confirmed: true });
    await t.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });
    const carried = (await readItem(t, workItemId)).output as { applied: AppliedAction[] };
    recorded.model.length = 0;
    // The browser driver is absent when the resumed run starts.
    vi.stubEnv('DAY0_BROWSER_MCP_URL', '');
    await t.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });

    const stopped = await readItem(t, workItemId);
    expect(stopped.state).toBe('failed');
    expect(stopped.skipReason).toMatch(
      new RegExp(`^${STOPPED_PREFIX}could not re-read looker before the closing set: `),
    );
    // No closing set was authored or applied, nothing reached Slack or the tile.
    expect(recorded.model).toEqual([]);
    expect(recorded.http.length).toBe(postsBefore);
    expect(recorded.driver!.calls.length).toBe(callsBefore);
    // The row keeps the resumable ledger, so Retry resumes at the closing phase again.
    expect(stopped.output).toMatchObject({ phase: 'dependent-authoring', resumedClosing: true, applied: carried.applied });
    expect(before.skipReason).not.toBe(stopped.skipReason);
  }, 30_000);

  // The carried ledger holds a landed refresh: the re-read replays the
  // sign-in and reads the page, and never enters or saves a figure again.
  it('sends nothing on resume but the carried read and the sign-in it needs', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const fixture = await import('../fixtures/browser-phase-split-2026-09-16');
    const [navigate, signIn, clickSignIn, snapshot] = fixture.slackPhaseOne;
    const [fill, save] = fixture.slackClosing;
    const firstRun = 'k57bfirstattempt0000000000000000';
    const workItemId = await seed(t);
    const key = (index: number): string => `${workItemId}:${firstRun}:${index}`;
    const reply = {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'POST',
        path: '/chat.postMessage',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
        body: JSON.stringify({ channel: REPLY_CHANNEL, thread_ts: REPLY_THREAD, text: 'The tile reads 74%.' }),
      },
    } satisfies MockAction;
    await t.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        state: 'failed',
        skipReason: '1 of 1 actions did not change the work environment: http.request (HTTP 500)',
        output: {
          draft: '',
          notes: '',
          needsDependentPhase: false,
          actions: [navigate, signIn, clickSignIn, fill, save, snapshot, reply],
          applied: [
            ...[0, 1, 2, 3, 4].map((index): AppliedAction => ({
              tool: 'mcp.call', ok: true, authority: 'autonomous', effect: 'landed on looker', idempotencyKey: key(index),
            })),
            {
              tool: 'mcp.call', ok: true, authority: 'autonomous',
              effect: 'browser_snapshot on looker · visible figure 74% · Last updated by revops at 2026-09-16 21:07:34 UTC',
              idempotencyKey: key(5),
            },
            { tool: 'http.request', ok: false, reason: 'HTTP 500', idempotencyKey: key(6) },
          ],
          planStepOutcomes: fixture.slackClosingReply.planStepOutcomes.map((outcome) => ({
            ...outcome, evidence: 'Ledger rows 0-5: signed in, refreshed to 74% and read back.',
          })),
          prerequisiteCount: 6,
          procedureTrails: [],
        },
      });
    });
    saveSeventyFour();
    const tileBefore = { ...recorded.driver!.tile };

    const resumed = await retryAtClosing(t, workItemId);
    const secondRun = resumed.executionRunId!;
    expect(ledger(resumed).map((row) => row.idempotencyKey)).toEqual([
      key(0), key(1), key(2), key(3), key(4), `${workItemId}:${secondRun}:5`,
    ]);
    const sent = recorded.driver!.calls.map((call) => [call.tool, JSON.stringify(call.args)]);
    expect(sent.map(([tool]) => tool).filter((tool) => tool !== 'browser_snapshot')).toEqual([
      'browser_navigate',
      'browser_fill_form',
      'browser_click',
    ]);
    expect(sent.some(([, args]) => args!.includes('Pipeline coverage') || args!.includes('Save'))).toBe(false);
    expect(recorded.driver!.tile).toEqual(tileBefore);
    expect(recorded.http).toEqual([]);
  }, 30_000);

  // Phase one opened the tile and signed in but took no snapshot, so there
  // is no read to take again; the resumed closing set's first call on the
  // tile is signed in from the first attempt's ledger, under the new run.
  it('signs the resumed closing set in from the first attempt\'s sign-in', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const fixture = await import('../fixtures/browser-phase-split-2026-09-16');
    const [navigate, signIn, clickSignIn] = fixture.slackPhaseOne;
    const [fill, save, readBack] = fixture.slackClosing;
    const firstRun = 'k57bfirstattempt0000000000000000';
    const workItemId = await seed(t);
    const key = (index: number): string => `${workItemId}:${firstRun}:${index}`;
    const refused = (index: number): AppliedAction => ({
      tool: 'mcp.call',
      ok: false,
      reason: 'browser session could not be re-established: browser_navigate net::ERR_CONNECTION_REFUSED',
      idempotencyKey: key(index),
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        state: 'failed',
        skipReason: '3 of 6 actions did not change the work environment',
        output: {
          draft: '',
          notes: '',
          needsDependentPhase: false,
          actions: [navigate, signIn, clickSignIn, fill, save, readBack],
          applied: [
            ...[0, 1, 2].map((index): AppliedAction => ({
              tool: 'mcp.call',
              ok: true,
              authority: 'autonomous',
              effect: 'landed on looker',
              idempotencyKey: key(index),
            })),
            refused(3),
            refused(4),
            refused(5),
          ],
          planStepOutcomes: fixture.slackClosingReply.planStepOutcomes.map((outcome) =>
            outcome.step <= 2 ? { ...outcome, evidence: 'Ledger rows 0-2: the tile opened and the sign-in landed.' } : outcome,
          ),
          prerequisiteCount: 3,
          procedureTrails: [],
        },
      });
    });
    recorded.resumedClosing = {
      ...fixture.slackClosingReply,
      actions: [fill, save, readBack],
      planStepOutcomes: fixture.slackClosingReply.planStepOutcomes.map((outcome) =>
        outcome.step === 3 ? { ...outcome, status: 'blocked', evidence: 'The reply waits for the read-back.' } : outcome,
      ),
    };

    const resumed = await retryAtClosing(t, workItemId);
    const secondRun = resumed.executionRunId!;
    await t.action(internal.workActions.authorDependentActions, { workItemId, runId: secondRun });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });

    const closing = ledger(await readItem(t, workItemId)).slice(3);
    expect(closing.map((row) => row.ok)).toEqual([true, true, true]);
    expect(closing[0]!.sessionRestore?.steps.map((step) => [step.idempotencyKey, step.replayOf])).toEqual(
      [0, 1, 2].map((index) => [`${workItemId}:${secondRun}:3.session-${index}`, key(index)]),
    );
    expect(closing[2]!.effect).toContain('visible figure 74%');
    expect(recorded.driver!.tile.value).toBe('74%');
  }, 30_000);

  // A resumed closing set that refreshes the tile and reads it back: the
  // read-back must reach the tile, not reuse the carried read of the same
  // page, which was taken before the Save.
  it.fails('sends the closing read-back again rather than reusing a carried read of the same page', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const workItemId = await seed(t);
    await failAtClosingWithTheTileDown(t, workItemId);
    const fixture = await import('../fixtures/browser-phase-split-2026-09-16');
    const [fill, save, readBack] = fixture.slackClosing;
    recorded.resumedClosing = {
      ...fixture.slackClosingReply,
      actions: [fill, save, readBack],
      planStepOutcomes: fixture.slackClosingReply.planStepOutcomes.map((outcome) =>
        outcome.step === 3 ? { ...outcome, status: 'blocked', evidence: 'The reply waits for the read-back.' } : outcome,
      ),
    };

    const resumed = await retryAtClosing(t, workItemId);
    const secondRun = resumed.executionRunId!;
    expect(ledger(resumed)[3]!.effect).toContain('visible figure 68%');
    await t.action(internal.workActions.authorDependentActions, { workItemId, runId: secondRun });
    await t.action(internal.workActions.applyApprovedActions, { workItemId });

    const closing = ledger(await readItem(t, workItemId)).slice(4);
    expect(closing.map((row) => [row.ok, row.idempotencyKey])).toEqual([
      [true, `${workItemId}:${secondRun}:4`],
      [true, `${workItemId}:${secondRun}:5`],
      [true, `${workItemId}:${secondRun}:6`],
    ]);
    expect(closing[2]!.reason).toBeUndefined();
    expect(closing[2]!.effect).toContain('visible figure 74%');
    expect(recorded.driver!.tile.value).toBe('74%');
  }, 30_000);
});
