import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, type MutationCtx } from './_generated/server';
import { assertOwnsAgent, getCallerOrThrow } from './ownership';
import { deleteOwnedDocumentation } from './docSources';
import { purgeCredential, purgeOwnedCredentials } from './credentials';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { appendEvent } from './eventLog';

/**
 * Every table whose rows belong to one agent through an `agentId` field.
 *
 * `tests/convex/reset.test.ts` derives the same list from the schema and
 * fails when the two differ, so a new agent-keyed table cannot be missed here.
 */
export const AGENT_KEYED_TABLES = [
  'charters',
  'workspace',
  'voiceSessions',
  'workItems',
  'externalClaims',
  'managerQuestions',
  'managerDecisionNotices',
  'managerNotes',
  'corrections',
  'decisionBatches',
  'skills',
  'permissionGrants',
  'events',
  'ticketListings',
  'surfaces',
  'mockDocs',
  'mockSpreadsheets',
  'mockSpreadsheetRows',
  'mockSlackChannels',
  'mockSlackMessages',
  'mockTweets',
  'mockTweetReplies',
  'mockTickets',
] as const;

/** The event a real-mode retire leaves behind for each employee it deletes. */
export const AGENT_RETIRED_EVENT = 'agent.retired';

/** What one employee's retire deleted and revoked, for its tombstone. */
interface Retired {
  readonly rowCounts: Record<string, number>;
  readonly boundCredentials: ReadonlySet<Id<'credentials'>>;
}

/**
 * The credentials one employee's surfaces bind: the connection credential and
 * a Slack app's client secret.
 *
 * @param surfaces - The employee's surface rows.
 */
function credentialsBoundBy(surfaces: readonly Doc<'surfaces'>[]): Set<Id<'credentials'>> {
  const bound = new Set<Id<'credentials'>>();
  for (const surface of surfaces) {
    if (surface.credentialId) bound.add(surface.credentialId);
    if (surface.provisioning) bound.add(surface.provisioning.clientSecretCredentialId);
  }
  return bound;
}

/**
 * Delete one employee and every row it owns.
 *
 * @param ctx - The reset's mutation context.
 * @param agent - The employee.
 * @returns How many rows each table lost, and the credentials its surfaces bound.
 */
async function deleteEmployee(ctx: MutationCtx, agent: Doc<'agents'>): Promise<Retired> {
  const sandboxLease = await ctx.db
    .query('sandboxLeases')
    .withIndex('by_name', (q) => q.eq('name', 'local-sandbox'))
    .unique();
  if (sandboxLease) {
    const heldSkill = await ctx.db.get(sandboxLease.skillId);
    if (heldSkill?.agentId === agent._id) await ctx.db.delete(sandboxLease._id);
  }
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
    .collect();
  const rowCounts: Record<string, number> = {};
  const tableDeletions: Array<Promise<unknown>> = [];
  for (const tableName of AGENT_KEYED_TABLES) {
    const rows = await ctx.db
      .query(tableName)
      .filter((q) => q.eq(q.field('agentId'), agent._id))
      .collect();
    if (rows.length > 0) rowCounts[tableName] = rows.length;
    for (const row of rows) tableDeletions.push(ctx.db.delete(row._id));
  }
  await Promise.all(tableDeletions);
  await ctx.db.delete(agent._id);
  return { rowCounts, boundCredentials: credentialsBoundBy(surfaces) };
}

/**
 * Whether anything that outlives a retire still binds a credential: another
 * employee's surface, as its connection or as a Slack app's client secret, or
 * one of the owner's documentation sources (decision N1).
 *
 * @param ctx - The reset's mutation context.
 * @param userId - The owner.
 * @param credentialId - The credential a retired employee bound.
 */
async function stillBound(
  ctx: MutationCtx,
  userId: string,
  credentialId: Id<'credentials'>,
): Promise<boolean> {
  const connection = await ctx.db
    .query('surfaces')
    .withIndex('by_credentialId', (q) => q.eq('credentialId', credentialId))
    .first();
  if (connection) return true;
  const sources = await ctx.db
    .query('docSources')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();
  if (sources.some((source) => source.credentialId === credentialId)) return true;
  const employees = await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .collect();
  for (const employee of employees) {
    const surfaces = await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', employee._id))
      .collect();
    if (credentialsBoundBy(surfaces).has(credentialId)) return true;
  }
  return false;
}

/**
 * Revoke, and delete the ciphertext of, each credential nothing binds any more.
 *
 * @param ctx - The reset's mutation context.
 * @param userId - The owner.
 * @param bound - The credentials the retired employees bound.
 * @param now - The retire time.
 * @returns The credentials revoked and the ones kept for what still binds them.
 */
async function revokeUnbound(
  ctx: MutationCtx,
  userId: string,
  bound: ReadonlySet<Id<'credentials'>>,
  now: number,
): Promise<{ revoked: Set<Id<'credentials'>>; kept: Set<Id<'credentials'>> }> {
  const revoked = new Set<Id<'credentials'>>();
  const kept = new Set<Id<'credentials'>>();
  for (const credentialId of bound) {
    const credential = await ctx.db.get(credentialId);
    if (!credential || credential.userId !== userId) continue;
    if (await stillBound(ctx, userId, credentialId)) {
      kept.add(credentialId);
      continue;
    }
    await purgeCredential(ctx, credential, now);
    revoked.add(credentialId);
  }
  return { revoked, kept };
}

/**
 * Delete the signed-in owner's employees: one, when `agentId` names it, or
 * every one. Public; the caller must own the employee. Idempotent for the
 * whole owner; a named employee already retired is refused as not found.
 * Called from the reset button on the landing page.
 *
 * In mock mode this is the hosted demo's full wipe. In real mode it is a
 * retire (decisions Q15 and N1): the working rows go, each credential a
 * retired employee bound that nothing else binds is revoked with its
 * ciphertext deleted, and each employee leaves one `agent.retired` event
 * that no later reset deletes. The event sits on the retired agent's own id
 * with the owner in its payload (the schema has no owner-keyed home for it
 * yet) and counts the rows deleted and the credentials that employee bound,
 * revoked or kept; a credential two retired employees shared is counted in
 * both.
 *
 * Owner-level documentation and credentials outlive a plain reset. With
 * `alsoUnlinkDocumentation` every owned source is unlinked and every owned
 * credential is revoked with its ciphertext deleted; the credential rows
 * stay as the audit trail of what was held. Unlinking retires every
 * employee, so it is refused beside `agentId`.
 */
export const deleteMyData = mutation({
  args: { alsoUnlinkDocumentation: v.optional(v.boolean()), agentId: v.optional(v.id('agents')) },
  handler: async (ctx, args): Promise<{ deleted: number; unlinkedSources: number }> => {
    const identity = await getCallerOrThrow(ctx);
    const userId = identity.subject;
    // The unlink purges every credential the owner holds, the ones the
    // remaining employees connect with included.
    if (args.agentId !== undefined && args.alsoUnlinkDocumentation) {
      throw new Error(
        'unlinking the documentation retires every employee; retire one employee without it',
      );
    }

    const agents =
      args.agentId === undefined
        ? await ctx.db
            .query('agents')
            .withIndex('by_userId', (q) => q.eq('userId', userId))
            .collect()
        : [await assertOwnsAgent(ctx, args.agentId)];

    const now = Date.now();
    const retired = new Map<Id<'agents'>, Retired>();
    for (const agent of agents) retired.set(agent._id, await deleteEmployee(ctx, agent));
    // Unlinked before the retire counts, so a credential the unlink purges is
    // counted revoked rather than kept for a source that is gone.
    const unlinkedSources = args.alsoUnlinkDocumentation
      ? await deleteOwnedDocumentation(ctx, userId)
      : 0;
    if (args.alsoUnlinkDocumentation) await purgeOwnedCredentials(ctx, userId);
    if (SURFACE_MODE === 'real') {
      const bound = new Set([...retired.values()].flatMap((entry) => [...entry.boundCredentials]));
      const { revoked, kept } = await revokeUnbound(ctx, userId, bound, now);
      for (const [agentId, entry] of retired) {
        const own = [...entry.boundCredentials];
        await appendEvent(ctx, {
          agentId,
          type: AGENT_RETIRED_EVENT,
          payload: {
            userId,
            agentId,
            retiredAt: now,
            rowCounts: entry.rowCounts,
            revokedCredentials: own.filter((id) => revoked.has(id)).length,
            keptCredentials: own.filter((id) => kept.has(id)).length,
          },
          createdAt: now,
        });
      }
    }
    return { deleted: agents.length, unlinkedSources };
  },
});
