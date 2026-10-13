import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { clipRoleLine } from '../../convex/roster';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { fixtureAddressOf, managerIdentity } from './fakes/manager-identity';

/*
 * The roster's helpers, moved out of `convex/agents.ts` with them (standard 9.2). The roster
 * query (`agents.rosterForUser`) is tested where its path is, in `agents.test.ts`; what wave 17
 * changed of a row's reading (17-F) is tested here, through the same query.
 */

type Harness = TestConvex<typeof schema>;

afterEach((): void => {
  vi.useRealTimers();
});

/** One employee of an owner, in a zone, with no charter and no work. */
async function employee(
  harness: Harness,
  owner: string,
  name: string,
  zone = 'Asia/Singapore',
): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: fixtureAddressOf(owner),
        name,
        userId: owner,
        state: 'active',
        zone,
        createdAt: 1,
      }),
  );
}

/** One finished item of an employee and the way to log what happened to it, at a moment. */
async function finishedItem(
  harness: Harness,
  agentId: Id<'agents'>,
): Promise<
  (type: 'work.completed' | 'work.retry', at: string, workDone?: string) => Promise<void>
> {
  const workItemId = await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'docs',
        sourceSystem: 'docs',
        externalId: 'docs-1',
        title: 'Kofi is locked out of the shared drive after a password change',
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state: 'completed',
        observedAt: 1,
        createdAt: 1,
      }),
  );
  return async (type, at, workDone): Promise<void> => {
    await harness.run(async (ctx) => {
      await ctx.db.insert('events', {
        agentId,
        type,
        payload:
          type === 'work.completed'
            ? { workItemId, output: { workDone, workDoneWhy: 'Said by the run.' } }
            : {
                workItemId,
                resumeState: 'plan-approved',
                fromState: 'completed',
                feedback: 'Finish it.',
              },
        createdAt: Date.parse(at),
      });
    });
  };
}

describe('what an employee landed this month, after a send-back (the v0.20.0 walk’s finding 4)', (): void => {
  it('counts a partly-done item sent back and finished as landed, once, on the day it finished', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T06:40:00Z'));
    const harness = convexTest(schema, allConvexModules());
    const nell = await employee(harness, 'owner', 'Nell');
    const log = await finishedItem(harness, nell);
    // The walk's row: partly done, sent back with a note at 14:34, landed at 14:35 Singapore time.
    await log('work.completed', '2026-10-12T06:10:00Z', 'partial');
    await log('work.retry', '2026-10-13T06:34:00Z');
    await log('work.completed', '2026-10-13T06:35:00Z', 'done');

    const [row] = await harness
      .withIdentity(managerIdentity('owner'))
      .query(api.agents.rosterForUser, {});

    expect(row?.landedThisMonth).toEqual({
      month: '2026-10',
      days: [{ day: '2026-10-13', landed: 1 }],
      atLeast: false,
    });
  });

  it('counts nothing for an item sent back and not finished again, and partly for one that finished so', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T06:40:00Z'));
    const harness = convexTest(schema, allConvexModules());
    const nell = await employee(harness, 'owner', 'Nell');
    const running = await finishedItem(harness, nell);
    await running('work.completed', '2026-10-12T06:10:00Z', 'done');
    await running('work.retry', '2026-10-13T06:34:00Z');
    const partly = await finishedItem(harness, nell);
    await partly('work.completed', '2026-10-12T07:00:00Z', 'done');
    await partly('work.retry', '2026-10-12T08:00:00Z');
    await partly('work.completed', '2026-10-13T01:00:00Z', 'partial');

    const [row] = await harness
      .withIdentity(managerIdentity('owner'))
      .query(api.agents.rosterForUser, {});

    expect(row?.landedThisMonth.days).toEqual([{ day: '2026-10-13', landed: 0, partly: 1 }]);
  });
});

describe('clipRoleLine', (): void => {
  it('clips a long role line at a word boundary to 90 characters', (): void => {
    const cases: Array<[string, string]> = [
      [
        'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
        'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps\u2026',
      ],
      [
        'Reconcile the month-end ledgers against the bank feeds, chase missing supplier invoices, and prepare the close pack.',
        'Reconcile the month-end ledgers against the bank feeds, chase missing supplier invoices\u2026',
      ],
      [
        '  Close the month,\n every month,   for the finance team. ',
        'Close the month, every month, for the finance team.',
      ],
      [`${'a'.repeat(44)} ${'b'.repeat(45)}`, `${'a'.repeat(44)} ${'b'.repeat(45)}`],
      ['x'.repeat(120), `${'x'.repeat(89)}\u2026`],
    ];
    for (const [text, expected] of cases) {
      expect(clipRoleLine(text)).toBe(expected);
      expect(clipRoleLine(text).length).toBeLessThanOrEqual(90);
    }
  });

  it('does not split a surrogate pair when one long role word must be clipped', (): void => {
    const glyph = '\u{1F600}';
    expect(clipRoleLine(glyph.repeat(60))).toBe(`${glyph.repeat(44)}\u2026`);
  });
});
