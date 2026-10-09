/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { McpClientLike, McpClientOptions } from '../../src/surfaces/mcp';
import { WITHHELD_REPORTED_WRITE_NOT_LANDED } from '../../src/surfaces/policy';
import type { AppliedAction } from '../../src/surfaces/types';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { managerIdentity, MANAGER_ADDRESS } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import {
  NOTE_1,
  NOTE_2,
  OWN_WRITES_CLOSING,
  OWN_WRITES_COMMENT,
  REVOPS_6,
  REVOPS_6_PLAN,
  STARTING_DM,
  STARTING_DM_LANDED,
} from '../fixtures/work/revops-6-own-writes-2026-10-05';

/*
 * W12X-2 through the real gate and the real apply: the re-walk's REVOPS-6 from the point its
 * closing set is authored (phase one's starting DM landed). The comment that reports the set's two
 * posts reaches the manager's request beside them, lands after them on approval, and is held back
 * when the manager approves it without them, so the ticket never carries a report of a post that
 * was not made.
 */

const recorded = vi.hoisted(() => ({
  mcp: [] as Array<{ tool: string; args: unknown }>,
  http: [] as Array<{ url: string; body: unknown }>,
  closingReply: undefined as unknown,
}));

vi.mock('../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async <T>(args: {
    agent: { name: string };
    schema: { parse(value: unknown): unknown };
  }): Promise<T> => {
    if (args.agent.name.endsWith('-dependent') && recorded.closingReply) {
      return (await import('./fakes/executor-reply')).parseRecordedReply(
        args.schema,
        recorded.closingReply,
      ) as T;
    }
    throw new Error(`unscripted agent ${args.agent.name}`);
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/surfaces/credentials', () => import('./fakes/surface-credentials'));

vi.mock('../../src/surfaces/mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/surfaces/mcp')>();
  return {
    ...original,
    createMastraMcpClient: (options: McpClientOptions): McpClientLike => ({
      listTools: async () =>
        Object.fromEntries(
          ['get_issue', 'list_issues', 'save_comment', 'save_issue'].map((tool) => [
            `${options.serverName}_${tool}`,
            {
              execute: async (args: unknown): Promise<unknown> => {
                // The ticket re-read before the first write is a read, not a call under test.
                if (tool === 'get_issue') {
                  const { id } = args as { id?: string };
                  return {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify({ id, status: 'Backlog', statusType: 'backlog' }),
                      },
                    ],
                  };
                }
                recorded.mcp.push({ tool, args });
                return { content: [{ type: 'text', text: JSON.stringify({ id: 'comment-6' }) }] };
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
  return new Response(JSON.stringify({ ok: true, ts: '1791181629.074579' }), { status: 200 });
});

type Harness = TestConvex<typeof schema>;
const OWNER = managerIdentity();

/** Bram, supervised, with Linear and Slack, and REVOPS-6 at its closing phase. */
async function seedAtClosing(
  harness: Harness,
): Promise<{ workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Bram',
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
        proposedFunction: 'Keep the RevOps close queue moving.',
        proposedBoundaries: {
          willDo: [
            'Read each delegated REVOPS ticket in Linear and do what it asks from connected systems.',
          ],
          willNotDo: [],
          escalationTriggers: [],
        },
        approvalChain: { boss: MANAGER_ADDRESS },
      },
    });
    const skillId = await ctx.db.insert('skills', {
      agentId,
      name: 'kanban-comment',
      description: 'Post what a ticket asks in Slack and comment on the ticket.',
      body: '# Post and comment\nPost the messages the ticket names with chat.postMessage, then comment on linear with save_comment.',
      requiredScopes: ['boss:message', 'linear:write', 'slack:write'],
      targetSurface: 'linear',
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
      'slack:write',
    ]) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
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
      toolAllowlist: ['get_issue', 'list_issues', 'save_comment', 'save_issue'],
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
      managerDmChannelId: 'D0C6MMVTY06',
      managerUserId: 'UMANAGER',
      ...live,
    } as never);
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: REVOPS_6.sourceCategory,
      sourceSystem: REVOPS_6.sourceSystem,
      externalId: REVOPS_6.externalId,
      title: REVOPS_6.title,
      contentSummary: REVOPS_6.contentSummary,
      contentRefs: REVOPS_6.contentRefs,
      priority: 'Medium',
      state: 'executing',
      skillId,
      plan: REVOPS_6_PLAN,
      verdict: { decision: 'claim', value: 60, risk: 30, requiredPermissions: ['linear:read'] },
      observedAt: 1,
      createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId,
      type: 'work.executing',
      payload: { workItemId },
      createdAt: Date.now(),
    });
    await ctx.db.patch(workItemId, {
      executionRunId: runId,
      output: {
        phase: 'dependent-authoring',
        draft: 'Told the manager the notes are starting.',
        notes: '',
        needsDependentPhase: true,
        deferredActions: [],
        procedureTrails: [],
        actions: [STARTING_DM],
        applied: [STARTING_DM_LANDED],
      },
    });
    return { workItemId, runId };
  });
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

/** The closing set authored, held for the manager, and the request's pending id. */
async function heldClosingSet(
  harness: Harness,
  reply: unknown = OWN_WRITES_CLOSING,
): Promise<Doc<'workItems'>> {
  const { workItemId, runId } = await seedAtClosing(harness);
  recorded.closingReply = reply;
  await harness.action(internal.workActions.authorDependentActions, { workItemId, runId });
  return await readItem(harness, workItemId);
}

function ledger(row: Doc<'workItems'>): AppliedAction[] {
  return (row.output as { applied?: AppliedAction[] }).applied ?? [];
}

describe('REVOPS-6 through the real gate: a comment that reports its own set’s posts (W12X-2)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
  });

  afterEach((): void => {
    recorded.mcp.length = 0;
    recorded.http.length = 0;
    recorded.closingReply = undefined;
    restoreSurfaceMode();
  });

  it('asks for the comment beside the two posts, and lands it after them on approval', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const held = await heldClosingSet(harness);
    expect(held.state).toBe('actions-pending');
    expect((held.output as { withheldActions?: unknown[] }).withheldActions ?? []).toEqual([]);
    expect((held.output as { actions: unknown[] }).actions).toHaveLength(3);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId: held._id,
      pendingRunId: held.pendingRunId!,
      approvedIndexes: [0, 1, 2],
    });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId: held._id });
    const done = await readItem(harness, held._id);
    expect(done.state).toBe('completed');
    expect(recorded.http.map((call) => (call.body as { channel: string }).channel)).toEqual([
      'C0BSQTE1H7E',
      'C0BSQTE1H7E',
    ]);
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['save_comment']);
    expect((recorded.mcp[0]!.args as { body: string }).body).toContain(
      'Posted both stop-drill notes in #revops.',
    );
  });

  it('holds the comment back when the manager approves it without a post it reports', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const held = await heldClosingSet(harness);
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId: held._id,
      pendingRunId: held.pendingRunId!,
      approvedIndexes: [0, 2],
    });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId: held._id });
    const after = await readItem(harness, held._id);
    expect(recorded.mcp).toEqual([]);
    expect(recorded.http).toHaveLength(1);
    expect(ledger(after).at(-1)).toMatchObject({
      ok: true,
      held: true,
      reason: WITHHELD_REPORTED_WRITE_NOT_LANDED,
    });
  });
});

/** REVOPS-6's closing set with its comment worded and its reports declared as given. */
function closingWith(body: string, reports: number[]): typeof OWN_WRITES_CLOSING {
  return {
    ...OWN_WRITES_CLOSING,
    actions: [
      { ...NOTE_1, reports: null },
      { ...NOTE_2, reports: null },
      {
        ...OWN_WRITES_COMMENT,
        args: {
          ...OWN_WRITES_COMMENT.args,
          toolArgsJson: JSON.stringify({ issueId: 'REVOPS-6', body }),
        },
        reports,
      },
    ] as typeof OWN_WRITES_CLOSING.actions,
  };
}

describe("REVOPS-6 with the run's declared reports (the wave 13 review's D-5 (b))", (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
  });

  afterEach((): void => {
    recorded.mcp.length = 0;
    recorded.http.length = 0;
    recorded.closingReply = undefined;
    restoreSurfaceMode();
  });

  it('keeps the declaration on the held set and holds back a report the words miss without its post', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const held = await heldClosingSet(
      harness,
      closingWith('Both stop-drill notes reached #revops.', [0, 1]),
    );
    expect(held.state).toBe('actions-pending');
    expect((held.output as { actions: Array<{ reports?: number[] }> }).actions[2]!.reports).toEqual(
      [0, 1],
    );
    await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
      workItemId: held._id,
      pendingRunId: held.pendingRunId!,
      approvedIndexes: [0, 2],
    });
    await harness.action(internal.workActions.applyApprovedActions, { workItemId: held._id });
    const after = await readItem(harness, held._id);
    expect(recorded.mcp).toEqual([]);
    expect(recorded.http).toHaveLength(1);
    expect(ledger(after).at(-1)).toMatchObject({
      ok: true,
      held: true,
      reason: WITHHELD_REPORTED_WRITE_NOT_LANDED,
    });
  });

  it('withholds at authoring a comment whose words report a post its reports leave out, naming the sentence', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const held = await heldClosingSet(
      harness,
      closingWith('Posted both stop-drill notes in #revops.', [0]),
    );
    const output = held.output as {
      actions: unknown[];
      withheldActions?: Array<{ reason: string }>;
    };
    expect(output.actions).toHaveLength(2);
    expect(output.withheldActions?.map((row) => row.reason)).toEqual([
      expect.stringContaining(
        'reports a write its `reports` does not name: it says "Posted both stop-drill notes in #revops."',
      ),
    ]);
  });
});
