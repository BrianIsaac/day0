/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * The verdict path (`convex/workVerdicts.ts`, moved out of `convex/work.ts` by the wave 15
 * helpers split): an evaluation's verdict moves a row to where it puts it and names the charter
 * that decided, a stale verdict leaves an advanced row alone, and a parked row whose wait is
 * already over goes back once per thing it waited on.
 */

type Harness = TestConvex<typeof schema>;

// A verdict schedules the row's next step; the scheduler's timer is faked so
// nothing runs after the test.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

/** The module under the mode the test chose; `SURFACE_MODE` is read at import. */
async function verdictsModule(): Promise<typeof import('../../convex/workVerdicts')> {
  return await import('../../convex/workVerdicts');
}

async function seed(
  harness: Harness,
  state: Doc<'workItems'>['state'],
  verdict?: Record<string, unknown>,
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Aiko',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-1',
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state,
      ...(verdict ? { verdict } : {}),
      observedAt: 1,
      createdAt: 1,
    });
    return { agentId, workItemId };
  });
}

async function row(harness: Harness, id: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const found = await harness.run(async (ctx) => await ctx.db.get(id));
  if (!found) throw new Error('work item missing');
  return found;
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

describe('applyVerdict', (): void => {
  it('skips the row with its reason and writes the evaluation and the skip', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { applyVerdict } = await verdictsModule();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'discovered');

    const effective = await harness.run(
      async (ctx) => await applyVerdict(ctx, workItemId, { decision: 'skip', reason: 'low value' }),
    );

    expect(effective).toEqual({ decision: 'skip', reason: 'low value' });
    expect(await row(harness, workItemId)).toMatchObject({
      state: 'skipped',
      skipReason: 'low value',
    });
    expect((await events(harness, agentId)).map((event) => event.type)).toEqual([
      'work.evaluated',
      'work.skipped',
    ]);
  });

  it('parks a row that lacks a permission with a reason naming it, as a sentence the manager reads (RM12 (c))', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { applyVerdict } = await verdictsModule();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'discovered');

    await harness.run(
      async (ctx) =>
        await applyVerdict(ctx, workItemId, {
          decision: 'defer',
          reason: 'awaiting-permission',
          missingPermissions: ['northstar:write'],
        }),
    );

    expect(await row(harness, workItemId)).toMatchObject({
      state: 'deferred',
      skipReason:
        'Deferred: this work needs northstar:write, a permission Aiko does not hold. It is evaluated again once you grant it.',
    });
    // A deferral ends nothing: the row waits, and no skip is recorded.
    expect((await events(harness, agentId)).map((event) => event.type)).toEqual(['work.evaluated']);
  });

  it('writes no such reason on a deferral that waits on something else', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { applyVerdict } = await verdictsModule();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'discovered');

    await harness.run(
      async (ctx) =>
        await applyVerdict(ctx, workItemId, {
          decision: 'defer',
          reason: 'awaiting-connection',
          missingSurface: 'northstar-crm',
        }),
    );

    const parked = await row(harness, workItemId);
    expect(parked.state).toBe('deferred');
    expect(parked.skipReason).toBeUndefined();
  });

  it('claims under the cap and names the approved charter that decided, not a draft above it', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { applyVerdict } = await verdictsModule();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'discovered');
    const approved = await harness.run(async (ctx) => {
      const id = await ctx.db.insert('charters', {
        agentId,
        version: '0.1',
        approved: true,
        approvedAt: 1,
        body: {},
        createdAt: 1,
      });
      await ctx.db.insert('charters', {
        agentId,
        version: '0.2',
        approved: false,
        body: {},
        createdAt: 2,
      });
      return id;
    });

    await harness.run(async (ctx) => {
      await applyVerdict(ctx, workItemId, { decision: 'claim', reason: 'part of the job' });
    });

    expect((await row(harness, workItemId)).state).toBe('claimed');
    const [evaluated] = await events(harness, agentId);
    expect(evaluated?.payload).toMatchObject({
      decision: 'claim',
      charterId: approved,
      charterVersion: '0.1',
    });
  });

  it('leaves a row that has moved past evaluation as it is', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { applyVerdict } = await verdictsModule();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending');

    await harness.run(async (ctx) => {
      await applyVerdict(ctx, workItemId, { decision: 'skip', reason: 'stale' });
    });

    expect((await row(harness, workItemId)).state).toBe('plan-pending');
    expect(await events(harness, agentId)).toEqual([]);
  });
});

describe('requeueBehindRegisteredSkill', (): void => {
  it('sends a row back once per registration, then skips it with the reason', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { requeueBehindRegisteredSkill } = await verdictsModule();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'needs-skill', {
      decision: 'needs-skill',
      suggestedSkillName: 'kanban-comment-and-close',
    });
    const skill = await harness.run(async (ctx) => {
      const id = await ctx.db.insert('skills', {
        agentId,
        name: 'kanban-comment-and-close',
        description: 'Comment on and close a ticket.',
        body: '',
        sourceType: 'agent-authored',
        state: 'registered',
        requiredScopes: ['linear:read', 'linear:write'],
        targetSurface: 'linear',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        registeredAt: 7,
        createdAt: 1,
      });
      const found = await ctx.db.get(id);
      if (!found) throw new Error('skill missing');
      return found;
    });

    const first = await harness.run(
      async (ctx) => await requeueBehindRegisteredSkill(ctx, skill, workItemId),
    );
    const requeued = await row(harness, workItemId);
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, { state: 'needs-skill' });
    });
    const second = await harness.run(
      async (ctx) => await requeueBehindRegisteredSkill(ctx, skill, workItemId),
    );
    const third = await harness.run(
      async (ctx) => await requeueBehindRegisteredSkill(ctx, skill, workItemId),
    );

    expect(first).toBe('requeued');
    expect(requeued).toMatchObject({ state: 'discovered', proposedSkillId: skill._id });
    expect(second).toBe('skipped');
    expect((await row(harness, workItemId)).skipReason).toBe(
      'registered skill "kanban-comment-and-close" was tried and does not cover this item',
    );
    expect(third).toBe('left');
  });
});

describe('readmitSatisfiedInTransaction', (): void => {
  it('re-admits a row whose grants are all live, once for those grants', async (): Promise<void> => {
    useSurfaceMode('real');
    const { readmitSatisfiedInTransaction } = await verdictsModule();
    const harness = convexTest(schema, allConvexModules());
    const parked = { decision: 'defer', reason: 'awaiting-permission' };
    const { agentId, workItemId } = await seed(harness, 'deferred', {
      ...parked,
      missingPermissions: ['linear:read'],
    });
    await harness.run(async (ctx) => {
      await ctx.db.insert('permissionGrants', { agentId, scope: 'linear:read', createdAt: 1 });
    });

    const first = await harness.run(
      async (ctx) => await readmitSatisfiedInTransaction(ctx, { agentId }, 50),
    );
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        state: 'deferred',
        verdict: { ...parked, missingPermissions: ['linear:read'] },
      });
    });
    const again = await harness.run(
      async (ctx) => await readmitSatisfiedInTransaction(ctx, { agentId }, 60),
    );

    expect(first).toEqual({ readmitted: 1, examined: 1, continued: false });
    expect(again).toEqual({ readmitted: 0, examined: 1, continued: false });
    expect((await row(harness, workItemId)).reevaluation).toMatchObject({
      trigger: 'check',
      at: 50,
    });
  });

  it('takes the deferral reason off a row it sends back, so no card says a granted permission is missing (the second pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    const { readmitSatisfiedInTransaction } = await verdictsModule();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'deferred', {
      decision: 'defer',
      reason: 'awaiting-permission',
      missingPermissions: ['linear:read'],
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        skipReason:
          'Deferred: this work needs linear:read, a permission Aiko does not hold. It is evaluated again once you grant it.',
      });
      await ctx.db.insert('permissionGrants', { agentId, scope: 'linear:read', createdAt: 1 });
    });

    await harness.run(async (ctx) => await readmitSatisfiedInTransaction(ctx, { agentId }, 50));

    const back = await row(harness, workItemId);
    expect(back.state).toBe('discovered');
    expect(back.skipReason).toBeUndefined();
  });
});
