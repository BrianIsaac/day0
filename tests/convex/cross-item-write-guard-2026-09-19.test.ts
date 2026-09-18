/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { McpClientLike, McpClientOptions } from '../../src/surfaces/mcp';
import { HELD_WITHHELD_TRANSITION } from '../../src/surfaces/policy';
import type { AppliedAction } from '../../src/surfaces/types';
import { withheldByClaim, withheldByClaimReason } from '../../src/work/claim-key';
import type { ExecutionPlan, MockAction } from '../../src/work/types';
import { blockedPlanReason } from '../../convex/workActions';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * Finding D of the 19 September full run: two items wrote one ticket.
 *
 * Mateo's FIN-1 item held the claim `linear:FIN-1` and posted the close
 * status note on it; his `#finance-close` ask's item held the claim on the
 * Slack message, and its plan wrote FIN-1 too: a second note
 * (`fec3d2bd-...` beside `f35414fd-...`) and a second move to Done. The
 * claim guarded the item a row was discovered from, never the item a plan
 * writes. The actions below are the two rows' own `output.actions` from the
 * run's export; the model is not involved, the apply is the real one.
 */

const recorded = vi.hoisted(() => ({
  mcp: [] as Array<{ server: string; tool: string; args: unknown }>,
  http: [] as Array<{ url: string; body: unknown }>,
}));

vi.mock('../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (args: { agent: { name: string } }): Promise<unknown> => {
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
          ['list_issues', 'save_comment', 'save_issue'].map((tool) => [
            `${options.serverName}_${tool}`,
            {
              execute: async (args: unknown): Promise<unknown> => {
                recorded.mcp.push({ server: options.serverName, tool, args });
                if (tool === 'save_comment') return text(JSON.stringify({ id: SECOND_NOTE_ID }));
                if (tool === 'save_issue') return text(JSON.stringify({ id: 'FIN-1', state: { name: 'Done' } }));
                return text('FIN-1 Post the September close status note (Todo); FIN-2 Accruals booked for September (Done); FIN-3 Bank reconciliation for September (In Progress)');
              },
            },
          ]),
        ),
      disconnect: async (): Promise<void> => {},
    }),
  };
});

vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit): Promise<Response> => {
  recorded.http.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
  return new Response(JSON.stringify({ ok: true, ts: '1789758308.103999' }), { status: 200 });
});

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };
const CREDENTIAL_KEY = randomBytes(32).toString('base64');

const WORKSPACE = 'T0BSQSQG0UU';
const ASK_CHANNEL = 'C0C2P932A2H';
const ASK_TS = '1789757862.783069';
const ASK_EXTERNAL_ID = `${ASK_CHANNEL}:${ASK_TS}`;
const ASK_TITLE = 'Slack mention in #finance-close';
const TICKET_TITLE = 'Post the September close status note';
const FIRST_NOTE_ID = 'f35414fd-91b6-44cf-9541-74b932b98363';
const SECOND_NOTE_ID = 'fec3d2bd-a3c4-420d-b7d9-c406e75688e2';
const NOTE = 'Accruals booked: FIN-2 Accruals booked for September, Done\nBank reconciliation: FIN-3 Bank reconciliation for September, In Progress\nNot done yet: Bank reconciliation';

const mcp = (tool: string, toolArgs: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call',
  args: { surface: 'linear', tool, toolArgsJson: JSON.stringify(toolArgs) },
});
const LIST = mcp('list_issues', { team: 'FIN', project: 'September close', limit: 50 });
const NOTE_ON_TICKET = mcp('save_comment', { issueId: 'FIN-1', body: NOTE });
const TICKET_TO_DONE = mcp('save_issue', { id: 'FIN-1', state: 'Done' });
const threadReply = (channel: string, threadTs: string): MockAction => ({
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}', 'Content-Type': 'application/json; charset=utf-8' }),
    body: JSON.stringify({ channel, thread_ts: threadTs, text: NOTE }),
  },
});

/** The ask's item's actions as the run recorded them: the read, the thread reply, the note and the move. */
const ASK_ACTIONS: MockAction[] = [LIST, threadReply(ASK_CHANNEL, ASK_TS), NOTE_ON_TICKET, TICKET_TO_DONE];

/** One employee of an owner with the run's two cards connected and autonomy on. */
async function seedEmployee(harness: Harness, options: { name: string; userId?: string }): Promise<Id<'agents'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local', name: options.name, userId: options.userId ?? 'owner', state: 'active',
      autonomousActions: true, createdAt: 1,
    });
    for (const scope of ['boss:message', 'linear:read', 'linear:write', 'slack:read', 'slack:write']) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    const live = {
      credentialLanded: true, lastVerifiedAt: Date.now(), whereFound: [], createdAt: 1,
      discoveryEvidence: [{ kind: 'documentation', ref: 'onboarding.md', quote: 'Linear is the formal work queue', current: true, firstSeenAt: 1, lastSeenAt: 1 }],
    };
    await ctx.db.insert('surfaces', {
      agentId, slug: 'linear', displayName: 'Linear', class: 'kanban', verdict: 'connected',
      endpoint: 'https://mcp.linear.app/mcp', path: 'mcp',
      toolAllowlist: ['list_issues', 'save_comment', 'save_issue'],
      toolArguments: [
        { tool: 'list_issues', arguments: ['team', 'project', 'limit'] },
        { tool: 'save_comment', arguments: ['issueId', 'body', 'id', 'parentId'] },
        { tool: 'save_issue', arguments: ['id', 'state', 'title', 'description'] },
      ],
      credentialId: 'cred-linear', ...live,
    } as never);
    await ctx.db.insert('surfaces', {
      agentId, slug: 'slack', displayName: 'Slack', class: 'chat', verdict: 'connected',
      endpoint: 'https://slack.com/api/', path: 'documented-api', toolAllowlist: ['chat.postMessage'],
      credentialId: 'cred-slack', managerDmChannelId: 'D0MANAGER', managerUserId: 'UMANAGER',
      providerWorkspaceId: WORKSPACE, ...live,
    } as never);
    return agentId;
  });
}

interface ItemSpec {
  source: 'ticket' | 'ask';
  state: Doc<'workItems'>['state'];
  /** Whether the row holds the claim on the item it was discovered from. */
  claims?: boolean;
  output?: unknown;
}

/** A work item of the run: FIN-1's own row or the `#finance-close` ask's. */
async function seedItem(harness: Harness, agentId: Id<'agents'>, spec: ItemSpec): Promise<Id<'workItems'>> {
  return await harness.run(async (ctx) => {
    const agent = await ctx.db.get(agentId);
    const ticket = spec.source === 'ticket';
    const externalClaimKey = ticket ? 'linear:FIN-1' : `slack:${WORKSPACE}:${ASK_EXTERNAL_ID}`;
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: ticket ? 'ticket-queue' : 'chat-mention',
      sourceSystem: ticket ? 'linear' : 'slack',
      externalId: ticket ? 'FIN-1' : ASK_EXTERNAL_ID,
      externalClaimKey,
      title: ticket ? TICKET_TITLE : ASK_TITLE,
      contentSummary: ticket ? 'Post the close status note for the September close on this ticket.' : '@Day0 can you post where the September close stands?',
      contentRefs: [],
      ...(ticket ? {} : { replyTarget: { channel: ASK_CHANNEL, threadTs: ASK_TS } }),
      state: spec.state,
      verdict: { decision: 'claim', value: 60, risk: 30, requiredPermissions: ['linear:read'] },
      ...(spec.output === undefined ? {} : { output: spec.output }),
      observedAt: 1, createdAt: 1,
    } as never);
    if (spec.claims !== false) {
      await ctx.db.insert('externalClaims', {
        userId: agent!.userId!, key: externalClaimKey, agentId, workItemId, claimedAt: 1,
      });
    }
    return workItemId;
  });
}

/** FIN-1's own row as the run left it: completed, the note landed, the ticket at Done. */
const TICKET_COMPLETED_OUTPUT = {
  draft: 'September close status note.', notes: '',
  actions: [LIST, NOTE_ON_TICKET, TICKET_TO_DONE],
  applied: [
    { tool: 'mcp.call', ok: true, effect: 'list_issues on linear', authority: 'autonomous', idempotencyKey: 'ticket:run:0' },
    { tool: 'mcp.call', ok: true, effect: 'save_comment on linear', providerId: FIRST_NOTE_ID, authority: 'autonomous', idempotencyKey: 'ticket:run:1' },
    { tool: 'mcp.call', ok: true, effect: 'save_issue on linear', providerId: 'FIN-1', authority: 'autonomous', idempotencyKey: 'ticket:run:2' },
  ],
};

/** Put a row at the apply of its set: every listed index automatic, the rest held for the manager. */
async function atApply(
  harness: Harness,
  workItemId: Id<'workItems'>,
  actions: MockAction[],
  heldForManager: readonly number[] = [],
): Promise<void> {
  await harness.run(async (ctx) => {
    const row = await ctx.db.get(workItemId);
    const runId = await ctx.db.insert('events', {
      agentId: row!.agentId, type: 'work.execution-claimed', payload: { workItemId }, createdAt: Date.now(),
    });
    await ctx.db.patch(workItemId, {
      state: 'executing', executionRunId: runId, pendingRunId: runId, applyPhase: 'auto',
      approvedIndexes: actions.map((_, index) => index).filter((index) => !heldForManager.includes(index)),
      actionVerdicts: actions.map((_, index) =>
        heldForManager.includes(index)
          ? { disposition: 'held' as const, reason: HELD_WITHHELD_TRANSITION }
          : { disposition: 'auto' as const },
      ),
      output: { draft: 'Where the September close stands.', notes: '', actions },
    });
  });
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

const ledger = (row: Doc<'workItems'>): AppliedAction[] => (row.output as { applied: AppliedAction[] }).applied;
const ticketWrites = (): string[] =>
  recorded.mcp.filter((call) => call.tool === 'save_comment' || call.tool === 'save_issue').map((call) => call.tool);
const threadReplies = (): unknown[] => recorded.http.filter((call) => call.url.endsWith('/chat.postMessage')).map((call) => call.body);

describe('a write to an external item another work item holds (finding D, 19 September)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', CREDENTIAL_KEY);
  });

  afterEach((): void => {
    recorded.mcp.length = 0;
    recorded.http.length = 0;
    vi.unstubAllEnvs();
    restoreSurfaceMode();
  });

  it('withholds the ask\'s note and move on the ticket its employee\'s other item holds, names the holder, and still answers the thread', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    await seedItem(t, mateo, { source: 'ticket', state: 'completed', output: TICKET_COMPLETED_OUTPUT });
    const ask = await seedItem(t, mateo, { source: 'ask', state: 'plan-approved' });
    await atApply(t, ask, ASK_ACTIONS);

    await t.action(internal.workActions.applyApprovedActions, { workItemId: ask });

    expect(ticketWrites()).toEqual([]);
    expect(threadReplies()).toHaveLength(1);
    const done = await readItem(t, ask);
    expect(done.state).toBe('completed');
    const rows = ledger(done);
    expect(rows[1]).toMatchObject({ ok: true, authority: 'autonomous' });
    for (const index of [2, 3]) {
      expect(rows[index]).toMatchObject({ ok: true, held: true });
      expect(rows[index]!.authority).toBeUndefined();
      expect(rows[index]!.reason).toContain('FIN-1');
      expect(rows[index]!.reason).toContain(TICKET_TITLE);
      expect(rows[index]!.reason).toContain('completed');
      expect(rows[index]!.reason).toContain("this employee's");
    }
    // The line cites the note that landed, so the answer can point at it.
    expect(rows[2]!.reason).toContain(FIRST_NOTE_ID);
  });

  it('holds across employees: a colleague\'s item holds the ticket, and the line names the colleague', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    const aiko = await seedEmployee(t, { name: 'Aiko' });
    await seedItem(t, aiko, { source: 'ticket', state: 'executing' });
    const ask = await seedItem(t, mateo, { source: 'ask', state: 'plan-approved' });
    await atApply(t, ask, ASK_ACTIONS);

    await t.action(internal.workActions.applyApprovedActions, { workItemId: ask });

    expect(ticketWrites()).toEqual([]);
    expect(threadReplies()).toHaveLength(1);
    const done = await readItem(t, ask);
    expect(done.state).toBe('completed');
    for (const index of [2, 3]) {
      expect(ledger(done)[index]).toMatchObject({ ok: true, held: true });
      expect(ledger(done)[index]!.reason).toContain("Aiko's");
      expect(ledger(done)[index]!.reason).toContain('executing');
    }
  });

  it('leaves a write to an item nobody holds untouched', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    const ask = await seedItem(t, mateo, { source: 'ask', state: 'plan-approved' });
    await atApply(t, ask, ASK_ACTIONS);

    await t.action(internal.workActions.applyApprovedActions, { workItemId: ask });

    expect(ticketWrites()).toEqual(['save_comment', 'save_issue']);
    const done = await readItem(t, ask);
    expect(done.state).toBe('completed');
    expect(ledger(done).map((row) => [row.ok, row.held === true])).toEqual([[true, false], [true, false], [true, false], [true, false]]);
  });

  it('leaves another owner\'s claim on the same key out of it, and a holder that let go', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    const stranger = await seedEmployee(t, { name: 'Noor', userId: 'another-owner' });
    await seedItem(t, stranger, { source: 'ticket', state: 'completed', output: TICKET_COMPLETED_OUTPUT });
    const cancelled = await seedItem(t, mateo, { source: 'ticket', state: 'cancelled', claims: false });
    await t.run(async (ctx) => {
      await ctx.db.insert('externalClaims', {
        userId: 'owner', key: 'linear:FIN-1', agentId: mateo, workItemId: cancelled, claimedAt: 1, releasedAt: 2,
      });
    });
    const ask = await seedItem(t, mateo, { source: 'ask', state: 'plan-approved' });
    await atApply(t, ask, ASK_ACTIONS);

    await t.action(internal.workActions.applyApprovedActions, { workItemId: ask });

    expect(ticketWrites()).toEqual(['save_comment', 'save_issue']);
  });

  it('lets the holder write its own ticket', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    const ticket = await seedItem(t, mateo, { source: 'ticket', state: 'plan-approved' });
    await atApply(t, ticket, [LIST, NOTE_ON_TICKET, TICKET_TO_DONE]);

    await t.action(internal.workActions.applyApprovedActions, { workItemId: ticket });

    expect(ticketWrites()).toEqual(['save_comment', 'save_issue']);
    expect((await readItem(t, ticket)).state).toBe('completed');
  });

  it('a completed holder still blocks a duplicate state change, whether the gate or the manager would have sent it', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    await seedItem(t, mateo, { source: 'ticket', state: 'completed', output: TICKET_COMPLETED_OUTPUT });
    // As the run had it: the move was held for the manager, the rest automatic.
    const ask = await seedItem(t, mateo, { source: 'ask', state: 'plan-approved' });
    await atApply(t, ask, ASK_ACTIONS, [3]);

    await t.action(internal.workActions.applyApprovedActions, { workItemId: ask });

    // Nothing is left for the manager to approve: the move is withheld at once.
    const done = await readItem(t, ask);
    expect(done.state).toBe('completed');
    expect(ledger(done)[3]).toMatchObject({ ok: true, held: true });
    expect(ledger(done)[3]!.awaitingApproval).toBeUndefined();
    expect(ledger(done)[3]!.reason).toContain(TICKET_TITLE);
    expect(ticketWrites()).toEqual([]);
  });

  it('withholds a move the manager approved once the holder has appeared since the hold', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    const ask = await seedItem(t, mateo, { source: 'ask', state: 'plan-approved' });
    await atApply(t, ask, [LIST, TICKET_TO_DONE], [1]);
    await t.action(internal.workActions.applyApprovedActions, { workItemId: ask });
    const parked = await readItem(t, ask);
    expect(parked.state).toBe('actions-pending');
    expect(ledger(parked)[1]).toMatchObject({ held: true, awaitingApproval: true });

    // FIN-1's own item is claimed and completes while the ask waits on the manager.
    await seedItem(t, mateo, { source: 'ticket', state: 'completed', output: TICKET_COMPLETED_OUTPUT });
    await t.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId: ask, pendingRunId: parked.pendingRunId!, approvedIndexes: [1],
    });
    await t.action(internal.workActions.applyApprovedActions, { workItemId: ask });

    const done = await readItem(t, ask);
    expect(done.state).toBe('completed');
    expect(ledger(done)[1]).toMatchObject({ ok: true, held: true });
    expect(ledger(done)[1]!.reason).toContain(TICKET_TITLE);
    expect(ticketWrites()).toEqual([]);
  });

  it('withholds the mirror: the ticket\'s item replying in the thread the ask\'s item holds', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    await seedItem(t, mateo, { source: 'ask', state: 'completed' });
    const ticket = await seedItem(t, mateo, { source: 'ticket', state: 'plan-approved' });
    await atApply(t, ticket, [LIST, NOTE_ON_TICKET, TICKET_TO_DONE, threadReply(ASK_CHANNEL, ASK_TS)]);

    await t.action(internal.workActions.applyApprovedActions, { workItemId: ticket });

    expect(ticketWrites()).toEqual(['save_comment', 'save_issue']);
    expect(threadReplies()).toEqual([]);
    const done = await readItem(t, ticket);
    expect(done.state).toBe('completed');
    expect(ledger(done)[3]).toMatchObject({ ok: true, held: true });
    expect(ledger(done)[3]!.reason).toContain(ASK_TITLE);
  });

  it('does not fail a closing phase over a step the holder did: a claim-withheld write is accounted for, a plain held one is not', (): void => {
    const plan = { summary: 'Answer the ask.', steps: ['Read', 'Reply', 'Post the note'], expectedOutputType: 'message' } as unknown as ExecutionPlan;
    const outcomes = [{ step: 3, status: 'blocked' as const, evidence: 'the note on FIN-1 was withheld' }];
    const actions = [LIST, threadReply(ASK_CHANNEL, ASK_TS), NOTE_ON_TICKET];
    const landed = { tool: 'mcp.call', ok: true, idempotencyKey: 'k' };
    const byClaim = {
      ...landed, held: true,
      reason: withheldByClaimReason({ target: 'FIN-1', holderName: 'Mateo', sameEmployee: true, title: TICKET_TITLE, state: 'completed' }),
    };
    expect(blockedPlanReason(outcomes, { plan, actions, applied: [landed, landed, byClaim] })).toBeUndefined();
    const byManager = { ...landed, held: true, reason: 'not approved by the manager' };
    expect(blockedPlanReason(outcomes, { plan, actions, applied: [landed, landed, byManager] })).toContain('remained blocked');
  });
});

/**
 * The order the run actually took. The ask's item was approved at 03:03:42 and
 * wrote FIN-1; FIN-1's own item took its claim at 03:03:59. For those
 * seventeen seconds nobody held `linear:FIN-1`, so a guard that reads only
 * the claims let the ask's note land, and the ticket's item then posted a
 * second on its own key.
 */
const ASK_APPROVED_AT = Date.UTC(2026, 8, 19, 3, 3, 42);
const TICKET_CLAIMED_AT = Date.UTC(2026, 8, 19, 3, 3, 59);

describe('a write to an external item that has a work item of its own, claimed or not (finding D, the order of the run)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', CREDENTIAL_KEY);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ASK_APPROVED_AT);
  });

  afterEach((): void => {
    recorded.mcp.length = 0;
    recorded.http.length = 0;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    restoreSurfaceMode();
  });

  it('withholds the ask that writes first, then lands exactly one note when the ticket\'s own item claims and writes', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    const ticket = await seedItem(t, mateo, { source: 'ticket', state: 'discovered', claims: false });
    const ask = await seedItem(t, mateo, { source: 'ask', state: 'plan-approved' });
    await atApply(t, ask, ASK_ACTIONS);

    await t.action(internal.workActions.applyApprovedActions, { workItemId: ask });

    expect(ticketWrites()).toEqual([]);
    expect(threadReplies()).toHaveLength(1);
    const answered = await readItem(t, ask);
    expect(answered.state).toBe('completed');
    for (const index of [2, 3]) {
      const row = ledger(answered)[index]!;
      expect(row).toMatchObject({ ok: true, held: true });
      expect(row.authority).toBeUndefined();
      expect(withheldByClaim(row)).toBe(true);
      expect(row.reason).toContain('FIN-1 has its own work item with this employee');
      expect(row.reason).toContain(TICKET_TITLE);
      expect(row.reason).toContain('discovered');
      expect(row.reason).toContain('will be written there');
    }

    vi.setSystemTime(TICKET_CLAIMED_AT);
    await t.run(async (ctx) => {
      await ctx.db.patch(ticket, { verdict: undefined });
    });
    await t.mutation(internal.work.setVerdict, {
      workItemId: ticket,
      verdict: { decision: 'claim', value: 60, risk: 30, requiredPermissions: ['linear:read'] },
    });
    expect((await readItem(t, ticket)).state).toBe('claimed');
    await atApply(t, ticket, [LIST, NOTE_ON_TICKET, TICKET_TO_DONE]);
    await t.action(internal.workActions.applyApprovedActions, { workItemId: ticket });

    expect(ticketWrites()).toEqual(['save_comment', 'save_issue']);
    expect((await readItem(t, ticket)).state).toBe('completed');
  });

  it('holds across two employees: a colleague\'s unclaimed item for the ticket withholds the ask, by name', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    const aiko = await seedEmployee(t, { name: 'Aiko' });
    await seedItem(t, aiko, { source: 'ticket', state: 'deferred', claims: false });
    const ask = await seedItem(t, mateo, { source: 'ask', state: 'plan-approved' });
    await atApply(t, ask, ASK_ACTIONS);

    await t.action(internal.workActions.applyApprovedActions, { workItemId: ask });

    expect(ticketWrites()).toEqual([]);
    expect(threadReplies()).toHaveLength(1);
    const answered = await readItem(t, ask);
    expect(answered.state).toBe('completed');
    expect(ledger(answered)[2]!.reason).toContain('FIN-1 has its own work item with Aiko');
    expect(ledger(answered)[2]!.reason).toContain('deferred');
  });

  it('never withholds the ticket\'s own item from its own key, whatever a colleague\'s row for the same ticket is doing', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    const aiko = await seedEmployee(t, { name: 'Aiko' });
    await seedItem(t, aiko, { source: 'ticket', state: 'discovered', claims: false });
    const ticket = await seedItem(t, mateo, { source: 'ticket', state: 'plan-approved' });
    await atApply(t, ticket, [LIST, NOTE_ON_TICKET, TICKET_TO_DONE]);

    await t.action(internal.workActions.applyApprovedActions, { workItemId: ticket });

    expect(ticketWrites()).toEqual(['save_comment', 'save_issue']);
    expect(ledger(await readItem(t, ticket)).every((row) => row.held !== true)).toBe(true);
  });

  it.each(['skipped', 'cancelled', 'failed'] as const)('a %s item that never claimed the ticket does not block', async (state): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    await seedItem(t, mateo, { source: 'ticket', state, claims: false });
    const ask = await seedItem(t, mateo, { source: 'ask', state: 'plan-approved' });
    await atApply(t, ask, ASK_ACTIONS);

    await t.action(internal.workActions.applyApprovedActions, { workItemId: ask });

    expect(ticketWrites()).toEqual(['save_comment', 'save_issue']);
  });

  it('leaves another owner\'s unclaimed item for the same ticket out of it', async (): Promise<void> => {
    const t = convexTest(contractSchema(), allConvexModules());
    const mateo = await seedEmployee(t, { name: 'Mateo' });
    const stranger = await seedEmployee(t, { name: 'Noor', userId: 'another-owner' });
    await seedItem(t, stranger, { source: 'ticket', state: 'discovered', claims: false });
    const ask = await seedItem(t, mateo, { source: 'ask', state: 'plan-approved' });
    await atApply(t, ask, ASK_ACTIONS);

    await t.action(internal.workActions.applyApprovedActions, { workItemId: ask });

    expect(ticketWrites()).toEqual(['save_comment', 'save_issue']);
  });
});
