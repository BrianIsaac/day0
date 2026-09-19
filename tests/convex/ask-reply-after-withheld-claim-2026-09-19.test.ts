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

const slackMessage = (body: Record<string, unknown>): MockAction => ({
  tool: 'http.request',
  args: {
    surface: 'slack', method: 'POST', path: '/chat.postMessage',
    headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}', 'Content-Type': 'application/json; charset=utf-8' }),
    body: JSON.stringify(body),
  },
});
const threadReply = (text: string): MockAction =>
  slackMessage({ channel: REVOPS_ASKS_ASK.replyTarget.channel, thread_ts: REVOPS_ASKS_ASK.replyTarget.threadTs, text });
const managerDm = (text: string): MockAction => slackMessage({ channel: MANAGER_DM, text });
const satisfied = (evidence: string): PlanStepOutcome[] =>
  revopsAsksPlan.steps.map((_, index) => ({ step: index + 1, status: 'satisfied' as const, evidence }));

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
/** Apply the set that is waiting, as the scheduled apply would. */
async function applyWaiting(harness: Harness, workItemId: Id<'workItems'>): Promise<void> {
  await harness.action(internal.workActions.applyApprovedActions, { workItemId });
}
/**
 * Drain what the steps above left scheduled. Every step is driven by hand
 * first: `runAllTimers` fires the six-minute apply watchdog at once, and it
 * would read an apply still in flight as interrupted.
 */
async function settle(harness: Harness): Promise<void> {
  await harness.finishAllScheduledFunctions(vi.runAllTimers);
}
/** The closing apply, the second authoring it may ask for, and that set's apply. */
async function closeOut(harness: Harness, workItemId: Id<'workItems'>): Promise<void> {
  await applyWaiting(harness, workItemId);
  if ((outputOf(await readItem(harness, workItemId)) as { phase?: string }).phase === 'dependent-authoring') {
    await authorClosing(harness, workItemId);
    await applyWaiting(harness, workItemId);
  }
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

  it('two asks, one tile: the claim is taken after the set is authored, the Save is withheld, no message claims it, and the reply still lands naming the holder', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { ask, holder } = await seed(t);
    recorded.closingAnswers.push(RUN_CLOSING, closingAnswer({
      draft: 'The tile reads 68%; the refresh was not made from this request.',
      notes: '',
      actions: [threadReply('Pipeline coverage on the Looker tile reads 68% as I read it just now; it has not been refreshed to the 74% standup figure yet.'), managerDm('The #revops-asks ask is answered from the tile as read, 68%. Could you obtain an approved access path for the Q4 pipeline tracker?')],
      planStepOutcomes: satisfied('ledger rows 0 to 3 and 6: the tile read 68%; rows 4 and 5 were withheld for the work item that holds the field'),
    }));

    await runPhaseOne(t, ask);
    await authorClosing(t, ask);
    // The set is authored and waits for its apply; the sibling begins and takes the field.
    expect(recorded.closingPrompts[0]).not.toContain('page field');
    await holderBegins(t, holder);
    await closeOut(t, ask);
    await applyWaiting(t, holder);
    await settle(t);

    const row = await readItem(t, ask);
    expect(row.state).toBe('completed');
    const { actions = [], applied = [] } = outputOf(row);
    expect(actions).toHaveLength(10);
    // The first closing set: fill and Save withheld for the holder, the snapshot read, the DM not sent as written.
    for (const index of [4, 5]) {
      expect(applied[index]).toMatchObject({ ok: true, held: true });
      expect(applied[index]!.reason).toContain(`withheld for another work item's claim: the page field "pipeline coverage" on ${SLUG} is held by this employee's work item "${OPS_REQUESTS_ASK_TITLE}"`);
    }
    expect(applied[6]!.effect).toContain('visible figure');
    expect(applied[7]).toMatchObject({ ok: true, held: true });
    expect(applied[7]!.reason).toContain('withheld with the write it reports: ');
    expect(applied[7]!.reason).toContain(OPS_REQUESTS_ASK_TITLE);
    // One Save, the holder's.
    expect(saves()).toBe(1);
    expect((outputOf(await readItem(t, holder)).applied ?? []).every((entry) => entry.ok && !entry.held)).toBe(true);

    // The set was authored once more, under the holders as they then stood and from the ledger as it then stood.
    expect(recorded.closingPrompts).toHaveLength(2);
    expect(recorded.closingPrompts[1]).toContain(`${SLUG} · page field "Pipeline coverage" · this employee · "${OPS_REQUESTS_ASK_TITLE}"`);
    expect(recorded.closingPrompts[1]).toContain(`5. held · {"tool":"mcp.call","args":{"surface":"${SLUG}","tool":"browser_click","toolArgsJson":"{\\"element\\":\\"Save\\"}"}} · mcp.call ${SLUG} · browser_click · {element: "Save"} · withheld for another work item's claim: the page field "pipeline coverage"`);
    expect(recorded.closingPrompts[1]).toMatch(/7\. held · .*withheld with the write it reports: /);
    expect(applied[8]).toMatchObject({ ok: true });
    expect(applied[8]!.held).toBeUndefined();

    // The person who asked is answered, from what was read, and told whose work the refresh is.
    const replies = posted().filter((body) => body.channel === REVOPS_ASKS_ASK.replyTarget.channel);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.thread_ts).toBe(REVOPS_ASKS_ASK.replyTarget.threadTs);
    expect(replies[0]!.text).toContain('reads 68%');
    expect(replies[0]!.text).toContain(`Pipeline coverage on ${SLUG} is refreshed by its own work item ("${OPS_REQUESTS_ASK_TITLE}"); it was not written from this request.`);
    // No message anywhere says this run made the refresh.
    expect(posted().map((body) => String(body.text)).filter((text) => /emitted the documented refresh/.test(text))).toEqual([]);

    const events = await t.run(async (ctx) => await ctx.db.query('events').collect());
    const mine = events.filter((event) => (event.payload as { workItemId?: string }).workItemId === ask);
    expect(mine.filter((event) => event.type === 'work.closing-reauthored').map((event) => event.payload)).toEqual([
      expect.objectContaining({ reason: 'claim-withheld', withheldIndexes: [4, 5, 7] }),
    ]);
    expect(mine.some((event) => event.type === 'audit.corrected' && String((event.payload as { reason?: string }).reason).startsWith('held-item reply completed'))).toBe(true);
    expect(mine.filter((event) => event.type === 'work.failed')).toEqual([]);
  }, 30_000);

  it("adds nothing to a reply that already says whose work the field is", async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { ask, holder } = await seed(t);
    const text = 'Pipeline coverage reads 68% on the tile as I read it; the field refresh is held by its own work item, so I have not written it.';
    recorded.closingAnswers.push(RUN_CLOSING, closingAnswer({
      draft: 'Answered from the tile as read.', notes: '', actions: [threadReply(text)],
      planStepOutcomes: satisfied('ledger rows 0 to 3 and 6'),
    }));

    await runPhaseOne(t, ask);
    await authorClosing(t, ask);
    await holderBegins(t, holder);
    await closeOut(t, ask);
    await applyWaiting(t, holder);
    await settle(t);

    expect((await readItem(t, ask)).state).toBe('completed');
    const replies = posted().filter((body) => body.channel === REVOPS_ASKS_ASK.replyTarget.channel).map((body) => String(body.text));
    expect(replies).toHaveLength(1);
    expect(replies[0]!.startsWith(text)).toBe(true);
    expect(replies[0]).not.toContain('is refreshed by its own work item (');
  }, 30_000);

  it('is one round: a second closing set that still leaves the reply blocked stops the run, and nothing is authored a third time', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { ask, holder } = await seed(t);
    recorded.closingAnswers.push(RUN_CLOSING, closingAnswer({
      draft: 'Still no reply.', notes: '', actions: [managerDm('The tile reads 68%. Could you decide how the ask should be answered?')],
      planStepOutcomes: revopsAsksOutcomes,
    }));

    await runPhaseOne(t, ask);
    await authorClosing(t, ask);
    await holderBegins(t, holder);
    await closeOut(t, ask);
    await applyWaiting(t, holder);
    await settle(t);

    const row = await readItem(t, ask);
    expect(row.state).toBe('failed');
    expect(row.skipReason).toContain('approved plan step(s) remained blocked: step 3 (');
    expect(recorded.closingPrompts).toHaveLength(2);
    expect(recorded.closingAnswers).toHaveLength(0);
    expect(posted().some((body) => body.channel === REVOPS_ASKS_ASK.replyTarget.channel)).toBe(false);
  }, 30_000);

  it('sends the messages of a set whose executor was told of the holder as they were written, and still authors once more for the reply it left out', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { ask, holder } = await seed(t);
    // Told of the holder, the executor still fills and Saves; sent back once by its own reply check, it answers the same.
    recorded.closingAnswers.push(RUN_CLOSING, RUN_CLOSING, closingAnswer({
      draft: 'Answered from the tile as read.', notes: '',
      actions: [threadReply('Pipeline coverage reads 74% on the tile; the field refresh is held by its own work item.')],
      planStepOutcomes: satisfied('ledger rows 0 to 3 and 6'),
    }));

    await runPhaseOne(t, ask);
    // The sibling holds the field before this closing set is authored: the executor is told, and ignores it.
    await holderBegins(t, holder);
    await applyWaiting(t, holder);
    await authorClosing(t, ask);
    expect(recorded.closingPrompts[0]).toContain(`page field "Pipeline coverage" · this employee · "${OPS_REQUESTS_ASK_TITLE}"`);
    await closeOut(t, ask);
    await settle(t);

    const row = await readItem(t, ask);
    const { applied = [] } = outputOf(row);
    expect(applied[4]).toMatchObject({ held: true });
    expect(applied[5]).toMatchObject({ held: true });
    expect(applied[7]).toMatchObject({ ok: true, tool: 'http.request' });
    expect(applied[7]!.held).toBeUndefined();
    // The DM went out with whose work the refresh is, as the authoring's own check completes it.
    expect(String(posted().find((body) => body.channel === MANAGER_DM)?.text)).toContain(`Pipeline coverage on ${SLUG} is refreshed by its own work item ("${OPS_REQUESTS_ASK_TITLE}"); it was not written from this request.`);
    expect(recorded.closingPrompts).toHaveLength(3);
    expect(saves()).toBe(1);
    expect(row.state).toBe('completed');
    const events = await t.run(async (ctx) => await ctx.db.query('events').collect());
    expect(events.filter((event) => event.type === 'work.closing-reauthored').map((event) => (event.payload as { reason?: string }).reason)).toEqual(['reply-owed']);
    expect(posted().filter((body) => body.channel === REVOPS_ASKS_ASK.replyTarget.channel)).toHaveLength(1);
  }, 30_000);

  it("the day's own race: the claim is taken while the set is authored, the holders are read again before the set goes on, and nothing is withheld because nothing is written", async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { ask, holder } = await seed(t);
    recorded.closingAnswers.push(RUN_CLOSING, closingAnswer({
      draft: 'Answered from the tile as read.', notes: '',
      actions: [tile('browser_snapshot', {}), threadReply('Pipeline coverage reads 68% on the tile as I read it just now.')],
      planStepOutcomes: satisfied('ledger rows 0 to 3: the tile read 68%'),
    }));
    // 19 September, 01:48:36 UTC: the sibling's claim landed 170 ms after this authoring began, 18 s before it ended.
    recorded.duringClosing = async (): Promise<void> => await holderBegins(t, holder);

    await runPhaseOne(t, ask);
    await authorClosing(t, ask);

    // Authored twice in the one authoring turn: the second time under the holders as they stood when the first came back.
    expect(recorded.closingPrompts).toHaveLength(2);
    expect(recorded.closingPrompts[0]).not.toContain('page field');
    expect(recorded.closingPrompts[1]).toContain(`${SLUG} · page field "Pipeline coverage" · this employee · "${OPS_REQUESTS_ASK_TITLE}"`);
    const waiting = (await readItem(t, ask)).output as { actions: MockAction[]; authoredUnder?: Array<{ externalId: string }> };
    expect(waiting.actions).toHaveLength(2);
    expect(waiting.authoredUnder?.map((listed) => listed.externalId)).toContain('Pipeline coverage');

    await closeOut(t, ask);
    await applyWaiting(t, holder);
    await settle(t);

    const row = await readItem(t, ask);
    expect(row.state).toBe('completed');
    const { actions = [], applied = [] } = outputOf(row);
    expect(actions).toHaveLength(6);
    expect(applied.every((entry) => entry.ok && !entry.held)).toBe(true);
    expect(JSON.stringify(actions)).not.toContain('"Pipeline coverage\\",\\"value\\":\\"74%');
    expect(saves()).toBe(1);

    const replies = posted().filter((body) => body.channel === REVOPS_ASKS_ASK.replyTarget.channel);
    expect(replies).toHaveLength(1);
    // The set that was dropped wrote the field, so the reply owes the asker whose work that is.
    expect(replies[0]!.text).toContain(`Pipeline coverage on ${SLUG} is refreshed by its own work item ("${OPS_REQUESTS_ASK_TITLE}"); it was not written from this request.`);
    expect(posted().map((body) => String(body.text)).filter((text) => /emitted the documented refresh/.test(text))).toEqual([]);

    const events = await t.run(async (ctx) => await ctx.db.query('events').collect());
    expect(events.filter((event) => event.type === 'work.closing-reauthored').map((event) => event.payload)).toEqual([
      expect.objectContaining({ workItemId: ask, reason: 'holder-changed', heldNow: ['Pipeline coverage'] }),
    ]);
  }, 30_000);

  it('keeps the holders the set was authored under at the finish: a holder that goes away while the set waits does not fail a run whose reply said where the work is', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { ask, holder } = await seed(t);
    recorded.closingAnswers.push(RUN_CLOSING, closingAnswer({
      draft: 'Answered from the tile as read.', notes: '',
      actions: [threadReply('Pipeline coverage reads 68% on the tile; the field refresh is held by its own work item.')],
      planStepOutcomes: satisfied('ledger rows 0 to 3: the tile read 68%'),
    }));
    recorded.duringClosing = async (): Promise<void> => await holderBegins(t, holder);

    await runPhaseOne(t, ask);
    await authorClosing(t, ask);
    const authoredUnder = ((await readItem(t, ask)).output as { authoredUnder?: unknown[] }).authoredUnder;
    // The holder is cancelled while the set waits; what the set was authored under stands on the row.
    await t.run(async (ctx) => await ctx.db.patch(holder, { state: 'skipped' }));
    await closeOut(t, ask);

    const row = await readItem(t, ask);
    expect(row.state).toBe('completed');
    expect(recorded.closingPrompts).toHaveLength(2);
    expect(authoredUnder).toEqual(expect.arrayContaining([expect.objectContaining({ externalId: 'Pipeline coverage', pageField: true })]));
  }, 30_000);
});
