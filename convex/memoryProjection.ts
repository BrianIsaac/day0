import { v } from 'convex/values';
import { query, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { assertOwnsAgent } from './ownership';
import { activeAgreementsOf } from './workingAgreements';
import { agentZone } from '../src/lib/zone';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import {
  projectKnowledge,
  type KnowledgeProjection,
  type ProjectedCharter,
  type ProjectionInput,
} from '../src/memory/projection';

/*
 * What an employee knows, as the manager reads it on the Record tab (decision A2): a projection
 * of the structured rows, made on each read, so it is regenerated whenever any row it reads
 * changes. Nothing writes it and no prompt reads it; the employee's own reads go to the rows.
 */

/** The most rows of each kind one projection reads; the text is bounded well below any of them. */
const PROJECTION_ROWS = 100;

/** The most charter versions walked back to find the newest approved one. */
const CHARTER_VERSIONS = 50;

/** The newest approved version of the employee's charter, or null before the first approval. */
async function approvedCharter(
  ctx: QueryCtx,
  agentId: Doc<'agents'>['_id'],
): Promise<ProjectedCharter | null> {
  const versions = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc')
    .take(CHARTER_VERSIONS);
  const approved = versions.find((charter) => charter.approved);
  if (approved === undefined) return null;
  return {
    version: approved.version,
    ...(approved.approvedAt !== undefined ? { approvedAt: approved.approvedAt } : {}),
    body: approved.body as unknown,
  };
}

/** The documentation sources the employee inherits: its owner's, less those unticked at deploy. */
async function inheritedDocumentation(ctx: QueryCtx, agent: Doc<'agents'>): Promise<string[]> {
  const owner = agent.userId;
  if (owner === undefined) return [];
  const excluded = new Set<string>(agent.excludedDocSourceIds ?? []);
  const sources = await ctx.db
    .query('docSources')
    .withIndex('by_user', (q) => q.eq('userId', owner))
    .take(PROJECTION_ROWS);
  return sources.filter((source) => !excluded.has(source._id)).map((source) => source.label);
}

/** Every row the projection is made from, read through the employee's indexes and bounded. */
async function projectionInput(ctx: QueryCtx, agent: Doc<'agents'>): Promise<ProjectionInput> {
  const [charter, agreements, lessons, skills, surfaces, documentation] = await Promise.all([
    approvedCharter(ctx, agent._id),
    activeAgreementsOf(ctx, agent),
    ctx.db
      .query('corrections')
      .withIndex('by_agent_active_createdAt', (q) =>
        q.eq('agentId', agent._id).eq('retiredAt', undefined),
      )
      .order('desc')
      .take(PROJECTION_ROWS),
    ctx.db
      .query('skills')
      .withIndex('by_agent_state', (q) => q.eq('agentId', agent._id).eq('state', 'registered'))
      .take(PROJECTION_ROWS),
    ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
      .take(PROJECTION_ROWS),
    inheritedDocumentation(ctx, agent),
  ]);
  return {
    name: agent.name,
    managerEmail: agent.bossEmail,
    zone: agentZone(agent),
    charter,
    agreements: agreements.slice(0, PROJECTION_ROWS).map((agreement) => agreement.statement),
    lessons: lessons.map((correction) => correction.text),
    skills: skills.map((skill) => ({ name: skill.name, sourceType: skill.sourceType })),
    surfaces: surfaces.map((surface) => ({
      displayName: surface.displayName,
      verdict: surface.verdict,
      ...(surface.expiresAt !== undefined ? { expiresAt: surface.expiresAt } : {}),
    })),
    documentation,
    office: SURFACE_MODE === 'real' ? 'real' : 'mock',
  };
}

/**
 * The readable projection of what one employee knows: its charter, people, working agreements,
 * lessons from the manager's corrections, skills, connections and documentation, at most 4,000
 * characters. Public; owner-guarded; reads the employee's rows through their indexes, each read
 * bounded, and writes nothing.
 */
export const forAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<KnowledgeProjection> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    return projectKnowledge(await projectionInput(ctx, agent));
  },
});
