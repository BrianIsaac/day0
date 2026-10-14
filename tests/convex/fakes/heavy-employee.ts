import type { TestConvex } from 'convex-test';
import type { Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';
import { MANAGER_ADDRESS } from './manager-identity';

/*
 * An employee whose records pass what one function may read (C1; 17-FW's `items.py heavy`, wave
 * 18, 18-F): finished work items whose runs' notes weigh 900 KB each, each with its completion
 * event carrying the same output, as the completing write stores both. Its twin is the same rows
 * with empty notes, which no figure reads, so the two draw the same figures.
 */

/** A harness over the tree's schema. */
type Harness = TestConvex<typeof schema>;

/** The notes of one of 17-FW's heavy runs: 900 KB. */
export const HEAVY_NOTES = 'x'.repeat(900 * 1024);

/** How many finished items 17-FW's bed gave Aiko: 24 of 900 KB, past 16 MiB in their rows alone. */
export const HEAVY_ITEMS = 24;

/** When the seeded employee was deployed, and its work dated after it. */
const DEPLOYED_AT = Date.UTC(2026, 9, 13, 1);

/**
 * One employee of an owner with a charter approved and {@link HEAVY_ITEMS} finished items, each
 * decided in Slack, its write landed and its output's notes as given; each item and its event are
 * written in a transaction of their own, under the bound on what one may write.
 *
 * @param harness - The harness.
 * @param name - The employee's name.
 * @param notes - Each run's notes: {@link HEAVY_NOTES} for the heavy one, empty for its twin.
 * @param owner - The owner key the employee is deployed under.
 * @returns The employee's id.
 */
export async function seedWorkedEmployee(
  harness: Harness,
  name: string,
  notes: string,
  owner = 'owner',
): Promise<Id<'agents'>> {
  const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
    const id = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name,
      userId: owner,
      state: 'active',
      createdAt: DEPLOYED_AT,
    });
    await ctx.db.insert('events', {
      agentId: id,
      type: 'agent.deployed',
      payload: {},
      createdAt: DEPLOYED_AT,
    });
    await ctx.db.insert('charters', {
      agentId: id,
      version: '0.1',
      body: {},
      approved: true,
      approvedAt: DEPLOYED_AT + 60_000,
      createdAt: DEPLOYED_AT + 30_000,
    });
    return id;
  });
  for (let n = 0; n < HEAVY_ITEMS; n += 1) {
    const at = DEPLOYED_AT + (n + 1) * 3_600_000;
    const runId = `run${n}`;
    const output = {
      draft: '',
      notes,
      actions: [{ tool: 'linear.save_comment', args: { issueId: `REVOPS-${400 + n}` } }],
      applied: [
        {
          tool: 'linear.save_comment',
          ok: true,
          authority: 'manager',
          effect: 'commented',
          idempotencyKey: `${runId}:0`,
        },
      ],
      workDone: 'done',
      workDoneWhy: 'The audit note was closed.',
    };
    await harness.run(async (ctx): Promise<void> => {
      const workItemId = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: `REVOPS-${400 + n}`,
        title: `Close the audit note ${n + 1}`,
        contentSummary: 'Seeded: a finished run whose output is heavy.',
        contentRefs: [],
        state: 'completed',
        observedAt: at - 60_000,
        createdAt: at - 60_000,
        decision: {
          id: `hv${n}`,
          kind: 'actions',
          requestedAt: at - 30_000,
          decidedAt: at - 10_000,
          outcome: 'approved',
          decidedVia: 'channel',
          channel: 'D0MANAGER',
          surfaceSlug: 'slack',
          surfaceName: 'Slack',
          ts: `1791870000.${String(n).padStart(6, '0')}`,
        },
        output,
      });
      await ctx.db.insert('events', {
        agentId,
        type: 'work.completed',
        payload: { workItemId, output },
        createdAt: at,
      });
    });
  }
  return agentId;
}
