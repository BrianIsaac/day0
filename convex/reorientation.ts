import { v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { appendEvent, eventsOfType } from './eventLog';
import { reorientationTalkProposalValidator } from './schema';
import { agentZone, dayKey } from '../src/lib/zone';
import type { Charter } from '../src/agent/charter';
import { RELATIONSHIP_NOUNS } from '../src/people/words';
import {
  REORIENTATION_BLOCKING_LIMIT,
  UNDECIDED_REORIENTATION_STATUSES,
  type ReorientationRisk,
  type ReorientationStatus,
  type ReorientationTrigger,
} from '../src/agent/reorientation-vocabulary';
import { conflictQuestionText, type NamedPageWords } from '../src/agent/reorientation-words';
import {
  agreementActionsOf,
  type ClauseField,
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
 * only, imports no other `convex/` module but `eventLog` and `schema`, and sits below
 * `convex/work.ts` (it never imports `./work`), so a writer in `docStatus`, `people`, `surfaces`
 * or `agents` gains no edge towards `work` by calling it. The decisions, which call the targets'
 * own transaction helpers, are a module above it.
 */

/** What a card rests on, every kind by id. */
export type CardEvidence = Doc<'reorientations'>['evidence'];

/** What a card's change reaches. */
export type CardAffected = Doc<'reorientations'>['affected'];

/**
 * The most ids one list of a card's evidence or affected set keeps: a later trigger of the day adds
 * to a card's lists, and Convex refuses an array past 8,192 values, so each list keeps its first
 * hundred (16-K's handover, "Bound every list on a card"). What a list left out is not recorded.
 */
export const CARD_LIST_LIMIT = 100;

/** The work item states a card's change can still reach: drafted, approved, running or held. */
export const OPEN_WORK_STATES = [
  'plan-pending',
  'plan-approved',
  'executing',
  'actions-pending',
] as const satisfies readonly Doc<'workItems'>['state'][];

/** The rows one state of an employee's open work is read to, for the affected set. */
const OPEN_WORK_READ = 100;

/** The cards of one standing a read takes: an employee has few undecided cards (C6). */
const UNDECIDED_CARDS_READ = 50;

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
  /** A write scope is involved, so the card is high risk whatever else it reaches. */
  readonly writeScope?: boolean;
  readonly now?: number;
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
  return {
    eventIds: unique([base.eventIds, added?.eventIds], idKey),
    pageRefs: unique([base.pageRefs, added?.pageRefs], (page) => `${page.sourceId}:${page.ref}`),
    relationIds: unique([base.relationIds, added?.relationIds], idKey),
    correctionIds: unique([base.correctionIds, added?.correctionIds], idKey),
    relationshipIds: unique([base.relationshipIds, added?.relationshipIds], idKey),
    skillIds: unique([base.skillIds, added?.skillIds], idKey),
    skillVersionIds: unique([base.skillVersionIds, added?.skillVersionIds], idKey),
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

/**
 * The work a card holds at plan approval: on a high-risk card, its affected items still open, at
 * most `REORIENTATION_BLOCKING_LIMIT`; a low- or medium-risk card holds nothing (A11).
 */
async function blockingWorkOf(
  ctx: QueryCtx,
  affected: CardAffected,
  risk: ReorientationRisk,
): Promise<Id<'workItems'>[]> {
  if (risk !== 'high') return [];
  const open: Id<'workItems'>[] = [];
  for (const id of affected.workItems) {
    if (open.length >= REORIENTATION_BLOCKING_LIMIT) break;
    const row = await ctx.db.get(id);
    if (row !== null && (OPEN_WORK_STATES as readonly string[]).includes(row.state)) open.push(id);
  }
  return open;
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
          .take(UNDECIDED_CARDS_READ),
    ),
  );
  return byStatus.flat();
}

/**
 * Whether one of the employee's cards is being approved in this transaction, so the change Approve
 * applies opens no second card about itself on the same employee. Approve closes the card
 * `applied` before its target runs and writes the card's outcome after (`reorientationDecisions`),
 * so an applied card with no outcome is seen only inside that Approve's own transaction.
 */
async function approvingNow(ctx: QueryCtx, agentId: Id<'agents'>): Promise<boolean> {
  return (
    await ctx.db
      .query('reorientations')
      .withIndex('by_agent_status', (q) => q.eq('agentId', agentId).eq('status', 'applied'))
      .order('desc')
      .take(UNDECIDED_CARDS_READ)
  ).some((card) => card.outcome === undefined);
}

/** Whether a card already carries a report: its own key, or a joined trigger's event. */
function carries(card: Doc<'reorientations'>, triggerKey: string): boolean {
  return card.triggerKey === triggerKey || card.evidence.eventIds.some((id) => id === triggerKey);
}

/**
 * Open a card for a change under an employee, or join the change to the card of its kind already
 * standing that day (C6). Called by the change's writer inside its own transaction. A change the
 * employee's standing cards already carry (by its key, or a joined event's id) writes nothing; an
 * employee that is gone, or has no owner key, gets no card. A new card opens with its proposal
 * pending and schedules the judgement (O-2); a joined card asks the judgement again only while
 * nothing is proposed. Writes `reorientation.opened`, with `joined` for a join.
 *
 * @returns The card the change is on, or null when nothing was written.
 */
export async function openCard(
  ctx: MutationCtx,
  input: CardTrigger,
): Promise<Id<'reorientations'> | null> {
  const agent = await ctx.db.get(input.agentId);
  if (agent === null || agent.userId === undefined) return null;
  if (await approvingNow(ctx, agent._id)) return null;
  const standing = await standingCards(ctx, agent._id);
  if (standing.some((card) => carries(card, input.triggerKey))) return null;
  const now = input.now ?? Date.now();
  const day = dayKey(now, agentZone(agent));
  const today = await ctx.db
    .query('reorientations')
    .withIndex('by_agent_day_trigger', (q) =>
      q.eq('agentId', agent._id).eq('day', day).eq('trigger', input.trigger),
    )
    .take(DAY_CARDS_READ);
  const joinable = today.find((card) =>
    (STANDING_STATUSES as readonly string[]).includes(card.status),
  );
  if (joinable !== undefined) return await joinCard(ctx, joinable, input);
  const evidence = joinedEvidence(NO_EVIDENCE, input.evidence);
  const affected = joinedAffected(NOTHING_AFFECTED, input.affected);
  const risk = riskOf(affected, input.writeScope === true);
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
    blockingWork: await blockingWorkOf(ctx, affected, risk),
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
  await ctx.scheduler.runAfter(0, internal.reorientationActions.propose, { reorientationId });
  return reorientationId;
}

/** Join a change to the card of its kind standing that day: its lists grow, its risk can rise. */
async function joinCard(
  ctx: MutationCtx,
  card: Doc<'reorientations'>,
  input: CardTrigger,
): Promise<Id<'reorientations'>> {
  const now = input.now ?? Date.now();
  const evidence = joinedEvidence(card.evidence, input.evidence);
  const affected = joinedAffected(card.affected, input.affected);
  const risk = higher(card.risk, riskOf(affected, input.writeScope === true));
  await ctx.db.patch(card._id, {
    evidence,
    affected,
    risk,
    blockingWork: await blockingWorkOf(ctx, affected, risk),
  });
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
  if (card.proposed.kind === 'pending') {
    await ctx.scheduler.runAfter(0, internal.reorientationActions.propose, {
      reorientationId: card._id,
    });
  }
  return card._id;
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
 * Move an employee's cards to its new owner, in the handover's transaction (16-K's F2, option
 * (a)): `userId` is a copy of the employee's owner key, so the owner's cards across employees
 * (`by_user_status`) list the moved employee's under the owner who has it.
 */
export async function moveCardsToOwner(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  userId: string,
): Promise<void> {
  for (const status of ['open', 'discussing', 'deferred', 'applied', 'dismissed'] as const) {
    const cards = await ctx.db
      .query('reorientations')
      .withIndex('by_agent_status', (q) => q.eq('agentId', agentId).eq('status', status))
      .take(MOVED_CARDS_READ);
    for (const card of cards) {
      if (card.userId !== userId) await ctx.db.patch(card._id, { userId });
    }
  }
}

/** An employee's open work, each open state read to its bound. */
export async function openWorkOf(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'workItems'>[]> {
  const byState = await Promise.all(
    OPEN_WORK_STATES.map(
      async (state) =>
        await ctx.db
          .query('workItems')
          .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
          .take(OPEN_WORK_READ),
    ),
  );
  return byState.flat();
}

/** A stored plan's cites, as far as a card reads them: the page each cite is of. */
function citedPagesOf(plan: unknown): Array<{ sourceId?: string; pageRef?: string }> {
  if (typeof plan !== 'object' || plan === null || !('cites' in plan)) return [];
  return Array.isArray(plan.cites)
    ? (plan.cites as Array<{ sourceId?: string; pageRef?: string }>)
    : [];
}

/** An employee's open work whose plan cites any of the pages. */
export async function openWorkCiting(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  pages: ReadonlyArray<{ readonly sourceId: Id<'docSources'>; readonly ref: string }>,
): Promise<Id<'workItems'>[]> {
  if (pages.length === 0) return [];
  const keys = new Set(pages.map((page) => `${page.sourceId}:${page.ref}`));
  return (await openWorkOf(ctx, agentId))
    .filter((row) =>
      citedPagesOf(row.plan).some((cite) => keys.has(`${cite.sourceId}:${cite.pageRef}`)),
    )
    .map((row) => row._id);
}

/** An employee's open work that runs one of the skills. */
export async function openWorkUsingSkills(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  skillIds: readonly Id<'skills'>[],
): Promise<Id<'workItems'>[]> {
  const rows = await Promise.all(
    skillIds.map(
      async (skillId) =>
        await ctx.db
          .query('workItems')
          .withIndex('by_skill', (q) => q.eq('skillId', skillId))
          .take(OPEN_WORK_READ),
    ),
  );
  return rows
    .flat()
    .filter(
      (row) =>
        row.agentId === agentId && (OPEN_WORK_STATES as readonly string[]).includes(row.state),
    )
    .map((row) => row._id);
}

/** The registered skills one read of an employee's library takes, for the affected set. */
const SKILLS_READ = 100;

/** Whether a scope lets the employee write, so a change to it is high risk (5.2). */
export function isWriteScope(scope: string): boolean {
  return /:(write|admin)$/.test(scope);
}

/** What a change to some of an employee's skills reaches: the skills and the open work running them. */
export async function skillReach(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  skillIds: readonly Id<'skills'>[],
): Promise<Partial<CardAffected>> {
  return { skills: [...skillIds], workItems: await openWorkUsingSkills(ctx, agentId, skillIds) };
}

/** An employee's registered skills. */
async function registeredSkills(ctx: QueryCtx, agentId: Id<'agents'>): Promise<Doc<'skills'>[]> {
  return await ctx.db
    .query('skills')
    .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', 'registered'))
    .take(SKILLS_READ);
}

/**
 * What a revoked scope reaches: the employee's systems it was for, the registered skills that need
 * it and the open work running them.
 */
export async function scopeReach(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  scope: string,
): Promise<Partial<CardAffected>> {
  const system = scope.split(':')[0];
  const [skills, surfaces] = await Promise.all([
    registeredSkills(ctx, agentId),
    ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .take(SKILLS_READ),
  ]);
  const needing = skills
    .filter((skill) => (skill.requiredScopes ?? []).includes(scope))
    .map((skill) => skill._id);
  return {
    ...(await skillReach(ctx, agentId, needing)),
    surfaces: surfaces.filter((surface) => surface.slug === system).map((surface) => surface._id),
  };
}

/** What an ended access reaches: the system, the registered skills that write it and their open work. */
export async function surfaceReach(
  ctx: QueryCtx,
  surface: Pick<Doc<'surfaces'>, '_id' | 'agentId' | 'slug'>,
): Promise<Partial<CardAffected>> {
  const writing = (await registeredSkills(ctx, surface.agentId))
    .filter((skill) => skill.targetSurface === surface.slug)
    .map((skill) => skill._id);
  return { ...(await skillReach(ctx, surface.agentId, writing)), surfaces: [surface._id] };
}

/** The employees of an owner a fan-out reads, at most. */
const OWNER_AGENTS_READ = 200;

/** The agreements one read of an owner's or an employee's active ones takes. */
const AGREEMENTS_READ = 200;

/** Every employee of an owner, to the fan-out's bound. */
export async function ownerAgents(ctx: QueryCtx, userId: string): Promise<Doc<'agents'>[]> {
  return await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .take(OWNER_AGENTS_READ);
}

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
 * employees' systems run on (section 3's revocation rows).
 */
export async function openCardsOnSurfaces(
  ctx: MutationCtx,
  surfaceIds: readonly Id<'surfaces'>[],
  change: Pick<CardTrigger, 'trigger' | 'triggerKey' | 'summary' | 'now'>,
): Promise<void> {
  const byAgent = new Map<Id<'agents'>, Doc<'surfaces'>[]>();
  for (const id of surfaceIds) {
    const surface = await ctx.db.get(id);
    if (surface !== null)
      byAgent.set(surface.agentId, [...(byAgent.get(surface.agentId) ?? []), surface]);
  }
  for (const [agentId, surfaces] of byAgent) {
    const reached = await Promise.all(
      surfaces.map(async (surface) => await surfaceReach(ctx, surface)),
    );
    await openCard(ctx, {
      ...change,
      agentId,
      affected: {
        surfaces: reached.flatMap((reach) => reach.surfaces ?? []),
        skills: reached.flatMap((reach) => reach.skills ?? []),
        workItems: reached.flatMap((reach) => reach.workItems ?? []),
      },
    });
  }
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
  if (asked.some((question) => question.workItemId === row._id)) return null;
  const [agent, charter] = await Promise.all([
    ctx.db.get(row.agentId),
    approvedCharter(ctx, row.agentId),
  ]);
  if (agent === null || charter === undefined) return null;
  const question = conflictQuestionText(agent.name, conflict.heading, conflict.pages);
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
async function approvedCharter(
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

/** The scopes a card is about: a revoked scope's event, or a repeated refusal's counted scope. */
async function scopesOf(ctx: QueryCtx, card: Doc<'reorientations'>): Promise<string[]> {
  const scopes = new Set<string>();
  if (card.trigger === 'repeated-refusal' && card.triggerKey.startsWith(REFUSAL_KEY_PREFIX)) {
    scopes.add(card.triggerKey.slice(REFUSAL_KEY_PREFIX.length));
  }
  for (const id of card.evidence.eventIds) {
    const event = await ctx.db.get(id);
    if (event?.type === 'permission.revoked') {
      const scope = (event.payload as { scope?: unknown }).scope;
      if (typeof scope === 'string') scopes.add(scope);
    }
  }
  return [...scopes];
}

/** How a repeated refusal's key opens: the scope follows it. */
export const REFUSAL_KEY_PREFIX = 'refusal:';

/** How many times a pattern repeats before it opens a card (section 3: three). */
export const REPEAT_THRESHOLD = 3;

const DAY_MS = 86_400_000;

/** The window a repeated refusal is counted in: seven days. */
export const REFUSAL_WINDOW_MS = 7 * DAY_MS;

/** The window a repeated skip or rejection is counted in: thirty days. */
export const REPEAT_WINDOW_MS = 30 * DAY_MS;

/** The events of one kind a count reads back, newest first. */
const COUNTED_EVENTS_READ = 200;

/** The scope a gate's refusal names (`no grant (<scope>)`), wherever it sits in a held row's reason. */
export function refusedScopeOf(reason: string | undefined): string | undefined {
  return reason === undefined ? undefined : /no grant \(([^)]+)\)/.exec(reason)?.[1];
}

/**
 * When the manager last decided a card about a counted pattern, or 0: a card of the trigger whose
 * key is the pattern's, or one the pattern joined (its evidence holds any of the pattern's events).
 * A count starts after it, so a dismissed pattern opens a card again only once it repeats again.
 */
async function lastDecidedAt(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  pattern: {
    readonly trigger: ReorientationTrigger;
    readonly triggerKey: string;
    readonly eventIds: ReadonlySet<string>;
  },
): Promise<number> {
  const decided = await Promise.all(
    (['applied', 'dismissed'] as const).map(
      async (status) =>
        await ctx.db
          .query('reorientations')
          .withIndex('by_agent_status', (q) => q.eq('agentId', agentId).eq('status', status))
          .order('desc')
          .take(UNDECIDED_CARDS_READ),
    ),
  );
  return Math.max(
    0,
    ...decided
      .flat()
      .filter(
        (card) =>
          card.trigger === pattern.trigger &&
          (card.triggerKey === pattern.triggerKey ||
            card.evidence.eventIds.some((id) => pattern.eventIds.has(id))),
      )
      .map((card) => card.decidedAt ?? card.createdAt),
  );
}

/** One counted occurrence of a pattern: the event it was written in, and when. */
interface Occurrence {
  readonly id: Id<'events'>;
  readonly at: number;
}

/**
 * The occurrences of a pattern since the manager last decided a card about it, each event once,
 * when there are exactly enough to open a card: a card opens, or a trigger joins the day's card,
 * at the crossing only, so a pattern that goes on repeating writes nothing more until it is decided.
 */
async function crossing(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  pattern: { readonly trigger: ReorientationTrigger; readonly triggerKey: string },
  occurrences: readonly Occurrence[],
): Promise<Occurrence[] | undefined> {
  const distinct = [
    ...new Map(occurrences.map((occurrence) => [occurrence.id, occurrence])).values(),
  ];
  const since = await lastDecidedAt(ctx, agentId, {
    ...pattern,
    eventIds: new Set(distinct.map((occurrence) => occurrence.id)),
  });
  const counted = distinct.filter((occurrence) => occurrence.at > since);
  return counted.length === REPEAT_THRESHOLD ? counted : undefined;
}

/**
 * Open a card for every scope Day0's gate refused the employee in three runs in seven days (section
 * 3's refusal row), counted over the held rows of its settled runs, a run once, since the last card
 * about the scope was decided. Called where a run's ledger is settled (`workRuns.setCompleted`).
 */
export async function openRepeatedRefusalCards(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<void> {
  const events = await eventsOfType(ctx, agentId, 'work.actions-withheld', {
    after: now - REFUSAL_WINDOW_MS,
  })
    .order('desc')
    .take(COUNTED_EVENTS_READ);
  const byScope = new Map<string, Occurrence[]>();
  for (const event of events) {
    const rows =
      (event.payload as { withheld?: ReadonlyArray<{ reason?: string }> }).withheld ?? [];
    for (const scope of new Set(rows.flatMap((row) => refusedScopeOf(row.reason) ?? []))) {
      byScope.set(scope, [
        ...(byScope.get(scope) ?? []),
        { id: event._id, at: event._creationTime },
      ]);
    }
  }
  for (const [scope, refusals] of byScope) {
    const triggerKey = `${REFUSAL_KEY_PREFIX}${scope}`;
    const counted = await crossing(
      ctx,
      agentId,
      { trigger: 'repeated-refusal', triggerKey },
      refusals,
    );
    if (counted === undefined) continue;
    await openCard(ctx, {
      agentId,
      trigger: 'repeated-refusal',
      triggerKey,
      summary: `Day0's gate refused its “${scope}” work in ${counted.length} runs in seven days`,
      evidence: { eventIds: counted.map((refusal) => refusal.id) },
      affected: await scopeReach(ctx, agentId, scope),
      writeScope: isWriteScope(scope),
      now,
    });
  }
}

/**
 * Open a card when three items in thirty days were skipped as outside the role on one willNotDo
 * clause (section 3's skip row): the clause, to amend or confirm. Called where the skip is written
 * (`workVerdicts.applyVerdict`).
 */
export async function openRepeatedSkipCard(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  clause: string,
  now: number,
): Promise<void> {
  const triggerKey = `skip:${clause}`;
  const skips = (
    await eventsOfType(ctx, agentId, 'work.skipped', { after: now - REPEAT_WINDOW_MS })
      .order('desc')
      .take(COUNTED_EVENTS_READ)
  ).filter((event) => (event.payload as { clause?: unknown }).clause === clause);
  const counted = await crossing(
    ctx,
    agentId,
    { trigger: 'repeated-skip', triggerKey },
    skips.map((event) => ({ id: event._id, at: event._creationTime })),
  );
  if (counted === undefined) return;
  await openCard(ctx, {
    agentId,
    trigger: 'repeated-skip',
    triggerKey,
    summary: `${counted.length} items in thirty days were skipped as outside its role under “${clause}”`,
    evidence: { eventIds: counted.map((skip) => skip.id) },
    affected: {
      charterClauses: await charterClausesWhere(
        ctx,
        agentId,
        (candidate) => candidate.field === 'willNotDo' && candidate.text === clause,
      ),
    },
    now,
  });
}

/** How a plan rejection's key reads: one standing card about the employee's rejected plans. */
const REJECTIONS_KEY = 'rejections';

/**
 * Open a card when the manager rejected three of the employee's plans in thirty days (section 3's
 * rejection row): the charter's clauses, to amend or confirm. Called where a plan is cancelled
 * (`managerDecisions.cancelPlanInTransaction`).
 */
export async function openRepeatedRejectionCard(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<void> {
  const rejections = (
    await eventsOfType(ctx, agentId, 'work.cancelled', { after: now - REPEAT_WINDOW_MS })
      .order('desc')
      .take(COUNTED_EVENTS_READ)
  ).filter((event) => (event.payload as { decidedVia?: unknown }).decidedVia !== undefined);
  const counted = await crossing(
    ctx,
    agentId,
    { trigger: 'repeated-rejection', triggerKey: REJECTIONS_KEY },
    rejections.map((event) => ({ id: event._id, at: event._creationTime })),
  );
  if (counted === undefined) return;
  await openCard(ctx, {
    agentId,
    trigger: 'repeated-rejection',
    triggerKey: REJECTIONS_KEY,
    summary: `You rejected ${counted.length} of its plans in thirty days`,
    evidence: { eventIds: counted.map((rejection) => rejection.id) },
    affected: {
      charterClauses: await charterClausesWhere(
        ctx,
        agentId,
        (clause) => clause.field === 'willDo' || clause.field === 'willNotDo',
      ),
    },
    now,
  });
}

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
        actions: agreementActionsOf(agreement),
      });
    }
  }
  for (const id of unique([card.affected.relationships, card.evidence.relationshipIds], idKey)) {
    const edge = await ctx.db.get(id);
    if (edge !== null && edge.status !== 'superseded') {
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
  for (const scope of await scopesOf(ctx, card)) {
    candidates.push({ kind: 'scope', scope, held: await holdsScope(ctx, card.agentId, scope) });
  }
  for (const id of unique([card.affected.skills, card.evidence.skillIds], idKey)) {
    const skill = await ctx.db.get(id);
    if (skill !== null) candidates.push({ kind: 'skill', skillId: id, name: skill.name });
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
  for (const id of card.affected.workItems.slice(0, 10)) {
    const row = await ctx.db.get(id);
    if (row !== null) lines.push(`Work affected: “${row.title}”, ${row.state}`);
  }
  return lines;
}

/**
 * What the judgement reads of one card, or null when the card is decided or gone. Internal; read
 * by `reorientationActions.propose`.
 */
export const proposalInput = internalQuery({
  args: { reorientationId: v.id('reorientations') },
  handler: async (ctx, args): Promise<ProposalInput | null> => {
    const card = await ctx.db.get(args.reorientationId);
    if (card === null || card.proposed.kind !== 'pending') return null;
    if (!(STANDING_STATUSES as readonly string[]).includes(card.status)) return null;
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
  },
});

/**
 * Write the judgement's proposal onto its card, which never applies it. Internal; called by
 * `reorientationActions.propose`. A card decided meanwhile, or one whose proposal a Discuss
 * conversation already wrote, keeps what it has. Writes `reorientation.proposed`.
 */
export const writeProposal = internalMutation({
  args: { reorientationId: v.id('reorientations'), proposed: reorientationTalkProposalValidator },
  handler: async (ctx, args): Promise<{ written: boolean }> => {
    const card = await ctx.db.get(args.reorientationId);
    if (card === null || card.proposed.kind !== 'pending') return { written: false };
    if (!(STANDING_STATUSES as readonly string[]).includes(card.status)) return { written: false };
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
 * and says when and why. Internal; called by `reorientationActions.propose`.
 */
export const recordProposalFailure = internalMutation({
  args: { reorientationId: v.id('reorientations'), failure: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const card = await ctx.db.get(args.reorientationId);
    if (card === null || card.proposed.kind !== 'pending') return;
    await ctx.db.patch(card._id, {
      proposed: { kind: 'pending', failedAt: Date.now(), failure: args.failure },
    });
  },
});

/**
 * Open again every deferred card whose date has come (A21), up to a bound a run: the Defer sweep,
 * run hourly through `crons.runScheduledJob`. Internal. Writes `reorientation.reopened`.
 */
export const reopenDeferred = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ reopened: number }> => {
    const now = Date.now();
    const due = await ctx.db
      .query('reorientations')
      .withIndex('by_status_revisit', (q) => q.eq('status', 'deferred').lte('revisitAt', now))
      .take(REOPEN_READ);
    for (const card of due) {
      await ctx.db.patch(card._id, { status: 'open' });
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
    return { reopened: due.length };
  },
});
