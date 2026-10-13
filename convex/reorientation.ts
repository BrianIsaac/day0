import { v, type Infer } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { appendEvent } from './eventLog';
import {
  REACH_ROW_BUDGET,
  blockingWorkOf,
  cardReachValidator,
  hasOpenWork,
  openWorkCache,
  ownerAgents,
  reachOf,
  workRowsReadIn,
  type CardAffected,
  type CardReach,
  type ReachLimits,
} from './reorientationReach';
import schema, { reorientationTalkProposalValidator } from './schema';
import { agentZone, dayKey } from '../src/lib/zone';
import type { Charter } from '../src/agent/charter';
import { RELATIONSHIP_NOUNS } from '../src/people/words';
import { PLAN_CANCELLED_REASON } from '../src/work/stop';
import { redactTokenShapes } from '../src/surfaces/redact';
import { conflictSteps, heldWriteSurfaces, planLeansOn } from '../src/work/conflict-hold';
import type { ExecutionPlan } from '../src/work/types';
import {
  UNDECIDED_REORIENTATION_STATUSES,
  type ReorientationRisk,
  type ReorientationStatus,
  type ReorientationTrigger,
} from '../src/agent/reorientation-vocabulary';
import {
  PROPOSAL_DID_NOT_FINISH,
  approvedResultWords,
  closedByHandSummary,
  conflictQuestionText,
  type NamedPageWords,
} from '../src/agent/reorientation-words';
import {
  COUNTED_EVENTS_SHOWN,
  agreementActionsOf,
  countedEventLine,
  type ClauseField,
  type CountedEvent,
  type ProposalCandidate,
  type ProposalInput,
} from '../src/agent/reorientation-proposal';

/*
 * Reorientation cards (wave 16, 16-O; the wave file's sections 1 and 5.2, A11): a card opens when
 * the organisation changes under an employee, inside the transaction of the change's own writer,
 * with the evidence, what the change reaches and, once the scheduled judgement has answered, what
 * the employee proposes. Only Approve changes anything (`convex/reorientationDecisions.ts`); a
 * low-risk card never holds work; at most one card a day per trigger kind and employee, in the
 * employee's zone (C6), a later trigger of the kind that day joining it.
 *
 * This module is the floor every trigger writer imports: it reads and writes cards and events
 * only, imports no other `convex/` module but `eventLog`, `schema` and `reorientationReach`, and
 * sits below `convex/work.ts` (it never imports `./work`), so a writer in `docStatus`, `people`,
 * `surfaces` or `agents` gains no edge towards `work` by calling it. The decisions, which call the
 * targets' own transaction helpers, are a module above it; the counted rows (three refusals, skips
 * or rejections) a module beside it, `convex/reorientationPatterns.ts`, which calls `openCard`. A
 * writer that can reach more than one employee hands its cards over once (`openCards`): the first
 * open in its transaction, within a budget of work rows read, and the rest ride one scheduled
 * function that opens what its own budget allows and schedules one more (`openCardsLater`; wave
 * 17, 17-O, D-9 (a)), so no transaction schedules more than one function for cards.
 *
 * What a card reaches and holds is read a module below, `convex/reorientationReach.ts` (wave 17,
 * 17-s): the employee's open work, what a change to skills, a scope or a connected system
 * reaches, a card's reach as its writer names it (`CardReach`, `reachOf`), the work a high-risk
 * card holds (`blockingWorkOf`) and an owner's employees (`ownerAgents`). This module keeps the
 * card's store, `openCard`, the hold's read, the conflict's question and the judgement's
 * registered functions.
 */

/** What a card rests on, every kind by id. */
export type CardEvidence = Doc<'reorientations'>['evidence'];

/**
 * The most ids one list of a card's evidence or affected set keeps: a later trigger of the day adds
 * to a card's lists, and Convex refuses an array past 8,192 values, so each list keeps its first
 * hundred (16-K's handover, "Bound every list on a card"). What a list left out is not recorded.
 */
export const CARD_LIST_LIMIT = 100;

/**
 * The cards of one standing a read takes: an employee has few undecided cards (C6). The hold and
 * the employee's card list read the same number, so a card that holds work is always listed.
 */
export const STANDING_CARDS_READ = 50;

/** The standings a card still waits in, deferred among them: it holds and a trigger joins it. */
const STANDING_STATUSES = [
  ...UNDECIDED_REORIENTATION_STATUSES,
  'deferred',
] as const satisfies readonly ReorientationStatus[];

/** The cards one employee's day of one trigger kind can hold, decided ones among them. */
const DAY_CARDS_READ = 20;

/** The cards a handover's move rewrites per standing (16-K's F2). */
const MOVED_CARDS_READ = 1_000;

/** The deferred cards the sweep opens again per run. */
const REOPEN_READ = 100;

const NO_EVIDENCE: CardEvidence = {
  eventIds: [],
  pageRefs: [],
  relationIds: [],
  correctionIds: [],
  relationshipIds: [],
  skillIds: [],
  skillVersionIds: [],
};

const NOTHING_AFFECTED: CardAffected = {
  charterClauses: [],
  agreements: [],
  relationships: [],
  skills: [],
  surfaces: [],
  workItems: [],
};

/** One change under an employee, as its writer reports it to `openCard`. */
export interface CardTrigger {
  readonly agentId: Id<'agents'>;
  readonly trigger: ReorientationTrigger;
  /** What makes a second report of the same change a no-op: its event's id, or its counted window. */
  readonly triggerKey: string;
  /** One line of what changed, in the card's words. */
  readonly summary: string;
  readonly evidence?: Partial<CardEvidence>;
  readonly affected?: Partial<CardAffected>;
  /** What of the employee's work and connections the change reaches, read where the card opens. */
  readonly reach?: CardReach;
  /** A write scope is involved, so the card is high risk whatever else it reaches. */
  readonly writeScope?: boolean;
  readonly now?: number;
}

const cardFields = schema.tables.reorientations.validator.fields;

/** A card left to a later transaction, whole: its lists as the card would store them. */
const laterCardValidator = v.object({
  agentId: v.id('agents'),
  trigger: cardFields.trigger,
  triggerKey: v.string(),
  summary: v.string(),
  evidence: cardFields.evidence,
  affected: cardFields.affected,
  reach: v.optional(cardReachValidator),
  writeScope: v.optional(v.boolean()),
  now: v.number(),
});

/** {@link laterCardValidator}'s type. */
type LaterCard = Infer<typeof laterCardValidator>;

/**
 * How many cards a writer's own transaction opens or joins: of a list handed to `openCards`, the
 * first eight the row budget allows, the rest riding the chain; and the most `openCard` opens one
 * at a time in one transaction before it throws (O-2), so a writer that fans out (an approver for
 * everyone, an organisation's connection, a page's readers, a skill's holders) cannot bring back
 * one scheduled function a card by calling `openCard` in a loop.
 */
export const INLINE_CARDS_PER_TRANSACTION = 8;

/** The cards one link of the chain opens or joins, at most: each writes a card and an event. */
export const CHAIN_CARDS_PER_LINK = 50;

/**
 * The most bytes of cards one scheduled function carries: under Convex's 4 MiB an argument, with
 * room for the encoding. A fan-out past it (about four thousand cards) rides more than one chain.
 */
const CHAIN_ARGUMENT_BYTES = 2 * 1024 * 1024;

/** How many judgements a fan-out starts at one time (W16-R23). */
export const JUDGEMENTS_AT_ONCE = 8;

/** How long after one group of a fan-out's judgements the next starts. */
export const JUDGEMENT_STAGGER_MS = 5_000;

/** The longest a fan-out holds a judgement back: well inside the sweep's ten minutes. */
const JUDGEMENT_STAGGER_CAP_MS = 180_000;

/** When the judgement of a fan-out's card starts, by how many of its judgements started before. */
function judgeAfterMs(startedBefore: number): number {
  return Math.min(
    Math.floor(startedBefore / JUDGEMENTS_AT_ONCE) * JUDGEMENT_STAGGER_MS,
    JUDGEMENT_STAGGER_CAP_MS,
  );
}

/** The most of a thrown error's message the record keeps of a card that could not be opened. */
const CARD_NOT_OPENED_REASON_CHARS = 300;

/** The cards each transaction has opened one at a time so far, by its database handle. */
const singleCardsThisTransaction = new WeakMap<object, number>();

/**
 * Count one more card opened one at a time in this transaction.
 *
 * @throws Error at the ninth: a writer that reaches that many employees hands `openCards` a list.
 */
function countSingleCard(ctx: MutationCtx): void {
  const taken = singleCardsThisTransaction.get(ctx.db) ?? 0;
  if (taken >= INLINE_CARDS_PER_TRANSACTION) {
    throw new Error(
      `openCard was called more than ${INLINE_CARDS_PER_TRANSACTION} times in one transaction: a writer that reaches more than one employee hands its whole list to openCards.`,
    );
  }
  singleCardsThisTransaction.set(ctx.db, taken + 1);
}

/** The list's values once each, by a key, at most `CARD_LIST_LIMIT` of them. */
function unique<T>(
  lists: ReadonlyArray<readonly T[] | undefined>,
  keyOf: (value: T) => string,
): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const value of lists.flatMap((list) => list ?? [])) {
    const key = keyOf(value);
    if (seen.has(key) || kept.length >= CARD_LIST_LIMIT) continue;
    seen.add(key);
    kept.push(value);
  }
  return kept;
}

const idKey = (id: string): string => id;

/** Two evidence sets as one, each list once and bounded. */
function joinedEvidence(
  base: CardEvidence,
  added: Partial<CardEvidence> | undefined,
): CardEvidence {
  // The organisation's ledger lines: absent on a card opened before 0.21.0, and kept absent on
  // a card that rests on none.
  const connectionEventIds = unique([base.connectionEventIds, added?.connectionEventIds], idKey);
  return {
    eventIds: unique([base.eventIds, added?.eventIds], idKey),
    pageRefs: unique([base.pageRefs, added?.pageRefs], (page) => `${page.sourceId}:${page.ref}`),
    relationIds: unique([base.relationIds, added?.relationIds], idKey),
    correctionIds: unique([base.correctionIds, added?.correctionIds], idKey),
    relationshipIds: unique([base.relationshipIds, added?.relationshipIds], idKey),
    skillIds: unique([base.skillIds, added?.skillIds], idKey),
    skillVersionIds: unique([base.skillVersionIds, added?.skillVersionIds], idKey),
    ...(connectionEventIds.length > 0 ? { connectionEventIds } : {}),
  };
}

/** Two affected sets as one, each list once and bounded. */
function joinedAffected(
  base: CardAffected,
  added: Partial<CardAffected> | undefined,
): CardAffected {
  return {
    charterClauses: unique(
      [base.charterClauses, added?.charterClauses],
      (clause) => `${clause.field}:${clause.index}`,
    ),
    agreements: unique([base.agreements, added?.agreements], idKey),
    relationships: unique([base.relationships, added?.relationships], idKey),
    skills: unique([base.skills, added?.skills], idKey),
    surfaces: unique([base.surfaces, added?.surfaces], idKey),
    workItems: unique([base.workItems, added?.workItems], idKey),
  };
}

/**
 * How much a card can hold up (5.2): high when a write scope or work that would be held is
 * involved, medium for a charter clause, low otherwise.
 */
export function riskOf(affected: CardAffected, writeScope: boolean): ReorientationRisk {
  if (writeScope || affected.workItems.length > 0) return 'high';
  return affected.charterClauses.length > 0 ? 'medium' : 'low';
}

/** The higher of two risks. */
function higher(left: ReorientationRisk, right: ReorientationRisk): ReorientationRisk {
  const rank: Readonly<Record<ReorientationRisk, number>> = { low: 0, medium: 1, high: 2 };
  return rank[left] >= rank[right] ? left : right;
}

/** An employee's cards still standing (open, discussing or deferred), newest first per standing. */
async function standingCards(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'reorientations'>[]> {
  const byStatus = await Promise.all(
    STANDING_STATUSES.map(
      async (status) =>
        await ctx.db
          .query('reorientations')
          .withIndex('by_agent_status', (q) => q.eq('agentId', agentId).eq('status', status))
          .order('desc')
          .take(STANDING_CARDS_READ),
    ),
  );
  return byStatus.flat();
}

/** The employees whose card each transaction is approving, by its database handle. */
const approvingThisTransaction = new WeakMap<object, Set<Id<'agents'>>>();

/**
 * Mark the employees the change a card's Approve applies reaches, so that change opens no second
 * card about itself (O-13): the card's own employee, and every employee of the owner when the
 * proposal edits or retires an edge for everyone, which `people.openEdgeCards` would otherwise fan
 * out to again, each Approve re-opening the rest (W16-R2: bed 1's 50 joined events). Called by
 * `reorientationDecisions.approve` before the target runs; the mark lives as long as the
 * transaction, whatever the employees' other cards (the second pass's minor: a read of the newest
 * applied cards missed an old one).
 */
export async function markApproving(ctx: MutationCtx, card: Doc<'reorientations'>): Promise<void> {
  const approving = approvingThisTransaction.get(ctx.db) ?? new Set<Id<'agents'>>();
  approving.add(card.agentId);
  if (card.proposed.kind === 'relationship') {
    const edge = await ctx.db.get(card.proposed.relationshipId);
    if (edge !== null && edge.fromAgentId === undefined && edge.fromPersonId === undefined) {
      for (const agent of await ownerAgents(ctx, edge.userId)) approving.add(agent._id);
    }
  }
  approvingThisTransaction.set(ctx.db, approving);
}

/** Whether this transaction is approving one of the employee's cards. */
function approvingNow(ctx: MutationCtx, agentId: Id<'agents'>): boolean {
  return approvingThisTransaction.get(ctx.db)?.has(agentId) === true;
}

/** Whether a card already carries a report: its own key, or a joined trigger's event or ledger line. */
function carries(card: Doc<'reorientations'>, triggerKey: string): boolean {
  return (
    card.triggerKey === triggerKey ||
    card.evidence.eventIds.some((id) => id === triggerKey) ||
    (card.evidence.connectionEventIds ?? []).some((id) => id === triggerKey)
  );
}

/** What became of one report of a change: its card, nothing to write, or a wait for room. */
export type OpenOutcome =
  | {
      readonly kind: 'opened' | 'joined';
      readonly reorientationId: Id<'reorientations'>;
      /** Whether the judgement was asked for the card. */
      readonly judging: boolean;
    }
  | { readonly kind: 'nothing' }
  | { readonly kind: 'over-budget' };

const NOTHING_OPENED: OpenOutcome = { kind: 'nothing' };

/** How one card opens: how far its reach may read, and when its judgement starts. */
export interface OneCardLimits extends ReachLimits {
  readonly judgeAfterMs: number;
}

/**
 * Open a card for one report, or join it to the card of its kind already standing that day (C6)
 * or deferred on an earlier one (W16-R24).
 * A change the employee's standing cards already carry (by its key, or a joined event's id) writes
 * nothing; an employee that is gone, or has no owner key, gets no card. Every read comes before the
 * first write, so a report whose reach needs more work rows than `room` leaves nothing behind.
 */
async function openOne(
  ctx: MutationCtx,
  reported: CardTrigger,
  limits: OneCardLimits,
): Promise<OpenOutcome> {
  const now = reported.now ?? Date.now();
  const agent = await ctx.db.get(reported.agentId);
  if (agent === null || agent.userId === undefined) return NOTHING_OPENED;
  const standing = await standingCards(ctx, agent._id);
  if (standing.some((card) => carries(card, reported.triggerKey))) return NOTHING_OPENED;
  const reached =
    reported.reach !== undefined
      ? await reachOf(ctx, agent._id, reported.reach, limits)
      : undefined;
  if (reached?.kind === 'nothing') return NOTHING_OPENED;
  if (reached?.kind === 'over-budget') return { kind: 'over-budget' };
  const input: CardTrigger =
    reached === undefined
      ? reported
      : {
          ...reported,
          affected: joinedAffected(
            joinedAffected(NOTHING_AFFECTED, reported.affected),
            reached.affected,
          ),
        };
  const day = dayKey(now, agentZone(agent));
  const today = await ctx.db
    .query('reorientations')
    .withIndex('by_agent_day_trigger', (q) =>
      q.eq('agentId', agent._id).eq('day', day).eq('trigger', input.trigger),
    )
    .take(DAY_CARDS_READ);
  // The day's standing card of the kind, or a card of the kind deferred on an earlier day: left
  // out, the same trigger on a later day opened a second card beside the deferred one, and both
  // opened again (W16-R24).
  const joinable =
    today.find((card) => (STANDING_STATUSES as readonly string[]).includes(card.status)) ??
    standing.find((card) => card.status === 'deferred' && card.trigger === input.trigger);
  if (joinable !== undefined) return await joinCard(ctx, joinable, input, limits.judgeAfterMs);
  const evidence = joinedEvidence(NO_EVIDENCE, input.evidence);
  const affected = joinedAffected(NOTHING_AFFECTED, input.affected);
  const risk = riskOf(affected, input.writeScope === true);
  const blockingWork = await blockingWorkOf(ctx, affected, risk);
  const reorientationId = await ctx.db.insert('reorientations', {
    agentId: agent._id,
    userId: agent.userId,
    trigger: input.trigger,
    triggerKey: input.triggerKey,
    triggerSummary: input.summary,
    evidence,
    affected,
    proposed: { kind: 'pending' },
    risk,
    blockingWork,
    status: 'open',
    day,
    createdAt: now,
  });
  await appendEvent(ctx, {
    agentId: agent._id,
    type: 'reorientation.opened',
    payload: {
      reorientationId,
      summary: input.summary,
      trigger: input.trigger,
      triggerKey: input.triggerKey,
      risk,
    },
    createdAt: now,
  });
  await ctx.scheduler.runAfter(limits.judgeAfterMs, internal.reorientationActions.propose, {
    reorientationId,
  });
  return { kind: 'opened', reorientationId, judging: true };
}

/**
 * Open a card for a change under one employee, or join the change to the card of its kind already
 * standing that day (C6). Called by the change's writer inside its own transaction, **for a change
 * that reaches one employee**: a writer that can reach more hands its whole list to
 * {@link openCards}. A change the employee's standing cards already carry writes nothing; an
 * employee that is gone, or has no owner key, gets no card. A new card opens with its proposal
 * pending and schedules the judgement (O-2); a joined card asks the judgement again only while
 * nothing is proposed. Writes `reorientation.opened`, with `joined` for a join.
 *
 * @returns The card the change is on, or null when nothing was written.
 * @throws Error at the ninth call in one transaction (wave 17, O-2): a programming error a test
 *   meets, never a path of production, since one scheduled function a card is the bound a fan-out
 *   broke (W16-R5).
 */
export async function openCard(
  ctx: MutationCtx,
  reported: CardTrigger,
): Promise<Id<'reorientations'> | null> {
  if (approvingNow(ctx, reported.agentId)) return null;
  countSingleCard(ctx);
  const outcome = await openOne(ctx, reported, { judgeAfterMs: 0 });
  return outcome.kind === 'opened' || outcome.kind === 'joined' ? outcome.reorientationId : null;
}

/** A report as the chain carries it: whole, with its time. */
function carried(reported: CardTrigger, now: number): LaterCard {
  return {
    agentId: reported.agentId,
    trigger: reported.trigger,
    triggerKey: reported.triggerKey,
    summary: reported.summary,
    evidence: joinedEvidence(NO_EVIDENCE, reported.evidence),
    affected: joinedAffected(NOTHING_AFFECTED, reported.affected),
    ...(reported.reach !== undefined ? { reach: reported.reach } : {}),
    ...(reported.writeScope !== undefined ? { writeScope: reported.writeScope } : {}),
    now: reported.now ?? now,
  };
}

/** How one transaction opens the cards it was handed. */
interface OpenLimits {
  /** The most cards it opens or joins. */
  readonly cards: number;
  /**
   * Whether its first reach reads whatever its employee's open work takes: a link of the chain
   * must open at least the card it starts on, where a writer's own transaction leaves any card
   * past its room to the chain.
   */
  readonly firstReachUnbounded: boolean;
  /** How many of the fan-out's judgements were started before this transaction. */
  readonly judged: number;
}

/** The opener a link of the chain runs for each card: the store's own, or a test's. */
export type CardOpener = (
  ctx: MutationCtx,
  reported: CardTrigger,
  limits: OneCardLimits,
) => Promise<OpenOutcome>;

/**
 * Open what one transaction's budget allows of a list of cards, in order, and answer the rest
 * (W16-R5, W16-R6). A `citing` card for an employee with no open work is dropped for four index
 * reads; a card is opened while fewer than `REACH_ROW_BUDGET` work rows have been read and fewer
 * than `limits.cards` cards opened; a card whose reach would pass the room left, and every card
 * after it, waits. A card that throws is recorded (`reorientation.card-not-opened`) and the next
 * one is tried, so one bad card cannot take the rest of a fan-out with it (W16-R23).
 */
async function openWithinBudget(
  ctx: MutationCtx,
  cards: readonly LaterCard[],
  limits: OpenLimits,
  open: CardOpener,
): Promise<{ readonly rest: LaterCard[]; readonly judged: number }> {
  const rest: LaterCard[] = [];
  const openWork = openWorkCache();
  let opened = 0;
  let judged = limits.judged;
  let reachRead = false;
  for (const [at, card] of cards.entries()) {
    if (opened >= limits.cards || workRowsReadIn(ctx) >= REACH_ROW_BUDGET) {
      rest.push(...cards.slice(at));
      break;
    }
    try {
      if (card.reach?.kind === 'citing' && !(await hasOpenWork(ctx, card.agentId))) continue;
      const unbounded = limits.firstReachUnbounded && !reachRead;
      reachRead ||= card.reach !== undefined;
      const outcome = await open(ctx, card, {
        ...(unbounded ? {} : { room: REACH_ROW_BUDGET - workRowsReadIn(ctx) }),
        openWork,
        judgeAfterMs: judgeAfterMs(judged),
      });
      if (outcome.kind === 'over-budget') {
        rest.push(...cards.slice(at));
        break;
      }
      if (outcome.kind === 'nothing') continue;
      opened += 1;
      if (outcome.judging) judged += 1;
    } catch (error) {
      // Recorded and passed over: a scheduled function that throws is not run again, and the
      // cards behind this one in the chain would be lost with it.
      await appendEvent(ctx, {
        agentId: card.agentId,
        type: 'reorientation.card-not-opened',
        payload: {
          trigger: card.trigger,
          triggerKey: card.triggerKey,
          summary: card.summary,
          reason: redactTokenShapes(error instanceof Error ? error.message : String(error)).slice(
            0,
            CARD_NOT_OPENED_REASON_CHARS,
          ),
        },
        createdAt: card.now,
      });
    }
  }
  return { rest, judged };
}

/** A list of cards as the functions that carry it, each under the argument's bound. */
function chained(cards: readonly LaterCard[]): LaterCard[][] {
  const encoder = new TextEncoder();
  const chains: LaterCard[][] = [];
  let bytes = 0;
  for (const card of cards) {
    const size = encoder.encode(JSON.stringify(card)).length;
    if (chains.length === 0 || bytes + size > CHAIN_ARGUMENT_BYTES) {
      chains.push([]);
      bytes = 0;
    }
    chains[chains.length - 1].push(card);
    bytes += size;
  }
  return chains;
}

/** Schedule what a transaction left of a fan-out: one function, or one for each argument's worth. */
async function scheduleRest(
  ctx: MutationCtx,
  rest: readonly LaterCard[],
  judged: number,
): Promise<void> {
  for (const cards of chained(rest)) {
    await ctx.scheduler.runAfter(0, internal.reorientation.openCardsLater, { cards, judged });
  }
}

/**
 * Open a card on each employee a change reaches, handed over once by the change's writer inside
 * its own transaction (wave 17, 17-O; D-9 (a), O-1). The writer's transaction opens the first
 * cards itself, at most `INLINE_CARDS_PER_TRANSACTION` and within its budget of work rows read
 * (`REACH_ROW_BUDGET`), and schedules **one** function carrying the rest (`openCardsLater`), which
 * opens what its own budget allows and schedules one more: a change of any reach is a chain of
 * single scheduled functions, where one a card met Convex's thousand a mutation at 51 employees
 * and twenty pages (W16-R5). Each card opens or joins as `openCard`'s does; an employee whose card
 * this transaction is approving gets none.
 *
 * A list past about 16 MiB of cards (Convex's bound on a mutation's scheduled arguments: some
 * twenty-five thousand cards) is refused by the scheduler; no writer reaches it.
 */
export async function openCards(ctx: MutationCtx, reports: readonly CardTrigger[]): Promise<void> {
  const now = Date.now();
  const cards = reports
    .filter((reported) => !approvingNow(ctx, reported.agentId))
    .map((reported) => carried(reported, now));
  if (cards.length === 0) return;
  const { rest, judged } = await openWithinBudget(
    ctx,
    cards,
    { cards: INLINE_CARDS_PER_TRANSACTION, firstReachUnbounded: false, judged: 0 },
    openOne,
  );
  await scheduleRest(ctx, rest, judged);
}

/**
 * One link of a fan-out's chain, in the caller's transaction: open what its budget allows of the
 * cards it carries and schedule one function for what is left.
 *
 * @param open - The opener; a test hands one that throws to show a card that fails is recorded.
 */
export async function continueCardChain(
  ctx: MutationCtx,
  chain: { readonly cards: readonly LaterCard[]; readonly judged: number },
  open: CardOpener = openOne,
): Promise<void> {
  const { rest, judged } = await openWithinBudget(
    ctx,
    chain.cards,
    { cards: CHAIN_CARDS_PER_LINK, firstReachUnbounded: true, judged: chain.judged },
    open,
  );
  await scheduleRest(ctx, rest, judged);
}

/**
 * Open the next cards of a fanned-out change and pass the rest on (wave 17, 17-O; D-9 (a)).
 * Internal; scheduled by `openCards` and by itself, one function at a time. Writes each card with
 * its `reorientation.opened`, or `reorientation.card-not-opened` for a card that threw.
 */
export const openCardsLater = internalMutation({
  args: { cards: v.array(laterCardValidator), judged: v.number() },
  handler: async (ctx, args): Promise<void> => {
    await continueCardChain(ctx, args);
  },
});

/**
 * Open a card a fanned-out change left to a transaction of its own (the second pass's M5).
 * Internal. Nothing schedules it from 0.21.0 on (`openCards` took its place); it stays registered
 * because a job scheduled by 0.20.0 can stand in a deployment's queue across the upgrade.
 */
export const openCardLater = internalMutation({
  args: { card: laterCardValidator },
  handler: async (ctx, args): Promise<void> => {
    await openCard(ctx, args.card);
  },
});

/** Join a change to the card of its kind standing that day: its lists grow, its risk can rise. */
async function joinCard(
  ctx: MutationCtx,
  card: Doc<'reorientations'>,
  input: CardTrigger,
  judgeAfter: number,
): Promise<OpenOutcome> {
  const now = input.now ?? Date.now();
  const evidence = joinedEvidence(card.evidence, input.evidence);
  const affected = joinedAffected(card.affected, input.affected);
  const risk = higher(card.risk, riskOf(affected, input.writeScope === true));
  const blockingWork = await blockingWorkOf(ctx, affected, risk);
  await ctx.db.patch(card._id, { evidence, affected, risk, blockingWork });
  await appendEvent(ctx, {
    agentId: card.agentId,
    type: 'reorientation.opened',
    payload: {
      reorientationId: card._id,
      summary: input.summary,
      trigger: input.trigger,
      triggerKey: input.triggerKey,
      risk,
      joined: true,
    },
    createdAt: now,
  });
  const judging = card.proposed.kind === 'pending';
  if (judging) {
    await ctx.scheduler.runAfter(judgeAfter, internal.reorientationActions.propose, {
      reorientationId: card._id,
    });
  }
  return { kind: 'joined', reorientationId: card._id, judging };
}

/**
 * The card holding a work item, if one does: a high-risk card still standing (open, discussing or
 * deferred: Defer on a high-risk card keeps its hold, A21) whose blocking work names the row. Read
 * by the plan's decision (the seventh held reason) and before the closing phase authors (O-3).
 */
export async function heldByReorientation(
  ctx: QueryCtx,
  row: Pick<Doc<'workItems'>, '_id' | 'agentId'>,
): Promise<Doc<'reorientations'> | undefined> {
  return (await standingCards(ctx, row.agentId)).find(
    (card) => card.risk === 'high' && card.blockingWork.some((id) => id === row._id),
  );
}

/**
 * Where a card's hold stops a row it names (the second pass's M3): a drafted plan at its approval
 * (`decidePlan`'s seventh reason), a run going on before its closing steps (the closing phase's
 * check); a run whose closing set is already written, or a row past running, is not stopped.
 */
export function heldStageOf(
  row: Pick<Doc<'workItems'>, 'state' | 'output'>,
): 'plan' | 'run' | undefined {
  switch (row.state) {
    case 'plan-pending':
      return 'plan';
    case 'plan-approved':
    case 'executing':
      return 'run';
    case 'actions-pending':
      return (row.output as { phase?: string } | undefined)?.phase === 'dependent'
        ? undefined
        : 'run';
    case 'discovered':
    case 'claimed':
    case 'completed':
    case 'cancelled':
    case 'failed':
    case 'skipped':
    case 'deferred':
    case 'needs-skill':
      return undefined;
    default: {
      const unknown: never = row.state;
      throw new Error(`unhandled work item state ${String(unknown)}`);
    }
  }
}

/**
 * The card holding a work item, for the closing phase's own check (O-3): its id and its summary,
 * or null. Internal; read by `workActions.authorDependentActions` in both modes.
 */
export const holdingCard = internalQuery({
  args: { workItemId: v.id('workItems') },
  handler: async (
    ctx,
    args,
  ): Promise<{ reorientationId: Id<'reorientations'>; summary: string } | null> => {
    const row = await ctx.db.get(args.workItemId);
    if (row === null) return null;
    const card = await heldByReorientation(ctx, row);
    return card === undefined ? null : { reorientationId: card._id, summary: card.triggerSummary };
  },
});

/**
 * Move an employee's cards to its new owner, in the handover's transaction (16-K's F2): `userId`
 * is a copy of the employee's owner key, so the owner's cards across employees (`by_user_status`)
 * list the moved employee's under the owner who has it. A card still undecided is closed as handed
 * over (W16-R1, D-5 (a); 16-K's option (b)): what it asks rests on the old manager's graph, words
 * and documentation, which stay theirs, so the new manager starts from the transfer's own card.
 * Its talk's words are cleared beside it (`reorientationTalk.clearTalksForHandover`), and the
 * summary of a card the old manager opened by hand with them (D-5's remainder, (a)): the card's own
 * line. The record's lines about the card move whole, as the record does (D10).
 */
export async function moveCardsToOwner(
  ctx: MutationCtx,
  handover: {
    readonly agentId: Id<'agents'>;
    /** The new owner's key. */
    readonly userId: string;
    /** The previous manager, as a closed by-hand card names who opened it. */
    readonly previousManager: string;
    readonly now: number;
  },
): Promise<void> {
  const { agentId, userId, now } = handover;
  for (const status of ['open', 'discussing', 'deferred', 'applied', 'dismissed'] as const) {
    const cards = await ctx.db
      .query('reorientations')
      .withIndex('by_agent_status', (q) => q.eq('agentId', agentId).eq('status', status))
      .take(MOVED_CARDS_READ);
    // A deferred card is standing too: left as it was it would keep its hold and open again
    // under the new manager on its date (the second pass).
    const undecided = (STANDING_STATUSES as readonly string[]).includes(status);
    for (const card of cards) {
      if (undecided) {
        await ctx.db.patch(card._id, {
          userId,
          status: 'dismissed',
          decidedAt: now,
          revisitAt: undefined,
          outcome: { summary: approvedResultWords.handedOver },
          // A card opened by hand says what the previous manager typed: cleared with the talk's
          // words, the card kept with who opened it (D-5's remainder, (a)).
          ...(card.trigger === 'role-changed'
            ? { triggerSummary: closedByHandSummary(handover.previousManager) }
            : {}),
        });
      } else if (card.userId !== userId) {
        await ctx.db.patch(card._id, { userId });
      }
    }
  }
}

/** Whether a scope lets the employee write, so a change to it is high risk (5.2). */
export function isWriteScope(scope: string): boolean {
  return /:(write|admin)$/.test(scope);
}

/** The agreements one read of an owner's or an employee's active ones takes. */
const AGREEMENTS_READ = 200;

/** The owner's active working agreements about one person. */
export async function personAgreements(
  ctx: QueryCtx,
  userId: string,
  personId: Id<'people'>,
): Promise<Id<'workingAgreements'>[]> {
  return (
    await ctx.db
      .query('workingAgreements')
      .withIndex('by_user_person', (q) =>
        q.eq('userId', userId).eq('personId', personId).eq('status', 'active'),
      )
      .take(AGREEMENTS_READ)
  ).map((agreement) => agreement._id);
}

/**
 * The active working agreements binding an employee (its own and the owner's for everyone) whose
 * stored plans include a work item: what a correction on that item reaches.
 */
export async function agreementsApplying(
  ctx: QueryCtx,
  agent: Pick<Doc<'agents'>, '_id' | 'userId'>,
  workItemId: Id<'workItems'>,
): Promise<Id<'workingAgreements'>[]> {
  const userId = agent.userId;
  if (userId === undefined) return [];
  const [own, everyone] = await Promise.all(
    [agent._id, undefined].map(
      async (agentId) =>
        await ctx.db
          .query('workingAgreements')
          .withIndex('by_user_agent_status', (q) =>
            q.eq('userId', userId).eq('agentId', agentId).eq('status', 'active'),
          )
          .take(AGREEMENTS_READ),
    ),
  );
  return [...own, ...everyone]
    .filter((agreement) => agreement.appliedTo.includes(workItemId))
    .map((agreement) => agreement._id);
}

/**
 * Open one card on every employee among some of their systems' cards, each card naming that
 * employee's systems and what they reach: a change the organisation made to a connection several
 * employees' systems run on (section 3's revocation rows). The change's line on the connection's
 * ledger rides as the card's evidence (`evidence.connectionEventIds`; wave 17).
 */
export async function openCardsOnSurfaces(
  ctx: MutationCtx,
  surfaceIds: readonly Id<'surfaces'>[],
  change: Pick<CardTrigger, 'trigger' | 'triggerKey' | 'summary' | 'now' | 'evidence'>,
): Promise<void> {
  const byAgent = new Map<Id<'agents'>, Doc<'surfaces'>[]>();
  for (const id of surfaceIds) {
    const surface = await ctx.db.get(id);
    if (surface !== null)
      byAgent.set(surface.agentId, [...(byAgent.get(surface.agentId) ?? []), surface]);
  }
  await openCards(
    ctx,
    [...byAgent].map(([agentId, surfaces]) => ({
      ...change,
      agentId,
      reach: { kind: 'surfaces', surfaceIds: surfaces.map((surface) => surface._id) },
    })),
  );
}

/** A standing conflict as a question names it: its relation, its heading and its two pages. */
export interface ConflictAsked {
  readonly relationId: Id<'docRelations'>;
  readonly heading: string;
  readonly pages: readonly [NamedPageWords, NamedPageWords];
}

/** A conflict question's key: one question about one relation on one work item. */
export function conflictQuestionKey(relationId: Id<'docRelations'>): string {
  return `conflict:${relationId}`;
}

/**
 * What a conflict's hold would withhold of a plan, in the manager's words (W16-R10): the display
 * names of the surfaces its held steps write, or `every` where the plan declares no writes. A
 * conflict the plan names in its own words and cites nowhere holds every step (D-1 (c)).
 */
async function heldSurfaceNames(
  ctx: QueryCtx,
  row: Doc<'workItems'>,
  conflict: ConflictAsked,
): Promise<string[] | 'every'> {
  const { relationId } = conflict;
  const plan = row.plan as ExecutionPlan | undefined;
  const relation = await ctx.db.get(relationId);
  if (plan === undefined || !Array.isArray(plan.steps) || relation === null) return [];
  // The blocks the two pages disagree in, as `docRelationProposals.conflictBlocks` reads them.
  const blocks =
    relation.evidence.find((entry) => entry.measure === 'heading-figures')?.blockRefs ?? [];
  const leaned = planLeansOn(plan, {
    heading: conflict.heading,
    titles: conflict.pages.map((page) => page.title),
  });
  const held = heldWriteSurfaces(plan, conflictSteps(plan, { relationId, blocks, leaned }));
  if (held === 'every' || held.length === 0) return held;
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
    .take(SURFACES_NAMED_READ);
  return held.map(
    (slug) =>
      surfaces.find((surface) => surface.slug.toLowerCase() === slug.toLowerCase())?.displayName ??
      slug,
  );
}

/** The employee's surfaces a question reads for their names. */
const SURFACES_NAMED_READ = 100;

/**
 * Ask, beside a plan, which of two pages is right (RM20 (a); D-4 (c)): one non-blocking
 * `retrieval` question about the relation, on the plan's own row, which its request and its card
 * carry; asked once per row and relation. The steps that rely on the passage wait for the answer
 * at the apply, and the rest run. Nothing is asked of an employee with no approved charter (a
 * question names the charter it was asked under). Writes the question and
 * `manager.question-asked`.
 *
 * @returns The question, or null when it was asked before or could not be.
 */
export async function askConflictQuestion(
  ctx: MutationCtx,
  ask: { readonly row: Doc<'workItems'>; readonly conflict: ConflictAsked; readonly now: number },
): Promise<Id<'managerQuestions'> | null> {
  const { row, conflict } = ask;
  const asked = await ctx.db
    .query('managerQuestions')
    .withIndex('by_relation', (q) => q.eq('relationId', conflict.relationId))
    .take(QUESTIONS_PER_RELATION_READ);
  // Asked once while its question is open; a conflict settled and confirmed again is asked again,
  // since the answer given was to the conflict as it stood then (W16-R27).
  if (asked.some((question) => question.workItemId === row._id && question.answer === undefined)) {
    return null;
  }
  const [agent, charter] = await Promise.all([
    ctx.db.get(row.agentId),
    approvedCharter(ctx, row.agentId),
  ]);
  if (agent === null || charter === undefined) return null;
  const question = conflictQuestionText(
    agent.name,
    conflict.heading,
    conflict.pages,
    await heldSurfaceNames(ctx, row, conflict),
  );
  const questionId = await ctx.db.insert('managerQuestions', {
    agentId: row.agentId,
    key: conflictQuestionKey(conflict.relationId),
    question,
    context: { touchedBy: 'plan', text: conflict.heading, words: [] },
    askedAt: ask.now,
    workItemId: row._id,
    charterId: charter._id,
    blocking: false,
    type: 'retrieval',
    relationId: conflict.relationId,
  });
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'manager.question-asked',
    payload: {
      questionId,
      workItemId: row._id,
      question,
      type: 'retrieval',
      blocking: false,
      relationId: conflict.relationId,
    },
    createdAt: ask.now,
  });
  return questionId;
}

/** The questions about one relation one read takes: one a work item, few items a relation. */
const QUESTIONS_PER_RELATION_READ = 500;

/** The employee's charter as approved last, or undefined. */
export async function approvedCharter(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'charters'> | undefined> {
  const latest = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc')
    .first();
  return latest?.approved ? latest : undefined;
}

/** The charter's list clauses, each by its list, its place and its text. */
function clausesOf(body: Charter): CardAffected['charterClauses'] {
  const lists: ReadonlyArray<readonly [ClauseField, readonly string[] | undefined]> = [
    ['willDo', body.proposedBoundaries?.willDo],
    ['willNotDo', body.proposedBoundaries?.willNotDo],
    ['escalationTriggers', body.proposedBoundaries?.escalationTriggers],
  ];
  return lists.flatMap(([field, clauses]) =>
    (clauses ?? []).map((text, index) => ({ field, index, text })),
  );
}

/**
 * The employee's approved charter's clauses that a test picks, by list and place: what a card about
 * a reporting line, a clause skipped against or the role itself reaches.
 */
export async function charterClausesWhere(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  picks: (clause: CardAffected['charterClauses'][number], body: Charter) => boolean,
): Promise<CardAffected['charterClauses']> {
  const charter = await approvedCharter(ctx, agentId);
  if (charter === undefined) return [];
  const body = charter.body as Charter;
  return clausesOf(body)
    .filter((clause) => picks(clause, body))
    .slice(0, CARD_LIST_LIMIT);
}

/**
 * Whether a clause carries one of the charter's reporting-line rules: the rule's bound clauses
 * name it by list and place (`binds`), or, for a rule drafted before rules were bound, its wording
 * is in the clause.
 */
export function carriesReportingLine(
  clause: CardAffected['charterClauses'][number],
  body: Charter,
): boolean {
  return (body.constraints ?? []).some(
    (rule) =>
      rule.kind === 'reporting-line' &&
      rule.struck !== true &&
      (rule.binds !== undefined
        ? rule.binds.some((bound) => bound.field === clause.field && bound.index === clause.index)
        : rule.wording.some((phrase) => clause.text.includes(phrase))),
  );
}

/**
 * The words of each reporting-line rule the charter carries that binds none of its clauses (W16-R21,
 * W7a): a rule drafted before rules were bound has neither `binds` nor `wording`, so no clause
 * carries it and a handover's card would name nothing of what the old manager's rule was.
 */
export function unboundReportingLines(body: Charter): string[] {
  const clauses = clausesOf(body);
  return (body.constraints ?? []).flatMap((rule) =>
    rule.kind === 'reporting-line' &&
    rule.struck !== true &&
    rule.quote.trim() !== '' &&
    !clauses.some((clause) => carriesReportingLine(clause, { ...body, constraints: [rule] }))
      ? [rule.quote.trim()]
      : [],
  );
}

/** The scope a card offers the judgement: a repeated refusal's counted scope. */
function scopesOf(card: Doc<'reorientations'>): string[] {
  // A revoked scope is not offered: its only action would grant back what the manager just
  // revoked, one click from Approve (the second pass's minor).
  return card.trigger === 'repeated-refusal' && card.triggerKey.startsWith(REFUSAL_KEY_PREFIX)
    ? [card.triggerKey.slice(REFUSAL_KEY_PREFIX.length)]
    : [];
}

/** How a repeated refusal's key opens: the scope follows it. */
export const REFUSAL_KEY_PREFIX = 'refusal:';

/** Whether the employee holds a scope now. */
async function holdsScope(ctx: QueryCtx, agentId: Id<'agents'>, scope: string): Promise<boolean> {
  const grants = await ctx.db
    .query('permissionGrants')
    .withIndex('by_agent_scope', (q) => q.eq('agentId', agentId).eq('scope', scope))
    .take(10);
  return grants.some((grant) => grant.revokedAt === undefined);
}

/** A page by its source and ref, or null. */
async function pageOf(
  ctx: QueryCtx,
  page: { readonly sourceId: Id<'docSources'>; readonly ref: string },
): Promise<Doc<'docPages'> | null> {
  return await ctx.db
    .query('docPages')
    .withIndex('by_source_ref', (q) => q.eq('sourceId', page.sourceId).eq('ref', page.ref))
    .first();
}

/** An edge of the people graph in the card's words: who, what to the employee, and its scope. */
async function edgeWords(ctx: QueryCtx, edge: Doc<'relationships'>): Promise<string> {
  const person = await ctx.db.get(edge.toPersonId);
  const scope = edge.scope !== undefined && edge.scope !== '' ? `, for ${edge.scope}` : '';
  return `${person?.displayName ?? 'someone'} (${RELATIONSHIP_NOUNS[edge.type]}${scope}), ${edge.status}`;
}

/** The candidates a card offers its judgement, in the prompt's order. */
async function candidatesOf(
  ctx: QueryCtx,
  card: Doc<'reorientations'>,
  charter: Doc<'charters'> | undefined,
): Promise<ProposalCandidate[]> {
  const clauses =
    card.trigger === 'role-changed' && charter !== undefined
      ? clausesOf(charter.body as Charter).slice(0, CARD_LIST_LIMIT)
      : card.affected.charterClauses;
  const candidates: ProposalCandidate[] = clauses.map((clause) => ({
    kind: 'charter-clause' as const,
    ...clause,
  }));
  for (const id of card.affected.agreements) {
    const agreement = await ctx.db.get(id);
    if (agreement !== null) {
      candidates.push({
        kind: 'agreement',
        agreementId: id,
        statement: agreement.statement,
        // An owed check's card offers the check and nothing else of the agreement (RM34 (a)).
        actions:
          card.trigger === 'agreement-check-owed' ? ['recheck'] : agreementActionsOf(agreement),
      });
    }
  }
  for (const id of unique([card.affected.relationships, card.evidence.relationshipIds], idKey)) {
    const edge = await ctx.db.get(id);
    // An edge already retired or superseded has nothing left to change (the walk's W-3).
    if (edge !== null && edge.status !== 'superseded' && edge.status !== 'retired') {
      candidates.push({
        kind: 'relationship',
        relationshipId: id,
        description: await edgeWords(ctx, edge),
        type: edge.type,
      });
    }
  }
  for (const ref of card.evidence.pageRefs) {
    const page = await pageOf(ctx, ref);
    if (page === null) continue;
    const successor = page.supersededBy !== undefined ? await pageOf(ctx, page.supersededBy) : null;
    candidates.push({
      kind: 'page',
      page: { sourceId: page.sourceId, ref: page.ref },
      title: page.title,
      status: page.status ?? 'active',
      setByManager: page.statusSource === 'manager',
      ...(successor !== null
        ? {
            supersededBy: {
              page: { sourceId: successor.sourceId, ref: successor.ref },
              title: successor.title,
            },
          }
        : {}),
    });
  }
  for (const scope of scopesOf(card)) {
    candidates.push({ kind: 'scope', scope, held: await holdsScope(ctx, card.agentId, scope) });
  }
  for (const id of unique([card.affected.skills, card.evidence.skillIds], idKey)) {
    const skill = await ctx.db.get(id);
    // Only a registered skill takes a re-check, a retirement or a withdrawal (the walk's W-2).
    if (skill?.state === 'registered') {
      candidates.push({ kind: 'skill', skillId: id, name: skill.name });
    }
  }
  return candidates;
}

/** What the card rests on and reaches, one line each, for the judgement's prompt. */
async function evidenceLines(ctx: QueryCtx, card: Doc<'reorientations'>): Promise<string[]> {
  const lines: string[] = [];
  for (const id of card.evidence.relationIds) {
    const relation = await ctx.db.get(id);
    if (relation === null) continue;
    const [from, to] = await Promise.all([pageOf(ctx, relation.from), pageOf(ctx, relation.to)]);
    lines.push(
      `Pages “${from?.title ?? relation.from.ref}” and “${to?.title ?? relation.to.ref}”: ${relation.kind.replace(/_/g, ' ')}, ${relation.status}`,
    );
  }
  for (const id of card.evidence.correctionIds) {
    const correction = await ctx.db.get(id);
    if (correction !== null)
      lines.push(`Correction on “${correction.itemTitle}”: ${correction.text}`);
  }
  lines.push(...(await countedEventLines(ctx, card)));
  if (card.trigger === 'manager-changed') {
    const charter = await approvedCharter(ctx, card.agentId);
    for (const quote of charter === undefined
      ? []
      : unboundReportingLines(charter.body as Charter)) {
      lines.push(
        `A reporting-line rule of the previous manager’s that the charter carries: “${redactTokenShapes(quote)}”`,
      );
    }
  }
  for (const id of card.affected.workItems.slice(0, 10)) {
    const row = await ctx.db.get(id);
    if (row !== null) lines.push(`Work affected: “${row.title}”, ${row.state}`);
  }
  return lines;
}

/**
 * The events a counted card rests on, up to `COUNTED_EVENTS_SHOWN` of each type, as evidence lines
 * (W16-R4, D-4 (a)): the rejections' reasons, the skips' clauses and reasons, the refusals'
 * withheld reasons, each by its item's title. Other events a card carries say nothing here.
 */
async function countedEventLines(ctx: QueryCtx, card: Doc<'reorientations'>): Promise<string[]> {
  const lines: string[] = [];
  const shown = new Map<string, number>();
  for (const id of card.evidence.eventIds) {
    const event = await ctx.db.get(id);
    if (event === null) continue;
    const counted = await countedEventOf(ctx, event);
    if (counted === undefined || (shown.get(counted.type) ?? 0) >= COUNTED_EVENTS_SHOWN) continue;
    const line = countedEventLine(counted);
    if (line === undefined) continue;
    shown.set(counted.type, (shown.get(counted.type) ?? 0) + 1);
    lines.push(line);
  }
  return lines;
}

/** A counted event with its item's title, or undefined for an event of another type. */
async function countedEventOf(
  ctx: QueryCtx,
  event: Doc<'events'>,
): Promise<CountedEvent | undefined> {
  const payload = event.payload as {
    workItemId?: Id<'workItems'>;
    reason?: unknown;
    clause?: unknown;
    withheld?: ReadonlyArray<{ reason?: unknown }>;
  };
  if (
    event.type !== 'work.cancelled' &&
    event.type !== 'work.skipped' &&
    event.type !== 'work.actions-withheld'
  ) {
    return undefined;
  }
  const item = payload.workItemId === undefined ? null : await ctx.db.get(payload.workItemId);
  const title = item?.title ?? 'an item no longer listed';
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined;
  switch (event.type) {
    case 'work.cancelled':
      return { type: event.type, title, reason: text(payload.reason) ?? PLAN_CANCELLED_REASON };
    case 'work.skipped': {
      const clause = text(payload.clause);
      const reason = text(payload.reason);
      return {
        type: event.type,
        title,
        ...(clause === undefined ? {} : { clause }),
        ...(reason === undefined ? {} : { reason }),
      };
    }
    case 'work.actions-withheld':
      return {
        type: event.type,
        title,
        reasons: (payload.withheld ?? []).flatMap((row) => text(row.reason) ?? []),
      };
  }
}

/**
 * What a proposal about one card is drawn from: the employee, what changed, what the card rests on
 * and the numbered candidates. Null when the employee is gone. Read by the judgement
 * (`proposalInput`) and by a Discuss conversation (`convex/reorientationTalk.ts`, 16-D), so both
 * choose among the same candidates in the same order.
 */
export async function proposalInputOf(
  ctx: QueryCtx,
  card: Doc<'reorientations'>,
): Promise<ProposalInput | null> {
  const agent = await ctx.db.get(card.agentId);
  if (agent === null) return null;
  const charter = await approvedCharter(ctx, card.agentId);
  return {
    employeeName: agent.name,
    roleFunction:
      charter !== undefined ? (charter.body as Charter).proposedFunction : 'not yet chartered',
    trigger: card.trigger,
    summary: card.triggerSummary,
    evidence: await evidenceLines(ctx, card),
    candidates: await candidatesOf(ctx, card, charter),
  };
}

/**
 * What the judgement reads of one card, or null when the card is decided or gone. Internal; read
 * by `reorientationActions.propose`.
 */
export const proposalInput = internalQuery({
  args: { reorientationId: v.id('reorientations') },
  handler: async (ctx, args): Promise<{ input: ProposalInput; basis: string } | null> => {
    const card = await ctx.db.get(args.reorientationId);
    if (card === null || card.proposed.kind !== 'pending') return null;
    if (!(STANDING_STATUSES as readonly string[]).includes(card.status)) return null;
    const input = await proposalInputOf(ctx, card);
    return input === null ? null : { input, basis: proposalBasis(card) };
  },
});

/**
 * What of a card a join changes, as one string: the judgement's proposal is written only onto the
 * card it read (the second pass's M6). A join while the model answers schedules its own judgement,
 * which reads the joined card; the earlier answer is then set aside, not written.
 */
export function proposalBasis(card: Doc<'reorientations'>): string {
  return JSON.stringify([card.evidence, card.affected, card.risk]);
}

/**
 * Write the judgement's proposal onto its card, which never applies it. Internal; called by
 * `reorientationActions.propose`. A card decided meanwhile, one a join changed since the judgement
 * read it (its own judgement proposes), or one whose proposal a Discuss conversation already wrote,
 * keeps what it has. Writes `reorientation.proposed`.
 */
export const writeProposal = internalMutation({
  args: {
    reorientationId: v.id('reorientations'),
    proposed: reorientationTalkProposalValidator,
    basis: v.string(),
  },
  handler: async (ctx, args): Promise<{ written: boolean }> => {
    const card = await ctx.db.get(args.reorientationId);
    if (card === null || card.proposed.kind !== 'pending') return { written: false };
    if (!(STANDING_STATUSES as readonly string[]).includes(card.status)) return { written: false };
    if (proposalBasis(card) !== args.basis) return { written: false };
    await ctx.db.patch(card._id, { proposed: args.proposed });
    await appendEvent(ctx, {
      agentId: card.agentId,
      type: 'reorientation.proposed',
      payload: {
        reorientationId: card._id,
        summary: card.triggerSummary,
        kind: args.proposed.kind,
        by: 'judgement',
      },
      createdAt: Date.now(),
    });
    return { written: true };
  },
});

/**
 * Record that the judgement could not propose (K-10): the card stays open with nothing proposed,
 * and says when and why. Internal; called by `reorientationActions.propose`. A failure about a card
 * a join changed since is not recorded: the join's own judgement answers for it.
 */
export const recordProposalFailure = internalMutation({
  args: {
    reorientationId: v.id('reorientations'),
    failure: v.string(),
    /** What the judgement read; absent when it failed before it read the card (W16-R23). */
    basis: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const card = await ctx.db.get(args.reorientationId);
    if (card === null || card.proposed.kind !== 'pending') return;
    if (args.basis !== undefined && proposalBasis(card) !== args.basis) return;
    await ctx.db.patch(card._id, {
      proposed: { kind: 'pending', failedAt: Date.now(), failure: args.failure },
    });
  },
});

/** How long a card's proposal may stay pending before the sweep says it did not finish. */
export const PROPOSAL_PENDING_MS = 10 * 60_000;

/** The newest open cards the sweep reads for a proposal that never finished. */
const PENDING_SWEEP_READ = 200;

/**
 * Mark failed every open card whose proposal has been pending past `PROPOSAL_PENDING_MS` with
 * nothing said (W16-R23): an action killed, or a failure that could not be recorded, left such a
 * card waiting for good. A judgement that answers after all still writes its proposal.
 *
 * @returns How many cards were marked.
 */
async function failStalePending(ctx: MutationCtx, now: number): Promise<number> {
  const open = await ctx.db
    .query('reorientations')
    .withIndex('by_status_revisit', (q) => q.eq('status', 'open'))
    .order('desc')
    .take(PENDING_SWEEP_READ);
  let marked = 0;
  for (const card of open) {
    if (card.proposed.kind !== 'pending' || card.proposed.failedAt !== undefined) continue;
    if (card.createdAt > now - PROPOSAL_PENDING_MS) continue;
    await ctx.db.patch(card._id, {
      proposed: { kind: 'pending', failedAt: now, failure: PROPOSAL_DID_NOT_FINISH },
    });
    marked += 1;
  }
  return marked;
}

/**
 * Open again every deferred card whose date has come (A21), up to a bound a run: the Defer sweep,
 * run every fifteen minutes through `crons.runScheduledJob`. A card that opens again with nothing
 * proposed, pending or failed, is asked for its proposal again; and an open card whose proposal
 * has been pending ten minutes with nothing said is marked as not finished (W16-R23). Internal.
 * Writes `reorientation.reopened`.
 */
export const reopenDeferred = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ reopened: number; stale?: number }> => {
    const now = Date.now();
    const stale = await failStalePending(ctx, now);
    const due = await ctx.db
      .query('reorientations')
      .withIndex('by_status_revisit', (q) => q.eq('status', 'deferred').lte('revisitAt', now))
      .take(REOPEN_READ);
    let asked = 0;
    for (const card of due) {
      await ctx.db.patch(card._id, {
        status: 'open',
        ...(card.proposed.kind === 'pending' ? { proposed: { kind: 'pending' as const } } : {}),
      });
      if (card.proposed.kind === 'pending') {
        await ctx.scheduler.runAfter(judgeAfterMs(asked), internal.reorientationActions.propose, {
          reorientationId: card._id,
        });
        asked += 1;
      }
      await appendEvent(ctx, {
        agentId: card.agentId,
        type: 'reorientation.reopened',
        payload: {
          reorientationId: card._id,
          summary: card.triggerSummary,
          revisitAt: card.revisitAt ?? now,
        },
        createdAt: now,
      });
    }
    return { reopened: due.length, ...(stale > 0 ? { stale } : {}) };
  },
});
