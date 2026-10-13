import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  CARD_LIST_LIMIT,
  CHAIN_CARDS_PER_LINK,
  INLINE_CARDS_PER_TRANSACTION,
  JUDGEMENTS_AT_ONCE,
  JUDGEMENT_STAGGER_MS,
  continueCardChain,
  heldByReorientation,
  openCard,
  openCards,
  moveCardsToOwner,
  proposalInputOf,
  riskOf,
  type CardOpener,
  type CardTrigger,
} from '../../convex/reorientation';
import { REACH_ROW_BUDGET, workRowsReadIn } from '../../convex/reorientationReach';
import * as reorientationModule from '../../convex/reorientation';
import { allConvexModules } from './all-modules';
import { registeredIn } from './registered-functions';
import {
  basisOf,
  cardOf,
  cardsOf,
  eventTypesOf,
  openTestCard,
  runCardChain,
  scheduledAs,
  seedEmployee,
  seedWork,
  type Harness,
} from './fakes/reorientation';

// openCard schedules the judgement: fake timers keep it from running unless a test drains it.
beforeEach((): void => {
  vi.useFakeTimers();
});
afterEach((): void => {
  vi.useRealTimers();
});

/** 26 September 2026, 09:10 UTC. */
const MORNING_UTC = Date.UTC(2026, 8, 26, 9, 10);

/** The page the tests' cards are about. */
async function seededPage(harness: Harness): Promise<{ sourceId: Id<'docSources'>; ref: string }> {
  const sourceId = await harness.run(
    async (ctx) =>
      await ctx.db.insert('docSources', {
        userId: 'owner',
        kind: 'folder',
        label: 'Company handbook',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      }),
  );
  return { sourceId, ref: 'revops/escalation-paths.md' };
}

describe('openCard: a card for a change under an employee', (): void => {
  it('opens one card with its proposal pending, writes its event and asks the judgement', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const cardId = await openTestCard(harness, {
      agentId,
      trigger: 'skill-withdrawn',
      triggerKey: 'event-1',
      summary: 'The kanban-comment-and-close skill was withdrawn',
      now: MORNING_UTC,
    });
    expect(cardId).not.toBeNull();
    const card = await cardOf(harness, cardId!);
    expect(card).toMatchObject({
      agentId,
      userId: 'owner',
      trigger: 'skill-withdrawn',
      triggerKey: 'event-1',
      proposed: { kind: 'pending' },
      status: 'open',
      risk: 'low',
      blockingWork: [],
      day: '2026-09-26',
      createdAt: MORNING_UTC,
    });
    expect(await eventTypesOf(harness, agentId)).toEqual(['reorientation.opened']);
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(scheduled.map((job) => [job.name, job.args[0]])).toEqual([
      ['reorientationActions:propose', { reorientationId: cardId }],
    ]);
  });

  it('writes nothing for a change the employee’s standing cards already carry', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const trigger = {
      agentId,
      trigger: 'access-revoked' as const,
      triggerKey: 'event-7',
      summary: 'Access linear:write was revoked',
      now: MORNING_UTC,
    };
    const first = await openTestCard(harness, trigger);
    expect(await openTestCard(harness, trigger)).toBeNull();
    expect(
      await openTestCard(harness, { ...trigger, now: MORNING_UTC + 3 * 86_400_000 }),
    ).toBeNull();
    expect((await cardsOf(harness, agentId)).map((card) => card._id)).toEqual([first]);
    expect(await eventTypesOf(harness, agentId)).toEqual(['reorientation.opened']);
  });

  it('joins a second trigger of the same kind the same day to the open card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const page = await seededPage(harness);
    const first = await openTestCard(harness, {
      agentId,
      trigger: 'page-status-changed',
      triggerKey: 'event-1',
      summary: '“Escalation paths” was superseded',
      evidence: { pageRefs: [page] },
      now: MORNING_UTC,
    });
    const second = await openTestCard(harness, {
      agentId,
      trigger: 'page-status-changed',
      triggerKey: 'event-2',
      summary: '“Tier-2 runbook” was archived',
      evidence: { pageRefs: [{ ...page, ref: 'revops/tier-2-runbook.md' }, page] },
      now: MORNING_UTC + 3_600_000,
    });
    expect(second).toBe(first);
    const cards = await cardsOf(harness, agentId);
    expect(cards).toHaveLength(1);
    expect(cards[0].evidence.pageRefs).toEqual([
      page,
      { ...page, ref: 'revops/tier-2-runbook.md' },
    ]);
    expect(cards[0].triggerSummary).toBe('“Escalation paths” was superseded');
    const opened = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).map(
        (event) => event.payload as { joined?: boolean },
      ),
    );
    expect(opened.map((payload) => payload.joined === true)).toEqual([false, true]);
    // A joined report is carried by its event's id from then on.
    expect(
      await openTestCard(harness, {
        agentId,
        trigger: 'page-status-changed',
        triggerKey: 'event-2',
        summary: '“Tier-2 runbook” was archived',
        evidence: { eventIds: [] },
        now: MORNING_UTC + 7_200_000,
      }),
    ).toBe(first);
  });

  it('opens a second card for a different kind the same day, and for the same kind once the day’s card is decided', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const skill = await openTestCard(harness, {
      agentId,
      trigger: 'skill-withdrawn',
      triggerKey: 'event-1',
      summary: 'A skill was withdrawn',
      now: MORNING_UTC,
    });
    const access = await openTestCard(harness, {
      agentId,
      trigger: 'access-ended',
      triggerKey: 'event-2',
      summary: 'Linear access ended',
      now: MORNING_UTC,
    });
    expect(access).not.toBe(skill);
    await harness.run(async (ctx) => await ctx.db.patch(skill!, { status: 'dismissed' }));
    const again = await openTestCard(harness, {
      agentId,
      trigger: 'skill-withdrawn',
      triggerKey: 'event-3',
      summary: 'Another skill was withdrawn',
      now: MORNING_UTC + 60_000,
    });
    expect(again).not.toBeNull();
    expect([skill, access]).not.toContain(again);
  });

  it('counts the day in the employee’s zone, not the deployment’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const singapore = await seedEmployee(harness, { zone: 'Asia/Singapore' });
    const london = await seedEmployee(harness, { zone: 'Europe/London', name: 'Pip' });
    // 23:30 UTC on 26 September is 07:30 on the 27th in Singapore and 00:30 on the 27th in London.
    const late = Date.UTC(2026, 8, 26, 23, 30);
    const honolulu = await seedEmployee(harness, { zone: 'Pacific/Honolulu', name: 'Nell' });
    for (const agentId of [singapore, london, honolulu]) {
      await openTestCard(harness, {
        agentId,
        trigger: 'access-ended',
        triggerKey: `ended-${agentId}`,
        summary: 'Linear access ended',
        now: late,
      });
    }
    const dayOf = async (agentId: Id<'agents'>): Promise<string> =>
      (await cardsOf(harness, agentId))[0].day;
    expect(await dayOf(singapore)).toBe('2026-09-27');
    expect(await dayOf(london)).toBe('2026-09-27');
    expect(await dayOf(honolulu)).toBe('2026-09-26');
    // A second trigger at 01:00 UTC the next day is still the 27th in Singapore: it joins.
    await openTestCard(harness, {
      agentId: singapore,
      trigger: 'access-ended',
      triggerKey: 'ended-again',
      summary: 'Notion access ended',
      now: Date.UTC(2026, 8, 27, 1, 0),
    });
    expect(await cardsOf(harness, singapore)).toHaveLength(1);
  });

  it('opens no card for an employee that is gone or has no owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ownerless = await seedEmployee(harness, { userId: undefined });
    const gone = await seedEmployee(harness, { name: 'Gone' });
    await harness.run(async (ctx) => await ctx.db.delete(gone));
    for (const agentId of [ownerless, gone]) {
      expect(
        await openTestCard(harness, {
          agentId,
          trigger: 'access-ended',
          triggerKey: 'event-1',
          summary: 'Linear access ended',
        }),
      ).toBeNull();
    }
    expect(
      await harness.run(async (ctx) => await ctx.db.query('reorientations').collect()),
    ).toEqual([]);
  });

  it('keeps at most a hundred ids in each evidence list, however many triggers join', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const page = await seededPage(harness);
    const pages = (from: number): Array<{ sourceId: Id<'docSources'>; ref: string }> =>
      Array.from({ length: 80 }, (_unused, index) => ({ ...page, ref: `page-${from + index}.md` }));
    const cardId = await openTestCard(harness, {
      agentId,
      trigger: 'page-status-changed',
      triggerKey: 'event-1',
      summary: 'Eighty pages archived',
      evidence: { pageRefs: pages(0) },
      now: MORNING_UTC,
    });
    await openTestCard(harness, {
      agentId,
      trigger: 'page-status-changed',
      triggerKey: 'event-2',
      summary: 'Eighty more archived',
      evidence: { pageRefs: pages(80) },
      now: MORNING_UTC + 1,
    });
    const card = await cardOf(harness, cardId!);
    expect(card.evidence.pageRefs).toHaveLength(CARD_LIST_LIMIT);
    expect(card.evidence.pageRefs[0].ref).toBe('page-0.md');
  });
});

/** Seed employees of the owner, each with open plans. */
async function seedEmployeesWithWork(
  harness: Harness,
  employees: number,
  plansEach = 1,
): Promise<Id<'agents'>[]> {
  const agents: Id<'agents'>[] = [];
  for (let at = 0; at < employees; at += 1) {
    const agentId = await seedEmployee(harness, { name: `Employee ${at}` });
    for (let plan = 0; plan < plansEach; plan += 1) {
      await seedWork(harness, agentId, 'plan-pending', { externalId: `REVOPS-${at}-${plan}` });
    }
    agents.push(agentId);
  }
  return agents;
}

/** One change reported for each employee, as an approver's edge for everyone reaches them. */
function edgeChangeFor(agents: readonly Id<'agents'>[]): CardTrigger[] {
  return agents.map((agentId) => ({
    agentId,
    trigger: 'relationship-changed' as const,
    triggerKey: 'edge-change-1',
    summary: 'Priya, its approver, changed',
    reach: { kind: 'open-work' as const },
    now: MORNING_UTC,
  }));
}

describe('a change reaching many employees: one list handed over once (wave 17, D-9 (a))', (): void => {
  it('opens the first cards in the writer’s transaction and hands the rest to one scheduled function, which opens each reading its work there', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const reached = INLINE_CARDS_PER_TRANSACTION + 4;
    const agents = await seedEmployeesWithWork(harness, reached);
    await harness.run(async (ctx) => {
      await openCards(ctx, edgeChangeFor(agents));
    });
    const opened = async (): Promise<number> =>
      (await harness.run(async (ctx) => await ctx.db.query('reorientations').collect())).length;
    expect(await opened()).toBe(INLINE_CARDS_PER_TRANSACTION);
    // One function carries every card the writer's transaction left, and none rides alone.
    const later = await scheduledAs(harness, 'reorientation:openCardsLater');
    expect(later).toHaveLength(1);
    expect((later[0].args[0] as { cards: unknown[] }).cards).toHaveLength(4);
    expect(await scheduledAs(harness, 'reorientation:openCardLater')).toEqual([]);
    expect(await runCardChain(harness)).toEqual({ links: 1, mostWaiting: 1 });
    const cards = await harness.run(async (ctx) => await ctx.db.query('reorientations').collect());
    expect(cards).toHaveLength(reached);
    // Each card read its employee's open work where it opened.
    expect(cards.every((card) => card.affected.workItems.length === 1)).toBe(true);
    expect(new Set(cards.map((card) => card.agentId)).size).toBe(reached);
  });

  it('is a chain of single functions however many employees the change reaches', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const reached = INLINE_CARDS_PER_TRANSACTION + 2 * CHAIN_CARDS_PER_LINK + 5;
    const agents = await seedEmployeesWithWork(harness, reached);
    await harness.run(async (ctx) => {
      await openCards(ctx, edgeChangeFor(agents));
    });
    // Eight in the writer's transaction, fifty a link, and never two functions waiting at once.
    expect(await runCardChain(harness)).toEqual({ links: 3, mostWaiting: 1 });
    const cards = await harness.run(async (ctx) => await ctx.db.query('reorientations').collect());
    expect(new Set(cards.map((card) => card.agentId)).size).toBe(reached);
    // A second report of the same change, handed over again, opens nothing more.
    await harness.run(async (ctx) => {
      await openCards(ctx, edgeChangeFor(agents));
    });
    await runCardChain(harness);
    expect(
      await harness.run(async (ctx) => await ctx.db.query('reorientations').collect()),
    ).toHaveLength(reached);
  });

  it('leaves a card whose reach would pass the transaction’s budget of work rows to the chain, which opens it (W16-R6)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    // A hundred open plans an employee: the third card's read would pass three hundred rows.
    const agents = await seedEmployeesWithWork(harness, 4, 100);
    const rowsRead = await harness.run(async (ctx) => {
      await openCards(ctx, edgeChangeFor(agents));
      return workRowsReadIn(ctx);
    });
    const inline = await harness.run(async (ctx) => await ctx.db.query('reorientations').collect());
    expect(inline.map((card) => card.agentId)).toEqual(agents.slice(0, 2));
    // Each opened card read its probe's row, its hundred rows and the ten it holds; the third stopped one row past its room.
    expect(rowsRead).toBeLessThanOrEqual(REACH_ROW_BUDGET + 2);
    const [later] = await scheduledAs(harness, 'reorientation:openCardsLater');
    expect(
      (later.args[0] as { cards: Array<{ agentId: string }> }).cards.map((card) => card.agentId),
    ).toEqual(agents.slice(2));
    await runCardChain(harness);
    const cards = await harness.run(async (ctx) => await ctx.db.query('reorientations').collect());
    expect(cards.map((card) => card.agentId)).toEqual(agents);
    expect(cards.every((card) => card.affected.workItems.length === 100)).toBe(true);
  });

  it('opens a card whose employee alone has more open work than the budget, in a link of its own', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [agentId] = await seedEmployeesWithWork(harness, 1, 100);
    for (let at = 0; at < 100; at += 1) {
      await seedWork(harness, agentId, 'executing', { externalId: `REVOPS-run-${at}` });
      await seedWork(harness, agentId, 'plan-approved', { externalId: `REVOPS-approved-${at}` });
      await seedWork(harness, agentId, 'actions-pending', { externalId: `REVOPS-held-${at}` });
    }
    await harness.run(async (ctx) => {
      await openCards(ctx, edgeChangeFor([agentId]));
    });
    // Four hundred open rows: past the writer's room, so the card waits for the chain.
    expect(await cardsOf(harness, agentId)).toEqual([]);
    expect(await runCardChain(harness)).toEqual({ links: 1, mostWaiting: 1 });
    const [card] = await cardsOf(harness, agentId);
    expect(card.affected.workItems).toHaveLength(CARD_LIST_LIMIT);
    expect(card.blockingWork).toHaveLength(10);
  });

  it('starts a fan-out’s judgements eight at a time, five seconds apart (W16-R23)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agents = await seedEmployeesWithWork(harness, 2 * JUDGEMENTS_AT_ONCE + 4);
    vi.setSystemTime(MORNING_UTC);
    await harness.run(async (ctx) => {
      await openCards(ctx, edgeChangeFor(agents));
    });
    await runCardChain(harness);
    const judgements = await scheduledAs(harness, 'reorientationActions:propose');
    const startingAfter = new Map<number, number>();
    for (const job of judgements) {
      const after = job.scheduledTime - MORNING_UTC;
      startingAfter.set(after, (startingAfter.get(after) ?? 0) + 1);
    }
    expect([...startingAfter].sort(([left], [right]) => left - right)).toEqual([
      [0, JUDGEMENTS_AT_ONCE],
      [JUDGEMENT_STAGGER_MS, JUDGEMENTS_AT_ONCE],
      [2 * JUDGEMENT_STAGGER_MS, 4],
    ]);
  });

  it('records a card that throws in a link of the chain, with its reason scrubbed, and opens the next (W16-R23)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [first, broken, last] = await seedEmployeesWithWork(harness, 3);
    const [carriedCard] = await (async (): Promise<Array<{ cards: never[]; judged: number }>> => {
      // The cards as a chain carries them: handed over past the writer's own eight.
      const fill = await seedEmployeesWithWork(harness, INLINE_CARDS_PER_TRANSACTION);
      await harness.run(async (ctx) => {
        await openCards(ctx, edgeChangeFor([...fill, first, broken, last]));
      });
      return (await scheduledAs(harness, 'reorientation:openCardsLater')).map(
        (job) => job.args[0] as { cards: never[]; judged: number },
      );
    })();
    const opener: CardOpener = async (ctx, card) => {
      if (card.agentId === broken) {
        throw new Error('the card could not be written with xoxb-1234567890-abcdefghijkl');
      }
      const reorientationId = await openCard(ctx, card);
      return reorientationId === null
        ? { kind: 'nothing' }
        : { kind: 'opened', reorientationId, judging: true };
    };
    await harness.run(async (ctx) => {
      await continueCardChain(ctx, carriedCard, opener);
    });
    expect(await cardsOf(harness, first)).toHaveLength(1);
    expect(await cardsOf(harness, last)).toHaveLength(1);
    expect(await cardsOf(harness, broken)).toEqual([]);
    const events = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter((event) => event.agentId === broken),
    );
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      [
        'reorientation.card-not-opened',
        {
          trigger: 'relationship-changed',
          triggerKey: 'edge-change-1',
          summary: 'Priya, its approver, changed',
          reason: expect.stringMatching(
            /^the card could not be written with (?!xoxb-1234)/,
          ) as string,
        },
      ],
    ]);
  });
});

describe('a card opened one at a time (O-2)', (): void => {
  it('throws at the ninth in one transaction, naming openCards, and opens eight', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agents = await seedEmployeesWithWork(harness, INLINE_CARDS_PER_TRANSACTION + 1);
    const reports = edgeChangeFor(agents);
    await harness.run(async (ctx) => {
      for (const report of reports.slice(0, INLINE_CARDS_PER_TRANSACTION)) {
        await openCard(ctx, report);
      }
    });
    expect(
      await harness.run(async (ctx) => await ctx.db.query('reorientations').collect()),
    ).toHaveLength(INLINE_CARDS_PER_TRANSACTION);
    await expect(
      harness.run(async (ctx) => {
        for (const report of reports) await openCard(ctx, { ...report, triggerKey: 'edge-2' });
      }),
    ).rejects.toThrow(/hands its whole list to openCards/);
  });

  it('still opens the one card a job scheduled before 0.21.0 carries', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [agentId] = await seedEmployeesWithWork(harness, 1);
    await harness.mutation(internal.reorientation.openCardLater, {
      card: {
        agentId,
        trigger: 'relationship-changed',
        triggerKey: 'edge-change-1',
        summary: 'Priya, its approver, changed',
        evidence: {
          eventIds: [],
          pageRefs: [],
          relationIds: [],
          correctionIds: [],
          relationshipIds: [],
          skillIds: [],
          skillVersionIds: [],
        },
        affected: {
          charterClauses: [],
          agreements: [],
          relationships: [],
          skills: [],
          surfaces: [],
          workItems: [],
        },
        reach: { kind: 'open-work' },
        now: MORNING_UTC,
      },
    });
    const [card] = await cardsOf(harness, agentId);
    expect(card.affected.workItems).toHaveLength(1);
  });
});

describe('the risk and the hold', (): void => {
  it('reads high for a write scope or held work, medium for a charter clause, low otherwise', (): void => {
    const none = {
      charterClauses: [],
      agreements: [],
      relationships: [],
      skills: [],
      surfaces: [],
      workItems: [],
    };
    const clause = { field: 'willDo' as const, index: 0, text: 'Triage' };
    expect(riskOf(none, false)).toBe('low');
    expect(riskOf(none, true)).toBe('high');
    expect(riskOf({ ...none, charterClauses: [clause] }, false)).toBe('medium');
    expect(riskOf({ ...none, workItems: ['w' as Id<'workItems'>] }, false)).toBe('high');
  });

  it('keeps the hold of a deferred high-risk card and drops it once the card is decided', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const row = await seedWork(harness, agentId, 'plan-approved');
    const cardId = await openTestCard(harness, {
      agentId,
      trigger: 'access-revoked',
      triggerKey: 'event-1',
      summary: 'Access linear:write was revoked',
      writeScope: true,
      affected: { workItems: [row] },
    });
    const holder = async (): Promise<Id<'reorientations'> | null> =>
      (await harness.run(async (ctx) => await heldByReorientation(ctx, { _id: row, agentId })))
        ?._id ?? null;
    await harness.run(
      async (ctx) => await ctx.db.patch(cardId!, { status: 'deferred', revisitAt: 1 }),
    );
    expect(await holder()).toBe(cardId);
    await harness.run(async (ctx) => await ctx.db.patch(cardId!, { status: 'applied' }));
    expect(await holder()).toBeNull();
  });
});

describe('the judgement’s write-back', (): void => {
  it('writes a proposal onto a pending card, once, and never onto a decided one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const cardId = (await openTestCard(harness, {
      agentId,
      trigger: 'skill-recheck-due',
      triggerKey: 'event-1',
      summary: 'A skill is due a re-check',
    }))!;
    const proposed = { kind: 'none' as const, rationale: 'The page changed only its title.' };
    await expect(
      harness.mutation(internal.reorientation.writeProposal, {
        reorientationId: cardId,
        proposed,
        basis: await basisOf(harness, cardId),
      }),
    ).resolves.toEqual({ written: true });
    await expect(
      harness.mutation(internal.reorientation.writeProposal, {
        reorientationId: cardId,
        proposed: { kind: 'none', rationale: 'Again.' },
        basis: await basisOf(harness, cardId),
      }),
    ).resolves.toEqual({ written: false });
    expect((await cardOf(harness, cardId)).proposed).toEqual(proposed);
    expect(await eventTypesOf(harness, agentId)).toEqual([
      'reorientation.opened',
      'reorientation.proposed',
    ]);

    const other = (await openTestCard(harness, {
      agentId,
      trigger: 'access-ended',
      triggerKey: 'event-2',
      summary: 'Linear access ended',
    }))!;
    const basis = await basisOf(harness, other);
    await harness.run(async (ctx) => await ctx.db.patch(other, { status: 'dismissed' }));
    await expect(
      harness.mutation(internal.reorientation.writeProposal, {
        reorientationId: other,
        proposed,
        basis,
      }),
    ).resolves.toEqual({ written: false });
  });

  it('records a failed judgement on the card, which stays open with nothing proposed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const cardId = (await openTestCard(harness, {
      agentId,
      trigger: 'skill-recheck-due',
      triggerKey: 'event-1',
      summary: 'A skill is due a re-check',
    }))!;
    await harness.mutation(internal.reorientation.recordProposalFailure, {
      reorientationId: cardId,
      failure: 'the model did not answer',
      basis: await basisOf(harness, cardId),
    });
    const card = await cardOf(harness, cardId);
    expect(card.status).toBe('open');
    expect(card.proposed).toMatchObject({ kind: 'pending', failure: 'the model did not answer' });
    expect(card.proposed.kind === 'pending' && typeof card.proposed.failedAt).toBe('number');
  });
});

describe('proposalInputOf: what a proposal is drawn from (the judgement and Discuss)', (): void => {
  it('gives the card’s candidates whatever it proposes, and the judgement’s read only while pending', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const cardId = (await openTestCard(harness, {
      agentId,
      trigger: 'role-changed',
      triggerKey: 'role-changed:1',
      summary: 'Priya now approves committee-deck numbers',
    }))!;
    const pending = await harness.query(internal.reorientation.proposalInput, {
      reorientationId: cardId,
    });
    await harness.mutation(internal.reorientation.writeProposal, {
      reorientationId: cardId,
      proposed: { kind: 'none', rationale: 'Nothing needs to change.' },
      basis: await basisOf(harness, cardId),
    });
    const card = await cardOf(harness, cardId);
    const input = await harness.run(async (ctx) => await proposalInputOf(ctx, card));
    expect(input).toEqual(pending?.input);
    expect(input?.candidates.map((candidate) => candidate.kind)).toEqual([
      'charter-clause',
      'charter-clause',
      'charter-clause',
    ]);
    await expect(
      harness.query(internal.reorientation.proposalInput, { reorientationId: cardId }),
    ).resolves.toBeNull();
  });
});

describe('reopenDeferred: the Defer sweep', (): void => {
  it('opens again every deferred card whose date has come, and leaves the rest', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const due = (await openTestCard(harness, {
      agentId,
      trigger: 'skill-recheck-due',
      triggerKey: 'event-1',
      summary: 'A skill is due a re-check',
    }))!;
    const later = (await openTestCard(harness, {
      agentId,
      trigger: 'access-ended',
      triggerKey: 'event-2',
      summary: 'Linear access ended',
    }))!;
    const now = Date.now();
    await harness.run(async (ctx) => {
      await ctx.db.patch(due, { status: 'deferred', revisitAt: now - 1 });
      await ctx.db.patch(later, { status: 'deferred', revisitAt: now + 86_400_000 });
    });
    await expect(harness.mutation(internal.reorientation.reopenDeferred, {})).resolves.toEqual({
      reopened: 1,
    });
    expect((await cardOf(harness, due)).status).toBe('open');
    expect((await cardOf(harness, later)).status).toBe('deferred');
    expect((await eventTypesOf(harness, agentId)).at(-1)).toBe('reorientation.reopened');
  });
});

describe('moveCardsToOwner: a handover’s move (16-K’s F2)', (): void => {
  it('lists every card of the employee under its new owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const open = (await openTestCard(harness, {
      agentId,
      trigger: 'skill-recheck-due',
      triggerKey: 'event-1',
      summary: 'A skill is due a re-check',
    }))!;
    const applied = (await openTestCard(harness, {
      agentId,
      trigger: 'access-ended',
      triggerKey: 'event-2',
      summary: 'Linear access ended',
    }))!;
    await harness.run(async (ctx) => await ctx.db.patch(applied, { status: 'applied' }));
    await harness.run(
      async (ctx) =>
        await moveCardsToOwner(ctx, {
          agentId,
          userId: 'successor',
          previousManager: 'priya@acme.test',
          now: 5,
        }),
    );
    expect((await cardOf(harness, open)).userId).toBe('successor');
    expect((await cardOf(harness, applied)).userId).toBe('successor');
    // The undecided card closes as handed over (W16-R1, D-5 (a)); the decided one keeps its standing.
    expect(await cardOf(harness, open)).toMatchObject({
      status: 'dismissed',
      decidedAt: 5,
      outcome: { summary: 'closed at the handover, as it was the previous manager’s to decide' },
    });
    expect((await cardOf(harness, applied)).status).toBe('applied');
  });

  it('clears the summary of a card the previous manager opened by hand, which then says who opened it (D-5’s remainder, (a))', async (): Promise<void> => {
    // The pre-tag's row 5: the closed card kept "Wren now covers renewals too", the old manager's
    // typed words, on the new manager's page.
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness, { name: 'Wren' });
    const byHand = (await openTestCard(harness, {
      agentId,
      trigger: 'role-changed',
      triggerKey: 'role-changed:1',
      summary: 'Wren now covers renewals too',
    }))!;
    const automatic = (await openTestCard(harness, {
      agentId,
      trigger: 'skill-recheck-due',
      triggerKey: 'event-1',
      summary: 'A skill is due a re-check',
    }))!;
    const decidedByHand = (await openTestCard(harness, {
      agentId,
      trigger: 'role-changed',
      triggerKey: 'role-changed:0',
      summary: 'Wren took on the weekly digest',
      now: Date.UTC(2026, 8, 20),
    }))!;
    await harness.run(async (ctx) => await ctx.db.patch(decidedByHand, { status: 'applied' }));
    await harness.run(
      async (ctx) =>
        await moveCardsToOwner(ctx, {
          agentId,
          userId: 'successor',
          previousManager: 'priya@acme.test',
          now: 5,
        }),
    );
    expect(await cardOf(harness, byHand)).toMatchObject({
      status: 'dismissed',
      triggerSummary: 'A card priya@acme.test opened was closed at the handover',
    });
    // A card Day0 opened says what changed in Day0's own words, and a decided card is the record.
    expect((await cardOf(harness, automatic)).triggerSummary).toBe('A skill is due a re-check');
    expect((await cardOf(harness, decidedByHand)).triggerSummary).toBe(
      'Wren took on the weekly digest',
    );
  });

  it('closes a deferred card too, so it holds nothing and reopens nowhere under the new manager (the second pass)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const deferred = (await openTestCard(harness, {
      agentId,
      trigger: 'skill-recheck-due',
      triggerKey: 'event-1',
      summary: 'A skill is due a re-check',
    }))!;
    await harness.run(
      async (ctx) => await ctx.db.patch(deferred, { status: 'deferred', revisitAt: 9_999 }),
    );
    await harness.run(
      async (ctx) =>
        await moveCardsToOwner(ctx, {
          agentId,
          userId: 'successor',
          previousManager: 'priya@acme.test',
          now: 5,
        }),
    );
    const card = await cardOf(harness, deferred);
    expect(card).toMatchObject({ status: 'dismissed', userId: 'successor', decidedAt: 5 });
    expect(card.revisitAt).toBeUndefined();
  });
});

describe('the functions convex/reorientation.ts registers', (): void => {
  // The move of what a card reaches into `convex/reorientationReach.ts` (wave 17, 17-s; decision
  // S-1) moves no registered function: each `internal.reorientation.*` path is a string the
  // scheduler, the judgement's action and the closing phase hold. The list as `v0.20.0`
  // registered it.
  it('are the ones it registered at v0.20.0, each of the same kind and visibility, and the chain’s one (17-O)', (): void => {
    // Re-taken for `openCardsLater` (wave 17, 17-O; D-9 (a)): the one function a fan-out's chain
    // schedules. `openCardLater` stays for a job 0.20.0 scheduled before the upgrade.
    expect(registeredIn(reorientationModule)).toEqual([
      'holdingCard internal query',
      'openCardLater internal mutation',
      'openCardsLater internal mutation',
      'proposalInput internal query',
      'recordProposalFailure internal mutation',
      'reopenDeferred internal mutation',
      'writeProposal internal mutation',
    ]);
  });
});
