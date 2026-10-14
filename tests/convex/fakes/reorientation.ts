import type { TestConvex } from 'convex-test';
import { vi } from 'vitest';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';
import { internal } from '../../../convex/_generated/api';
import { openCard, type CardTrigger } from '../../../convex/reorientation';
import { proposalBasis } from '../../../convex/reorientationJudgementInput';
import { proposalFingerprint } from '../../../src/agent/reorientation-words';
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

/**
 * What the page sends with Approve: the card, and the proposal it drew (`proposalFingerprint`),
 * which Approve requires from 0.22.0 (O-2 (a)).
 */
export async function shownOf(
  harness: Harness,
  reorientationId: Id<'reorientations'>,
): Promise<{ reorientationId: Id<'reorientations'>; shown: string }> {
  return {
    reorientationId,
    shown: proposalFingerprint((await cardOf(harness, reorientationId)).proposed),
  };
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

/** One function the scheduler holds, as the tests read it. */
export interface ScheduledJob {
  readonly _id: string;
  readonly scheduledTime: number;
  readonly args: unknown[];
}

/** The functions of one name the scheduler holds, oldest first, with their arguments. */
export async function scheduledAs(harness: Harness, name: string): Promise<ScheduledJob[]> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.system
        .query('_scheduled_functions')
        .filter((q) => q.eq(q.field('name'), name))
        .collect(),
  );
}

/**
 * Run a fan-out's chain of cards to its end, one link at a time, as the scheduler would: each
 * `reorientation.openCardsLater` once, and nothing else the scheduler holds (the judgements stay
 * unasked, so no test reaches a model).
 *
 * @returns How many links ran, and the most functions for cards found waiting at one time.
 */
export async function runCardChain(
  harness: Harness,
): Promise<{ links: number; mostWaiting: number }> {
  const ran = new Set<string>();
  let mostWaiting = 0;
  for (;;) {
    const waiting = (await scheduledAs(harness, 'reorientation:openCardsLater')).filter(
      (job) => !ran.has(job._id),
    );
    mostWaiting = Math.max(mostWaiting, waiting.length);
    const [next] = waiting;
    if (next === undefined) return { links: ran.size, mostWaiting };
    ran.add(next._id);
    await harness.mutation(
      internal.reorientation.openCardsLater,
      next.args[0] as { cards: never[]; judged: number },
    );
  }
}

/**
 * Run something and hand back, beside its result, the warnings the logger wrote meanwhile, each
 * parsed from its line.
 *
 * @param run - What to run with the log read.
 */
export async function warnedBy<Result>(
  run: () => Promise<Result>,
): Promise<{ result: Result; warnings: Array<Record<string, unknown>> }> {
  const written = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
  try {
    const result = await run();
    const warnings = written.mock.calls.flatMap(([line]): Array<Record<string, unknown>> => {
      try {
        const parsed = JSON.parse(String(line)) as Record<string, unknown>;
        return parsed.level === 'warn' ? [parsed] : [];
      } catch {
        // Not one of the logger's lines: something else wrote to the console.
        return [];
      }
    });
    return { result, warnings };
  } finally {
    written.mockRestore();
  }
}
