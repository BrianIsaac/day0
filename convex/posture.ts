import { v } from 'convex/values';
import { internalMutation, mutation } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent } from './ownership';
import {
  agentPosture,
  decisionsFromEvents,
  replaySupervisedRuns,
  SKILL_SUPERVISED_RUNS,
  type AgentPosture,
} from '../src/work/posture';

/**
 * The action posture ladder's persistence: the manager's control over an
 * agent's posture, and the one-off backfill for rows written before the
 * ladder existed. The automatic cold-start exit lives with the completion
 * that triggers it (`work.setCompleted`); the per-skill counter is written by
 * the manager's gate decisions (`work.approveActions`, `work.rejectActions`).
 */

const postureValidator = v.union(
  v.literal('cold-start'),
  v.literal('supervised'),
  v.literal('trusted'),
);

export const setPosture = mutation({
  args: { agentId: v.id('agents'), posture: postureValidator },
  handler: async (ctx, args): Promise<{ ok: true; posture: AgentPosture; changed: boolean }> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const from = agentPosture(agent);
    if (from === args.posture) return { ok: true, posture: from, changed: false };
    await ctx.db.patch(args.agentId, { posture: args.posture });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'agent.posture-changed',
      payload: { from, to: args.posture, reason: 'set by the manager' },
      createdAt: Date.now(),
    });
    return { ok: true, posture: args.posture, changed: true };
  },
});

const GATE_EVENT_TYPES = new Set([
  'work.actions-pending',
  'work.actions-approved',
  'work.actions-rejected',
]);

/**
 * Give rows that predate the ladder the values its rules would have produced.
 *
 *   npx convex run posture:backfill
 *
 * A skill without a counter gets the supervised-run rule replayed over the
 * gate events of the work items it ran (an approval with no held row left
 * out counts one; a rejection or a partial approval starts again). An agent
 * without a posture that has completed a work item is past cold start and
 * becomes `supervised`; one that has not stays absent, which reads as
 * `cold-start`. Safe to run twice: a row that already carries a value is
 * left alone.
 */
export const backfill = internalMutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    skills: Array<{ skillId: Id<'skills'>; name: string; supervisedRunsCompleted: number; trusted: boolean }>;
    agents: Array<{ agentId: Id<'agents'>; name: string; posture: AgentPosture }>;
  }> => {
    const skills: Array<{
      skillId: Id<'skills'>;
      name: string;
      supervisedRunsCompleted: number;
      trusted: boolean;
    }> = [];
    const agents: Array<{ agentId: Id<'agents'>; name: string; posture: AgentPosture }> = [];
    const eventsByAgent = new Map<Id<'agents'>, Doc<'events'>[]>();
    const gateEventsFor = async (agentId: Id<'agents'>): Promise<Doc<'events'>[]> => {
      const cached = eventsByAgent.get(agentId);
      if (cached) return cached;
      const rows = (
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect()
      ).filter((event) => GATE_EVENT_TYPES.has(event.type));
      eventsByAgent.set(agentId, rows);
      return rows;
    };
    for (const skill of await ctx.db.query('skills').collect()) {
      if (skill.supervisedRunsCompleted !== undefined) continue;
      const workItems = await ctx.db
        .query('workItems')
        .withIndex('by_agent_state', (q) => q.eq('agentId', skill.agentId))
        .collect();
      const owned = new Set(
        workItems.filter((item) => item.skillId === skill._id).map((item) => String(item._id)),
      );
      const events = (await gateEventsFor(skill.agentId)).filter((event) =>
        owned.has(String((event.payload as { workItemId?: unknown })?.workItemId)),
      );
      const supervisedRunsCompleted = replaySupervisedRuns(decisionsFromEvents(events));
      await ctx.db.patch(skill._id, { supervisedRunsCompleted });
      skills.push({
        skillId: skill._id,
        name: skill.name,
        supervisedRunsCompleted,
        trusted: supervisedRunsCompleted >= SKILL_SUPERVISED_RUNS,
      });
    }
    for (const agent of await ctx.db.query('agents').collect()) {
      if (agent.posture !== undefined) continue;
      const completed = await ctx.db
        .query('workItems')
        .withIndex('by_agent_state', (q) => q.eq('agentId', agent._id).eq('state', 'completed'))
        .first();
      if (!completed) continue;
      await ctx.db.patch(agent._id, { posture: 'supervised' });
      await ctx.db.insert('events', {
        agentId: agent._id,
        type: 'agent.posture-changed',
        payload: {
          from: 'cold-start',
          to: 'supervised',
          reason: 'backfill: a work item had already completed',
          workItemId: completed._id,
        },
        createdAt: Date.now(),
      });
      agents.push({ agentId: agent._id, name: agent.name, posture: 'supervised' });
    }
    return { skills, agents };
  },
});
