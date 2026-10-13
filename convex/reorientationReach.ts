import { v, type Infer } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  REORIENTATION_BLOCKING_LIMIT,
  type ReorientationRisk,
} from '../src/agent/reorientation-vocabulary';

/*
 * What a reorientation card reaches and holds (wave 17, 17-s; the wave 16 review's D-6 (a)): the
 * reads behind a card's affected set and its hold, moved out of `convex/reorientation.ts` as they
 * stood. An employee's open work, whole or by the pages its plans cite or the skills it runs; what
 * a change to skills, to a scope or to a connected system reaches; a reach as its card's writer
 * names it (`CardReach`, `reachOf`); the work a high-risk card holds (`blockingWorkOf`); and an
 * owner's employees, for a change that reaches every one of them (`ownerAgents`).
 *
 * This module is the floor under the cards: it reads rows and writes none, registers no function,
 * and imports no other `convex/` module, so it sits below `convex/reorientation.ts`, which calls
 * it where a card opens, and below `convex/work.ts`. A trigger's writer (`agents`, `people`,
 * `skills`, `surfaces`, `reorientationPatterns`) imports its reach from here and `openCard` from
 * the card's store.
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

/** What a change's reach comes to for one employee, or null when it reaches nothing to open on. */
export async function reachOf(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  reach: CardReach,
): Promise<Partial<CardAffected> | null> {
  switch (reach.kind) {
    case 'open-work':
      return { workItems: (await openWorkOf(ctx, agentId)).map((row) => row._id) };
    case 'citing': {
      const cited = await openWorkCiting(ctx, agentId, reach.pageRefs);
      return cited.length === 0 ? null : { workItems: cited };
    }
    case 'skills':
      return await skillReach(ctx, agentId, reach.skillIds);
    case 'surfaces': {
      const reached: Array<Partial<CardAffected>> = [];
      for (const id of reach.surfaceIds) {
        const surface = await ctx.db.get(id);
        if (surface !== null) reached.push(await surfaceReach(ctx, surface));
      }
      return {
        surfaces: reached.flatMap((one) => one.surfaces ?? []),
        skills: reached.flatMap((one) => one.skills ?? []),
        workItems: reached.flatMap((one) => one.workItems ?? []),
      };
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
    if (row !== null && (OPEN_WORK_STATES as readonly string[]).includes(row.state)) open.push(id);
  }
  return open;
}

/** The employees of an owner a fan-out reads, at most. */
const OWNER_AGENTS_READ = 200;

/** Every employee of an owner, to the fan-out's bound. */
export async function ownerAgents(ctx: QueryCtx, userId: string): Promise<Doc<'agents'>[]> {
  return await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .take(OWNER_AGENTS_READ);
}
