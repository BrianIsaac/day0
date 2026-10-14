import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { OWNER_SUBJECT, managerIdentity } from './fakes/manager-identity';
import {
  basisOf,
  cardOf,
  openTestCard,
  seedEmployee,
  seedWork,
  type Harness,
} from './fakes/reorientation';

/*
 * The sibling chain's catch and its `alone` (wave 18, 18-O; the review's W17-R7): one employee's
 * card that cannot be closed as decided elsewhere is recorded on that card, and the others close;
 * a sibling whose own proposal or reach is about more than the edge stays for its manager.
 */

/** The send-back made to throw for the one row the test names by its ticket. */
vi.mock('../../convex/planRedraft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../convex/planRedraft')>();
  return {
    ...actual,
    sendBackToDrafting: async (
      ...args: Parameters<typeof actual.sendBackToDrafting>
    ): Promise<void> => {
      if (args[1].externalId === 'THROWS-1') throw new Error('the send-back failed');
      await actual.sendBackToDrafting(...args);
    },
  };
});

const OWNER = managerIdentity();

beforeEach((): void => {
  vi.useFakeTimers();
});
afterEach((): void => {
  vi.useRealTimers();
});

/** The approver for everyone, Ines Duarte. */
async function seedEdge(harness: Harness): Promise<Id<'relationships'>> {
  return await harness.run(async (ctx) => {
    const person = await ctx.db.insert('people', {
      userId: OWNER_SUBJECT,
      displayName: 'Ines Duarte',
      nameKey: 'ines duarte',
      status: 'active',
      source: 'manager',
      evidence: [],
      confirmedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    return await ctx.db.insert('relationships', {
      userId: OWNER_SUBJECT,
      toPersonId: person,
      type: 'approval-authority',
      scope: 'NetLedger journal changes',
      effectiveFrom: 1,
      status: 'active',
      source: 'manager',
      confirmedAt: 1,
      createdAt: 1,
    });
  });
}

/** A card about the edge, its proposal written as the judgement writes one. */
async function cardAbout(
  harness: Harness,
  agentId: Id<'agents'>,
  edge: Id<'relationships'>,
  proposed: Exclude<Doc<'reorientations'>['proposed'], { kind: 'pending' }>,
  more: { workItems?: Id<'workItems'>[]; agreements?: Id<'workingAgreements'>[] } = {},
): Promise<Id<'reorientations'>> {
  const cardId = await openTestCard(harness, {
    agentId,
    trigger: 'relationship-changed',
    triggerKey: 'edge-change-1',
    summary: 'Ines Duarte, its approver, changed',
    evidence: { relationshipIds: [edge] },
    affected: { relationships: [edge], ...more },
  });
  if (cardId === null) throw new Error('no card opened');
  await harness.mutation(internal.reorientation.writeProposal, {
    reorientationId: cardId,
    proposed,
    basis: await basisOf(harness, cardId),
  });
  return cardId;
}

describe('the sibling chain (W17-R7)', (): void => {
  it('records on its card a sibling whose send-back throws, and closes the others (red at the tag: the Approve throws)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const edge = await seedEdge(harness);
    const retire = {
      kind: 'relationship' as const,
      relationshipId: edge,
      action: 'retire' as const,
      rationale: 'Ines has left.',
    };
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const mateo = await seedEmployee(harness, { name: 'Mateo' });
    const aiko = await seedEmployee(harness, { name: 'Aiko' });
    const priyas = await cardAbout(harness, priya, edge, retire);
    const throws = await seedWork(harness, mateo, 'plan-pending', { externalId: 'THROWS-1' });
    const mateos = await cardAbout(harness, mateo, edge, retire, { workItems: [throws] });
    const held = await seedWork(harness, aiko, 'plan-pending', { externalId: 'REVOPS-2' });
    const aikos = await cardAbout(harness, aiko, edge, retire, { workItems: [held] });
    vi.setSystemTime(Date.UTC(2026, 9, 14, 5, 0));

    await expect(
      harness
        .withIdentity(OWNER)
        .mutation(api.reorientationDecisions.approve, { reorientationId: priyas }),
    ).resolves.toEqual({ result: 'the relationship was retired' });
    expect(await cardOf(harness, mateos)).toMatchObject({
      status: 'open',
      outcome: { summary: 'not closed: decided on Priya’s card' },
    });
    expect(await cardOf(harness, aikos)).toMatchObject({
      status: 'dismissed',
      outcome: { summary: 'decided on Priya’s card: the relationship was retired' },
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(held)))?.state).toBe('claimed');
  });

  it('leaves standing a sibling whose proposal changes an agreement, or whose reach names one (red at the tag: closed as decided elsewhere)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const edge = await seedEdge(harness);
    const agreement = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workingAgreements', {
          userId: OWNER_SUBJECT,
          kind: 'convention',
          statement: 'Ask Ines Duarte before any journal change.',
          scope: 'global',
          sourceType: 'manager-card',
          status: 'active',
          createdAt: 1,
          appliedTo: [],
          approvedVia: 'agreements-card',
        }),
    );
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const mateo = await seedEmployee(harness, { name: 'Mateo' });
    const aiko = await seedEmployee(harness, { name: 'Aiko' });
    const priyas = await cardAbout(harness, priya, edge, {
      kind: 'relationship',
      relationshipId: edge,
      action: 'retire',
      rationale: 'Ines has left.',
    });
    const mateos = await cardAbout(harness, mateo, edge, {
      kind: 'agreement',
      agreementId: agreement,
      action: 'retire',
      rationale: 'The agreement names Ines, who has left.',
    });
    const aikos = await cardAbout(
      harness,
      aiko,
      edge,
      { kind: 'none', rationale: 'Nothing.' },
      { agreements: [agreement] },
    );

    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: priyas });
    for (const sibling of [mateos, aikos]) {
      expect((await cardOf(harness, sibling)).status).toBe('open');
    }
  });
});
