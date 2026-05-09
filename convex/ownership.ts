import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx, ActionCtx } from './_generated/server';
import { internal } from './_generated/api';

/**
 * Per-account ownership guards. Every public query/mutation/action that
 * touches a per-agent row calls one of these. Internal functions skip the
 * check — they're only callable from other Convex functions, which have
 * already verified the caller.
 */

async function getCallerOrThrow(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('not authenticated');
  return identity;
}

export async function assertOwnsAgent(
  ctx: QueryCtx | MutationCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'agents'>> {
  const identity = await getCallerOrThrow(ctx);
  const agent = await ctx.db.get(agentId);
  if (!agent) throw new Error('agent not found');
  if (!agent.userId) throw new Error('forbidden: agent has no owner');
  if (agent.userId !== identity.subject) throw new Error('forbidden');
  return agent;
}

export async function assertOwnsAgentAction(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'agents'>> {
  const identity = await getCallerOrThrow(ctx);
  const agent = await ctx.runQuery(internal.agents.getInternal, { agentId });
  if (!agent) throw new Error('agent not found');
  if (!agent.userId) throw new Error('forbidden: agent has no owner');
  if (agent.userId !== identity.subject) throw new Error('forbidden');
  return agent;
}

export async function assertOwnsCharter(
  ctx: QueryCtx | MutationCtx,
  charterId: Id<'charters'>,
): Promise<Doc<'charters'>> {
  const charter = await ctx.db.get(charterId);
  if (!charter) throw new Error('charter not found');
  await assertOwnsAgent(ctx, charter.agentId);
  return charter;
}

export async function assertOwnsWorkItem(
  ctx: QueryCtx | MutationCtx,
  workItemId: Id<'workItems'>,
): Promise<Doc<'workItems'>> {
  const item = await ctx.db.get(workItemId);
  if (!item) throw new Error('work item not found');
  await assertOwnsAgent(ctx, item.agentId);
  return item;
}

export async function assertOwnsSkill(
  ctx: QueryCtx | MutationCtx,
  skillId: Id<'skills'>,
): Promise<Doc<'skills'>> {
  const skill = await ctx.db.get(skillId);
  if (!skill) throw new Error('skill not found');
  await assertOwnsAgent(ctx, skill.agentId);
  return skill;
}

export async function assertOwnsVoiceSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<'voiceSessions'>,
): Promise<Doc<'voiceSessions'>> {
  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error('voice session not found');
  await assertOwnsAgent(ctx, session.agentId);
  return session;
}
