import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  CARD_LIST_LIMIT,
  INLINE_CARDS_PER_TRANSACTION,
  heldByReorientation,
  openCard,
  moveCardsToOwner,
  proposalInputOf,
  riskOf,
} from '../../convex/reorientation';
import { allConvexModules } from './all-modules';
import {
  basisOf,
  cardOf,
  cardsOf,
  eventTypesOf,
  openTestCard,
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

describe('a change reaching many employees (the second pass’s M5)', (): void => {
  it('opens the first cards in the writer’s transaction and each further one in a transaction of its own, reading its work there', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const reached = INLINE_CARDS_PER_TRANSACTION + 4;
    const agents: Id<'agents'>[] = [];
    for (let at = 0; at < reached; at += 1) {
      const agentId = await seedEmployee(harness, { name: `Employee ${at}` });
      await seedWork(harness, agentId, 'plan-pending');
      agents.push(agentId);
    }
    // One change, as an approver's edge for everyone reaches every employee of the owner.
    await harness.run(async (ctx) => {
      for (const agentId of agents) {
        await openCard(ctx, {
          agentId,
          trigger: 'relationship-changed',
          triggerKey: 'edge-change-1',
          summary: 'Priya, its approver, changed',
          reach: { kind: 'open-work' },
          now: MORNING_UTC,
        });
      }
    });
    const opened = async (): Promise<number> =>
      (await harness.run(async (ctx) => await ctx.db.query('reorientations').collect())).length;
    expect(await opened()).toBe(INLINE_CARDS_PER_TRANSACTION);
    const later = await harness.run(
      async (ctx) =>
        await ctx.db.system
          .query('_scheduled_functions')
          .filter((q) => q.eq(q.field('name'), 'reorientation:openCardLater'))
          .collect(),
    );
    expect(later).toHaveLength(4);
    for (const job of later) {
      await harness.mutation(internal.reorientation.openCardLater, job.args[0] as { card: never });
    }
    const cards = await harness.run(async (ctx) => await ctx.db.query('reorientations').collect());
    expect(cards).toHaveLength(reached);
    // Each card read its employee's open work where it opened.
    expect(cards.every((card) => card.affected.workItems.length === 1)).toBe(true);
    expect(new Set(cards.map((card) => card.agentId)).size).toBe(reached);
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
    await harness.run(async (ctx) => await moveCardsToOwner(ctx, agentId, 'successor', 5));
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
    await harness.run(async (ctx) => await moveCardsToOwner(ctx, agentId, 'successor', 5));
    const card = await cardOf(harness, deferred);
    expect(card).toMatchObject({ status: 'dismissed', userId: 'successor', decidedAt: 5 });
    expect(card.revisitAt).toBeUndefined();
  });
});
