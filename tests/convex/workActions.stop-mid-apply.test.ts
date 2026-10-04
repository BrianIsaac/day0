/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { AppliedAction } from '../../src/surfaces/types';
import {
  NOT_SENT_AFTER_STOP_REASON,
  OUTCOME_UNKNOWN_AFTER_STOP_REASON,
  providerReconciliationEntries,
} from '../../src/work/reconciliation';
import { landedWritesOf, unsentWritesOf } from '../../src/work/landed-writes';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

/*
 * The manager's Stop while an approved set is being sent (the wave 12 review's W12-R11): the
 * apply reads its claim before each send, so after a Stop it sends nothing more, and the rows it
 * never sent are recorded as not sent rather than left for the manager to check. Split from
 * `workActions.test.ts`, which holds the apply itself, to keep each file under a thousand lines.
 */

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/surfaces/credentials', () => import('./fakes/surface-credentials'));

type Harness = TestConvex<typeof schema>;
const OWNER = managerIdentity();
const REPLIES = 8;

const reply = (n: number) => ({
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: '{"Authorization":"Bearer {{secret}}"}',
    body: JSON.stringify({
      channel: 'C0REVOPS',
      thread_ts: '1789.1',
      text: `Deal ${n + 1} reconciled.`,
    }),
  },
});

/** Eight replies to one thread, held for the manager and approved, waiting for their apply. */
async function seedApprovedReplies(harness: Harness): Promise<Id<'workItems'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    for (const scope of ['slack:read', 'slack:write', 'boss:message']) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
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
      credentialLanded: true,
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
      lastVerifiedAt: Date.now(),
      whereFound: [],
      createdAt: 1,
    } as never);
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'chat-thread',
      sourceSystem: 'slack',
      externalId: 'C0REVOPS/1789.1',
      title: 'Reconcile the eight deals in the thread',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state: 'actions-pending',
      plan: { summary: 'Reply per deal.', steps: ['reply'] },
      observedAt: 1,
      createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId,
      type: 'work.execution-claimed',
      payload: { workItemId },
      createdAt: 1,
    });
    const indexes = Array.from({ length: REPLIES }, (_, n) => n);
    await ctx.db.patch(workItemId, {
      executionRunId: runId,
      pendingRunId: runId,
      applyPhase: 'approved',
      approvedIndexes: indexes,
      actionVerdicts: indexes.map(() => ({
        disposition: 'held' as const,
        reason: 'public post held for the manager',
      })),
      output: { draft: 'Replying per deal.', notes: '', actions: indexes.map(reply) },
    });
    return workItemId;
  });
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

describe('a Stop while the approved writes are being sent (W12-R11)', (): void => {
  const posted: string[] = [];

  beforeEach((): void => {
    useSurfaceMode('real');
  });

  afterEach((): void => {
    posted.length = 0;
    vi.unstubAllGlobals();
    restoreSurfaceMode();
  });

  it('sends nothing after the Stop, and records the rows it never sent as not sent', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const workItemId = await seedApprovedReplies(harness);
    // The manager presses Stop while the first reply is on the wire.
    vi.stubGlobal('fetch', async (_input: URL | string, init?: RequestInit): Promise<Response> => {
      // The first line: the server adds the run's provenance after it.
      posted.push(
        String((JSON.parse(String(init?.body)) as { text: string }).text).split('\n')[0]!,
      );
      if (posted.length === 1) {
        await harness.withIdentity(OWNER).mutation(api.workRuns.stopRun, { workItemId });
      }
      return new Response(JSON.stringify({ ok: true, ts: `1789.${posted.length + 1}` }), {
        status: 200,
      });
    });

    await harness.action(internal.workActions.applyApprovedActions, { workItemId });

    expect(posted).toEqual(['Deal 1 reconciled.']);
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('failed');
    const applied = (row.output as { applied: AppliedAction[] }).applied;
    // The reply on the wire when the Stop landed is the one to check; the rest were never sent.
    expect(applied[0]).toMatchObject({ ok: false, reason: OUTCOME_UNKNOWN_AFTER_STOP_REASON });
    // Accounted for as a held row is: never sent, nothing to check, named by what it would have done.
    for (const entry of applied.slice(1)) {
      expect(entry).toMatchObject({ ok: true, held: true, reason: NOT_SENT_AFTER_STOP_REASON });
      expect(entry.effect).toEqual(expect.any(String));
    }
    expect(providerReconciliationEntries(row.output).map((entry) => entry.actionIndex)).toEqual([
      0,
    ]);
    // The manager finds the first reply on Slack; the retry carries it landed and the seven
    // never sent as not sent, so the thread's landed reply stands in for none of them (W12-R13).
    await harness.withIdentity(OWNER).mutation(api.workRuns.reconcileFailed, {
      workItemId,
      confirmed: true,
      answers: [{ phase: 'single', actionIndex: 0, answer: 'landed' }],
    });
    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId });
    const retried = (await readItem(harness, workItemId)).output;
    expect(landedWritesOf(retried).map((write) => write.action)).toEqual([reply(0)]);
    expect(unsentWritesOf(retried).map((write) => write.action)).toEqual(
      Array.from({ length: REPLIES - 1 }, (_, n) => reply(n + 1)),
    );
  });

  it('answers the pre-send check whether the apply still holds its claim, and no longer once stopped', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const workItemId = await seedApprovedReplies(harness);
    const claim = await harness.mutation(internal.workRuns.claimApprovedActions, { workItemId });
    if (!claim.claimed) throw new Error(`apply not claimed: ${claim.reason}`);
    const { agentId } = await readItem(harness, workItemId);
    const asked = async (): Promise<unknown> => {
      const authority = await harness.query(internal.work.transportAuthority, {
        agentId,
        surfaceSlug: 'slack',
        applyClaim: { workItemId, applyAttemptId: claim.applyAttemptId },
      });
      return authority.agentExists ? authority.applyClaimHeld : undefined;
    };
    expect(await asked()).toBe(true);
    await harness.withIdentity(OWNER).mutation(api.workRuns.stopRun, { workItemId });
    expect(await asked()).toBe(false);
  });

  it('leaves a row the manager reconciled before the apply recorded what it did not send', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const workItemId = await seedApprovedReplies(harness);
    const claim = await harness.mutation(internal.workRuns.claimApprovedActions, { workItemId });
    if (!claim.claimed) throw new Error(`apply not claimed: ${claim.reason}`);
    await harness.withIdentity(OWNER).mutation(api.workRuns.stopRun, { workItemId });
    await harness.withIdentity(OWNER).mutation(api.workRuns.reconcileFailed, {
      workItemId,
      confirmed: true,
      answers: Array.from({ length: REPLIES }, (_, actionIndex) => ({
        phase: 'single' as const,
        actionIndex,
        answer: 'landed' as const,
      })),
    });
    await expect(
      harness.mutation(internal.workRuns.recordUnsentAfterStop, {
        workItemId,
        runId: claim.runId,
        firstUnsent: 0,
      }),
    ).resolves.toBe(0);
    const applied = ((await readItem(harness, workItemId)).output as { applied: AppliedAction[] })
      .applied;
    expect(applied.every((entry) => entry.reason === OUTCOME_UNKNOWN_AFTER_STOP_REASON)).toBe(true);
  });
});
