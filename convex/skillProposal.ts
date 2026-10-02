import { v, type ObjectType } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { appendEvent } from './eventLog';
import { requeueBehindRegisteredSkill } from './work';
import { recordOffer } from './skillAdoption';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { namedSurfacesFor, targetSurfaceFor } from '../src/work/skill-shape';
import { surfaceSlug } from '../src/surfaces/slug';

/*
 * A skill proposed for the manager from the work that needed it: the surface the work names, the
 * scopes the skill asks for, the live row of the name it joins or the new row, and the offer of a
 * sibling's version beside it. The registered `skills.propose` (whose block says who calls it and
 * when it is refused) validates and calls it; no Convex function lives here.
 */

/** Why a skill is not proposed: the employee changed owner during the evaluation that asked. */
export const PROPOSAL_AFTER_HANDOVER =
  'the employee was handed over to a new manager while this work was being evaluated';

/**
 * The states of a row that no longer holds its name for a proposal: a later item of the name
 * proposes afresh beside it. A failed row is here because Retry belongs to its own card, not to
 * a new item's evaluation.
 */
const ENDED_PROPOSAL_STATES: ReadonlySet<Doc<'skills'>['state']> = new Set([
  'rejected',
  'failed',
  'retired',
  'superseded',
]);

/** What a proposal takes: the work that needed the skill, its name and shape, and any offer. */
export const proposeArgs = {
  agentId: v.id('agents'),
  workItemId: v.id('workItems'),
  name: v.string(),
  description: v.string(),
  rationale: v.string(),
  requiredScopes: v.array(v.string()),
  surfaceClass: v.optional(v.string()),
  operation: v.optional(v.string()),
  startedUnder: v.optional(v.string()),
  /**
   * A sibling's verified version of the shape to offer for adoption, as
   * `skillAdoption.offerFor` found it (10-A); absent when none is offered.
   */
  offeredVersionId: v.optional(v.id('skillVersions')),
};

/**
 * The target surface named by the work, falling back to its intake source.
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: The agent.
 *   workItemId: The work item the skill is proposed for.
 *
 * Returns:
 *   The source plus the literal target slug in real mode.
 */
async function surfaceForWork(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  workItemId: Id<'workItems'>,
): Promise<{ sourceSystem: string; targetSurface?: string }> {
  const item = await ctx.db.get(workItemId);
  if (!item) throw new Error('work item for skill proposal not found');
  if (item.agentId !== agentId) {
    throw new Error('skill and work item belong to different agents');
  }
  if (SURFACE_MODE !== 'real') return { sourceSystem: item.sourceSystem };
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .collect();
  // The same rule the evaluator shaped the proposal by, so the surface whose
  // class named the skill is the surface the scopes and the approval gate
  // are about.
  const sourceSlug = surfaceSlug(item.sourceSystem);
  const namedSlugs = [
    ...new Set(
      namedSurfacesFor(item, surfaces)
        .map((surface: Doc<'surfaces'>): string => surface.slug)
        .filter((slug: string): boolean => slug !== sourceSlug),
    ),
  ];
  if (namedSlugs.length > 1) {
    throw new Error(`work evidence names more than one target surface: ${namedSlugs.join(', ')}`);
  }
  const targetSurface = targetSurfaceFor(item, surfaces)?.slug ?? item.sourceSystem;
  if (
    surfaces.filter((surface: Doc<'surfaces'>): boolean => surface.slug === targetSurface).length >
    1
  ) {
    throw new Error(`more than one surface is listed with slug ${targetSurface}`);
  }
  return { sourceSystem: item.sourceSystem, targetSurface };
}

/**
 * Propose a skill for the work that needed it, in the caller's transaction (`skills.propose`).
 *
 * @returns The proposed row's id: the live row of the name, or a new one.
 * @throws Error with {@link PROPOSAL_AFTER_HANDOVER} once the employee is gone or another owner's.
 */
export async function proposeInTransaction(
  ctx: MutationCtx,
  { startedUnder, ...args }: ObjectType<typeof proposeArgs>,
): Promise<Id<'skills'>> {
  if (startedUnder !== undefined && (await ctx.db.get(args.agentId))?.userId !== startedUnder) {
    throw new Error(PROPOSAL_AFTER_HANDOVER);
  }
  const target = await surfaceForWork(ctx, args.agentId, args.workItemId);
  const targetSurface = target.targetSurface;
  const requestedScopes =
    targetSurface && targetSurface !== target.sourceSystem
      ? args.requiredScopes.filter(
          (scope: string): boolean => scope !== `${target.sourceSystem}:write`,
        )
      : args.requiredScopes;
  const proposedScopes = targetSurface
    ? [...new Set([...requestedScopes, `${targetSurface}:read`, `${targetSurface}:write`])]
    : requestedScopes;
  // The live row of this name, wherever it sits among the rows that ended:
  // reading the oldest row alone meant that once a failed proposal existed,
  // every later item inserted a fresh duplicate beside the live one. A
  // retired or superseded row runs nothing and comes back through no
  // control, so it ends a name as a rejection does.
  const existing = (
    await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) => q.eq('agentId', args.agentId).eq('name', args.name))
      .collect()
  ).find((row: Doc<'skills'>): boolean => !ENDED_PROPOSAL_STATES.has(row.state));
  if (existing) {
    if (existing.state === 'registered') {
      // The late verdict's one way back: the verdict write parked it and
      // stood down, so the row is re-queued here, once per registration.
      await requeueBehindRegisteredSkill(ctx, existing, args.workItemId);
    }
    if (existing.state === 'proposed') {
      if (
        existing.targetSurface &&
        targetSurface &&
        existing.targetSurface !== targetSurface &&
        existing.proposedFor !== args.workItemId
      ) {
        throw new Error(
          `skill ${args.name} is already proposed for surface ${existing.targetSurface}`,
        );
      }
      const targetChanged =
        existing.targetSurface !== undefined && existing.targetSurface !== targetSurface;
      await ctx.db.patch(existing._id, {
        targetSurface: existing.targetSurface ?? targetSurface,
        ...(targetChanged ? { targetSurface } : {}),
        requiredScopes: targetChanged
          ? proposedScopes
          : [...new Set([...(existing.requiredScopes ?? []), ...proposedScopes])],
        surfaceClass: existing.surfaceClass ?? args.surfaceClass,
        operation: existing.operation ?? args.operation,
      });
      // The latest evaluation's offer stands: a new one is said, a withdrawn one goes.
      await recordOffer(ctx, existing, args.offeredVersionId);
    }
    return existing._id;
  }
  // A skill proposed for work that came in from a discovered surface acts on
  // that surface: it is named on the row so approval can insist the surface
  // is connected, and its scopes are the surface's read and write pair.
  const id = await ctx.db.insert('skills', {
    agentId: args.agentId,
    name: args.name,
    description: args.description,
    body: '',
    sourceType: 'agent-authored',
    state: 'proposed',
    proposedFor: args.workItemId,
    rationale: args.rationale,
    requiredScopes: proposedScopes,
    targetSurface,
    surfaceClass: args.surfaceClass,
    operation: args.operation,
    createdAt: Date.now(),
  });
  await appendEvent(ctx, {
    agentId: args.agentId,
    type: 'skill.proposed',
    payload: {
      skillId: id,
      name: args.name,
      rationale: args.rationale,
      forWorkItem: args.workItemId,
    },
    createdAt: Date.now(),
  });
  if (args.offeredVersionId !== undefined) {
    const row = await ctx.db.get(id);
    if (row !== null) await recordOffer(ctx, row, args.offeredVersionId);
  }
  return id;
}
