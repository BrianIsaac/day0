// @vitest-environment node

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

const tasks = [
  {
    sourceCategory: 'inbox',
    sourceSystem: 'docs',
    externalId: 'EVAL-SEED-01',
    title: 'Read the team overview',
    contentSummary: 'Read the source and report the standup time.',
    contentRefs: ['doc://team-overview'],
    priority: 'P2',
    requesterLabel: 'Manager',
  },
  {
    sourceCategory: 'ticket-queue',
    sourceSystem: 'ticket',
    externalId: 'EVAL-SEED-02',
    title: 'Update REVOPS-202',
    contentSummary: 'Add the approved audit comment.',
    contentRefs: ['ticket://REVOPS-EVAL-02'],
    originatingTicket: {
      slug: 'REVOPS-EVAL-02',
      title: 'Evaluation audit note',
      body: 'Record the approved audit note and preserve the current ticket status.',
      status: 'open' as const,
      priority: 'P2',
    },
  },
];

afterEach((): void => restoreSurfaceMode());

describe('evaluation backend boundary', (): void => {
  it('seeds fixed tasks idempotently and returns owner-scoped grader state', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const agentId = await owner.mutation(api.agents.deploy, {
      bossEmail: 'boss@day0.local',
      arm: 'day0',
    });

    const first = await owner.mutation(api.evaluation.seedTasks, { agentId, tasks });
    const second = await owner.mutation(api.evaluation.seedTasks, { agentId, tasks });
    expect(second).toEqual(first);
    const snapshot = await owner.query(api.evaluation.snapshot, { agentId });
    expect(snapshot.workItems.map((row) => row.externalId).sort()).toEqual([
      'EVAL-SEED-01',
      'EVAL-SEED-02',
    ]);
    expect(snapshot.events.filter((event) => event.type === 'work.discovered')).toHaveLength(2);
    expect(snapshot.tickets).toMatchObject([
      {
        slug: 'REVOPS-EVAL-02',
        title: 'Evaluation audit note',
        body: 'Record the approved audit note and preserve the current ticket status.',
        status: 'open',
        priority: 'P2',
        comments: [],
      },
    ]);
    await expect(
      harness.withIdentity({ subject: 'stranger' }).query(api.evaluation.snapshot, { agentId }),
    ).rejects.toThrow('forbidden');
  });

  it('refuses benchmark mutation outside mock mode', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const agentId = await owner.mutation(api.agents.deploy, {
      bossEmail: 'boss@day0.local',
      arm: 'day0',
    });
    await expect(owner.mutation(api.evaluation.seedTasks, { agentId, tasks })).rejects.toThrow(
      'mock mode',
    );
  });

  it('terminalises a timed-out benchmark row and fences its late execution run', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const agentId = await owner.mutation(api.agents.deploy, {
      bossEmail: 'boss@day0.local',
      arm: 'day0',
    });
    const [workItemId] = await owner.mutation(api.evaluation.seedTasks, {
      agentId,
      tasks: [tasks[0]!],
    });
    const runId = await harness.run(
      async (ctx): Promise<Id<'events'>> =>
        await ctx.db.insert('events', {
          agentId,
          type: 'work.execution-claimed',
          payload: { workItemId },
          createdAt: 10,
        }),
    );
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, { state: 'executing', executionRunId: runId });
    });

    await expect(owner.mutation(api.evaluation.timeoutTask, { workItemId })).resolves.toEqual({
      timedOut: true,
    });
    const row = await owner.query(api.work.get, { workItemId });
    expect(row.state).toBe('failed');
    expect(row.executionRunId).toBeUndefined();
    expect(row.skipReason).toContain('evaluation timeout');
    const snapshot = await owner.query(api.evaluation.snapshot, { agentId });
    expect(snapshot.events.some((event) => event.type === 'work.failed')).toBe(true);
  });
});
