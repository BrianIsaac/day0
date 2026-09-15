'use node';

import { v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { assertOwnsAgentAction } from './ownership';
import type { AgentTrace } from './events';
import { ownerKnownValues, scrubKnownValues } from '../src/redaction/known-values';

/**
 * The complete redacted trace one owner exports for a judge or a report.
 *
 * The synchronous trace query applies the structural floor but cannot
 * decrypt, so the export is an action: it checks ownership, runs the
 * internal query under the same identity (which checks ownership again), then
 * removes every value the owner stores from every string before returning.
 * Nothing decrypted is returned or persisted; the values exist only to be
 * removed. The command in the README points here.
 */
export const exportForAgent = action({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<AgentTrace> => {
    const agent = await assertOwnsAgentAction(ctx, args.agentId);
    const trace: AgentTrace = await ctx.runQuery(internal.events.exportForAgent, { agentId: args.agentId });
    const known = agent.userId ? await ownerKnownValues(ctx, agent.userId) : [];
    return scrubKnownValues(trace, known);
  },
});
