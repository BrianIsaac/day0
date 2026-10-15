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
import { rosterRows } from './fakes/roster';
import { HEAVY_ITEMS, HEAVY_NOTES, seedWorkedEmployee } from './fakes/heavy-employee';

/*
 * The roster's helpers, moved out of `convex/agents.ts` with them (standard 9.2). A row's reading
 * is tested in `agents.test.ts` and here, through the page the home reads (`roster.page`; the one
 * read of the twenty newest, `agents.rosterForUser`, is gone since 0.22.0, F-1).
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

    const [row] = await rosterRows(harness.withIdentity(managerIdentity('owner')));

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

    const [row] = await rosterRows(harness.withIdentity(managerIdentity('owner')));

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

    const [row] = await rosterRows(harness.withIdentity(managerIdentity('owner')));

    expect(row?.landedThisMonth.days).toEqual([{ day: '2026-10-13', landed: 1 }]);
  });

  it('counts every completion after a hundred and fifty send-backs in a month, the month read to its start (T5, wave 18)', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T06:40:00Z'));
    const harness = convexTest(schema, allConvexModules());
    const nell = await employee(harness, 'owner', 'Nell');
    // Done on the 2nd and sent back on the 3rd, never finished again: its card shows it running.
    const takenBack = await finishedItem(harness, nell);
    await takenBack('work.completed', '2026-10-02T06:00:00Z', 'done');
    await takenBack('work.retry', '2026-10-03T06:00:00Z');
    // A hundred and fifty send-backs of another item, a minute apart, with a third item landed
    // among them (never sent back), and the busy one landed after them all.
    const busy = await finishedItem(harness, nell);
    const among = await finishedItem(harness, nell);
    for (let minute = 0; minute < 150; minute += 1) {
      const at = Date.parse('2026-10-05T00:00:00Z') + minute * 60_000;
      await busy('work.retry', new Date(at).toISOString());
      if (minute === 25) await among('work.completed', new Date(at + 1_000).toISOString(), 'done');
    }
    await busy('work.completed', '2026-10-06T06:00:00Z', 'done');

    const [row] = await rosterRows(harness.withIdentity(managerIdentity('owner')));

    // The send-back of the 3rd is read, so the item it took back is not landed; the one landed
    // among the send-backs is, and the count is the month's whole, not a floor.
    expect(row?.landedThisMonth).toEqual({
      month: '2026-10',
      days: [
        { day: '2026-10-05', landed: 1 },
        { day: '2026-10-06', landed: 1 },
      ],
      atLeast: false,
    });
  });
});

describe('what an employee landed this month, past the bytes its send-backs may read (T5, wave 18)', (): void => {
  it('says the count is a floor, and leaves out what finished before the oldest send-back read', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T06:40:00Z'));
    const harness = convexTest(schema, allConvexModules());
    const nell = await employee(harness, 'owner', 'Nell');
    const early = await finishedItem(harness, nell);
    await early('work.completed', '2026-10-02T06:00:00Z', 'done');
    const busy = await finishedItem(harness, nell);
    await busy('work.completed', '2026-10-12T06:00:00Z', 'done');
    // Three hundred send-backs of 1.5 KB of note each: more than a month's send-backs may read.
    await harness.run(async (ctx) => {
      const [item] = await ctx.db.query('workItems').order('desc').take(1);
      for (let minute = 0; minute < 300; minute += 1) {
        await ctx.db.insert('events', {
          agentId: nell,
          type: 'work.retry',
          payload: {
            workItemId: item!._id,
            resumeState: 'plan-approved',
            fromState: 'completed',
            feedback: `Finish it, ${minute}: ${'a long note '.repeat(128)}`,
          },
          createdAt: Date.parse('2026-10-05T00:00:00Z') + minute * 60_000,
        });
      }
    });
    await busy('work.completed', '2026-10-12T07:00:00Z', 'done');

    const [row] = await rosterRows(harness.withIdentity(managerIdentity('owner')));

    expect(row?.landedThisMonth).toEqual({
      month: '2026-10',
      days: [{ day: '2026-10-12', landed: 1 }],
      atLeast: true,
    });
  });
});

describe('what an employee landed this month, at exactly the send-backs it reads (the second pass of the fixes, 17-F)', (): void => {
  it('leaves nothing out and says no floor in a month of exactly a hundred send-backs', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T06:40:00Z'));
    const harness = convexTest(schema, allConvexModules());
    const nell = await employee(harness, 'owner', 'Nell');
    // Done on the 2nd and never sent back: older than every send-back, and still landed.
    const early = await finishedItem(harness, nell);
    await early('work.completed', '2026-10-02T06:00:00Z', 'done');
    const busy = await finishedItem(harness, nell);
    for (let minute = 0; minute < 100; minute += 1) {
      await busy(
        'work.retry',
        new Date(Date.parse('2026-10-05T00:00:00Z') + minute * 60_000).toISOString(),
      );
    }

    const [row] = await rosterRows(harness.withIdentity(managerIdentity('owner')));

    expect(row?.landedThisMonth).toEqual({
      month: '2026-10',
      days: [{ day: '2026-10-02', landed: 1 }],
      atLeast: false,
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

/** The quarter hour a viewer's clock, written as a date, asks the roster at. */
function stepOf(viewer: string): number {
  const at = rosterClock(Date.parse(viewer));
  if (at === undefined) throw new Error(`no step for ${viewer}`);
  return at;
}

describe('the roster’s day follows the viewer’s clock (W16-R32)', (): void => {
  it('turns to the next day past the employee’s midnight while the backend’s clock stands still', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // The backend's clock, as a cached query last ran it: 23:50 on the 13th in Singapore.
    vi.setSystemTime(new Date('2026-10-13T15:50:00Z'));
    const harness = convexTest(schema, allConvexModules());
    await employee(harness, 'owner', 'Priya', 'Asia/Singapore');
    await employee(harness, 'owner', 'Mateo', 'America/Sao_Paulo');
    const todayAt = async (viewer: string): Promise<Record<string, string>> => {
      const { rows } = await everyRosterPage(harness, 'owner', stepOf(viewer));
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
          at: stepOf(viewer),
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

describe('the roster of an employee whose month of completions passes one read (C1’s roster; wave 18, 18-F)', (): void => {
  it('answers the page, the heavy employee’s month a floor of what fit, the others’ whole', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T06:00:00Z'));
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    await seedWorkedEmployee(harness, 'Aiko', HEAVY_NOTES);
    await seedWorkedEmployee(harness, 'Mateo', '');

    const rows = await rosterRows(harness.withIdentity(managerIdentity('owner')));

    const aiko = rows.find((row) => row.name === 'Aiko');
    const mateo = rows.find((row) => row.name === 'Mateo');
    expect(mateo?.landedThisMonth).toMatchObject({ month: '2026-10', atLeast: false });
    expect(mateo?.landedThisMonth.days.reduce((sum, day) => sum + day.landed, 0)).toBe(HEAVY_ITEMS);
    expect(aiko?.landedThisMonth.atLeast).toBe(true);
    expect(aiko?.landedThisMonth.days.reduce((sum, day) => sum + day.landed, 0)).toBeGreaterThan(0);
  });
});

describe('the roster of an employee whose unfinished rows pass one read (18-W’s F1, at the joins)', (): void => {
  it('answers the page with an employee of eleven parked rows of 900 KB and its stopped rows', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T06:00:00Z'));
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const aiko = await seedWorkedEmployee(harness, 'Aiko', '');
    await seedWorkedEmployee(harness, 'Mateo', '');
    // 18-W's bed shape (`wave18-w-2026-10-14-bed/kit/heavy.py`): eleven deferred rows whose output
    // weighs 900 KB, two stopped rows, each row in a transaction of its own.
    const base = {
      agentId: aiko,
      sourceCategory: 'ticket-queue' as const,
      sourceSystem: 'linear',
      contentRefs: [],
      contentSummary: 'Seeded: a parked row whose output is heavy.',
      observedAt: Date.now(),
      createdAt: Date.now(),
    };
    for (let n = 0; n < 11; n += 1) {
      await harness.run(async (ctx) => {
        await ctx.db.insert('workItems', {
          ...base,
          externalId: `REVOPS-${600 + n}`,
          title: `Parked audit note ${n + 1}`,
          state: 'deferred',
          output: { draft: '', notes: HEAVY_NOTES, actions: [], applied: [] },
        });
      });
    }
    for (const externalId of ['REVOPS-500', 'REVOPS-501']) {
      await harness.run(async (ctx) => {
        await ctx.db.insert('workItems', {
          ...base,
          externalId,
          title: `Stopped ${externalId}`,
          state: 'failed',
          skipReason: 'stopped: the model call failed: 429 Too Many Requests',
          output: { draft: '', notes: HEAVY_NOTES, actions: [], applied: [] },
        });
      });
    }

    const rows = await rosterRows(harness.withIdentity(managerIdentity('owner')));

    const row = rows.find((one) => one.name === 'Aiko');
    expect(row).toMatchObject({ parkedCount: 11, stoppedCount: 2 });
    expect(rows.map((one) => one.name).sort()).toEqual(['Aiko', 'Mateo']);
  });
});
