/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { WITHHELD_REPORTED_WRITE_NOT_LANDED } from '../../src/surfaces/policy';
import { allConvexModules } from './all-modules';
import { managerIdentity, MANAGER_ADDRESS } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import {
  PIP_SAME_SET,
  PIP_SAME_SET_DRAFT,
  PIP_TICKET_SUMMARY,
} from '../fixtures/work/pip-same-set-report-2026-10-11';

/*
 * W19-2 through the real gate and the real mock office apply (RM22 (a)): Pip's REVOPS-204 set from
 * the v0.19.0 walk, as the executor now keeps it. The comment and the DM report the post before
 * them; held with it, they land after it on the manager's approval, so the ticket is commented and
 * closed as Hana's ask said. Approved without the post, they are held back with it.
 */

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  useSurfaceMode('mock');
});

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

type Harness = TestConvex<typeof schema>;

const OWNER = managerIdentity();

/** Pip in the hosted office, REVOPS-204 open, its item executing under a run claim. */
async function seed(
  harness: Harness,
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Pip',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    for (const [slug, displayName, kind] of [
      ['office-asks', '#office-asks', 'channel'],
      ['dm-manager', 'DM · Manager', 'dm'],
    ] as const) {
      await ctx.db.insert('mockSlackChannels', { agentId, slug, displayName, kind, createdAt: 1 });
    }
    await ctx.db.insert('mockTickets', {
      agentId,
      slug: 'REVOPS-204',
      title: 'Northwind double charge on INV-2207 needs a first reply',
      body: PIP_TICKET_SUMMARY,
      status: 'open',
      priority: 'P1',
      comments: [],
      updatedAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'ticket',
      externalId: 'REVOPS-204',
      title: 'Northwind double charge on INV-2207 needs a first reply',
      contentSummary: PIP_TICKET_SUMMARY,
      contentRefs: ['ticket://REVOPS-204'],
      state: 'executing',
      plan: {
        summary: 'Post the first reply in the thread, then comment on and close REVOPS-204.',
        steps: ['Post the reply in the thread.', 'Comment on REVOPS-204 and close it.'],
      },
      observedAt: 1,
      createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId,
      type: 'work.execution-claimed',
      payload: { workItemId },
      createdAt: 1,
    });
    await ctx.db.patch(workItemId, { executionRunId: runId });
    return { agentId, workItemId, runId };
  });
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

/** The set held for the manager, then approved with the given indexes and applied. */
async function approveAndApply(
  harness: Harness,
  approvedIndexes: number[],
): Promise<{ agentId: Id<'agents'>; row: Doc<'workItems'> }> {
  const { agentId, workItemId, runId } = await seed(harness);
  await harness.mutation(internal.workRuns.setActionsPending, {
    workItemId,
    runId,
    output: {
      draft: PIP_SAME_SET_DRAFT,
      notes: '',
      workDone: 'done',
      workDoneWhy: 'The reply is posted in the thread, and the ticket is commented and closed.',
      actions: PIP_SAME_SET,
    },
  });
  const held = await readItem(harness, workItemId);
  expect(held.actionVerdicts?.map((verdict) => verdict.disposition)).toEqual([
    'held',
    'held',
    'held',
  ]);
  await harness.withIdentity(OWNER).mutation(api.work.approveActions, {
    workItemId,
    pendingRunId: held.pendingRunId!,
    approvedIndexes,
  });
  await harness.action(internal.workActions.applyApprovedActions, { workItemId });
  return { agentId, row: await readItem(harness, workItemId) };
}

describe("Pip's REVOPS-204 set, its comment held with the post it reports (RM22 (a), W19-2)", (): void => {
  it('posts the reply, then comments on and closes the ticket and sends the DM, on Approve all', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, row } = await approveAndApply(harness, [0, 1, 2]);
    const office = await harness.run(async (ctx) => ({
      ticket: await ctx.db
        .query('mockTickets')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'REVOPS-204'))
        .unique(),
      messages: await ctx.db
        .query('mockSlackMessages')
        .withIndex('by_agent_channel', (q) => q.eq('agentId', agentId))
        .collect(),
    }));
    expect(office.ticket?.status).toBe('done');
    expect(office.ticket?.comments.map((comment) => comment.body)).toEqual([
      PIP_SAME_SET[1]!.args.comment,
    ]);
    // The index reads by channel; the ledger below gives the order they landed in.
    expect(
      office.messages.map((message) => [message.channelSlug, message.threadKey ?? null]),
    ).toEqual([
      ['dm-manager', null],
      ['office-asks', 'thread-double-charge'],
    ]);
    expect(row.state).toBe('completed');
    const applied = (row.output as { applied: Array<{ ok: boolean; held?: boolean }> }).applied;
    expect(applied.map((entry) => entry.ok && entry.held !== true)).toEqual([true, true, true]);
  });

  it('holds the comment and the DM back with the post when the manager leaves the post out, and the ticket stays open', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, row } = await approveAndApply(harness, [1, 2]);
    const ticket = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('mockTickets')
          .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'REVOPS-204'))
          .unique(),
    );
    expect(ticket?.status).toBe('open');
    expect(ticket?.comments).toEqual([]);
    const applied = (row.output as { applied: Array<{ held?: boolean; reason?: string }> }).applied;
    expect(applied.slice(1).map((entry) => entry.reason)).toEqual([
      WITHHELD_REPORTED_WRITE_NOT_LANDED,
      WITHHELD_REPORTED_WRITE_NOT_LANDED,
    ]);
  });
});
