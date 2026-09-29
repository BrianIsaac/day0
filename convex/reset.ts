import { v, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { ConvexError } from 'convex/values';
import { mutation, query, type DatabaseReader, type MutationCtx } from './_generated/server';
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

/** A table whose rows belong to one employee and go with it. */
export type AgentKeyedTable = (typeof AGENT_KEYED_TABLES)[number];

/** What a reader needs to find one employee's rows: the employee, and its work items for the tables keyed by item. */
interface EmployeeKeys {
  readonly agentId: Id<'agents'>;
  readonly workItemIds: readonly Id<'workItems'>[];
}

/** The rows of one table that belong to an employee, at most `limit` of them when one is given. */
type RowReader = (
  db: DatabaseReader,
  keys: EmployeeKeys,
  limit: number | undefined,
) => Promise<ReadonlyArray<{ readonly _id: string }>>;

/** Every row a query names, or its first `limit`. */
async function upTo<Row>(
  query: { take(n: number): Promise<Row[]>; collect(): Promise<Row[]> },
  limit: number | undefined,
): Promise<Row[]> {
  return limit === undefined ? await query.collect() : await query.take(limit);
}

/**
 * One employee's rows of a table keyed by work item, read item by item: the claim and the
 * listing carry the item's employee, and only a reset deletes a work item, so the employee's
 * items name every such row it has.
 */
async function byWorkItem<Row>(
  keys: EmployeeKeys,
  limit: number | undefined,
  read: (workItemId: Id<'workItems'>) => Promise<Row[]>,
): Promise<Row[]> {
  if (limit === undefined) return (await Promise.all(keys.workItemIds.map(read))).flat();
  // Bounded, the items are read one after another and the walk stops at the bound, so the
  // preview never reads a claim or a listing past it.
  const rows: Row[] = [];
  for (const workItemId of keys.workItemIds) {
    if (rows.length >= limit) break;
    rows.push(...(await read(workItemId)).slice(0, limit - rows.length));
  }
  return rows;
}

/**
 * How each agent-keyed table's rows for one employee are read, each by an index that leads with
 * the employee or its work item, so neither the retire nor its preview scans another employee's
 * rows. Typed over the whole list: a table added to `AGENT_KEYED_TABLES` does not compile until
 * it is given a reader here.
 */
const EMPLOYEE_ROWS: Readonly<Record<AgentKeyedTable, RowReader>> = {
  charters: (db, { agentId }, limit) =>
    upTo(
      db.query('charters').withIndex('by_agent', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  workspace: (db, { agentId }, limit) =>
    upTo(
      db.query('workspace').withIndex('by_agent_file', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  voiceSessions: (db, { agentId }, limit) =>
    upTo(
      db.query('voiceSessions').withIndex('by_agent', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  workItems: (db, { agentId }, limit) =>
    upTo(
      db.query('workItems').withIndex('by_agent', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  externalClaims: (db, keys, limit) =>
    byWorkItem(keys, limit, (workItemId) =>
      upTo(
        db.query('externalClaims').withIndex('by_work_item', (q) => q.eq('workItemId', workItemId)),
        limit,
      ),
    ),
  managerQuestions: (db, { agentId }, limit) =>
    upTo(
      db.query('managerQuestions').withIndex('by_agent', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  managerDecisionNotices: (db, { agentId }, limit) =>
    upTo(
      db.query('managerDecisionNotices').withIndex('by_agent', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  managerNotes: (db, { agentId }, limit) =>
    upTo(
      db.query('managerNotes').withIndex('by_agent', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  corrections: (db, { agentId }, limit) =>
    upTo(
      db.query('corrections').withIndex('by_agent', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  decisionBatches: (db, { agentId }, limit) =>
    upTo(
      db.query('decisionBatches').withIndex('by_agent_id', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  skills: (db, { agentId }, limit) =>
    upTo(
      db.query('skills').withIndex('by_agent_name', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  permissionGrants: (db, { agentId }, limit) =>
    upTo(
      db.query('permissionGrants').withIndex('by_agent_scope', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  events: (db, { agentId }, limit) =>
    upTo(
      db.query('events').withIndex('by_agent', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  ticketListings: (db, keys, limit) =>
    byWorkItem(keys, limit, (workItemId) =>
      upTo(
        db
          .query('ticketListings')
          .withIndex('by_work_item_listed_at', (q) => q.eq('workItemId', workItemId)),
        limit,
      ),
    ),
  surfaces: (db, { agentId }, limit) =>
    upTo(
      db.query('surfaces').withIndex('by_agent', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  mockDocs: (db, { agentId }, limit) =>
    upTo(
      db.query('mockDocs').withIndex('by_agent_slug', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  mockSpreadsheets: (db, { agentId }, limit) =>
    upTo(
      db.query('mockSpreadsheets').withIndex('by_agent_slug', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  mockSpreadsheetRows: (db, { agentId }, limit) =>
    upTo(
      db
        .query('mockSpreadsheetRows')
        .withIndex('by_agent_sheet_tab', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  mockSlackChannels: (db, { agentId }, limit) =>
    upTo(
      db.query('mockSlackChannels').withIndex('by_agent_slug', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  mockSlackMessages: (db, { agentId }, limit) =>
    upTo(
      db.query('mockSlackMessages').withIndex('by_agent_channel', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  mockTweets: (db, { agentId }, limit) =>
    upTo(
      db.query('mockTweets').withIndex('by_agent_slug', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  mockTweetReplies: (db, { agentId }, limit) =>
    upTo(
      db.query('mockTweetReplies').withIndex('by_agent_tweet', (q) => q.eq('agentId', agentId)),
      limit,
    ),
  mockTickets: (db, { agentId }, limit) =>
    upTo(
      db.query('mockTickets').withIndex('by_agent_slug', (q) => q.eq('agentId', agentId)),
      limit,
    ),
};

/**
 * One employee's rows, table by table: every row when `limit` is absent (the retire), at most
 * `limit` of each table otherwise (the preview). Tables with no row are left out.
 *
 * @param db - Any database reader.
 * @param agentId - The employee.
 * @param items - The employee's work items, read once by the caller: every one for the retire,
 *   the first `limit` for the preview.
 * @param limit - The most rows read from each table.
 * @returns The ids of each table's rows.
 */
async function employeeRows(
  db: DatabaseReader,
  agentId: Id<'agents'>,
  items: readonly Doc<'workItems'>[],
  limit?: number,
): Promise<Map<AgentKeyedTable, string[]>> {
  const keys: EmployeeKeys = { agentId, workItemIds: items.map((item) => item._id) };
  const read = await Promise.all(
    AGENT_KEYED_TABLES.map(
      async (table) =>
        [
          table,
          // The work items are already read; every other table is read by its own index.
          table === 'workItems'
            ? [...keys.workItemIds]
            : (await EMPLOYEE_ROWS[table](db, keys, limit)).map((row) => row._id),
        ] as const,
    ),
  );
  return new Map(read.filter(([, ids]) => ids.length > 0).map(([table, ids]) => [table, [...ids]]));
}

/**
 * One employee's work items, every one or the first `limit`: the rows the retire's claims, its
 * boundaries and the tables keyed by item are all read from.
 *
 * @param db - Any database reader.
 * @param agentId - The employee.
 * @param limit - The most items read.
 */
async function employeeWorkItems(
  db: DatabaseReader,
  agentId: Id<'agents'>,
  limit?: number,
): Promise<Doc<'workItems'>[]> {
  return await upTo(
    db.query('workItems').withIndex('by_agent', (q) => q.eq('agentId', agentId)),
    limit,
  );
}

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
 * @param db - The retire's or its preview's reader.
 * @param items - The employee's work items: every one for the retire, the first few for the preview.
 * @param now - When the retire happens, the settle time of a write-target claim it keeps.
 * @returns What its retirement keeps, and the claims to release.
 */
async function boundariesOf(
  db: DatabaseReader,
  items: readonly Doc<'workItems'>[],
  now: number,
): Promise<Boundaries> {
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
    const live = await db
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
  return { claims, rejections, released };
}

/**
 * Refuse a retire whose boundaries one retirement row cannot keep.
 *
 * @param boundaries - What the retire would keep.
 * @throws ConvexError when there are more than `RETIRED_BOUNDARY_LIMIT` claims and rejections.
 */
function assertKeepable(boundaries: Boundaries): void {
  const { claims, rejections } = boundaries;
  if (claims.length + rejections.length <= RETIRED_BOUNDARY_LIMIT) return;
  throw new ConvexError(
    `This employee holds ${claims.length} items and ${rejections.length} rejections, more than one retirement keeps (${RETIRED_BOUNDARY_LIMIT}).`,
  );
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
  const rows = await employeeRows(ctx.db, agent._id, await employeeWorkItems(ctx.db, agent._id));
  const rowCounts: Record<string, number> = {};
  const deletedIds = new Set<string>([agent._id]);
  for (const [table, ids] of rows) {
    rowCounts[table] = ids.length;
    for (const id of ids) deletedIds.add(id);
  }
  await Promise.all(
    [...rows.values()].flat().map(async (id) => await ctx.db.delete(id as Id<AgentKeyedTable>)),
  );
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
 * @param db - The retire's or its preview's reader.
 * @param userId - The owner.
 * @param credentialId - The credential a retiring employee binds.
 * @param retiring - The employees being retired, whose own surfaces do not count; after the
 *   retire has deleted them there are none to skip.
 */
async function stillBound(
  db: DatabaseReader,
  userId: string,
  credentialId: Id<'credentials'>,
  retiring: ReadonlySet<Id<'agents'>>,
): Promise<boolean> {
  const connections = await db
    .query('surfaces')
    .withIndex('by_credentialId', (q) => q.eq('credentialId', credentialId))
    .collect();
  if (connections.some((surface) => !retiring.has(surface.agentId))) return true;
  const sources = await db
    .query('docSources')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();
  if (sources.some((source) => source.credentialId === credentialId)) return true;
  const employees = await db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .collect();
  for (const employee of employees) {
    if (retiring.has(employee._id)) continue;
    const surfaces = await db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', employee._id))
      .collect();
    if (credentialsBoundBy(surfaces).has(credentialId)) return true;
  }
  return false;
}

/**
 * Which of a retiring employee's credentials a retire would revoke and which it would keep for
 * what still binds them; a credential that is gone or not the owner's is in neither.
 *
 * @param db - The retire's or its preview's reader.
 * @param userId - The owner.
 * @param bound - The credentials the retiring employees bind.
 * @param retiring - The employees being retired.
 */
async function sortCredentials(
  db: DatabaseReader,
  userId: string,
  bound: ReadonlySet<Id<'credentials'>>,
  retiring: ReadonlySet<Id<'agents'>>,
): Promise<{ revoke: Doc<'credentials'>[]; kept: Set<Id<'credentials'>> }> {
  const revoke: Doc<'credentials'>[] = [];
  const kept = new Set<Id<'credentials'>>();
  for (const credentialId of bound) {
    const credential = await db.get(credentialId);
    if (!credential || credential.userId !== userId) continue;
    if (await stillBound(db, userId, credentialId, retiring)) kept.add(credentialId);
    else revoke.push(credential);
  }
  return { revoke, kept };
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
  const { revoke, kept } = await sortCredentials(ctx.db, userId, bound, new Set());
  for (const credential of revoke) await purgeCredential(ctx, credential, now);
  return { revoked: new Set(revoke.map((credential) => credential._id)), kept };
}

/**
 * Delete employees of one owner and what each owns, and, in real mode, leave each a retirement.
 *
 * In mock mode this is the hosted demo's wipe. In real mode it is a retire (decisions Q15 and
 * N1): the working rows go, each credential a retired employee bound that nothing else binds is
 * revoked with its ciphertext deleted, and each employee leaves a `retirements` row under its
 * owner that no later reset deletes, counting the rows deleted and the credentials that employee
 * bound, revoked or kept (a credential two retired employees shared is counted in both), with one
 * `agent.retired` event on its own id naming the row. Retiring one employee (`single`) keeps its
 * claims on items it may already have written and its rejections on its row, where a
 * colleague's claim, write and plan still meet them, and releases its other claims; retiring
 * every employee lets both go. Every pending job whose arguments name a deleted row is
 * cancelled, so nothing scheduled ahead of time for a retired employee runs afterwards.
 *
 * @param ctx - The mutation context.
 * @param userId - The owner.
 * @param agents - The employees to retire, all the owner's.
 * @param options - Whether this is one employee of several, and whether the owner's
 *   documentation and credentials go too (never beside `single`).
 * @throws ConvexError when one employee holds more than its retirement can keep.
 */
async function retireEmployees(
  ctx: MutationCtx,
  userId: string,
  agents: readonly Doc<'agents'>[],
  options: { readonly single: boolean; readonly unlinkDocumentation: boolean },
): Promise<{ unlinkedSources: number }> {
  const now = Date.now();
  const real = SURFACE_MODE === 'real';
  const keepsBoundaries = options.single && real;
  const boundaries = new Map<Id<'agents'>, Boundaries>();
  for (const agent of agents) {
    const held = keepsBoundaries
      ? await boundariesOf(ctx.db, await employeeWorkItems(ctx.db, agent._id), now)
      : NO_BOUNDARIES;
    assertKeepable(held);
    boundaries.set(agent._id, held);
  }
  const retired = new Map<Id<'agents'>, Retired>();
  for (const agent of agents) retired.set(agent._id, await deleteEmployee(ctx, agent));
  await cancelJobsFor(
    ctx,
    new Set([...retired.values()].flatMap((entry) => [...entry.deletedIds])),
  );
  // Unlinked before the retire counts, so a credential the unlink purges is
  // counted revoked rather than kept for a source that is gone.
  const unlinkedSources = options.unlinkDocumentation
    ? await deleteOwnedDocumentation(ctx, userId)
    : 0;
  if (options.unlinkDocumentation) await purgeOwnedCredentials(ctx, userId);
  if (!real) return { unlinkedSources };
  if (!options.single) await releaseRetiredBoundaries(ctx, userId);
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
  return { unlinkedSources };
}

/**
 * Retire one employee (decisions Q15 and N1): the Manage tab's Retire, once the manager has
 * typed its confirmation. Public; the caller must own the employee, and one already retired is
 * refused as not found. Real mode revokes what only it bound, deletes its working rows and
 * keeps one retirement row with an `agent.retired` event; the hosted office wipes it. What it
 * would do is `retirePreview`'s answer. Owner-level documentation and credentials are never
 * touched here: unlinking them retires every employee (`deleteMyData`).
 *
 * @returns The retired employee's name.
 * @throws ConvexError when the employee holds more than one retirement keeps.
 */
export const retire = mutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ agentName: string }> => {
    const identity = await getCallerOrThrow(ctx);
    const agent = await assertOwnsAgent(ctx, args.agentId);
    await retireEmployees(ctx, identity.ownerKey, [agent], {
      single: true,
      unlinkDocumentation: false,
    });
    return { agentName: agent.name };
  },
});

/**
 * Retire every one of the signed-in owner's employees: the hosted demo's reset and the bed's.
 * Public, for the signed-in owner; idempotent. Retiring every employee keeps no claim or
 * rejection binding, since every colleague they bound goes too, and empties the boundaries of
 * the owner's earlier retirements; the record of each stays.
 *
 * Owner-level documentation and credentials outlive it. With `alsoUnlinkDocumentation` every
 * owned source is unlinked and every owned credential is revoked with its ciphertext deleted;
 * the credential rows stay as the audit trail of what was held.
 */
export const deleteMyData = mutation({
  args: { alsoUnlinkDocumentation: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ deleted: number; unlinkedSources: number }> => {
    const identity = await getCallerOrThrow(ctx);
    const userId = identity.ownerKey;
    const agents = await ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .collect();
    const { unlinkedSources } = await retireEmployees(ctx, userId, agents, {
      single: false,
      unlinkDocumentation: args.alsoUnlinkDocumentation === true,
    });
    return { deleted: agents.length, unlinkedSources };
  },
});

/**
 * The most rows of each table the preview counts; past it the count is "at least". Past an
 * employee's own tables apart from a long-lived one's events and work items, and 4,600 rows
 * across the 23 tables, well inside the 16,384 documents one query may read; the bytes depend
 * on the rows, which is why the bound is this low.
 */
export const RETIRE_PREVIEW_ROW_LIMIT = 200;

/** One connection a retire revokes or keeps, by the name the Surfaces tab gives it. */
const previewSurface = v.object({ slug: v.string(), displayName: v.string() });

/** What `retirePreview` answers. */
const retirePreviewValidator = v.object({
  mode: v.union(v.literal('mock'), v.literal('real')),
  /** Rows the retire deletes, by table, the employee's own row not counted. */
  rowCounts: v.record(v.string(), v.number()),
  /** Whether a table reached `RETIRE_PREVIEW_ROW_LIMIT`, so its count is a floor. */
  atLeast: v.boolean(),
  /** The connections whose credential is revoked at once: nothing else binds it. */
  revoked: v.array(previewSurface),
  /** The connections whose credential stays, for another employee or a documentation source. */
  kept: v.array(previewSurface),
  /** The items it may already have written, whose claims its retirement keeps. */
  keptClaims: v.number(),
  /** Whether a retirement row outlives it: real mode only. */
  tombstone: v.boolean(),
});

/**
 * What retiring one employee would do, for the retire dialog to say before the manager
 * confirms: the rows each table would lose, the connections whose credential would be revoked or
 * kept, the claims its retirement would keep and whether a tombstone stays. What waits on the
 * manager is `work.needsYouForAgent`'s answer, the inbox's own rule. Public, owner-guarded;
 * reads by index, at most `RETIRE_PREVIEW_ROW_LIMIT` rows a table, the work items once for the
 * counts and the claims; writes nothing. An employee already gone answers `null` to a signed-in
 * caller, as the dialog's last read after the retire does.
 */
export const retirePreview = query({
  args: { agentId: v.id('agents') },
  returns: v.union(v.null(), retirePreviewValidator),
  handler: async (ctx, args): Promise<Infer<typeof retirePreviewValidator> | null> => {
    const identity = await getCallerOrThrow(ctx);
    if ((await ctx.db.get(args.agentId)) === null) return null;
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const items = await employeeWorkItems(ctx.db, agent._id, RETIRE_PREVIEW_ROW_LIMIT);
    const rows = await employeeRows(ctx.db, agent._id, items, RETIRE_PREVIEW_ROW_LIMIT);
    const rowCounts = Object.fromEntries([...rows].map(([table, ids]) => [table, ids.length]));
    const atLeast = [...rows.values()].some((ids) => ids.length >= RETIRE_PREVIEW_ROW_LIMIT);
    if (SURFACE_MODE !== 'real') {
      return {
        mode: 'mock',
        rowCounts,
        atLeast,
        revoked: [],
        kept: [],
        keptClaims: 0,
        tombstone: false,
      };
    }
    const surfaces = await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
      .take(RETIRE_PREVIEW_ROW_LIMIT);
    const { revoke, kept } = await sortCredentials(
      ctx.db,
      identity.ownerKey,
      credentialsBoundBy(surfaces),
      new Set([agent._id]),
    );
    const revokedIds = new Set(revoke.map((credential) => credential._id));
    const named = (holds: (id: Id<'credentials'>) => boolean) =>
      surfaces
        .filter((surface) => [...credentialsBoundBy([surface])].some(holds))
        .map((surface) => ({ slug: surface.slug, displayName: surface.displayName }));
    const boundaries = await boundariesOf(ctx.db, items, Date.now());
    return {
      mode: 'real',
      rowCounts,
      atLeast,
      revoked: named((id) => revokedIds.has(id)),
      kept: named((id) => kept.has(id)),
      keptClaims: boundaries.claims.length,
      tombstone: true,
    };
  },
});
