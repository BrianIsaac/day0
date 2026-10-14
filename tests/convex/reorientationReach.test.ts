import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { heldByReorientation } from '../../convex/reorientation';
import * as reorientationReachModule from '../../convex/reorientationReach';
import {
  OPEN_WORK_STATES,
  REACH_ROW_BUDGET,
  blockingWorkOf,
  hasOpenWork,
  openWorkCache,
  openWorkCiting,
  openWorkOf,
  openWorkUsingSkills,
  ownerAgents,
  reachOf,
  scopeReach,
  skillReach,
  surfaceReach,
  workRowsReadIn,
  type CardAffected,
} from '../../convex/reorientationReach';
import { allConvexModules } from './all-modules';
import { OWNER_SUBJECT } from './fakes/manager-identity';
import {
  cardOf,
  openTestCard,
  seedEmployee,
  seedWork,
  warnedBy,
  type Harness,
} from './fakes/reorientation';
import { registeredIn } from './registered-functions';

/*
 * What a card reaches and holds (`convex/reorientationReach.ts`; wave 17, 17-s). The hold's first
 * test came from `tests/convex/reorientation.test.ts` as it stood; the rest read the module's
 * exports directly, where the card's and the triggers' tests read them through `openCard`.
 */

// openCard schedules the judgement: fake timers keep it from running unless a test drains it.
beforeEach((): void => {
  vi.useFakeTimers();
});
afterEach((): void => {
  vi.useRealTimers();
});

/** A registered skill of the employee's, needing the scopes, writing the system. */
async function registeredSkill(
  harness: Harness,
  agentId: Id<'agents'>,
  fields: Partial<Doc<'skills'>> = {},
): Promise<Id<'skills'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('skills', {
        agentId,
        ownerKey: OWNER_SUBJECT,
        name: 'kanban-comment-and-close',
        description: 'Ticket comment-and-close.',
        body: '# Ticket comment-and-close',
        sourceType: 'agent-authored',
        state: 'registered',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        targetSurface: 'linear',
        requiredScopes: ['linear:read', 'linear:write'],
        registeredAt: 1,
        createdAt: 1,
        ...fields,
      }),
  );
}

/** One of the employee's connected systems. */
async function connectedSystem(
  harness: Harness,
  agentId: Id<'agents'>,
  slug: string,
): Promise<Id<'surfaces'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('surfaces', {
        agentId,
        slug,
        displayName: slug,
        class: 'kanban',
        verdict: 'connected',
        whereFound: [],
        managerApprovedAt: 1,
        credentialLanded: true,
        createdAt: 1,
      }),
  );
}

/** A linked source, for a plan's cites to name. */
async function linkedSource(harness: Harness): Promise<Id<'docSources'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('docSources', {
        userId: OWNER_SUBJECT,
        kind: 'folder',
        label: 'Company handbook',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      }),
  );
}

/** A plan citing one page of a source. */
function planCiting(sourceId: Id<'docSources'>, pageRef: string): Doc<'workItems'>['plan'] {
  return {
    summary: 'Answer the ask.',
    steps: ['Read the page', 'Reply'],
    cites: [{ step: 1, label: 'Escalation paths > Tier 2', sourceId, pageRef, blocks: [] }],
  };
}

const NOTHING: CardAffected = {
  charterClauses: [],
  agreements: [],
  relationships: [],
  skills: [],
  surfaces: [],
  workItems: [],
};

describe('the hold: the work a high-risk card holds', (): void => {
  it('holds the affected open work on a high-risk card, at most ten items, and nothing on a low-risk one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const open: Id<'workItems'>[] = [];
    for (let index = 0; index < 12; index += 1) {
      open.push(
        await seedWork(harness, agentId, 'plan-pending', { externalId: `REVOPS-${index}` }),
      );
    }
    const done = await seedWork(harness, agentId, 'completed', { externalId: 'REVOPS-99' });
    const high = await openTestCard(harness, {
      agentId,
      trigger: 'relationship-changed',
      triggerKey: 'event-1',
      summary: 'Priya now approves tier-2 drafts',
      affected: { workItems: [done, ...open] },
    });
    const card = await cardOf(harness, high!);
    expect(card.risk).toBe('high');
    expect(card.blockingWork).toEqual(open.slice(0, 10));
    const held = await harness.run(
      async (ctx) => await heldByReorientation(ctx, { _id: open[0], agentId }),
    );
    expect(held?._id).toBe(high);
    // A run's undefined comes back as null.
    expect(
      await harness.run(async (ctx) => await heldByReorientation(ctx, { _id: open[11], agentId })),
    ).toBeNull();

    const low = await seedEmployee(harness, { name: 'Pip' });
    const lowWork = await seedWork(harness, low, 'plan-pending');
    await openTestCard(harness, {
      agentId: low,
      trigger: 'skill-recheck-due',
      triggerKey: 'event-2',
      summary: 'A skill is due a re-check',
    });
    expect(
      await harness.run(
        async (ctx) => await heldByReorientation(ctx, { _id: lowWork, agentId: low }),
      ),
    ).toBeNull();
  });

  it('holds nothing below high risk, and on a high-risk card only rows still open, a row that is gone left out', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const pending = await seedWork(harness, agentId, 'plan-pending', { externalId: 'REVOPS-1' });
    const running = await seedWork(harness, agentId, 'executing', { externalId: 'REVOPS-2' });
    const failed = await seedWork(harness, agentId, 'failed', { externalId: 'REVOPS-3' });
    const gone = await seedWork(harness, agentId, 'plan-approved', { externalId: 'REVOPS-4' });
    await harness.run(async (ctx) => await ctx.db.delete(gone));
    const affected = { ...NOTHING, workItems: [pending, failed, gone, running] };
    expect(await harness.run(async (ctx) => await blockingWorkOf(ctx, affected, 'low'))).toEqual(
      [],
    );
    expect(await harness.run(async (ctx) => await blockingWorkOf(ctx, affected, 'medium'))).toEqual(
      [],
    );
    expect(await harness.run(async (ctx) => await blockingWorkOf(ctx, affected, 'high'))).toEqual([
      pending,
      running,
    ]);
  });
});

describe('an employee’s open work', (): void => {
  it('is its rows in the four open states, and no row past them or of another employee', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const other = await seedEmployee(harness, { name: 'Pip' });
    const open: Id<'workItems'>[] = [];
    for (const state of OPEN_WORK_STATES) {
      open.push(await seedWork(harness, agentId, state, { externalId: `REVOPS-${state}` }));
    }
    for (const state of ['discovered', 'claimed', 'completed', 'cancelled', 'failed'] as const) {
      await seedWork(harness, agentId, state, { externalId: `REVOPS-${state}` });
    }
    await seedWork(harness, other, 'plan-pending');
    const rows = (await harness.run(async (ctx) => await openWorkOf(ctx, agentId))) ?? [];
    expect(rows.map((row) => row._id)).toEqual(open);
    expect(rows.map((row) => row.state)).toEqual([...OPEN_WORK_STATES]);
  });

  it('is narrowed to the rows whose plan cites one of the pages, by source and ref', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const sourceId = await linkedSource(harness);
    const otherSource = await linkedSource(harness);
    const ref = 'revops/escalation-paths.md';
    const cited = await seedWork(harness, agentId, 'plan-approved', {
      externalId: 'REVOPS-1',
      plan: planCiting(sourceId, ref),
    });
    await seedWork(harness, agentId, 'plan-pending', {
      externalId: 'REVOPS-2',
      plan: planCiting(sourceId, 'revops/glossary.md'),
    });
    await seedWork(harness, agentId, 'plan-pending', {
      externalId: 'REVOPS-3',
      plan: planCiting(otherSource, ref),
    });
    await seedWork(harness, agentId, 'completed', {
      externalId: 'REVOPS-4',
      plan: planCiting(sourceId, ref),
    });
    await seedWork(harness, agentId, 'executing', { externalId: 'REVOPS-5' });
    await seedWork(harness, agentId, 'executing', {
      externalId: 'REVOPS-6',
      plan: { summary: 'An older plan.', steps: [], cites: 'none' },
    });
    expect(
      await harness.run(async (ctx) => await openWorkCiting(ctx, agentId, [{ sourceId, ref }])),
    ).toEqual([cited]);
    expect(await harness.run(async (ctx) => await openWorkCiting(ctx, agentId, []))).toEqual([]);
  });

  it('is narrowed to the rows running one of the skills, the employee’s own and still open', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const other = await seedEmployee(harness, { name: 'Pip' });
    const skillId = await registeredSkill(harness, agentId);
    const unused = await registeredSkill(harness, agentId, { name: 'kanban-comment' });
    const running = await seedWork(harness, agentId, 'actions-pending', {
      externalId: 'REVOPS-1',
      skillId,
    });
    await seedWork(harness, agentId, 'completed', { externalId: 'REVOPS-2', skillId });
    await seedWork(harness, other, 'plan-approved', { externalId: 'REVOPS-3', skillId });
    await seedWork(harness, agentId, 'plan-approved', { externalId: 'REVOPS-4' });
    expect(
      await harness.run(async (ctx) => await openWorkUsingSkills(ctx, agentId, [skillId, unused])),
    ).toEqual([running]);
    expect(await harness.run(async (ctx) => await openWorkUsingSkills(ctx, agentId, []))).toEqual(
      [],
    );
  });
});

describe('what a change to skills, a scope or a connected system reaches', (): void => {
  it('reaches the skills named and the open work running them', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const skillId = await registeredSkill(harness, agentId);
    const running = await seedWork(harness, agentId, 'plan-approved', { skillId });
    expect(await harness.run(async (ctx) => await skillReach(ctx, agentId, [skillId]))).toEqual({
      skills: [skillId],
      workItems: [running],
    });
  });

  it('reaches, for a scope, the system it is for, the registered skills that need it and their open work', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const linear = await connectedSystem(harness, agentId, 'linear');
    await connectedSystem(harness, agentId, 'slack');
    const needing = await registeredSkill(harness, agentId);
    await registeredSkill(harness, agentId, {
      name: 'chat-post',
      targetSurface: 'slack',
      requiredScopes: ['slack:write'],
    });
    await registeredSkill(harness, agentId, { name: 'kanban-retired', state: 'retired' });
    const running = await seedWork(harness, agentId, 'executing', { skillId: needing });
    expect(
      await harness.run(async (ctx) => await scopeReach(ctx, agentId, 'linear:write')),
    ).toEqual({ skills: [needing], workItems: [running], surfaces: [linear] });
  });

  it('reaches, for a connected system, the system, the registered skills that write it and their open work', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const linear = await connectedSystem(harness, agentId, 'linear');
    const writing = await registeredSkill(harness, agentId);
    await registeredSkill(harness, agentId, { name: 'chat-post', targetSurface: 'slack' });
    const running = await seedWork(harness, agentId, 'plan-pending', { skillId: writing });
    expect(
      await harness.run(
        async (ctx) => await surfaceReach(ctx, { _id: linear, agentId, slug: 'linear' }),
      ),
    ).toEqual({ skills: [writing], workItems: [running], surfaces: [linear] });
  });
});

describe('a card’s reach, as its writer names it', (): void => {
  it('reads every open item, the items citing a page, a set of skills or a set of systems, and nothing to open on where no plan cites the page', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const sourceId = await linkedSource(harness);
    const ref = 'revops/escalation-paths.md';
    const linear = await connectedSystem(harness, agentId, 'linear');
    const gone = await connectedSystem(harness, agentId, 'notion');
    await harness.run(async (ctx) => await ctx.db.delete(gone));
    const skillId = await registeredSkill(harness, agentId);
    const cited = await seedWork(harness, agentId, 'plan-approved', {
      externalId: 'REVOPS-1',
      plan: planCiting(sourceId, ref),
    });
    const running = await seedWork(harness, agentId, 'executing', {
      externalId: 'REVOPS-2',
      skillId,
    });
    await seedWork(harness, agentId, 'completed', { externalId: 'REVOPS-3', skillId });

    expect(
      await harness.run(async (ctx) => await reachOf(ctx, agentId, { kind: 'open-work' })),
    ).toEqual({ kind: 'reached', affected: { workItems: [cited, running] } });
    expect(
      await harness.run(
        async (ctx) =>
          await reachOf(ctx, agentId, { kind: 'citing', pageRefs: [{ sourceId, ref }] }),
      ),
    ).toEqual({ kind: 'reached', affected: { workItems: [cited] } });
    expect(
      await harness.run(
        async (ctx) =>
          await reachOf(ctx, agentId, {
            kind: 'citing',
            pageRefs: [{ sourceId, ref: 'revops/glossary.md' }],
          }),
      ),
    ).toEqual({ kind: 'nothing' });
    expect(
      await harness.run(
        async (ctx) => await reachOf(ctx, agentId, { kind: 'skills', skillIds: [skillId] }),
      ),
    ).toEqual({ kind: 'reached', affected: { skills: [skillId], workItems: [running] } });
    // A system that is gone reaches nothing; the one still there reaches as `surfaceReach` reads it.
    expect(
      await harness.run(
        async (ctx) =>
          await reachOf(ctx, agentId, { kind: 'surfaces', surfaceIds: [gone, linear] }),
      ),
    ).toEqual({
      kind: 'reached',
      affected: { surfaces: [linear], skills: [skillId], workItems: [running] },
    });
  });
});

describe('the budget of work rows a transaction’s reaches read (W16-R6)', (): void => {
  /** A database handle that counts the index reads of `workItems` and the rows they returned. */
  function counting<Ctx extends { readonly db: { query: (table: never) => unknown } }>(
    ctx: Ctx,
  ): { readonly ctx: Ctx; readonly reads: () => number } {
    let reads = 0;
    const db = new Proxy(ctx.db, {
      get(target, property, receiver): unknown {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property !== 'query' || typeof value !== 'function') return value;
        return (table: string): unknown => {
          if (table === 'workItems') reads += 1;
          return (value as (table: string) => unknown).call(target, table);
        };
      },
    });
    return { ctx: { ...ctx, db }, reads: () => reads };
  }

  it('finds that an employee has no open row for four index reads and no row, and opens no card on a page nothing of its cites', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    // Finished and parked work is not open work.
    await seedWork(harness, agentId, 'completed');
    await seedWork(harness, agentId, 'skipped', { externalId: 'REVOPS-2' });
    const sourceId = await linkedSource(harness);
    const read = await harness.run(async (base) => {
      const { ctx, reads } = counting(base);
      const reached = await reachOf(ctx, agentId, {
        kind: 'citing',
        pageRefs: [{ sourceId, ref: 'revops/escalation-paths.md' }],
      });
      // Asked again in the same transaction, the answer is remembered.
      const again = await hasOpenWork(ctx, agentId);
      return { reached, again, indexReads: reads(), rows: workRowsReadIn(ctx) };
    });
    expect(read).toEqual({ reached: { kind: 'nothing' }, again: false, indexReads: 4, rows: 0 });
  });

  it('reads an empty reach for an open-work change under an employee with no open row, with no row read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const read = await harness.run(async (ctx) => ({
      reached: await reachOf(ctx, agentId, { kind: 'open-work' }),
      rows: workRowsReadIn(ctx),
    }));
    expect(read).toEqual({ reached: { kind: 'reached', affected: { workItems: [] } }, rows: 0 });
  });

  it('counts the rows a reach reads, and answers over-budget where the employee’s open work is more than the room left', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    for (let at = 0; at < 6; at += 1) {
      await seedWork(harness, agentId, at < 3 ? 'plan-pending' : 'executing', {
        externalId: `REVOPS-${at}`,
      });
    }
    const read = await harness.run(async (ctx) => {
      const within = await reachOf(ctx, agentId, { kind: 'open-work' }, { room: 6 });
      const afterFirst = workRowsReadIn(ctx);
      const over = await reachOf(ctx, agentId, { kind: 'open-work' }, { room: 5 });
      return { within: within.kind, afterFirst, over, rows: workRowsReadIn(ctx) };
    });
    // The probe's one row and the six of the reach; the second reach stops one row past its room.
    expect(read).toEqual({
      within: 'reached',
      afterFirst: 7,
      over: { kind: 'over-budget' },
      rows: 13,
    });
    expect(REACH_ROW_BUDGET).toBe(300);
  });

  it('reads an employee’s open work once for a list of cards, whatever each asks of it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const sourceId = await linkedSource(harness);
    const cited = await seedWork(harness, agentId, 'plan-approved', {
      plan: planCiting(sourceId, 'revops/escalation-paths.md'),
    });
    await seedWork(harness, agentId, 'executing', { externalId: 'REVOPS-2' });
    const read = await harness.run(async (ctx) => {
      const openWork = openWorkCache();
      const reaches = [];
      for (const ref of ['revops/escalation-paths.md', 'revops/glossary.md', 'revops/close.md']) {
        reaches.push(
          await reachOf(
            ctx,
            agentId,
            { kind: 'citing', pageRefs: [{ sourceId, ref }] },
            { openWork },
          ),
        );
      }
      return { reaches, rows: workRowsReadIn(ctx) };
    });
    expect(read.reaches).toEqual([
      { kind: 'reached', affected: { workItems: [cited] } },
      { kind: 'nothing' },
      { kind: 'nothing' },
    ]);
    // The probe's one row and the employee's two, read once for the three pages.
    expect(read.rows).toBe(3);
  });

  it('starts each transaction’s count at nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await seedWork(harness, agentId, 'plan-pending');
    const first = await harness.run(async (ctx) => {
      await reachOf(ctx, agentId, { kind: 'open-work' });
      return workRowsReadIn(ctx);
    });
    const second = await harness.run(async (ctx) => workRowsReadIn(ctx));
    expect([first, second]).toEqual([2, 0]);
  });
});

describe('an owner’s employees, for a change that reaches every one', (): void => {
  it('are the employees under the owner’s key, and no other owner’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await seedEmployee(harness);
    const pip = await seedEmployee(harness, { name: 'Pip' });
    await seedEmployee(harness, { name: 'Noor', userId: 'another-owner' });
    const agents = await harness.run(async (ctx) => await ownerAgents(ctx, OWNER_SUBJECT));
    expect(agents.map((agent) => agent._id)).toEqual([mira, pip]);
    expect(await harness.run(async (ctx) => await ownerAgents(ctx, 'nobody'))).toEqual([]);
  });
});

describe('the functions convex/reorientationReach.ts registers', (): void => {
  // Helpers only (17-s; decision S-1): a function registered here would be a new path, and the
  // cards' registered functions stay in `convex/reorientation.ts`.
  it('are none', (): void => {
    expect(registeredIn(reorientationReachModule)).toEqual([]);
  });
});

describe('an owner’s employees, as a fan-out reads them (W16-R24)', (): void => {
  it('reads the first 200 and says in the log that the rest were left out', async (): Promise<void> => {
    // The review's W16-R24: "silent caps with no record: `ownerAgents` 200".
    const harness = convexTest(schema, allConvexModules());
    const seed = async (count: number, userId: string): Promise<void> =>
      await harness.run(async (ctx) => {
        for (let index = 0; index < count; index += 1) {
          await ctx.db.insert('agents', {
            bossEmail: 'manager@acme.test',
            name: `Employee ${index}`,
            userId,
            state: 'active',
            createdAt: 1,
          });
        }
      });
    await seed(201, OWNER_SUBJECT);
    await seed(200, 'another-owner');
    const read = async (userId: string) =>
      await warnedBy(
        async () =>
          await harness.run(async (ctx) => await reorientationReachModule.ownerAgents(ctx, userId)),
      );
    const cut = await read(OWNER_SUBJECT);
    expect(cut.result).toHaveLength(200);
    expect(cut.warnings).toEqual([
      expect.objectContaining({ bound: 'OWNER_AGENTS_READ', limit: 200 }),
    ]);
    // An owner of exactly 200 is read whole, and nothing is said.
    const whole = await read('another-owner');
    expect(whole.result).toHaveLength(200);
    expect(whole.warnings).toEqual([]);
  });
});
