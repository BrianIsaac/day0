import type { TestConvex } from 'convex-test';
import { internal } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';
import { MANAGER_ADDRESS } from './manager-identity';

/*
 * The skill tests' shared seeds: an owned employee with one ticket waiting for a skill, a proposal
 * for it, and a shaped approved skill, as the skill modules' mirrors each start from them.
 */

type Harness = TestConvex<typeof schema>;

/** Seed Priya, the owner's employee, and one ticket of the given system waiting for a skill. */
export async function seedAgentAndWork(
  harness: Harness,
  sourceSystem: string,
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem,
      externalId: 'REVOPS-1',
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state: 'needs-skill',
      observedAt: 1,
      createdAt: 1,
    });
    return { agentId, workItemId };
  });
}

/** Propose the Linear skill the ticket waits for, as an evaluation proposes it. */
export async function proposeLinearSkill(
  harness: Harness,
  agentId: Id<'agents'>,
  workItemId: Id<'workItems'>,
): Promise<Id<'skills'>> {
  return await harness.mutation(internal.skills.propose, {
    agentId,
    workItemId,
    name: 'update-linear-ticket',
    description: 'Comment on and close a Linear ticket.',
    rationale: 'No skill handles linear work yet.',
    requiredScopes: ['boss:message', 'linear:read', 'linear:write'],
  });
}

/** A shaped, approved skill of an owned employee. */
export async function approvedSkill(harness: Harness): Promise<Id<'skills'>> {
  const { agentId, workItemId } = await seedAgentAndWork(harness, 'tickets');
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('skills', {
        agentId,
        name: 'kanban-comment-and-close',
        description: 'Ticket comment-and-close.',
        body: '',
        sourceType: 'agent-authored',
        state: 'approved',
        proposedFor: workItemId,
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        createdAt: 1,
      }),
  );
}
