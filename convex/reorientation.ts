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
  REACH_BYTE_BUDGET,
  blockingWorkOf,
  cardReachValidator,
  hasOpenWork,
  openWorkCache,
  ownerAgents,
  reachOf,
  reachBytesReadIn,
  type CardAffected,
  type CardReach,
  type ReachLimits,
} from './reorientationReach';
import schema from './schema';
import { agentZone, dayKey } from '../src/lib/zone';
import type { Charter } from '../src/agent/charter';
import { redactTokenShapes } from '../src/surfaces/redact';
import { conflictSteps, heldWriteSurfaces, planLeansOn } from '../src/work/conflict-hold';
import type { ExecutionPlan } from '../src/work/types';
import {
  BOUND_MET,
  type ReorientationRisk,
  type ReorientationTrigger,
} from '../src/agent/reorientation-vocabulary';
import { log } from '../src/lib/logger';
import {
  PROPOSAL_DID_NOT_FINISH,
  approvedResultWords,
  closedByHandSummary,
  decidedByHandSummary,
  conflictNoticeText,
  conflictQuestionText,
  type NamedPageWords,
} from '../src/agent/reorientation-words';
import { isOpenQuestion } from '../src/agent/manager-questions';
import {
  CARD_LIST_LIMIT,
  STANDING_STATUSES,
  approvedCharter,
  clausesOf,
  idKey,
  proposalInputArgs,
  proposalInputInTransaction,
  recordProposalFailureArgs,
  recordProposalFailureInTransaction,
  unique,
  writeProposalArgs,
  writeProposalInTransaction,
} from './reorientationJudgementInput';

/*
 * Reorientation cards (wave 16, 16-O; the wave file's sections 1 and 5.2, A11): a card opens when
 * the organisation changes under an employee, inside the transaction of the change's own writer,
 * with the evidence, what the change reaches and, once the scheduled judgement has answered, what
 * the employee proposes. Only Approve changes anything (`convex/reorientationDecisions.ts`); a
 * low-risk card never holds work; at most one card a day per trigger kind and employee, in the
 * employee's zone (C6), a later trigger of the kind that day joining it.
 *
 * This module is the floor every trigger writer imports: it reads and writes cards and events only,
 * imports no other `convex/` module but `eventLog`, `schema`, `reorientationReach` and
 * `reorientationJudgementInput`, and sits below `convex/work.ts` (it never imports `./work`), so a
 * writer in `docStatus`, `people`, `surfaces` or `agents` gains no edge towards `work` by calling
 * it. The decisions, which call the targets' own transaction helpers, are a module above it; the
 * counted rows (three refusals, skips or rejections) a module beside it,
 * `convex/reorientationPatterns.ts`, which calls `openCard`. A writer that can reach more than one
 * employee hands its cards over once (`openCards`): the first open in its transaction, within a
 * budget of work rows read, and the rest ride one scheduled function that opens what its own budget
 * allows and schedules one more (`openCardsLater`; wave 17, 17-O, D-9 (a)), so no transaction
 * schedules more than one function for cards.
 *
 * What a card reaches and holds is read a module below, `convex/reorientationReach.ts` (wave 17,
 * 17-s): the employee's open work, what a change to skills, a scope or a connected system reaches,
 * a card's reach as its writer names it (`CardReach`, `reachOf`), the work a high-risk card holds
 * (`blockingWorkOf`) and an owner's employees (`ownerAgents`). What the judgement reads of a card
 * and writes back is another module below, `convex/reorientationJudgementInput.ts` (wave 18, 18-s),
 * with the readers this one shares with it: the charter's approved clauses, the standings a card
 * waits in and a list's bound. This module keeps the card's store, `openCard`, the hold's read, the
 * conflict's question and the judgement's registered functions, each of those three a validator and
 * one call of its body below.
 */

/** What a card rests on, every kind by id. */
export type CardEvidence = Doc<'reorientations'>['evidence'];

/**
 * The cards of one standing a read takes: an employee has few undecided cards (C6). The hold and
 * the employee's card list read the same number, so a card that holds work is always listed.
 */
export const STANDING_CARDS_READ = 50;

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
export async function standingCards(
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
 * reads; a card is opened while its reaches have read fewer than `REACH_BYTE_BUDGET` bytes of rows
 * (W17-R8) and fewer than `limits.cards` cards opened; a card whose reach would pass the room left, and every card
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
    if (opened >= limits.cards || reachBytesReadIn(ctx) >= REACH_BYTE_BUDGET) {
      rest.push(...cards.slice(at));
      break;
    }
    try {
      if (card.reach?.kind === 'citing' && !(await hasOpenWork(ctx, card.agentId))) continue;
      const unbounded = limits.firstReachUnbounded && !reachRead;
      reachRead ||= card.reach !== undefined;
      const outcome = await open(ctx, card, {
        ...(unbounded ? {} : { room: REACH_BYTE_BUDGET - reachBytesReadIn(ctx) }),
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
 * cards itself, at most `INLINE_CARDS_PER_TRANSACTION` and within its budget of bytes read
 * (`REACH_BYTE_BUDGET`), and schedules **one** function carrying the rest (`openCardsLater`), which
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

/**
 * Join a change to the card of its kind standing that day, or deferred on an earlier one: its
 * lists grow, its risk can rise. A deferred card the change makes riskier, or makes hold work it
 * did not, opens again with its date cleared (W17-R3, D-3 (a)): left deferred, it held the new
 * plans under a card the Needs you inbox does not list until its date, up to a year on.
 */
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
  const reopens =
    card.status === 'deferred' &&
    (risk !== card.risk || blockingWork.some((id) => !card.blockingWork.includes(id)));
  await ctx.db.patch(card._id, {
    evidence,
    affected,
    risk,
    blockingWork,
    ...(reopens ? { status: 'open' as const, revisitAt: undefined } : {}),
  });
  if (reopens) {
    await appendEvent(ctx, {
      agentId: card.agentId,
      type: 'reorientation.reopened',
      payload: {
        reorientationId: card._id,
        summary: card.triggerSummary,
        revisitAt: card.revisitAt ?? now,
        joined: true,
      },
      createdAt: now,
    });
  }
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
  // The cards this handover closes, which the read of the decided ones then meets again.
  const closedHere = new Set<Id<'reorientations'>>();
  for (const status of ['open', 'discussing', 'deferred', 'applied', 'dismissed'] as const) {
    const read = await ctx.db
      .query('reorientations')
      .withIndex('by_agent_status', (q) => q.eq('agentId', agentId).eq('status', status))
      .take(MOVED_CARDS_READ + 1);
    // Cards past the bound keep the previous owner's key: said in the function log (W16-R24).
    if (read.length > MOVED_CARDS_READ) {
      log.warn(BOUND_MET, { bound: 'MOVED_CARDS_READ', limit: MOVED_CARDS_READ, agentId, status });
    }
    const cards = read.slice(0, MOVED_CARDS_READ);
    // A deferred card is standing too: left as it was it would keep its hold and open again
    // under the new manager on its date (the second pass).
    const undecided = (STANDING_STATUSES as readonly string[]).includes(status);
    for (const card of cards) {
      if (closedHere.has(card._id)) continue;
      if (undecided) {
        closedHere.add(card._id);
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
      } else if (card.userId !== userId || card.trigger === 'role-changed') {
        // A decided card opened by hand loses the previous manager's typed words too (W17-R4).
        await ctx.db.patch(card._id, {
          userId,
          ...(card.trigger === 'role-changed'
            ? { triggerSummary: decidedByHandSummary(handover.previousManager) }
            : {}),
        });
      }
    }
  }
}

/** Whether a scope lets the employee write, so a change to it is high risk (5.2). */
export function isWriteScope(scope: string): boolean {
  return /:(write|admin)$/.test(scope);
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
 * conflict the plan names in its own words and cites nowhere holds every step (D-1 (c)). Read
 * where the question is asked and again wherever the dashboard draws it, from the plan as it
 * stands then (17-C).
 */
export async function heldSurfaceNames(
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
  // since the answer given was to the conflict as it stood then (W16-R27), and so is the plan
  // drafted after a redraft closed the question its predecessor was asked (17-C).
  if (asked.some((question) => question.workItemId === row._id && isOpenQuestion(question))) {
    return null;
  }
  const [agent, charter] = await Promise.all([
    ctx.db.get(row.agentId),
    approvedCharter(ctx, row.agentId),
  ]);
  if (agent === null || charter === undefined) return null;
  const holds = await heldSurfaceNames(ctx, row, conflict);
  const question = conflictQuestionText(agent.name, conflict.heading, conflict.pages, holds);
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
  await queueQuestionNotice(ctx, {
    row,
    questionId,
    text: conflictNoticeText(agent.name, conflict.heading, conflict.pages, holds),
    now: ask.now,
  });
  return questionId;
}

/** A question notice's replay key: one notice a question, and never a provider's timestamp. */
export function questionNoticeKey(questionId: Id<'managerQuestions'>): string {
  return `question:${questionId}`;
}

/**
 * Queue a conflict's question for the thread of its plan's request, when a request is already out
 * (17-C; 16-O's design): a request delivered to the manager is never edited, so a question asked
 * after it is posted under it, once. A plan with no request yet carries the question in the
 * request's own body, and one whose request failed carries it in the resend. The notice is keyed
 * by its question ({@link questionNoticeKey}), so asking again queues nothing; whether it is still
 * owed is read again when it is sent (`managerQuestions.questionNoticeOwed`). Writes the notice
 * and schedules its send.
 */
async function queueQuestionNotice(
  ctx: MutationCtx,
  asked: {
    readonly row: Doc<'workItems'>;
    readonly questionId: Id<'managerQuestions'>;
    readonly text: string;
    readonly now: number;
  },
): Promise<void> {
  const { row, questionId } = asked;
  const decision = row.decision;
  if (decision === undefined || decision.kind !== 'plan') return;
  if (decision.requestFailedAt !== undefined) return;
  const surface = await ctx.db
    .query('surfaces')
    .withIndex('by_agent_slug', (q) =>
      q.eq('agentId', row.agentId).eq('slug', decision.surfaceSlug),
    )
    .unique();
  if (surface === null || surface.managerDmChannelId !== decision.channel) return;
  const messageTs = questionNoticeKey(questionId);
  const queued = await ctx.db
    .query('managerDecisionNotices')
    .withIndex('by_surface_message', (q) =>
      q.eq('surfaceId', surface._id).eq('messageTs', messageTs),
    )
    .unique();
  if (queued !== null) return;
  const noticeId = await ctx.db.insert('managerDecisionNotices', {
    agentId: row.agentId,
    surfaceId: surface._id,
    workItemId: row._id,
    decisionId: decision.id,
    messageTs,
    kind: 'question',
    questionId,
    text: asked.text,
    createdAt: asked.now,
  });
  await ctx.scheduler.runAfter(0, internal.managerChannelActions.sendManagerReplyNotice, {
    noticeId,
  });
}

/** The questions about one relation one read takes: one a work item, few items a relation. */
const QUESTIONS_PER_RELATION_READ = 500;

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
 * What the judgement reads of one card, or null when the card is decided or gone. Internal; read
 * by `reorientationActions.propose`.
 */
export const proposalInput = internalQuery({
  args: proposalInputArgs,
  handler: async (ctx, args) => await proposalInputInTransaction(ctx, args),
});

/**
 * Write the judgement's proposal onto its card, which never applies it. Internal; called by
 * `reorientationActions.propose`. A card decided meanwhile, one a join changed since the judgement
 * read it (its own judgement proposes), or one whose proposal a Discuss conversation already wrote,
 * keeps what it has. Writes `reorientation.proposed`.
 */
export const writeProposal = internalMutation({
  args: writeProposalArgs,
  handler: async (ctx, args) => await writeProposalInTransaction(ctx, args),
});

/**
 * Record that the judgement could not propose (K-10): the card stays open with nothing proposed,
 * and says when and why. Internal; called by `reorientationActions.propose`. A failure about a card
 * a join changed since is not recorded: the join's own judgement answers for it.
 */
export const recordProposalFailure = internalMutation({
  args: recordProposalFailureArgs,
  handler: async (ctx, args) => await recordProposalFailureInTransaction(ctx, args),
});

/** How long a card's proposal may stay pending before the sweep says it did not finish. */
export const PROPOSAL_PENDING_MS = 10 * 60_000;

/** The open cards one run of the sweep reads for a proposal that never finished: one page. */
const PENDING_SWEEP_READ = 200;

/**
 * Mark failed every open card of one page whose proposal has been pending past
 * `PROPOSAL_PENDING_MS` with nothing said (W16-R23): an action killed, or a failure that could not
 * be recorded, left such a card waiting for good. A judgement that answers after all still writes
 * its proposal. The open cards are paged newest first, and a page that is not the last hands its
 * cursor to the sweep's next run, scheduled at once (W17-R6, O-3 (a)): the newest two hundred alone
 * left an old stuck card behind them unmet for good. A card already marked is passed over.
 *
 * @param cursor - Where the previous run's page ended; absent for the first page.
 * @returns How many cards were marked.
 */
async function failStalePending(
  ctx: MutationCtx,
  now: number,
  cursor: string | undefined,
): Promise<number> {
  const page = await ctx.db
    .query('reorientations')
    .withIndex('by_status_revisit', (q) => q.eq('status', 'open'))
    .order('desc')
    .paginate({ cursor: cursor ?? null, numItems: PENDING_SWEEP_READ });
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.reorientation.reopenDeferred, {
      staleCursor: page.continueCursor,
    });
  }
  let marked = 0;
  for (const card of page.page) {
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
 * has been pending ten minutes with nothing said is marked as not finished (W16-R23), page by page
 * over runs this function schedules for itself, each given the cursor the last page ended at
 * (W17-R6), which reads only the next page and opens nothing. Internal. Writes
 * `reorientation.reopened`.
 */
export const reopenDeferred = internalMutation({
  args: { staleCursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ reopened: number; stale?: number }> => {
    const now = Date.now();
    const stale = await failStalePending(ctx, now, args.staleCursor);
    if (args.staleCursor !== undefined) return { reopened: 0, ...(stale > 0 ? { stale } : {}) };
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
