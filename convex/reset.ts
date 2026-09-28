import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { ConvexError } from 'convex/values';
import { mutation, type MutationCtx } from './_generated/server';
import { assertOwnsAgent, getCallerOrThrow } from './ownership';
import { deleteOwnedDocumentation } from './docSources';
import { purgeCredential, purgeOwnedCredentials } from './credentials';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { appendEvent } from './eventLog';
import { ownerRetirements, type RetiredClaim, type RetiredRejection } from './retirements';
import { internal } from './_generated/api';
import { landedWritesOf } from '../src/work/landed-writes';

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

/**
 * The tables that name an agent through `agentId` and outlive it: the record
 * a real-mode retire leaves. No reset deletes their rows.
 */
export const RETIRE_RECORD_TABLES = ['retirements'] as const;

/** The event a real-mode retire leaves on each employee's id, naming its `retirements` row. */
export const AGENT_RETIRED_EVENT = 'agent.retired';

/**
 * The states of a work item that may be writing its provider item or have
 * written it. Its claim outlives a single employee's retire: a colleague
 * taking the item could repeat what landed (review M14). A failed item holds
 * only when something it wrote landed; a claim held in any other state is
 * released instead, so the colleague it refused wakes (review M8).
 */
const WRITING_HOLDER_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set([
  'executing',
  'actions-pending',
  'completed',
]);

/**
 * Whether a retiring employee's item may have written its provider item.
 *
 * @param item - The holding work item.
 */
function mayHaveWritten(item: Doc<'workItems'>): boolean {
  if (WRITING_HOLDER_STATES.has(item.state)) return true;
  return item.state === 'failed' && landedWritesOf(item.output).length > 0;
}

/** The longest item title a kept claim carries, for the holder's name in a refusal. */
const RETIRED_TITLE_LENGTH = 200;

/**
 * The most claims and rejections one retirement keeps: far past any
 * employee's own work, and inside one document's size.
 */
const RETIRED_BOUNDARY_LIMIT = 2_000;

/** What a single employee's retire keeps binding its colleagues, and the claims it lets go. */
interface Boundaries {
  readonly claims: RetiredClaim[];
  readonly rejections: RetiredRejection[];
  readonly released: Id<'externalClaims'>[];
}

/** A whole-owner retire keeps nothing binding: every employee the boundaries protected is gone too. */
const NO_BOUNDARIES: Boundaries = { claims: [], rejections: [], released: [] };

/** What one employee's retire deleted and revoked, for its tombstone. */
interface Retired {
  readonly rowCounts: Record<string, number>;
  readonly boundCredentials: ReadonlySet<Id<'credentials'>>;
  /** The employee's id and every row id deleted with it, for the jobs that name them. */
  readonly deletedIds: ReadonlySet<string>;
}

/**
 * The newest scheduled-function records a reset reads for jobs it cancels.
 * The backend keeps finished records for a week beside the pending ones, so
 * this is far past a team deployment's queue. A pending job older than the
 * window still runs against a missing row: most steps end as a no-op, and a
 * few (`work.setFailed`, `work.decidePlan`) throw into the backend log.
 */
const SCHEDULED_JOB_SCAN_LIMIT = 4_000;

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
 * The claims and rejections a retiring employee's colleagues must still meet,
 * read before its rows are deleted: a live claim on an item it may already
 * have written is kept, any other is let go, and every rejection of its plan
 * or held actions is kept by the item's names (decision N3's sibling hold).
 *
 * @param ctx - The retire's mutation context.
 * @param agent - The employee being retired.
 * @returns What its retirement keeps, and the claims to release.
 * @throws ConvexError when there are more than one retirement can keep.
 */
async function boundariesOf(
  ctx: MutationCtx,
  agent: Doc<'agents'>,
  now: number,
): Promise<Boundaries> {
  const items = await ctx.db
    .query('workItems')
    .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
    .collect();
  const claims: RetiredClaim[] = [];
  const rejections: RetiredRejection[] = [];
  const released: Id<'externalClaims'>[] = [];
  for (const item of items) {
    const keys = [item.externalClaimKey, item.externalClaimAlias].filter(
      (key): key is string => key !== undefined,
    );
    const rejectedAt = item.rejectedAt ?? item.planRejectedAt;
    if (rejectedAt !== undefined && keys.length > 0) {
      rejections.push({ workItemId: item._id, keys, rejectedAt });
    }
    const live = await ctx.db
      .query('externalClaims')
      .withIndex('by_work_item', (q) => q.eq('workItemId', item._id))
      .filter((q) => q.eq(q.field('releasedAt'), undefined))
      .collect();
    for (const claim of live) {
      if (!mayHaveWritten(item)) {
        released.push(claim._id);
        continue;
      }
      claims.push({
        claimId: claim._id,
        key: claim.key,
        ...(claim.aliases ? { aliases: claim.aliases } : {}),
        workItemId: item._id,
        title: item.title.slice(0, RETIRED_TITLE_LENGTH),
        state: item.state,
        // A page field outlives the work that wrote it: its holder is done
        // once retired, so later work may write the field again (holdsAgainst).
        ...(claim.writeTarget
          ? { writeTarget: claim.writeTarget, settledAt: claim.settledAt ?? now }
          : {}),
        claimedAt: claim.claimedAt,
      });
    }
  }
  if (claims.length + rejections.length > RETIRED_BOUNDARY_LIMIT) {
    throw new ConvexError(
      `This employee holds ${claims.length} items and ${rejections.length} rejections, more than one retirement keeps (${RETIRED_BOUNDARY_LIMIT}).`,
    );
  }
  return { claims, rejections, released };
}

/**
 * Wake what each released claim refused: a colleague's row skipped because
 * the retired employee held its item is evaluated again. Each colleague and
 * claim is its own scheduled pass, so a retire that releases many claims
 * never reads every colleague's parked rows in its own transaction.
 *
 * @param ctx - The retire's mutation context.
 * @param userId - The owner.
 * @param released - The claims the retire let go.
 */
async function wakeReleasedClaims(
  ctx: MutationCtx,
  userId: string,
  released: readonly Id<'externalClaims'>[],
): Promise<void> {
  if (released.length === 0) return;
  const employees = await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .collect();
  for (const claimId of released) {
    for (const employee of employees) {
      await ctx.scheduler.runAfter(0, internal.work.reevaluatePending, {
        agentId: employee._id,
        trigger: 'claim-released',
        key: claimId,
      });
    }
  }
}

/**
 * Empty the boundaries of the owner's earlier retirements, when every
 * employee retires: the live claims go with the employees, and so do the kept
 * ones; the record of each retirement stays.
 *
 * @param ctx - The retire's mutation context.
 * @param userId - The owner.
 */
async function releaseRetiredBoundaries(ctx: MutationCtx, userId: string): Promise<void> {
  for (const retirement of await ownerRetirements(ctx, userId)) {
    if (retirement.claims.length === 0 && retirement.rejections.length === 0) continue;
    await ctx.db.patch(retirement._id, { claims: [], rejections: [] });
  }
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
  const deletedIds = new Set<string>([agent._id]);
  const tableDeletions: Array<Promise<unknown>> = [];
  for (const tableName of AGENT_KEYED_TABLES) {
    const rows = await ctx.db
      .query(tableName)
      .filter((q) => q.eq(q.field('agentId'), agent._id))
      .collect();
    if (rows.length > 0) rowCounts[tableName] = rows.length;
    for (const row of rows) {
      deletedIds.add(row._id);
      tableDeletions.push(ctx.db.delete(row._id));
    }
  }
  await Promise.all(tableDeletions);
  await ctx.db.delete(agent._id);
  return { rowCounts, boundCredentials: credentialsBoundBy(surfaces), deletedIds };
}

/**
 * Whether a scheduled job's arguments make it a retired employee's: they name
 * a row the reset deleted, and no surviving employee through `agentId` (a
 * colleague's wake keyed on a retired claim is still the colleague's).
 *
 * @param args - The job's arguments.
 * @param deletedIds - The ids the reset deleted.
 */
function namesDeletedRow(args: readonly unknown[], deletedIds: ReadonlySet<string>): boolean {
  return args.some((arg: unknown): boolean => {
    if (typeof arg !== 'object' || arg === null) return false;
    const fields = arg as Record<string, unknown>;
    if (typeof fields.agentId === 'string' && !deletedIds.has(fields.agentId)) return false;
    return Object.values(fields).some(
      (value: unknown) => typeof value === 'string' && deletedIds.has(value),
    );
  });
}

/**
 * Cancel every pending job that is a retired employee's: an evaluation, a
 * draft, an apply's recovery, a probe or a note scheduled ahead of time for
 * it would otherwise run against nothing (P4-7).
 *
 * @param ctx - The reset's mutation context.
 * @param deletedIds - The ids the reset deleted.
 * @returns How many jobs were cancelled.
 */
async function cancelJobsFor(ctx: MutationCtx, deletedIds: ReadonlySet<string>): Promise<number> {
  if (deletedIds.size === 0) return 0;
  const recent = await ctx.db.system
    .query('_scheduled_functions')
    .order('desc')
    .take(SCHEDULED_JOB_SCAN_LIMIT);
  const doomed = recent.filter(
    (job) => job.state.kind === 'pending' && namesDeletedRow(job.args, deletedIds),
  );
  await Promise.all(doomed.map((job) => ctx.scheduler.cancel(job._id)));
  return doomed.length;
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
 * ciphertext deleted, and each employee leaves a `retirements` row under its
 * owner that no later reset deletes, counting the rows deleted and the
 * credentials that employee bound, revoked or kept (a credential two retired
 * employees shared is counted in both), with one `agent.retired` event on its
 * own id naming the row. Retiring one employee keeps its claims on items it
 * may already have written and its rejections on its row, where a colleague's
 * claim, write and plan still meet them, and releases its other claims;
 * retiring every employee lets both go.
 *
 * Every pending job whose arguments name a deleted row is cancelled, so
 * nothing scheduled ahead of time for a retired employee runs afterwards.
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
    const userId = identity.ownerKey;
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
    const single = args.agentId !== undefined && SURFACE_MODE === 'real';
    const boundaries = new Map<Id<'agents'>, Boundaries>();
    for (const agent of agents) {
      boundaries.set(agent._id, single ? await boundariesOf(ctx, agent, now) : NO_BOUNDARIES);
    }
    const retired = new Map<Id<'agents'>, Retired>();
    for (const agent of agents) retired.set(agent._id, await deleteEmployee(ctx, agent));
    await cancelJobsFor(
      ctx,
      new Set([...retired.values()].flatMap((entry) => [...entry.deletedIds])),
    );
    // Unlinked before the retire counts, so a credential the unlink purges is
    // counted revoked rather than kept for a source that is gone.
    const unlinkedSources = args.alsoUnlinkDocumentation
      ? await deleteOwnedDocumentation(ctx, userId)
      : 0;
    if (args.alsoUnlinkDocumentation) await purgeOwnedCredentials(ctx, userId);
    if (SURFACE_MODE === 'real') {
      if (!single) await releaseRetiredBoundaries(ctx, userId);
      const bound = new Set([...retired.values()].flatMap((entry) => [...entry.boundCredentials]));
      const { revoked, kept } = await revokeUnbound(ctx, userId, bound, now);
      for (const agent of agents) {
        const entry = retired.get(agent._id);
        const held = boundaries.get(agent._id) ?? NO_BOUNDARIES;
        if (!entry) continue;
        const own = [...entry.boundCredentials];
        const retirementId = await ctx.db.insert('retirements', {
          userId,
          agentId: agent._id,
          agentName: agent.name,
          retiredAt: now,
          rowCounts: entry.rowCounts,
          revokedCredentials: own.filter((id) => revoked.has(id)).length,
          keptCredentials: own.filter((id) => kept.has(id)).length,
          claims: held.claims,
          rejections: held.rejections,
        });
        await appendEvent(ctx, {
          agentId: agent._id,
          type: AGENT_RETIRED_EVENT,
          payload: { retirementId, agentId: agent._id, retiredAt: now },
          createdAt: now,
        });
        await wakeReleasedClaims(ctx, userId, held.released);
      }
    }
    return { deleted: agents.length, unlinkedSources };
  },
});
