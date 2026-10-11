/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  REEVALUATION_BATCH,
  reevaluatePendingInTransaction,
  reevaluationSpent,
  reevaluationStamp,
  SPENT_REEVALUATION_KEYS,
} from '../../convex/workReevaluation';
import { OUT_OF_SCOPE_SKIP_PREFIX } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * Re-evaluation of parked work (`convex/workReevaluation.ts`, moved out of `convex/work.ts` by the
 * wave 15 helpers split): a policy change sends back the skipped and deferred rows whose verdict
 * read it, once per change key, and the stamp a row keeps remembers every key it spent.
 */

type Harness = TestConvex<typeof schema>;

// A re-admitted row schedules its next step; the scheduler's timer is faked so
// nothing runs after the test that scheduled it.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

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

async function seedSkipped(
  harness: Harness,
  agentId: Id<'agents'>,
  externalId: string,
  reason: string,
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId,
        title: `Ticket ${externalId}`,
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state: 'skipped',
        verdict: { decision: 'skip', reason },
        observedAt: 1,
        createdAt: 1,
      }),
  );
}

async function readRow(harness: Harness, id: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(id));
  if (!row) throw new Error('work item missing');
  return row;
}

describe('reevaluationSpent and reevaluationStamp', (): void => {
  it('remembers every key a row spent, newest last, and reads each as spent', (): void => {
    const first = reevaluationStamp({}, 'charter', 'charter:v2', 10);
    const second = reevaluationStamp({ reevaluation: first }, 'surface', 'surface:linear', 20);

    expect(second).toEqual({
      trigger: 'surface',
      key: 'surface:linear',
      at: 20,
      spent: ['charter:v2', 'surface:linear'],
    });
    expect(reevaluationSpent({ reevaluation: second }, 'charter:v2')).toBe(true);
    expect(reevaluationSpent({ reevaluation: second }, 'charter:v3')).toBe(false);
    expect(reevaluationSpent({}, 'charter:v2')).toBe(false);
  });

  it('forgets the oldest key past the bound', (): void => {
    let stamp = reevaluationStamp({}, 'charter', 'key:0', 0);
    for (let index = 1; index <= SPENT_REEVALUATION_KEYS; index += 1) {
      stamp = reevaluationStamp({ reevaluation: stamp }, 'charter', `key:${index}`, index);
    }

    expect(stamp.spent).toHaveLength(SPENT_REEVALUATION_KEYS);
    expect(reevaluationSpent({ reevaluation: stamp }, 'key:0')).toBe(false);
    expect(reevaluationSpent({ reevaluation: stamp }, `key:${SPENT_REEVALUATION_KEYS}`)).toBe(true);
  });
});

describe('reevaluatePendingInTransaction', (): void => {
  it('sends back the skip a charter change can alter, once per key, and leaves the rest', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const outOfScope = await seedSkipped(
      harness,
      agentId,
      'REVOPS-1',
      `${OUT_OF_SCOPE_SKIP_PREFIX}no charter overlap`,
    );
    const lowValue = await seedSkipped(harness, agentId, 'REVOPS-2', 'low value');

    const first = await harness.run(
      async (ctx) =>
        await reevaluatePendingInTransaction(ctx, {
          agentId,
          trigger: 'charter',
          key: 'charter:v2',
          now: 100,
        }),
    );

    expect(first).toEqual({ readmitted: 1, examined: 2, continued: false });
    expect(await readRow(harness, outOfScope)).toMatchObject({
      state: 'discovered',
      reevaluation: { trigger: 'charter', key: 'charter:v2', at: 100, spent: ['charter:v2'] },
    });
    expect((await readRow(harness, outOfScope)).verdict).toBeUndefined();
    expect((await readRow(harness, lowValue)).state).toBe('skipped');

    await harness.run(async (ctx) => {
      await ctx.db.patch(outOfScope, {
        state: 'skipped',
        verdict: { decision: 'skip', reason: `${OUT_OF_SCOPE_SKIP_PREFIX}no charter overlap` },
      });
    });
    const again = await harness.run(
      async (ctx) =>
        await reevaluatePendingInTransaction(ctx, {
          agentId,
          trigger: 'charter',
          key: 'charter:v2',
        }),
    );

    expect(again).toEqual({ readmitted: 0, examined: 2, continued: false });
    expect((await readRow(harness, outOfScope)).state).toBe('skipped');
  });

  it('refuses a surface trigger that names no surface of the agent', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);

    await expect(
      harness.run(
        async (ctx) =>
          await reevaluatePendingInTransaction(ctx, { agentId, trigger: 'surface', key: 's' }),
      ),
    ).rejects.toThrow('a surface trigger names a surface of the agent');
  });

  it('examines one batch per state and schedules the rest as a continuation', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    for (let index = 0; index <= REEVALUATION_BATCH; index += 1) {
      await seedSkipped(harness, agentId, `REVOPS-${index}`, `${OUT_OF_SCOPE_SKIP_PREFIX}none`);
    }

    const result = await harness.run(
      async (ctx) =>
        await reevaluatePendingInTransaction(ctx, { agentId, trigger: 'charter', key: 'c' }),
    );
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );

    expect(result).toEqual({
      readmitted: REEVALUATION_BATCH,
      examined: REEVALUATION_BATCH,
      continued: true,
    });
    expect(
      scheduled.filter((job) => job.name.includes('reevaluatePending')).map((job) => job.args[0]),
    ).toEqual([
      {
        agentId,
        trigger: 'charter',
        key: 'c',
        after: { skipped: expect.any(Number) },
      },
    ]);
  });
});
