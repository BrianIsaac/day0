/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { McpClientLike, McpClientOptions } from '../../src/surfaces/mcp';
import type { AppliedAction } from '../../src/surfaces/types';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import {
  RUN_3_AUDIT_LINE,
  RUN_3_CORRECTION_NOTE,
  RUN_3_FIRST_COMMENT,
  RUN_3_RETRY_COMMENT_CORRECTED,
  RUN_3_RETRY_NOTE,
  RUN_3_STARTING_COMMENT,
  run3AuditNotePlan,
  run3CorrectionClosing,
  run3FirstClosing,
  run3FirstPhaseOne,
  run3ObedientClosing,
  run3RetryClosing,
  run3RetryPhaseOne,
  run3TwoCommentClosing,
  run3TwoCommentPhaseOne,
} from './fixtures/retry-reentry-2026-09-16';
import { landedWritesOf } from '../../src/work/landed-writes';
import { providerReconciliationEntries } from '../../src/work/reconciliation';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { HELD_WITHHELD_TRANSITION } from '../../src/surfaces/policy';
import { randomBytes } from 'node:crypto';

/**
 * The 16 September third run's REVOPS-5 item, replayed twice through the
 * real gate, the real apply and the real retry: the first run's phase one
 * lands the reads and the audit comment autonomously and its closing phase
 * blocks the Done on the checklist's rule; the manager reconciles and
 * retries with a note; the retry re-enters phase one, reads again, and its
 * closing phase authors a rewritten comment and the Done. The model is
 * scripted per agent and per run; everything between is the real code.
 */

const FIRST_COMMENT_ID = 'comment-6098cba6';
/** The tile as the browser double snapshots it: the sign-in form, the figure and the audit line. */
const TILE_SNAPSHOT = [
  '- textbox "Username" [ref=e11]',
  '- textbox "Password" [ref=e14]',
  '- button "Sign in" [ref=e15]',
  '- textbox "Pipeline coverage" [ref=e21]',
  '- button "Save" [ref=e23]',
  '- generic [ref=e30]: visible figure 74%',
  `- generic [ref=e31]: ${RUN_3_AUDIT_LINE}`,
].join('\n');
const SECOND_COMMENT_ID = 'comment-7b20a291';

const recorded = vi.hoisted(() => ({
  mcp: [] as Array<{ server: string; tool: string; args: unknown }>,
  http: [] as Array<{ url: string; body: unknown }>,
  model: [] as Array<{ agent: string; user: string }>,
  initialReply: undefined as unknown,
  closingReply: undefined as unknown,
  commentIds: [] as string[],
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
                if (tool === 'save_comment') {
                  const id = recorded.commentIds.shift() ?? SECOND_COMMENT_ID;
                  return text(JSON.stringify({ id }));
                }
                if (tool === 'save_issue') return text(JSON.stringify({ id: 'lin-5', state: { name: 'Done' } }));
                if (tool === 'list_issues') {
                  return text('REVOPS-5 Add the close-summary audit note (In Progress); REVOPS-6 Reconcile Northstar CRM ownership (Backlog); REVOPS-7 Refresh the Looker pipeline tile (Backlog)');
                }
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

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };
const CREDENTIAL_KEY = randomBytes(32).toString('base64');

/** An agent with the run's three surfaces, autonomy on, and REVOPS-5 at the apply of its first phase one. */
async function seedAtFirstApply(harness: Harness, phaseOne: typeof run3FirstPhaseOne = run3FirstPhaseOne): Promise<{ workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local', name: 'Priya', userId: 'owner', state: 'active', autonomousActions: true, createdAt: 1,
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
      agentId, sourceCategory: 'ticket-queue', sourceSystem: 'linear', externalId: 'REVOPS-5', title: 'Add the close-summary audit note',
      contentSummary: 'Add the close-summary audit note to REVOPS-5 per the Q3 close checklist.', contentRefs: ['ticket://REVOPS-5'], priority: 'Medium',
      state: 'executing', skillId, plan: run3AuditNotePlan,
      verdict: { decision: 'claim', value: 60, risk: 30, requiredPermissions: ['linear:read'] },
      observedAt: 1, createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId, type: 'work.execution-claimed', payload: { workItemId }, createdAt: Date.now(),
    });
    // Phase one held nothing: with autonomy on every row is automatic, and the apply is scheduled.
    await ctx.db.patch(workItemId, {
      executionRunId: runId, pendingRunId: runId, applyPhase: 'auto',
      approvedIndexes: phaseOne.actions.map((_, index) => index),
      output: phaseOne,
    });
    return { workItemId, runId };
  });
}

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

const ledger = (row: Doc<'workItems'>): AppliedAction[] => (row.output as { applied: AppliedAction[] }).applied;

/**
 * The plan conditions the Done on the manager's approval, so the closing
 * phase's Done is held for the manager whatever the switch says: the run
 * parks with the comment landed, the manager approves the Done, and the
 * item completes.
 */
/** The Done lands on the manager's note alone: no held row, the item completes, and the hold event records why. */
async function landedOnNote(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const done = await settle(harness, workItemId, ['actions-pending', 'failed', 'completed']);
  expect(done.state).toBe('completed');
  expect((done.actionVerdicts ?? []).map((verdict) => verdict.disposition)).not.toContain('held');
  const events = await harness.run(async (ctx) => await ctx.db.query('events').collect());
  const applying = events.filter((event) => event.type === 'work.actions-auto-applying' && (event.payload as { dependentPhase?: boolean }).dependentPhase);
  expect(applying.map((event) => (event.payload as { transitionDirectedByNote?: boolean }).transitionDirectedByNote)).toEqual([true]);
  return done;
}

async function approveHeldDone(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const held = await settle(harness, workItemId, ['actions-pending', 'failed', 'completed']);
  expect(held.state).toBe('actions-pending');
  const verdicts = held.actionVerdicts ?? [];
  const doneIndex = verdicts.findIndex((verdict) => verdict.disposition === 'held');
  expect(verdicts[doneIndex]?.reason).toBe(HELD_WITHHELD_TRANSITION);
  await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
    workItemId, pendingRunId: held.pendingRunId!, approvedIndexes: [doneIndex],
  });
  await harness.action(internal.workActions.applyApprovedActions, { workItemId });
  return await settle(harness, workItemId, ['failed', 'completed']);
}
const savedComments = (): Array<{ issueId: string; body: string; id?: string }> =>
  recorded.mcp.filter((call) => call.tool === 'save_comment').map((call) => call.args as { issueId: string; body: string; id?: string });

/** The first run as the third run recorded it: the comment lands in phase one, the closing phase blocks the Done. */
async function firstRun(t: Harness): Promise<{ workItemId: Id<'workItems'> }> {
  const { workItemId } = await seedAtFirstApply(t);
  recorded.commentIds.push(FIRST_COMMENT_ID);
  recorded.closingReply = run3FirstClosing;
  await t.action(internal.workActions.applyApprovedActions, { workItemId });
  const failed = await settle(t, workItemId, ['failed', 'completed']);
  expect(failed.state).toBe('failed');
  expect(failed.skipReason).toContain('1 approved plan step(s) remained blocked: step 5');
  expect(savedComments()).toHaveLength(1);
  expect(savedComments()[0]!.body).toContain(RUN_3_FIRST_COMMENT);
  expect(ledger(failed)[5]).toMatchObject({ ok: true, providerId: FIRST_COMMENT_ID, authority: 'autonomous' });
  recorded.model.length = 0;
  return { workItemId };
}

describe('the 16 September run 3 REVOPS-5 retry, re-entering phase one after a landed audit comment', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', CREDENTIAL_KEY);
  });

  afterEach((): void => {
    recorded.mcp.length = 0;
    recorded.http.length = 0;
    recorded.model.length = 0;
    recorded.commentIds.length = 0;
    recorded.initialReply = undefined;
    recorded.closingReply = undefined;
    restoreSurfaceMode();
  });

  it('reuses the landed comment on the retry: one save_comment ever reaches Linear, Done lands, the ledger shows the reuse', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await firstRun(t);

    await t.withIdentity(OWNER).mutation(api.work.reconcileFailed, { workItemId, confirmed: true });
    recorded.initialReply = run3RetryPhaseOne;
    recorded.closingReply = run3RetryClosing;
    // The retry resumes at plan-approved and the server runs the plan again.
    await t.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId, feedback: RUN_3_RETRY_NOTE });
    // The note directs the Done in so many words, so the hold the plan puts on it is the manager's word already given.
    const done = await landedOnNote(t, workItemId);
    expect(done.skipReason).toBeUndefined();

    // Exactly one comment ever reached Linear; the Done landed after it, on the manager's note.
    expect(recorded.model.map((call) => call.agent.split('-').pop())).toEqual(['initial', 'dependent']);
    expect(savedComments().map((comment) => comment.body.split('\n')[0])).toEqual([RUN_3_FIRST_COMMENT.split('\n')[0]]);
    expect(recorded.mcp.filter((call) => call.tool === 'save_issue').map((call) => call.args)).toEqual([{ id: 'REVOPS-5', state: 'Done' }]);
    const rows = ledger(done);
    const reused = rows[rows.length - 2]!;
    expect(reused).toMatchObject({ ok: true, providerId: FIRST_COMMENT_ID });
    expect(reused.reason).toContain(`reused landed comment ${FIRST_COMMENT_ID}`);
    expect(rows[rows.length - 1]).toMatchObject({ ok: true, authority: 'autonomous' });
    // The transition step rests on the note, recorded on the row; the ledger steps carry no basis once persisted.
    expect((done.output as { planStepOutcomes: Array<{ status: string; basis?: string }> }).planStepOutcomes.map((row) => [row.status, row.basis])).toEqual([
      ['satisfied', undefined], ['satisfied', undefined], ['satisfied', undefined], ['satisfied', undefined], ['satisfied', 'manager-feedback'],
    ]);
    // Provider reconciliation for this row lists the real comment once, under the reused row, and the Done once.
    const reconciled = providerReconciliationEntries(done.output);
    expect(reconciled.filter((entry) => entry.providerId === FIRST_COMMENT_ID)).toHaveLength(1);
    expect(reconciled.filter((entry) => entry.providerId === 'lin-5')).toHaveLength(1);
    // The next retry's list: both runs' browser writes, the comment once (the reused row carries its provider id), the Done.
    const listed = landedWritesOf(done.output);
    expect(listed.map((write) => write.applied.providerId ?? write.action.args?.tool)).toEqual(['browser_fill_form', 'browser_click', FIRST_COMMENT_ID, 'browser_fill_form', 'browser_click', 'lin-5']);
    expect(listed.filter((write) => write.applied.providerId === FIRST_COMMENT_ID)).toHaveLength(1);

    // The retry's phase one signed in and read again: an earlier run's browser
    // writes are not "already landed" for a new session, whatever their payload.
    const retryCalls = recorded.mcp.slice(recorded.mcp.findIndex((call) => call.tool === 'save_comment') + 1).map((call) => call.tool);
    expect(retryCalls).toEqual(['browser_navigate', 'browser_snapshot', 'browser_fill_form', 'browser_snapshot', 'browser_click', 'browser_snapshot', 'list_issues', 'save_issue']);
    expect(rows.slice(0, 5).map((row) => row.reason ?? '')).toEqual(['', '', '', '', '']);

    // The retry went back through phase one, then authored the closing set: both prompts name the landed comment.
    for (const call of recorded.model) {
      expect(call.user).toContain('Writes earlier runs of this item already landed');
      expect(call.user).toContain(FIRST_COMMENT_ID);
      expect(call.user).toContain('linear · save_comment · REVOPS-5');
      expect(call.user).toContain(RUN_3_RETRY_NOTE);
    }
  });

  it('tells both executor phases which external items other work items hold, with no secret-shaped value from a title', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await firstRun(t);
    const secret = ['xoxb', '2847561930', '5529104736', 'aBcDeFgHiJkLmNoPqRsTuVwX'].join('-');
    await t.run(async (ctx) => {
      const aiko = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local', name: 'Aiko', userId: 'owner', state: 'active', autonomousActions: true, createdAt: 1,
      });
      await ctx.db.insert('workItems', {
        agentId: aiko, sourceCategory: 'ticket-queue', sourceSystem: 'linear', externalId: 'REVOPS-27',
        externalClaimKey: 'linear:REVOPS-27', title: `Refresh the pipeline coverage tile ${secret}`,
        contentSummary: 'Refresh the tile.', contentRefs: [], state: 'discovered', observedAt: 1, createdAt: 1,
      });
    });

    await t.withIdentity(OWNER).mutation(api.work.reconcileFailed, { workItemId, confirmed: true });
    recorded.initialReply = run3RetryPhaseOne;
    recorded.closingReply = run3RetryClosing;
    await t.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId, feedback: RUN_3_RETRY_NOTE });
    await landedOnNote(t, workItemId);

    expect(recorded.model.map((call) => call.agent.split('-').pop())).toEqual(['initial', 'dependent']);
    for (const call of recorded.model) {
      expect(call.user).toContain('--- External items other work items hold (1) ---');
      expect(call.user).toContain('linear · REVOPS-27 · Aiko · "Refresh the pipeline coverage tile');
      expect(call.user).toContain('(discovered, not claimed yet) · nothing landed yet');
      expect(call.user).not.toContain(secret);
      // The item being worked is never listed as held elsewhere.
      expect(call.user).not.toContain('linear · REVOPS-5 · this employee');
    }
  });

  it('lands the Done when the retry obeys the prompt and emits no second comment: the landed comment is the audit trail', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await firstRun(t);

    await t.withIdentity(OWNER).mutation(api.work.reconcileFailed, { workItemId, confirmed: true });
    recorded.initialReply = run3RetryPhaseOne;
    recorded.closingReply = run3ObedientClosing(FIRST_COMMENT_ID);
    await t.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId, feedback: RUN_3_RETRY_NOTE });
    const done = await landedOnNote(t, workItemId);
    expect(done.skipReason).toBeUndefined();

    expect(savedComments()).toHaveLength(1);
    expect(recorded.mcp.filter((call) => call.tool === 'save_issue').map((call) => call.args)).toEqual([{ id: 'REVOPS-5', state: 'Done' }]);
    const rows = ledger(done);
    expect(rows[rows.length - 1]).toMatchObject({ ok: true, authority: 'autonomous', providerId: 'lin-5' });
  });

  it('posts the closing audit comment after a fixed-payload comment phase one landed on the same ticket: two comments the plan asked for', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seedAtFirstApply(t, run3TwoCommentPhaseOne);
    recorded.commentIds.push('comment-start', 'comment-audit');
    recorded.closingReply = run3TwoCommentClosing;
    await t.action(internal.workActions.applyApprovedActions, { workItemId });
    const done = await approveHeldDone(t, workItemId);
    expect(done.skipReason).toBeUndefined();
    expect(done.state).toBe('completed');

    expect(savedComments().map((comment) => comment.body.split('\n')[0])).toEqual([
      RUN_3_STARTING_COMMENT,
      RUN_3_RETRY_COMMENT_CORRECTED.split('\n')[0],
    ]);
    const rows = ledger(done);
    expect(rows[rows.length - 2]).toMatchObject({ ok: true, providerId: 'comment-audit' });
    expect(rows[rows.length - 2]!.reason ?? '').not.toContain('reused');
  });

  it('lets a rewrite with id through when the manager\'s note asks for a correction', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await firstRun(t);

    await t.withIdentity(OWNER).mutation(api.work.reconcileFailed, { workItemId, confirmed: true });
    recorded.initialReply = run3RetryPhaseOne;
    recorded.closingReply = run3CorrectionClosing(FIRST_COMMENT_ID);
    await t.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId, feedback: RUN_3_CORRECTION_NOTE });
    // The note asks for the correction and then directs the Done in so many words, so both land on the note.
    const done = await landedOnNote(t, workItemId);
    expect(done.skipReason).toBeUndefined();
    expect(done.state).toBe('completed');

    expect(savedComments()).toHaveLength(2);
    expect(savedComments()[1]).toMatchObject({ issueId: 'REVOPS-5', id: FIRST_COMMENT_ID });
    expect(savedComments()[1]!.body).toContain(RUN_3_RETRY_COMMENT_CORRECTED);
    expect(recorded.mcp.filter((call) => call.tool === 'save_issue')).toHaveLength(1);
    const rows = ledger(done);
    expect(rows[rows.length - 2]!.reason ?? '').not.toContain('reused landed comment');
  });
});
