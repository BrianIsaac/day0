/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { completionFailure } from '../../convex/workActions';
import { INTERRUPTED_APPLY_REASON } from '../../convex/work';
import type { McpClientLike, McpClientOptions } from '../../src/surfaces/mcp';
import {
  AWAITING_APPROVAL,
  HELD_MUTATION,
  HELD_NOT_APPROVED,
  HELD_PUBLIC_POST,
} from '../../src/surfaces/policy';
import type { AppliedAction } from '../../src/surfaces/types';
import type { ExecutionOutput } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

const recorded = vi.hoisted(() => ({
  mcp: [] as Array<{ server: string; tool: string; args: unknown; bearer: string }>,
  http: [] as Array<{ url: string; authorization: string; body: unknown }>,
  failMcpAfterRequest: false,
  afterCredentialRead: undefined as (() => Promise<void>) | undefined,
  skillRuns: 0,
  skillModes: [] as Array<string | undefined>,
  skillOutput: undefined as ExecutionOutput | undefined,
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
      args: { surface: 'linear', tool: 'save_issue', toolArgsJson: JSON.stringify({ id: 'iss-1', state: 'Done' }) },
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
    runSkill: async (args: { mode?: string }): Promise<ExecutionOutput> => {
      recorded.skillRuns += 1;
      recorded.skillModes.push(args.mode);
      return recorded.skillOutput ?? skillOutput;
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
      listTools: async () =>
        Object.fromEntries(
          ['save_comment', 'save_issue', 'get_issue', 'list_comments'].map((tool) => [
            `${options.serverName}_${tool}`,
            {
              execute: async (args: unknown): Promise<unknown> => {
                recorded.mcp.push({ server: options.serverName, tool, args, bearer: options.bearer ?? '' });
                if (recorded.failMcpAfterRequest) {
                  throw new Error('socket closed after provider accepted the request');
                }
                return { content: [{ type: 'text', text: JSON.stringify({ id: `${tool}-id` }) }] };
              },
            },
          ]),
        ),
      disconnect: async (): Promise<void> => {},
    }),
  };
});

vi.stubGlobal(
  'fetch',
  async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    recorded.http.push({ url: String(input), authorization: headers.Authorization, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: '1787654400.000200' }), { status: 200 });
  },
);

afterEach((): void => {
  recorded.mcp.length = 0;
  recorded.http.length = 0;
  recorded.failMcpAfterRequest = false;
  recorded.afterCredentialRead = undefined;
  recorded.skillRuns = 0;
  recorded.skillModes.length = 0;
  recorded.skillOutput = undefined;
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
      ...(options.autonomousActions !== undefined ? { autonomousActions: options.autonomousActions } : {}),
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
      const live = { credentialLanded: true, lastVerifiedAt: Date.now(), whereFound: [], createdAt: 1 };
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
        { tool: 'http.request', ok: true, held: true, reason: HELD_PUBLIC_POST, idempotencyKey: 'run:0' },
      ]),
    ).toBeUndefined();
  });
});

describe('executing an approved plan through the gate', (): void => {
  it('pauses a real-mode run at actions-pending with nothing but the DM applied', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real');
    const result = await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
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
    await expect(harness.action(internal.workActions.applyApprovedActions, { workItemId })).resolves.toEqual({
      ok: true,
      reason: "automatic actions applied; the rest await the manager's approval",
    });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('actions-pending');
    expect(row.pendingRunId).toBeDefined();
    expect((row.output as ExecutionOutput).actions).toEqual(skillOutput.actions);
    expect(ledger(row).map((entry) => [entry.ok, entry.held ?? false, entry.awaitingApproval ?? false, entry.authority])).toEqual([
      [true, true, true, undefined],
      [true, true, true, undefined],
      [true, false, false, 'standing'],
      [true, true, true, undefined],
    ]);
    expect(recorded.mcp).toHaveLength(0);
    expect(recorded.http.map((call) => (call.body as { channel: string }).channel)).toEqual(['D0MANAGER']);
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
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0, 1] });
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
        args: { issueId: 'iss-1', body: `Prepared the close summary.\n\n-- Priya (Day0) · run ${workItemId}/${runId}` },
        bearer: 'plain-cred-linear',
      },
      { server: 'linear', tool: 'save_issue', args: { id: 'iss-1', state: 'Done' }, bearer: 'plain-cred-linear' },
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
    await expect(harness.action(internal.workActions.applyApprovedActions, { workItemId })).resolves.toEqual({
      ok: false,
      reason: 'workItem state is completed; expected actions-pending',
    });
  });

  it('holds unapproved indexes and fails a status change whose comment was held', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    const { runId } = await park(harness, workItemId);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [1] });
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
    const { workItemId } = await seed(harness, 'real', ['boss:message', 'linear:read', 'linear:write', 'slack:read']);
    const { row: pending, runId } = await park(harness, workItemId);
    expect(pending.actionVerdicts).toEqual([
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_PUBLIC_POST },
    ]);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0, 1, 3] });
    await expect(harness.action(internal.workActions.applyApprovedActions, { workItemId })).resolves.toEqual({ ok: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    expect(ledger(row).map((entry) => [entry.ok, entry.held ?? false, entry.reason])).toEqual([
      [true, false, undefined],
      [true, false, undefined],
      [true, false, undefined],
      [true, false, undefined],
    ]);
    expect(ledger(row)[2].providerId).toBe('1787654400.000200');
    expect(recorded.http.map((call) => (call.body as { channel: string }).channel)).toEqual(['D0MANAGER', 'C0PUBLIC']);
  });

  it('refuses an ungranted read and the DM without boss:message from the moment the run is held', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = {
      ...skillOutput,
      actions: [
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'get_issue', toolArgsJson: JSON.stringify({ id: 'iss-1' }) } },
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
      harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0, 1, 2, 3] }),
    ).rejects.toThrow('action 1 is refused (no grant (linear:read))');
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [1] });
    await expect(harness.action(internal.workActions.applyApprovedActions, { workItemId })).resolves.toEqual({ ok: true });
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
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0] });
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
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [0] });
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
    recorded.skillOutput = { ...skillOutput, actions: [skillOutput.actions[0], skillOutput.actions[1], skillOutput.actions[3]] };
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

  it('keeps the mock path single-shot: no gate, applied in the same call', async (): Promise<void> => {
    useSurfaceMode('mock');
    recorded.skillOutput = {
      draft: 'Draft.',
      notes: '',
      actions: [{ tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'Draft ready for review.' } }],
    };
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'mock');
    const result = await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    expect(result).toEqual({ ok: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    expect(row.pendingRunId).toBeUndefined();
    expect(ledger(row)).toHaveLength(1);
    expect(ledger(row)[0]).toMatchObject({ tool: 'slack.postMessage', ok: true });
    const messages = await harness.run(async (ctx) => await ctx.db.query('mockSlackMessages').collect());
    expect(messages.map((message) => message.body)).toEqual(['Draft ready for review.']);
  });
});

/** The demo run: two reads, the audit comment on the item, the manager DM, and a threaded public reply. */
const ladderOutput: ExecutionOutput = {
  draft: 'Checked coverage.',
  notes: '',
  actions: [
    { tool: 'mcp.call', args: { surface: 'linear', tool: 'get_issue', toolArgsJson: JSON.stringify({ id: 'iss-1' }) } },
    { tool: 'mcp.call', args: { surface: 'linear', tool: 'list_comments', toolArgsJson: JSON.stringify({ issueId: 'iss-1' }) } },
    skillOutput.actions[0],
    skillOutput.actions[2],
    {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'POST',
        path: '/chat.postMessage',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
        body: JSON.stringify({ channel: 'C0PUBLIC', thread_ts: '1787746453.202809', text: 'Covered.' }),
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
async function park(harness: Harness, workItemId: Id<'workItems'>): Promise<{ row: Doc<'workItems'>; runId: Id<'events'> }> {
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
  it('off: applies the reads and the DM, parks the comment and the public reply, then sends the reply in its thread once approved', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = ladderOutput;
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real');
    const result = await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
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
    await expect(harness.action(internal.workActions.applyApprovedActions, { workItemId })).resolves.toEqual({
      ok: true,
      reason: "automatic actions applied; the rest await the manager's approval",
    });
    const parked = await readItem(harness, workItemId);
    expect(parked.state).toBe('actions-pending');
    expect(parked.approvedIndexes).toBeUndefined();
    expect(parked.applyPhase).toBeUndefined();
    expect(ledger(parked).map((entry) => [entry.ok, entry.held ?? false, entry.awaitingApproval ?? false, entry.reason, entry.authority])).toEqual([
      [true, false, false, undefined, 'standing'],
      [true, false, false, undefined, 'standing'],
      [true, true, true, AWAITING_APPROVAL, undefined],
      [true, false, false, undefined, 'standing'],
      [true, true, true, AWAITING_APPROVAL, undefined],
    ]);
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['get_issue', 'list_comments']);
    expect(recorded.http).toHaveLength(1);
    const pendingEvent = (await events(harness, agentId)).find((event) => event.type === 'work.actions-pending');
    expect(pendingEvent?.payload).toMatchObject({ autoIndexes: [0, 1, 3], heldIndexes: [2, 4], refusedIndexes: [], autoApplied: true });
    const runId = parked.pendingRunId;
    if (!runId) throw new Error('pending run missing');

    await harness.withIdentity(OWNER).mutation(api.work.approveActions, { workItemId, pendingRunId: runId, approvedIndexes: [2, 4] });
    await expect(harness.action(internal.workActions.applyApprovedActions, { workItemId })).resolves.toEqual({ ok: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    // The auto rows' ledger entries are carried forward unchanged; the comment and the reply landed under the manager's approval.
    expect([0, 1, 3].map((index) => ledger(row)[index])).toEqual([0, 1, 3].map((index) => ledger(parked)[index]));
    expect(ledger(row)[2]).toMatchObject({ ok: true, authority: 'manager' });
    expect(ledger(row)[4]).toMatchObject({ ok: true, providerId: '1787654400.000200', authority: 'manager', idempotencyKey: `${workItemId}:${runId}:4` });
    expect(ledger(row)[4].held).toBeUndefined();
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['get_issue', 'list_comments', 'save_comment']);
    expect(recorded.http.map((call) => call.body)).toEqual([
      expect.objectContaining({ channel: 'D0MANAGER' }),
      expect.objectContaining({ channel: 'C0PUBLIC', thread_ts: '1787746453.202809', text: `Covered.\n\n-- Priya (Day0) · run ${workItemId}/${runId}` }),
    ]);
    const types = (await events(harness, agentId)).map((event) => event.type);
    expect(types.filter((type) => type.startsWith('skill.') || type.startsWith('agent.'))).toEqual([]);
  });

  it('off: lands nothing more when the held rows are rejected, keeps the auto rows, and fences retry', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = ladderOutput;
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real');
    const { row: parked, runId } = await park(harness, workItemId);
    await harness.withIdentity(OWNER).mutation(api.work.rejectActions, { workItemId, pendingRunId: runId, reason: 'not in that thread' });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(row.skipReason).toBe('rejected by the manager: not in that thread');
    expect([0, 1, 3].map((index) => ledger(row)[index])).toEqual([0, 1, 3].map((index) => ledger(parked)[index]));
    expect(ledger(row)[2]).toMatchObject({ ok: true, held: true, reason: 'rejected by the manager: not in that thread' });
    expect(ledger(row)[4]).toMatchObject({ ok: true, held: true, reason: 'rejected by the manager: not in that thread' });
    expect(ledger(row)[4].awaitingApproval).toBeUndefined();
    expect(recorded.http).toHaveLength(1);
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['get_issue', 'list_comments']);
    await expect(harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId })).rejects.toThrow('reconcile the provider first');
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
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'delete_issue', toolArgsJson: JSON.stringify({ id: 'iss-1' }) } },
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'real', ['boss:message', 'linear:read', 'slack:read'], { autonomousActions: true });
    const result = await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
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
    await expect(harness.action(internal.workActions.applyApprovedActions, { workItemId })).resolves.toEqual({ ok: true });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    expect(row.approvedIndexes).toBeUndefined();
    expect(row.applyPhase).toBeUndefined();
    // Every applied row records the switch as its authority; the refused row stays refused with its reason.
    expect(ledger(row).map((entry) => [entry.ok, entry.held ?? false, entry.reason, entry.authority])).toEqual([
      [true, false, undefined, 'autonomous'],
      [true, false, undefined, 'autonomous'],
      [true, false, undefined, 'autonomous'],
      [true, false, undefined, 'autonomous'],
      [true, false, undefined, 'autonomous'],
      [true, true, 'tool not in the surface allowlist (delete_issue)', undefined],
    ]);
    expect(recorded.mcp.map((call) => [call.tool, call.args])).toEqual([
      ['get_issue', { id: 'iss-1' }],
      ['save_comment', { issueId: 'iss-1', body: expect.stringContaining('-- Priya (Day0) · run ') }],
      ['save_issue', { id: 'iss-1', state: 'Done' }],
    ]);
    expect(recorded.http.map((call) => call.body)).toEqual([
      expect.objectContaining({ channel: 'D0MANAGER' }),
      expect.objectContaining({ channel: 'C0PUBLIC', thread_ts: '1787746453.202809', text: expect.stringContaining('Covered.') }),
    ]);
    const types = (await events(harness, agentId)).map((event) => event.type);
    expect(types).toEqual(['work.execution-claimed', 'work.actions-auto-applying', 'work.actions-applying', 'work.completed']);
    expect(types).not.toContain('work.actions-pending');
    expect((await events(harness, agentId)).find((event) => event.type === 'work.actions-auto-applying')?.payload).toMatchObject({
      autonomousActions: true,
      refusedIndexes: [5],
    });
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
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('not an automatic action') });
    expect(recorded.mcp).toHaveLength(0);
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    expect(ledger(row)[0]).toMatchObject({ ok: false, reason: 'not an automatic action' });
    expect(ledger(row)[0].authority).toBeUndefined();
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
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_comment', toolArgsJson: JSON.stringify({ issueId: 'iss-1', body: 'x\n\n-- Someone Else (Day0) · run a/b' }) } },
        { tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'x' } },
        ladderOutput.actions[3],
      ],
    };
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'real', ['boss:message'], { autonomousActions: true });
    await harness.withIdentity(OWNER).action(api.workActions.executeApprovedPlan, { workItemId });
    const held = await readItem(harness, workItemId);
    expect(held.actionVerdicts).toEqual([
      { disposition: 'refused', reason: 'no grant (linear:read)' },
      { disposition: 'refused', reason: 'skill-supplied provenance trailer refused' },
      { disposition: 'refused', reason: expect.stringContaining('mock verb refused in real mode') },
      { disposition: 'auto' },
    ]);
    await expect(harness.action(internal.workActions.applyApprovedActions, { workItemId })).resolves.toEqual({ ok: true });
    expect((await readItem(harness, workItemId)).state).toBe('completed');
    expect(recorded.mcp).toHaveLength(0);
    expect(recorded.http.map((call) => (call.body as { channel: string }).channel)).toEqual(['D0MANAGER']);
  });

  it('off: classifies a comment and a state change on the working item as held, not automatic', async (): Promise<void> => {
    useSurfaceMode('real');
    recorded.skillOutput = { ...skillOutput, actions: [skillOutput.actions[0], skillOutput.actions[1]] };
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
});
