import type { TestConvex } from 'convex-test';
import { internal } from '../../../convex/_generated/api';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';
import { MANAGER_ADDRESS, managerIdentity } from './manager-identity';

/*
 * The work item tests' shared seeds (wave 18, 18-s): an owned employee with one work item and its
 * run's claim, a run parked on its held actions, and the reads the tests make of the rows. Moved
 * out of `tests/convex/work.test.ts` as they stood, for the tests left there and for the mirrors
 * of the modules the work's handler bodies moved into (`workManagerChannel.test.ts`,
 * `workLists.test.ts`).
 */

/** A harness over the tree's schema. */
export type Harness = TestConvex<typeof schema>;

/** The identity of the owner every seeded employee belongs to. */
export const OWNER = managerIdentity();

/** A run's output with two held Linear writes, a comment and a close. */
export const pendingOutput = {
  draft: 'Prepared the close summary.',
  notes: '',
  actions: [
    {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{"issueId":"i","body":"b"}' },
    },
    {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'save_issue', toolArgsJson: '{"id":"i","state":"Done"}' },
    },
  ],
};

/** What a seeded employee has beside its Linear surface and its grants. */
export interface SeedOptions {
  /** The agent's autonomous-actions switch; absent seeds a row without the field (off). */
  autonomousActions?: boolean;
  /** A connected Slack surface beside Linear. */
  withSlack?: boolean;
}

/**
 * Seed an owned agent with one work item in the given state and a run claim.
 *
 * Args:
 *   harness: Convex test harness.
 *   state: Initial work item state.
 *
 * Returns:
 *   The agent, work item and claim event ids.
 */
export async function seed(
  harness: Harness,
  state: Doc<'workItems'>['state'] = 'executing',
  grants: string[] = ['boss:message', 'linear:read', 'linear:write'],
  options: SeedOptions = {},
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      ...(options.autonomousActions !== undefined
        ? { autonomousActions: options.autonomousActions }
        : {}),
      createdAt: 1,
    });
    for (const scope of grants) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'connected',
      endpoint: 'https://mcp.linear.app/mcp',
      path: 'mcp',
      toolAllowlist: ['get_issue', 'save_comment', 'save_issue'],
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      whereFound: [],
      createdAt: 1,
    });
    if (options.withSlack) {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'team chat token',
        ciphertext: 'ciphertext',
        iv: 'iv',
        source: 'entered',
        createdAt: 1,
      });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        endpoint: 'https://slack.com/api/',
        path: 'documented-api',
        toolAllowlist: ['chat.postMessage'],
        toolArguments: [{ tool: 'chat.postMessage', arguments: ['channel', 'text'] }],
        managerDmChannelId: 'D0MANAGER',
        managerUserId: 'UMANAGER',
        credentialId,
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      });
    }
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-1',
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state,
      plan: { summary: 'Comment then close.', steps: ['comment', 'close'] },
      observedAt: 1,
      createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId,
      type: 'work.execution-claimed',
      payload: { workItemId },
      createdAt: 1,
    });
    if (state === 'executing') await ctx.db.patch(workItemId, { executionRunId: runId });
    return { agentId, workItemId, runId };
  });
}

/** An employee's events of one type. */
export async function eventsOfType(
  harness: Harness,
  agentId: Id<'agents'>,
  type: string,
): Promise<Doc<'events'>[]> {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .filter((q) => q.eq(q.field('type'), type))
        .collect(),
  );
}

/** A work item as it stands; a test fails if it is gone. */
export async function readItem(
  harness: Harness,
  workItemId: Id<'workItems'>,
): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

/** The names of the functions the harness has scheduled, sorted. */
export async function scheduledFunctionNames(harness: Harness): Promise<string[]> {
  const rows = await harness.run(
    async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
  );
  return rows.map((row) => row.name).sort();
}

/** A seeded employee whose run parked on {@link pendingOutput}'s held actions. */
export async function pend(
  harness: Harness,
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  const ids = await seed(harness, 'executing');
  await harness.mutation(internal.workRuns.setActionsPending, {
    workItemId: ids.workItemId,
    runId: ids.runId,
    output: pendingOutput,
  });
  return ids;
}

/** A second parked run under the same agent, so a batch has two members. */
export async function pendAnother(
  harness: Harness,
  agentId: Id<'agents'>,
  title = 'Close REVOPS-2',
): Promise<{ workItemId: Id<'workItems'>; runId: Id<'events'> }> {
  const ids = await harness.run(async (ctx) => {
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: title,
      title,
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state: 'executing',
      plan: { summary: 'Comment then close.', steps: ['comment', 'close'] },
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
    return { workItemId, runId };
  });
  await harness.mutation(internal.workRuns.setActionsPending, { ...ids, output: pendingOutput });
  return ids;
}
