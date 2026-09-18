/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import crons from '../../convex/crons';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

describe('scheduled documentation sync', (): void => {
  it('runs every fifteen minutes', (): void => {
    expect(crons.crons['sync documentation sources']).toMatchObject({
      name: 'docSyncActions:syncAll',
      schedule: { type: 'interval', minutes: 15 },
    });
  });
});

describe('scheduled surface maintenance', (): void => {
  it('re-probes connected surfaces every hour', (): void => {
    expect(crons.crons['re-probe connected surfaces']).toMatchObject({
      name: 'surfaceActions:reprobeAll',
      schedule: { type: 'interval', hours: 1 },
    });
  });

  it('polls connected surfaces for work every five minutes', (): void => {
    expect(crons.crons['poll connected surfaces for work']).toMatchObject({
      name: 'intakeActions:pollAll',
      schedule: { type: 'interval', minutes: 5 },
    });
  });

  it('polls manager decision replies every minute', (): void => {
    expect(crons.crons['poll manager decision replies']).toMatchObject({
      name: 'intakeActions:pollDecisions',
      schedule: { type: 'interval', seconds: 60 },
    });
  });

  it('sends manager digests every hour', (): void => {
    expect(crons.crons['send manager digests']).toMatchObject({
      name: 'managerChannelActions:sendManagerDigests',
      schedule: { type: 'interval', minutes: 60 },
    });
  });
});

type Harness = TestConvex<typeof schema>;
const LEASE_MS = 10 * 60 * 1000;
const PLAN = {
  summary: 'Tell the manager the close summary is ready.',
  steps: ['DM the manager.'],
  expectedOutputType: 'message',
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 2,
};

async function seedAgent(harness: Harness, autonomousActions: boolean): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        autonomousActions,
        createdAt: 1,
      }),
  );
}

function row(agentId: Id<'agents'>, externalId: string, now: number) {
  return {
    agentId,
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId,
    title: 'Triage the Linear close summary',
    contentSummary: 'Triage this Linear close summary revenue operations hand-off.',
    contentRefs: [],
    observedAt: now - 2 * LEASE_MS,
    createdAt: now - 2 * LEASE_MS,
  };
}

async function scheduledSteps(harness: Harness): Promise<Array<[string, string]>> {
  return (
    await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
  ).map((job): [string, string] => [
    job.name,
    (job.args[0] as { workItemId: string }).workItemId,
  ]);
}

describe('the stalled-step sweep', (): void => {
  afterEach((): void => {
    vi.useRealTimers();
    restoreSurfaceMode();
  });

  it('runs with the five-minute intake poll', (): void => {
    expect(crons.crons['resume stalled work steps']).toMatchObject({
      name: 'work:resumeStalledSteps',
      schedule: { type: 'interval', minutes: 5 },
    });
  });

  it('reschedules a row whose lease expired and leaves a live claim alone', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness, true);
    const now = Date.now();
    const ids = await harness.run(async (ctx) => ({
      lapsedEvaluation: await ctx.db.insert('workItems', {
        ...row(agentId, 'REVOPS-31', now),
        state: 'discovered',
        evaluationClaimedAt: now - LEASE_MS - 1,
      }),
      liveEvaluation: await ctx.db.insert('workItems', {
        ...row(agentId, 'REVOPS-32', now),
        state: 'discovered',
        evaluationClaimedAt: now - 60_000,
      }),
      lapsedDraft: await ctx.db.insert('workItems', {
        ...row(agentId, 'REVOPS-33', now),
        state: 'claimed',
        draftClaimedAt: now - LEASE_MS - 1,
      }),
      liveDraft: await ctx.db.insert('workItems', {
        ...row(agentId, 'REVOPS-34', now),
        state: 'claimed',
        draftClaimedAt: now - 60_000,
      }),
      approved: await ctx.db.insert('workItems', {
        ...row(agentId, 'REVOPS-35', now),
        state: 'plan-approved',
        plan: PLAN,
      }),
    }));

    await harness.mutation(internal.work.resumeStalledSteps, {});

    const scheduled = await scheduledSteps(harness);
    expect(scheduled).toEqual(
      expect.arrayContaining([
        ['workActions:evaluateWorkItemInternal', ids.lapsedEvaluation],
        ['workActions:draftPlanInternal', ids.lapsedDraft],
        ['workActions:executeApprovedPlanInternal', ids.approved],
      ]),
    );
    expect(scheduled).toHaveLength(3);
  });

  it('wakes the oldest queued row only when the employee has a free slot', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness, false);
    const now = Date.now();
    const queued = {
      state: 'discovered' as const,
      verdict: { decision: 'queue', reason: 'WIP cap reached: supervised cold-start limit is 1' },
    };
    const { older, open } = await harness.run(async (ctx) => ({
      older: await ctx.db.insert('workItems', { ...row(agentId, 'REVOPS-41', now), ...queued }),
      newer: await ctx.db.insert('workItems', { ...row(agentId, 'REVOPS-42', now), ...queued }),
      open: await ctx.db.insert('workItems', {
        ...row(agentId, 'REVOPS-43', now),
        state: 'plan-pending',
        verdict: { decision: 'claim' },
        plan: PLAN,
        planPendingAt: now,
      }),
    }));

    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await scheduledSteps(harness)).toEqual([]);

    await harness.run(async (ctx) => {
      await ctx.db.patch(open, { state: 'cancelled' });
    });
    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await scheduledSteps(harness)).toEqual([
      ['workActions:evaluateWorkItemInternal', older],
    ]);
  });

  it('recovers a plan whose drafting action died before deciding it', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness, false);
    const now = Date.now();
    const workItemId = await harness.run(async (ctx) =>
      await ctx.db.insert('workItems', {
        ...row(agentId, 'REVOPS-44', now),
        state: 'plan-pending',
        plan: PLAN,
      }),
    );

    await harness.mutation(internal.work.resumeStalledSteps, {});

    expect(await scheduledSteps(harness)).toContainEqual(['work:decidePlan', workItemId]);
  });

  it('continues an autonomous plan when the recovered decision wins', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness, true);
    const now = Date.now();
    const workItemId = await harness.run(async (ctx) =>
      await ctx.db.insert('workItems', {
        ...row(agentId, 'REVOPS-45', now),
        state: 'plan-pending',
        plan: PLAN,
      }),
    );

    const decision = await harness.mutation(internal.work.decidePlan, { workItemId, recovery: true });

    expect(decision).toEqual({ approved: true });
    expect(await scheduledSteps(harness)).toContainEqual([
      'workActions:executeApprovedPlanInternal',
      workItemId,
    ]);
  });

  it('does nothing in mock mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness, false);
    const now = Date.now();
    await harness.run(async (ctx) => {
      await ctx.db.insert('workItems', { ...row(agentId, 'REVOPS-51', now), state: 'discovered' });
      await ctx.db.insert('workItems', {
        ...row(agentId, 'REVOPS-52', now),
        state: 'plan-approved',
        plan: PLAN,
      });
    });

    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await scheduledSteps(harness)).toEqual([]);
  });
});
