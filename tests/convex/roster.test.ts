import { convexTest, type TestConvex } from 'convex-test';
import type { FunctionReturnType } from 'convex/server';
import { ConvexError } from 'convex/values';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { clipRoleLine } from '../../convex/roster';
import schema from '../../convex/schema';
import { rosterClock } from '../../src/metrics/roster-clock';
import { allConvexModules } from './all-modules';
import { guardRefusal } from './fakes/anonymous-caller';
import { fixtureAddressOf, managerIdentity } from './fakes/manager-identity';
import { registeredIn } from './registered-functions';
import * as rosterModule from '../../convex/roster';

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

  it('lands an item whose not-done answer was followed by a done one with no send-back between, as the cycle time counts it (the second pass, 17-F)', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T06:40:00Z'));
    const harness = convexTest(schema, allConvexModules());
    const nell = await employee(harness, 'owner', 'Nell');
    const log = await finishedItem(harness, nell);
    await log('work.completed', '2026-10-12T06:10:00Z', 'not-done');
    await log('work.completed', '2026-10-13T06:35:00Z', 'done');

    const [row] = await harness
      .withIdentity(managerIdentity('owner'))
      .query(api.agents.rosterForUser, {});

    expect(row?.landedThisMonth.days).toEqual([{ day: '2026-10-13', landed: 1 }]);
  });

  it('leaves out an item finished before the oldest send-back it read, and says the count is a floor, in a month of more send-backs than it reads (the second pass, 17-F)', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T06:40:00Z'));
    const harness = convexTest(schema, allConvexModules());
    const nell = await employee(harness, 'owner', 'Nell');
    // Done on the 2nd and sent back on the 3rd, never finished again: its card shows it running.
    const takenBack = await finishedItem(harness, nell);
    await takenBack('work.completed', '2026-10-02T06:00:00Z', 'done');
    await takenBack('work.retry', '2026-10-03T06:00:00Z');
    // Then a hundred send-backs of another item, a minute apart, and one landing after them all.
    const busy = await finishedItem(harness, nell);
    for (let minute = 0; minute < 100; minute += 1) {
      await busy(
        'work.retry',
        new Date(Date.parse('2026-10-05T00:00:00Z') + minute * 60_000).toISOString(),
      );
    }
    await busy('work.completed', '2026-10-06T06:00:00Z', 'done');

    const [row] = await harness
      .withIdentity(managerIdentity('owner'))
      .query(api.agents.rosterForUser, {});

    // The send-back of the 3rd is past the hundred read: the item it took back is not landed.
    expect(row?.landedThisMonth).toEqual({
      month: '2026-10',
      days: [{ day: '2026-10-06', landed: 1 }],
      atLeast: true,
    });
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

/** Every page of an owner's roster, read as the home reads it: twenty at a time to the end. */
async function everyRosterPage(
  harness: Harness,
  owner: string,
  at: number,
): Promise<{ rows: Array<{ agentId: string; name: string; today: string }>; pages: number }> {
  const caller = harness.withIdentity(managerIdentity(owner));
  const rows: Array<{ agentId: string; name: string; today: string }> = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page: FunctionReturnType<typeof api.roster.page> = await caller.query(api.roster.page, {
      paginationOpts: { numItems: 20, cursor },
      at,
    });
    rows.push(...page.page);
    pages += 1;
    if (page.isDone) return { rows, pages };
    cursor = page.continueCursor;
  }
}

describe('the roster read by pages (wave 17, 17-F; RM33 (a))', (): void => {
  it('lists every employee of an owner of fifty-one, each once, newest first, and no other owner’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mine: Id<'agents'>[] = [];
    for (let index = 1; index <= 51; index += 1) {
      mine.push(await employee(harness, 'owner', `Employee ${index}`));
    }
    // An evaluation agent of the owner's and another owner's employee, neither on the roster.
    await harness.run(async (ctx) => {
      await ctx.db.insert('agents', {
        bossEmail: 'eval-day0-r1-1760000000000@day0.local',
        name: 'Day0 evaluation 1',
        userId: 'owner',
        state: 'active',
        createdAt: 2,
      });
    });
    await employee(harness, 'neighbour', 'Not mine');

    const { rows, pages } = await everyRosterPage(harness, 'owner', Date.UTC(2026, 9, 13, 6));

    expect(pages).toBeGreaterThanOrEqual(3);
    expect(rows.map((row) => row.agentId)).toEqual([...mine].reverse());
    expect(rows.map((row) => row.name)).not.toContain('Day0 evaluation 1');
    expect(rows.map((row) => row.name)).not.toContain('Not mine');
  });

  it('reads at most twenty employees a page, whatever a caller asks for', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    for (let index = 1; index <= 25; index += 1) await employee(harness, 'owner', `E${index}`);
    const page = await harness.withIdentity(managerIdentity('owner')).query(api.roster.page, {
      paginationOpts: { numItems: 5_000, cursor: null },
      at: Date.UTC(2026, 9, 13, 6),
    });
    expect(page.page).toHaveLength(20);
    expect(page.isDone).toBe(false);
  });

  it('refuses a caller with no identity, and registers the one query', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(
      harness.query(api.roster.page, { paginationOpts: { numItems: 20, cursor: null }, at: 0 }),
    ).rejects.toMatchObject(await guardRefusal());
    expect(registeredIn(rosterModule)).toEqual(['page public query']);
  });
});

describe('the roster’s day follows the viewer’s clock (W16-R32)', (): void => {
  it('turns to the next day past the employee’s midnight while the backend’s clock stands still', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // The backend's clock, as a cached query last ran it: 23:50 on the 13th in Singapore.
    vi.setSystemTime(new Date('2026-10-13T15:50:00Z'));
    const harness = convexTest(schema, allConvexModules());
    await employee(harness, 'owner', 'Priya', 'Asia/Singapore');
    await employee(harness, 'owner', 'Mateo', 'America/Sao_Paulo');
    const todayAt = async (viewer: string): Promise<Record<string, string>> => {
      const { rows } = await everyRosterPage(harness, 'owner', rosterClock(Date.parse(viewer)));
      return Object.fromEntries(rows.map((row) => [row.name, row.today]));
    };

    // An idle page ten minutes before midnight in Singapore, then twenty minutes after it.
    expect(await todayAt('2026-10-13T15:50:00Z')).toEqual({
      Priya: '2026-10-13',
      Mateo: '2026-10-13',
    });
    expect(await todayAt('2026-10-13T16:10:00Z')).toEqual({
      Priya: '2026-10-14',
      Mateo: '2026-10-13',
    });
  });

  it('reads the month the viewer’s clock is in, so a new month starts empty', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T15:50:00Z'));
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'owner', 'Priya');
    const log = await finishedItem(harness, priya);
    await log('work.completed', '2026-10-31T10:00:00Z', 'done');
    const caller = harness.withIdentity(managerIdentity('owner'));
    const monthAt = async (viewer: string): Promise<unknown> =>
      (
        await caller.query(api.roster.page, {
          paginationOpts: { numItems: 20, cursor: null },
          at: rosterClock(Date.parse(viewer)),
        })
      ).page[0]?.landedThisMonth;

    expect(await monthAt('2026-10-31T15:50:00Z')).toEqual({
      month: '2026-10',
      days: [{ day: '2026-10-31', landed: 1 }],
      atLeast: false,
    });
    expect(await monthAt('2026-10-31T16:10:00Z')).toEqual({
      month: '2026-11',
      days: [],
      atLeast: false,
    });
  });

  it('refuses a clock that is no time on the calendar, in words the page shows', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await employee(harness, 'owner', 'Priya');
    const caller = harness.withIdentity(managerIdentity('owner'));
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, -1, Date.UTC(9999, 11, 31)]) {
      const refusal = await caller
        .query(api.roster.page, { paginationOpts: { numItems: 20, cursor: null }, at })
        .then(
          (): unknown => undefined,
          (error: unknown): unknown => error,
        );
      expect(refusal, String(at)).toBeInstanceOf(ConvexError);
      expect((refusal as ConvexError<string>).data).toBe(
        'The page’s clock is not a time Day0 can place on the calendar; reload the page',
      );
    }
  });
});

describe('the quarter hour the roster is asked at', (): void => {
  it('is the last quarter hour at or before the viewer’s clock, the step every zone’s midnight falls on', (): void => {
    expect(rosterClock(Date.parse('2026-10-13T16:14:59.999Z'))).toBe(
      Date.parse('2026-10-13T16:00:00Z'),
    );
    expect(rosterClock(Date.parse('2026-10-13T16:15:00Z'))).toBe(
      Date.parse('2026-10-13T16:15:00Z'),
    );
    // Kathmandu's midnight (UTC+5:45) is at a quarter hour too.
    expect(rosterClock(Date.parse('2026-10-13T18:15:00Z'))).toBe(
      Date.parse('2026-10-13T18:15:00Z'),
    );
  });
});
