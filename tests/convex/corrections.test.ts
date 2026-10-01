/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

/**
 * The one correction that crosses employees (decision N3): the first plan
 * rejection on a provider item reaches every other employee of the same
 * owner that plans that item, and no other employee's correction does.
 */

type Harness = TestConvex<typeof schema>;

const KEY = 'linear:REVOPS-1';

afterEach((): void => {
  restoreSurfaceMode();
});

interface Employee {
  agentId: Id<'agents'>;
  workItemId: Id<'workItems'>;
}

/**
 * One employee with one work item for the shared provider item.
 *
 * Args:
 *   harness: Convex test harness.
 *   options: The employee's name, its owner, and the row's state and rejection time.
 *
 * Returns:
 *   The agent and work item ids.
 */
async function employee(
  harness: Harness,
  options: {
    name: string;
    userId?: string;
    state?: Doc<'workItems'>['state'];
    planRejectedAt?: number;
    rejectedAt?: number;
    key?: { externalClaimKey?: string; externalClaimAlias?: string };
  },
): Promise<Employee> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: options.name,
      userId: options.userId ?? 'owner',
      state: 'active',
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-1',
      ...(options.key ?? { externalClaimKey: KEY }),
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state: options.state ?? 'claimed',
      ...(options.planRejectedAt !== undefined ? { planRejectedAt: options.planRejectedAt } : {}),
      ...(options.rejectedAt !== undefined ? { rejectedAt: options.rejectedAt } : {}),
      observedAt: 1,
      createdAt: 1,
    });
    return { agentId, workItemId };
  });
}

async function keep(
  harness: Harness,
  owner: Employee,
  options: {
    kind: Doc<'corrections'>['kind'];
    text: string;
    createdAt: number;
    retiredAt?: number;
  },
): Promise<Id<'corrections'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('corrections', {
        agentId: owner.agentId,
        workItemId: owner.workItemId,
        kind: options.kind,
        text: options.text,
        itemTitle: 'Add the close-summary audit note',
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        surfaces: ['linear'],
        createdAt: options.createdAt,
        ...(options.retiredAt !== undefined ? { retiredAt: options.retiredAt } : {}),
        appliedTo: [],
      }),
  );
}

/** The module under the mode the test chose; `SURFACE_MODE` is read at import. */
async function correctionsModule(): Promise<typeof import('../../convex/corrections')> {
  return await import('../../convex/corrections');
}

async function rejectionFor(harness: Harness, workItemId: Id<'workItems'>) {
  const { firstTicketRejection } = await correctionsModule();
  const rejection = await harness.run(async (ctx) => {
    const row = await ctx.db.get(workItemId);
    if (!row) throw new Error('work item missing');
    return await firstTicketRejection(ctx, row);
  });
  // `harness.run` returns an absent result as null.
  return rejection ?? undefined;
}

describe('firstTicketRejection', (): void => {
  it("names the earliest rejected plan for the item among the owner's other employees", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const later = await employee(harness, { name: 'Aiko', state: 'cancelled', planRejectedAt: 20 });
    const first = await employee(harness, {
      name: 'Priya',
      state: 'cancelled',
      planRejectedAt: 10,
    });
    const words = await keep(harness, first, {
      kind: 'plan-rejection',
      text: 'finance owns this ask',
      createdAt: 10,
    });
    await keep(harness, later, { kind: 'plan-rejection', text: 'not this week', createdAt: 20 });
    const sibling = await employee(harness, { name: 'Mateo' });

    const rejection = await rejectionFor(harness, sibling.workItemId);

    expect(rejection).toMatchObject({
      workItemId: first.workItemId,
      agentId: first.agentId,
      rejectedAt: 10,
      correction: expect.objectContaining({ _id: words, text: 'finance owns this ask' }),
    });
  });

  it("names a colleague's rejected actions as the first rejection, with the manager's words", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const planRejected = await employee(harness, {
      name: 'Aiko',
      state: 'cancelled',
      planRejectedAt: 20,
      rejectedAt: 20,
    });
    await keep(harness, planRejected, {
      kind: 'plan-rejection',
      text: 'not this week',
      createdAt: 20,
    });
    const actionsRejected = await employee(harness, {
      name: 'Priya',
      state: 'failed',
      rejectedAt: 10,
    });
    const words = await keep(harness, actionsRejected, {
      kind: 'rejection',
      text: 'the notice goes to finance first',
      createdAt: 10,
    });
    const sibling = await employee(harness, { name: 'Mateo' });

    expect(await rejectionFor(harness, sibling.workItemId)).toMatchObject({
      workItemId: actionsRejected.workItemId,
      rejectedAt: 10,
      correction: expect.objectContaining({ _id: words, text: 'the notice goes to finance first' }),
    });
  });

  it("finds the owner's rejection behind more rows for the item than one read takes", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    for (let row = 0; row < 40; row += 1) {
      await employee(harness, { name: `Earlier ${row}`, state: 'completed' });
    }
    const rejected = await employee(harness, { name: 'Priya', state: 'failed', rejectedAt: 50 });
    const sibling = await employee(harness, { name: 'Mateo' });

    expect(await rejectionFor(harness, sibling.workItemId)).toMatchObject({
      workItemId: rejected.workItemId,
      rejectedAt: 50,
    });
  });

  it('matches the item under its alias as well as its key', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const rejected = await employee(harness, {
      name: 'Priya',
      state: 'cancelled',
      planRejectedAt: 10,
      key: { externalClaimKey: 'linear:uuid-1', externalClaimAlias: KEY },
    });
    const sibling = await employee(harness, { name: 'Mateo' });

    expect(await rejectionFor(harness, sibling.workItemId)).toMatchObject({
      workItemId: rejected.workItemId,
    });
  });

  it("ignores another owner's rejection, the row's own, and a rejection whose words were retired", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    await employee(harness, {
      name: 'Elsewhere',
      userId: 'someone-else',
      state: 'cancelled',
      planRejectedAt: 1,
    });
    const own = await employee(harness, {
      name: 'Mateo',
      state: 'plan-pending',
      planRejectedAt: 2,
    });
    expect(await rejectionFor(harness, own.workItemId)).toBeUndefined();

    const retired = await employee(harness, {
      name: 'Priya',
      state: 'cancelled',
      planRejectedAt: 3,
    });
    await keep(harness, retired, {
      kind: 'plan-rejection',
      text: 'finance owns this ask',
      createdAt: 3,
      retiredAt: 4,
    });
    const rejection = await rejectionFor(harness, own.workItemId);
    expect(rejection).toMatchObject({ workItemId: retired.workItemId });
    expect(rejection).not.toHaveProperty('correction');
  });

  it('shares nothing in mock mode or for a row with no provider item key', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    await employee(harness, { name: 'Priya', state: 'cancelled', planRejectedAt: 10 });
    const keyless = await employee(harness, { name: 'Mateo', key: {} });
    const keyed = await employee(harness, { name: 'Aiko' });

    expect(await rejectionFor(harness, keyless.workItemId)).toBeUndefined();
    useSurfaceMode('mock');
    expect(await rejectionFor(harness, keyed.workItemId)).toBeUndefined();
  });
});

describe('the rejection a sibling reads', (): void => {
  async function rejectedAndSibling(harness: Harness): Promise<{
    rejected: Employee;
    sibling: Employee;
    shared: Id<'corrections'>;
    unrelated: Id<'corrections'>;
  }> {
    const rejected = await employee(harness, {
      name: 'Priya',
      state: 'cancelled',
      planRejectedAt: 10,
    });
    const shared = await keep(harness, rejected, {
      kind: 'plan-rejection',
      text: 'finance owns this ask',
      createdAt: 10,
    });
    const unrelated = await keep(harness, rejected, {
      kind: 'retry-note',
      text: 'use the new template',
      createdAt: 11,
    });
    const sibling = await employee(harness, { name: 'Mateo' });
    return { rejected, sibling, shared, unrelated };
  }

  it("puts the first rejection first in the sibling's planner corrections, and only when given the work item", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { sibling, shared } = await rejectedAndSibling(harness);
    const own = await keep(harness, sibling, {
      kind: 'retry-note',
      text: 'keep it short',
      createdAt: 12,
    });
    const candidate = {
      agentId: sibling.agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
    };

    const withItem = await harness.query(internal.corrections.selectedForCandidate, {
      ...candidate,
      workItemId: sibling.workItemId,
    });
    const withoutItem = await harness.query(internal.corrections.selectedForCandidate, candidate);

    expect(withItem.map((row) => row._id)).toEqual([shared, own]);
    expect(withoutItem.map((row) => row._id)).toEqual([own]);
  });

  it("lets the sibling's executor and stored plan keep the first rejection and no other of the colleague's corrections", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { sibling, shared, unrelated } = await rejectedAndSibling(harness);

    const forExecutor = await harness.query(internal.corrections.forPlan, {
      agentId: sibling.agentId,
      ids: [shared, unrelated],
      workItemId: sibling.workItemId,
    });
    const withoutItem = await harness.query(internal.corrections.forPlan, {
      agentId: sibling.agentId,
      ids: [shared, unrelated],
    });
    const { markCorrectionsAppliedInTransaction } = await correctionsModule();
    const applied = await harness.run(async (ctx) => {
      const row = await ctx.db.get(sibling.workItemId);
      if (!row) throw new Error('work item missing');
      return await markCorrectionsAppliedInTransaction(ctx, row, [shared, unrelated]);
    });

    expect(forExecutor.map((row) => row._id)).toEqual([shared]);
    expect(withoutItem).toEqual([]);
    expect(applied).toEqual([shared]);
    expect((await harness.run(async (ctx) => await ctx.db.get(shared)))?.appliedTo).toEqual([
      sibling.workItemId,
    ]);
  });
});
