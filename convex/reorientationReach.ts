import { getDocumentSize, v, type Infer } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  BOUND_MET,
  REORIENTATION_BLOCKING_LIMIT,
  type ReorientationRisk,
} from '../src/agent/reorientation-vocabulary';
import { log } from '../src/lib/logger';

/*
 * What a reorientation card reaches and holds (wave 17, 17-s; the wave 16 review's D-6 (a)): the
 * reads behind a card's affected set and its hold, moved out of `convex/reorientation.ts` as they
 * stood. An employee's open work, whole or by the pages its plans cite or the skills it runs; what
 * a change to skills, to a scope or to a connected system reaches; a reach as its card's writer
 * names it (`CardReach`, `reachOf`); the work a high-risk card holds (`blockingWorkOf`); an
 * owner's employees, for a change that reaches every one of them (`ownerAgents`); and the active
 * working agreements a change to a person or a correction on an item reaches (`personAgreements`,
 * `agreementsApplying`; moved here from the card's store in wave 18, 18-s).
 *
 * A transaction that opens many cards reads these rows within a budget (wave 17, 17-O; W16-R6):
 * each read counts the bytes of the rows it took against its transaction (`reachBytesReadIn`,
 * `REACH_BYTE_BUDGET`; W17-R8, as an employee's work list counts them), the skills and the held
 * work among them, a reach given less room than it needs says so (`Reached`), and an employee
 * with no open work at all is found for four index reads (`hasOpenWork`).
 *
 * This module is the floor under the cards: it reads rows and writes none, registers no function,
 * and imports no other `convex/` module, so it sits below `convex/reorientation.ts`, which calls
 * it where a card opens, and below `convex/work.ts`. A trigger's writer (`agents`, `corrections`,
 * `people`, `skills`, `surfaces`, `reorientationPatterns`) imports its reach from here and
 * `openCard` from the card's store.
 */

/** What a card's change reaches. */
export type CardAffected = Doc<'reorientations'>['affected'];

/**
 * What of one employee's work and connections a change reaches, read where its card opens rather
 * than by the writer (the second pass's M5): every open item, the open items whose plans cite a
 * page (none cited, no card), what a set of skills reaches, or what a set of connected systems
 * reaches.
 */
export const cardReachValidator = v.union(
  v.object({ kind: v.literal('open-work') }),
  v.object({
    kind: v.literal('citing'),
    pageRefs: v.array(v.object({ sourceId: v.id('docSources'), ref: v.string() })),
  }),
  v.object({ kind: v.literal('skills'), skillIds: v.array(v.id('skills')) }),
  v.object({ kind: v.literal('surfaces'), surfaceIds: v.array(v.id('surfaces')) }),
);

/** {@link cardReachValidator}'s type. */
export type CardReach = Infer<typeof cardReachValidator>;

/** The work item states a card's change can still reach: drafted, approved, running or held. */
export const OPEN_WORK_STATES = [
  'plan-pending',
  'plan-approved',
  'executing',
  'actions-pending',
] as const satisfies readonly Doc<'workItems'>['state'][];

/** The rows one state of an employee's open work is read to, for the affected set. */
const OPEN_WORK_READ = 100;

/**
 * The bytes of rows one transaction's cards read between them before the rest of a fan-out waits
 * for a transaction of its own (W16-R6, W17-R8): a `workItems` row is read whole, its plan, verdict
 * and output with it, and a skill with its body, so what bounds a transaction that opens many cards
 * is the bytes its reaches read (Convex's 16 MiB), not how many rows or cards. Half of it, as an
 * employee's work list holds (`WORK_LIST_BYTES`), which leaves the cards their own writes.
 */
export const REACH_BYTE_BUDGET = 8 * 1024 * 1024;

/** The most bytes one document holds (Convex's limit): what a row not yet read may weigh. */
const ROW_BYTES_AT_MOST = 1024 * 1024;

/** The bytes each transaction's reaches have read so far, by its database handle. */
const reachBytesRead = new WeakMap<object, number>();

/** The bytes of rows this transaction's reaches have read so far. */
export function reachBytesReadIn(ctx: QueryCtx): number {
  return reachBytesRead.get(ctx.db) ?? 0;
}

/** Count the rows a reach read against its transaction, by their bytes as Convex counts them. */
function countRead(ctx: QueryCtx, rows: ReadonlyArray<Doc<'workItems'> | Doc<'skills'>>): number {
  const bytes = rows.reduce((sum, row) => sum + getDocumentSize(row), 0);
  reachBytesRead.set(ctx.db, reachBytesReadIn(ctx) + bytes);
  return bytes;
}

/**
 * Rows of one index range, oldest first, a few at a time and never more at once than the room left
 * holds at a row's largest, so the room holds whatever a row weighs (W17-R8, as `listReader` reads
 * an employee's work list).
 *
 * @param next - One read: the rows after a creation time, at most a count.
 * @param limit - The most rows to take.
 * @param room - The bytes the rows may hold.
 * @returns The rows, and the bytes they hold; past the room once they hold more than it.
 */
async function takeWithin(
  ctx: QueryCtx,
  next: (after: number | undefined, count: number) => Promise<Doc<'workItems'>[]>,
  limit: number,
  room: number,
): Promise<{ rows: Doc<'workItems'>[]; bytes: number }> {
  const rows: Doc<'workItems'>[] = [];
  let bytes = 0;
  while (rows.length < limit) {
    const count = Math.min(
      limit - rows.length,
      Math.max(1, Math.floor((room - bytes) / ROW_BYTES_AT_MOST)),
    );
    const read = await next(rows.at(-1)?._creationTime, count);
    bytes += countRead(ctx, read);
    rows.push(...read);
    if (bytes > room || read.length < count) break;
  }
  return { rows, bytes };
}

/** Whether each employee has any open work, as this transaction first found it. */
const openWorkProbed = new WeakMap<object, Map<Id<'agents'>, boolean>>();

/**
 * Whether an employee has any open work at all: one index read a state, stopping at the first
 * state that holds a row, so an employee with none costs four index reads and no row, and one with
 * some costs one row. Asked once an employee a transaction, however many cards ask.
 */
export async function hasOpenWork(ctx: QueryCtx, agentId: Id<'agents'>): Promise<boolean> {
  const probed = openWorkProbed.get(ctx.db) ?? new Map<Id<'agents'>, boolean>();
  openWorkProbed.set(ctx.db, probed);
  const known = probed.get(agentId);
  if (known !== undefined) return known;
  let found = false;
  for (const state of OPEN_WORK_STATES) {
    const row = await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
      .first();
    if (row === null) continue;
    countRead(ctx, [row]);
    found = true;
    break;
  }
  probed.set(agentId, found);
  return found;
}

/**
 * The open work one list of cards has read, an employee's rows once: a status walk reports a
 * change of every page it flips to every reader, and each of an employee's reports asks which of
 * the same open plans cite its page. Made by `openWorkCache` for one hand-over of cards, in which
 * nothing changes a work item's state, and never kept across one.
 */
export type OpenWorkCache = Map<Id<'agents'>, Doc<'workItems'>[]>;

/** An empty {@link OpenWorkCache}. */
export function openWorkCache(): OpenWorkCache {
  return new Map<Id<'agents'>, Doc<'workItems'>[]>();
}

/** How far a reach may read. */
export interface ReachLimits {
  /** The most bytes of rows the read may take; left out, each read goes to its own bound. */
  readonly room?: number;
  /** The open work already read for this list of cards, which the read adds to. */
  readonly openWork?: OpenWorkCache;
}

/**
 * An employee's open work, each open state read to its bound.
 *
 * @returns The rows, or null when the employee's open work holds more bytes than the room given.
 */
export async function openWorkOf(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  within: ReachLimits = {},
): Promise<Doc<'workItems'>[] | null> {
  const known = within.openWork?.get(agentId);
  if (known !== undefined) return known;
  const room = within.room ?? Number.POSITIVE_INFINITY;
  const rows: Doc<'workItems'>[] = [];
  let bytes = 0;
  for (const state of OPEN_WORK_STATES) {
    const read = await takeWithin(
      ctx,
      async (after, count) =>
        await ctx.db
          .query('workItems')
          .withIndex('by_agent_state', (q) => {
            const ofState = q.eq('agentId', agentId).eq('state', state);
            return after === undefined ? ofState : ofState.gt('_creationTime', after);
          })
          .take(count),
      OPEN_WORK_READ,
      room - bytes,
    );
    rows.push(...read.rows);
    bytes += read.bytes;
    if (bytes > room) return null;
  }
  within.openWork?.set(agentId, rows);
  return rows;
}

/** A stored plan's cites, as far as a card reads them: the page each cite is of. */
function citedPagesOf(plan: unknown): Array<{ sourceId?: string; pageRef?: string }> {
  if (typeof plan !== 'object' || plan === null || !('cites' in plan)) return [];
  return Array.isArray(plan.cites)
    ? (plan.cites as Array<{ sourceId?: string; pageRef?: string }>)
    : [];
}

/**
 * An employee's open work whose plan cites any of the pages.
 *
 * @returns The cited rows' ids, or null when the employee's open work is more than the room given.
 */
export async function openWorkCiting(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  pages: ReadonlyArray<{ readonly sourceId: Id<'docSources'>; readonly ref: string }>,
  within: ReachLimits = {},
): Promise<Id<'workItems'>[] | null> {
  if (pages.length === 0) return [];
  const keys = new Set(pages.map((page) => `${page.sourceId}:${page.ref}`));
  const open = await openWorkOf(ctx, agentId, within);
  if (open === null) return null;
  return open
    .filter((row) =>
      citedPagesOf(row.plan).some((cite) => keys.has(`${cite.sourceId}:${cite.pageRef}`)),
    )
    .map((row) => row._id);
}

/**
 * An employee's open work that runs one of the skills: each skill's rows in each open state
 * (`by_skill_state`, K-1 (a)), so a skill's finished rows, however many, never stand before its
 * open ones (W17-R8: the read took a skill's oldest hundred rows whatever their state).
 *
 * @param room - The most bytes of rows the read may take.
 * @returns The rows' ids, or null when the skills' work holds more bytes than `room`.
 */
export async function openWorkUsingSkills(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  skillIds: readonly Id<'skills'>[],
  room = Number.POSITIVE_INFINITY,
): Promise<Id<'workItems'>[] | null> {
  const rows: Doc<'workItems'>[] = [];
  let bytes = 0;
  for (const skillId of skillIds) {
    for (const state of OPEN_WORK_STATES) {
      const read = await takeWithin(
        ctx,
        async (after, count) =>
          await ctx.db
            .query('workItems')
            .withIndex('by_skill_state', (q) => {
              const ofState = q.eq('skillId', skillId).eq('state', state);
              return after === undefined ? ofState : ofState.gt('_creationTime', after);
            })
            .take(count),
        OPEN_WORK_READ,
        room - bytes,
      );
      rows.push(...read.rows);
      bytes += read.bytes;
      if (bytes > room) return null;
    }
  }
  return rows.filter((row) => row.agentId === agentId).map((row) => row._id);
}

/** The registered skills one read of an employee's library takes, for the affected set. */
const SKILLS_READ = 100;

/** What a change to some of an employee's skills reaches: the skills and the open work running them. */
export async function skillReach(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  skillIds: readonly Id<'skills'>[],
): Promise<Partial<CardAffected>> {
  return {
    skills: [...skillIds],
    workItems: (await openWorkUsingSkills(ctx, agentId, skillIds)) ?? [],
  };
}

/** An employee's registered skills, their bytes counted against the transaction's reaches. */
async function registeredSkills(ctx: QueryCtx, agentId: Id<'agents'>): Promise<Doc<'skills'>[]> {
  const skills = await ctx.db
    .query('skills')
    .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', 'registered'))
    .take(SKILLS_READ);
  countRead(ctx, skills);
  return skills;
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

/** The employee's registered skills that write one of its systems. */
async function skillsWriting(
  ctx: QueryCtx,
  surface: Pick<Doc<'surfaces'>, 'agentId' | 'slug'>,
): Promise<Id<'skills'>[]> {
  return (await registeredSkills(ctx, surface.agentId))
    .filter((skill) => skill.targetSurface === surface.slug)
    .map((skill) => skill._id);
}

/** What an ended access reaches: the system, the registered skills that write it and their open work. */
export async function surfaceReach(
  ctx: QueryCtx,
  surface: Pick<Doc<'surfaces'>, '_id' | 'agentId' | 'slug'>,
): Promise<Partial<CardAffected>> {
  const writing = await skillsWriting(ctx, surface);
  return { ...(await skillReach(ctx, surface.agentId, writing)), surfaces: [surface._id] };
}

/**
 * What a change's reach comes to for one employee: what it reaches, nothing to open a card on, or
 * more work rows than the transaction has room left to read.
 */
export type Reached =
  | { readonly kind: 'reached'; readonly affected: Partial<CardAffected> }
  | { readonly kind: 'nothing' }
  | { readonly kind: 'over-budget' };

const OVER_BUDGET: Reached = { kind: 'over-budget' };

/** A reach that came to work rows, or the budget's refusal when the read was cut short. */
function reachedWork(
  workItems: readonly Id<'workItems'>[] | null,
  rest: Partial<CardAffected> = {},
): Reached {
  return workItems === null
    ? OVER_BUDGET
    : { kind: 'reached', affected: { ...rest, workItems: [...workItems] } };
}

/**
 * What a change's reach comes to for one employee (W16-R6). A reach over the employee's open work
 * first asks whether there is any (`hasOpenWork`): with none, a `citing` reach is nothing to open
 * on and an `open-work` reach is empty, and no row is read. Rows are read up to the room given,
 * and a reach that needs more is answered `over-budget` for its card to wait for another
 * transaction.
 */
export async function reachOf(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  reach: CardReach,
  within: ReachLimits = {},
): Promise<Reached> {
  switch (reach.kind) {
    case 'open-work': {
      if (!(await hasOpenWork(ctx, agentId))) return reachedWork([]);
      const open = await openWorkOf(ctx, agentId, within);
      return reachedWork(open === null ? null : open.map((row) => row._id));
    }
    case 'citing': {
      if (!(await hasOpenWork(ctx, agentId))) return { kind: 'nothing' };
      const cited = await openWorkCiting(ctx, agentId, reach.pageRefs, within);
      return cited !== null && cited.length === 0 ? { kind: 'nothing' } : reachedWork(cited);
    }
    case 'skills':
      return reachedWork(await openWorkUsingSkills(ctx, agentId, reach.skillIds, within.room), {
        skills: [...reach.skillIds],
      });
    case 'surfaces': {
      const surfaces: Id<'surfaces'>[] = [];
      const skills: Id<'skills'>[] = [];
      for (const id of reach.surfaceIds) {
        const surface = await ctx.db.get(id);
        if (surface === null) continue;
        surfaces.push(surface._id);
        skills.push(...(await skillsWriting(ctx, surface)));
      }
      return reachedWork(await openWorkUsingSkills(ctx, agentId, skills, within.room), {
        surfaces,
        skills,
      });
    }
  }
}

/**
 * The work a card holds at plan approval: on a high-risk card, its affected items still open, at
 * most `REORIENTATION_BLOCKING_LIMIT`; a low- or medium-risk card holds nothing (A11).
 */
export async function blockingWorkOf(
  ctx: QueryCtx,
  affected: CardAffected,
  risk: ReorientationRisk,
): Promise<Id<'workItems'>[]> {
  if (risk !== 'high') return [];
  const open: Id<'workItems'>[] = [];
  for (const id of affected.workItems) {
    if (open.length >= REORIENTATION_BLOCKING_LIMIT) break;
    const row = await ctx.db.get(id);
    if (row === null) continue;
    countRead(ctx, [row]);
    if ((OPEN_WORK_STATES as readonly string[]).includes(row.state)) open.push(id);
  }
  return open;
}

/** The employees of an owner a fan-out reads, at most. */
const OWNER_AGENTS_READ = 200;

/**
 * Every employee of an owner, to the fan-out's bound. An owner with more is read to the bound and
 * the function log says so (W16-R24).
 */
export async function ownerAgents(ctx: QueryCtx, userId: string): Promise<Doc<'agents'>[]> {
  const agents = await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .take(OWNER_AGENTS_READ + 1);
  if (agents.length > OWNER_AGENTS_READ) {
    log.warn(BOUND_MET, { bound: 'OWNER_AGENTS_READ', limit: OWNER_AGENTS_READ });
  }
  return agents.slice(0, OWNER_AGENTS_READ);
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
