/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * Plans sent back to drafting (`convex/planRedraft.ts`, moved out of `convex/work.ts` by wave 15's
 * cycle break, F-2): a parked plan drafted while a system was not connected is drafted again once
 * it connects, its request remembered as replaced and its next draft scheduled in the same
 * transaction; a decided plan, a plan whose read failed on a connected system and a plan drafted
 * without another system are left where they are.
 */

type Harness = TestConvex<typeof schema>;
type WithoutCause = NonNullable<Doc<'workItems'>['planDraftedWithout']>['cause'];

const PLAN = { steps: [{ id: 'step-1', description: 'Read the thread, then answer it.' }] };
const NOW = 1_787_768_413_000;

// Sending a row back schedules its draft; the scheduler's timer is faked so
// nothing runs after the test.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

/** The module under the mode the test chose; `SURFACE_MODE` is read at import. */
async function redraftModule(): Promise<typeof import('../../convex/planRedraft')> {
  return await import('../../convex/planRedraft');
}

async function seedSurface(
  harness: Harness,
  agentId: Id<'agents'>,
  slug: string,
): Promise<Doc<'surfaces'>> {
  return await harness.run(async (ctx) => {
    const id = await ctx.db.insert('surfaces', {
      agentId,
      slug,
      displayName: slug,
      class: 'chat',
      verdict: 'connected',
      whereFound: [],
      credentialLanded: true,
      createdAt: 1,
    });
    const surface = await ctx.db.get(id);
    if (!surface) throw new Error('surface missing');
    return surface;
  });
}

async function seedAgent(harness: Harness): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Aiko',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      }),
  );
}

interface ParkedPlan {
  readonly externalId: string;
  readonly without?: { readonly surfaceSlug: string; readonly cause: WithoutCause };
  readonly decision?: Doc<'workItems'>['decision'];
}

async function seedParked(
  harness: Harness,
  agentId: Id<'agents'>,
  parked: ParkedPlan,
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'chat-thread',
        sourceSystem: 'team-chat',
        externalId: parked.externalId,
        title: 'Answer the coverage ask',
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state: 'plan-pending',
        plan: PLAN,
        planPendingAt: 5,
        observedAt: 1,
        createdAt: 1,
        ...(parked.without ? { planDraftedWithout: { ...parked.without, subject: 'thread' } } : {}),
        ...(parked.decision ? { decision: parked.decision } : {}),
      }),
  );
}

function openRequest(id: string): NonNullable<Doc<'workItems'>['decision']> {
  return {
    id,
    kind: 'plan',
    surfaceSlug: 'team-chat',
    surfaceName: 'Team chat',
    channel: 'D0MANAGER',
    requestedAt: 10,
    ts: '1787768400.000100',
    requestText: `Plan ready (${id}).`,
  };
}

async function rowOf(harness: Harness, id: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(id));
  if (!row) throw new Error('work item missing');
  return row;
}

describe('sendBackToDrafting', (): void => {
  it('clears the plan and its request, remembers the request as replaced and records the redraft', async (): Promise<void> => {
    const { sendBackToDrafting } = await redraftModule();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surface = await seedSurface(harness, agentId, 'team-chat');
    const workItemId = await seedParked(harness, agentId, {
      externalId: 'thread-1',
      without: { surfaceSlug: 'team-chat', cause: 'not-connected' },
      decision: openRequest('plan-7f3a'),
    });

    await harness.run(async (ctx) => {
      await sendBackToDrafting(ctx, (await ctx.db.get(workItemId))!, surface, NOW);
    });

    const row = await rowOf(harness, workItemId);
    expect(row.state).toBe('claimed');
    expect(row.plan).toBeUndefined();
    expect(row.planPendingAt).toBeUndefined();
    expect(row.planDraftedWithout).toBeUndefined();
    expect(row.decision).toBeUndefined();
    const { replaced, events } = await harness.run(async (ctx) => ({
      replaced: await ctx.db.query('replacedDecisionRequests').collect(),
      events: await ctx.db.query('events').collect(),
    }));
    expect(replaced).toMatchObject([
      { agentId, workItemId, decisionId: 'plan-7f3a', kind: 'plan', replacedAt: NOW },
    ]);
    expect(events.map((event) => [event.type, event.payload, event.createdAt])).toEqual([
      ['work.plan-redrafting', { workItemId, surfaceId: surface._id, slug: 'team-chat' }, NOW],
    ]);
  });

  it('schedules the draft in the same transaction in real mode', async (): Promise<void> => {
    useSurfaceMode('real');
    const { sendBackToDrafting } = await redraftModule();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surface = await seedSurface(harness, agentId, 'team-chat');
    const workItemId = await seedParked(harness, agentId, {
      externalId: 'thread-1',
      without: { surfaceSlug: 'team-chat', cause: 'not-connected' },
    });

    await harness.run(async (ctx) => {
      await sendBackToDrafting(ctx, (await ctx.db.get(workItemId))!, surface, NOW);
    });

    const row = await rowOf(harness, workItemId);
    expect(row.state).toBe('claimed');
    const jobs = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(jobs.map((job) => [job._id, job.name, job.args])).toEqual([
      [row.stepJobId, 'workActions:draftPlanInternal', [{ workItemId }]],
    ]);
  });
});

describe('redraftPlansDraftedWithout', (): void => {
  it('sends back only the undecided plans drafted while this system was not connected', async (): Promise<void> => {
    const { redraftPlansDraftedWithout } = await redraftModule();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surface = await seedSurface(harness, agentId, 'team-chat');
    const draftedWithout = await seedParked(harness, agentId, {
      externalId: 'thread-1',
      without: { surfaceSlug: 'team-chat', cause: 'not-connected' },
    });
    const readFailed = await seedParked(harness, agentId, {
      externalId: 'thread-2',
      without: { surfaceSlug: 'team-chat', cause: 'read-failed' },
    });
    const anotherSystem = await seedParked(harness, agentId, {
      externalId: 'thread-3',
      without: { surfaceSlug: 'tracker', cause: 'not-connected' },
    });
    const decided = await seedParked(harness, agentId, {
      externalId: 'thread-4',
      without: { surfaceSlug: 'team-chat', cause: 'not-connected' },
      decision: { ...openRequest('plan-2b9c'), decidedAt: 20, outcome: 'approved' },
    });
    const draftedWithEverything = await seedParked(harness, agentId, { externalId: 'thread-5' });

    await harness.run(async (ctx) => {
      await redraftPlansDraftedWithout(ctx, surface, NOW);
    });

    expect((await rowOf(harness, draftedWithout)).state).toBe('claimed');
    for (const kept of [readFailed, anotherSystem, decided, draftedWithEverything]) {
      const row = await rowOf(harness, kept);
      expect([row.externalId, row.state, row.plan]).toEqual([row.externalId, 'plan-pending', PLAN]);
    }
    const redrafts = await harness.run(async (ctx) => await ctx.db.query('events').collect());
    expect(redrafts.map((event) => event.payload)).toEqual([
      { workItemId: draftedWithout, surfaceId: surface._id, slug: 'team-chat' },
    ]);
  });
});
