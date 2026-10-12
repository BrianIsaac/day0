import type { TestConvex } from 'convex-test';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';
import { openCard, proposalBasis, type CardTrigger } from '../../../convex/reorientation';
import { MANAGER_ADDRESS, OWNER_SUBJECT } from './manager-identity';

/*
 * The reorientation tests' shared seeds (16-O): an owned employee with an approved charter, a
 * work item in a state, and a card opened through `openCard` as a trigger's writer opens one.
 */

/** A harness over the tree's schema. */
export type Harness = TestConvex<typeof schema>;

/** The approved charter every seeded employee works under, with a reporting-line rule bound. */
export const SEEDED_CHARTER = {
  version: '0.1',
  source: 'one-to-one',
  whyThisHire: 'Tier-2 asks pile up.',
  proposedFunction: 'Triage tier-2 asks in #revops-asks.',
  evidence: [],
  shortTermGoals: { day30: '', day60: '', day90: '' },
  proposedBoundaries: {
    willDo: ['Triage tier-2 asks in #revops-asks'],
    willNotDo: ['Change committee-deck numbers'],
    escalationTriggers: ['Surface tier-2 answer drafts to the manager for review'],
  },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { approver: 'manager' },
  openQuestions: [],
  constraints: [
    {
      kind: 'reporting-line',
      quote: 'Send tier-2 drafts to me first.',
      wording: ['to the manager for review'],
      origin: 'synthesis',
      binds: [{ field: 'escalationTriggers', index: 0 }],
    },
  ],
};

/**
 * Seed an owned employee, Mira, with an approved charter.
 *
 * @param fields - Any field of the employee to set otherwise (its zone, its owner).
 */
export async function seedEmployee(
  harness: Harness,
  fields: Partial<Doc<'agents'>> = {},
): Promise<Id<'agents'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Mira',
      userId: OWNER_SUBJECT,
      state: 'active',
      createdAt: 1,
      ...fields,
    });
    await ctx.db.insert('charters', {
      agentId,
      version: '0.1',
      body: SEEDED_CHARTER,
      approved: true,
      approvedAt: 1,
      createdAt: 1,
    });
    return agentId;
  });
}

/** Seed one of the employee's tickets in a state, with a plan when one is given. */
export async function seedWork(
  harness: Harness,
  agentId: Id<'agents'>,
  state: Doc<'workItems'>['state'],
  fields: Partial<Doc<'workItems'>> = {},
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        title: 'Answer the tier-2 ask about the committee deck',
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state,
        observedAt: 1,
        createdAt: 1,
        ...fields,
      }),
  );
}

/** Open a card through `openCard`, as a trigger's writer does inside its transaction. */
export async function openTestCard(
  harness: Harness,
  trigger: CardTrigger,
): Promise<Id<'reorientations'> | null> {
  return await harness.run(async (ctx) => await openCard(ctx, trigger));
}

/** A stored row's fields without its id and creation time, to insert again as a copy. */
export function fieldsOf<T extends { readonly _id: unknown; readonly _creationTime: number }>(
  row: T,
): Omit<T, '_id' | '_creationTime'> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== '_id' && key !== '_creationTime'),
  ) as Omit<T, '_id' | '_creationTime'>;
}

/** What the judgement read of a card, as its write carries it (`proposalBasis`). */
export async function basisOf(
  harness: Harness,
  reorientationId: Id<'reorientations'>,
): Promise<string> {
  return proposalBasis(await cardOf(harness, reorientationId));
}

/** One card as stored. */
export async function cardOf(
  harness: Harness,
  reorientationId: Id<'reorientations'>,
): Promise<Doc<'reorientations'>> {
  const card = await harness.run(async (ctx) => await ctx.db.get(reorientationId));
  if (card === null) throw new Error('card not found');
  return card;
}

/** Every card of an employee, oldest first. */
export async function cardsOf(
  harness: Harness,
  agentId: Id<'agents'>,
): Promise<Doc<'reorientations'>[]> {
  return await harness.run(async (ctx) =>
    (await ctx.db.query('reorientations').collect()).filter((card) => card.agentId === agentId),
  );
}

/** The types of an employee's events, oldest first. */
export async function eventTypesOf(harness: Harness, agentId: Id<'agents'>): Promise<string[]> {
  return await harness.run(async (ctx) =>
    (await ctx.db.query('events').collect())
      .filter((event) => event.agentId === agentId)
      .map((event) => event.type),
  );
}
