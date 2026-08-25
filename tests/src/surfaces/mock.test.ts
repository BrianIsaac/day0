import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { ActionCtx } from '../../../convex/_generated/server';
import schema from '../../../convex/schema';
import { mockAdapter } from '../../../src/surfaces/mock';
import type { AdapterRun } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';

const modules = {
  '../../../convex/_generated/api.ts': (): Promise<
    typeof import('../../../convex/_generated/api')
  > => import('../../../convex/_generated/api'),
  '../../../convex/mock.ts': (): Promise<typeof import('../../../convex/mock')> =>
    import('../../../convex/mock'),
};

/**
 * Create the execution ids required by the adapter contract.
 *
 * Returns:
 *   Convex ids for one isolated synthetic run.
 */
async function createRun(): Promise<{
  harness: ReturnType<typeof convexTest>;
  run: AdapterRun;
}> {
  const harness = convexTest(schema, modules);
  const run = await harness.run(async (ctx): Promise<AdapterRun> => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'adapter test',
      userId: 'test-user',
      state: 'active',
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'inbox',
      sourceSystem: 'test',
      externalId: 'adapter-test',
      title: 'Adapter test',
      contentSummary: 'Synthetic adapter test',
      contentRefs: [],
      state: 'executing',
      observedAt: 1,
      createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId,
      type: 'work.execution-claimed',
      payload: {},
      createdAt: 1,
    });
    return { agentId, workItemId, runId };
  });
  return { harness, run };
}

/**
 * Apply one action through an inline Convex action context.
 *
 * Args:
 *   action: Legacy action under test.
 *
 * Returns:
 *   Adapter evidence row.
 */
async function apply(action: MockAction): Promise<Awaited<ReturnType<typeof mockAdapter.apply>>> {
  const { harness, run } = await createRun();
  return await harness.action(async (ctx) => {
    return await mockAdapter.apply(ctx as unknown as ActionCtx, run, action, 0, 'run:0');
  });
}

describe('mock surface adapter', (): void => {
  it.each<{
    action: MockAction;
    reason: string;
  }>([
    {
      action: {
        tool: 'spreadsheet.appendRow',
        args: {
          sheetSlug: 'missing',
          tabName: 'Closed-won',
          cells: [{ header: 'Name', value: 'A' }],
        },
      },
      reason: 'no spreadsheet with slug "missing"',
    },
    {
      action: { tool: 'slack.postMessage', args: { channelSlug: 'missing', body: 'Draft' } },
      reason: 'no Slack channel with slug "missing"',
    },
    {
      action: { tool: 'twitter.reply', args: { tweetSlug: 'missing', body: 'Draft' } },
      reason: 'no tweet with slug "missing"',
    },
    {
      action: { tool: 'ticket.update', args: { slug: 'missing', status: 'done' } },
      reason: 'no ticket with slug "missing"',
    },
  ])(
    'reports an honest failed write for $action.tool',
    async ({ action, reason }): Promise<void> => {
      await expect(apply(action)).resolves.toMatchObject({ ok: false, reason });
    },
  );

  it('reports missing required action arguments before a mutation', async (): Promise<void> => {
    await expect(apply({ tool: 'ticket.update', args: {} })).resolves.toMatchObject({
      ok: false,
      reason: 'missing slug',
    });
  });
});
