import { v, type Infer } from 'convex/values';
import type { DataModel, Doc, Id } from './_generated/dataModel';
import type { ExpressionOrValue, FilterBuilder, NamedTableInfo } from 'convex/server';
import { ConvexError } from 'convex/values';
import {
  internalMutation,
  mutation,
  query,
  type DatabaseReader,
  type MutationCtx,
} from './_generated/server';
import {
  assertOwnsAgent,
  getCaller,
  getCallerOrThrow,
  ownedAgentOrNull,
  verifiedAddressOf,
} from './ownership';
import { deleteOwnedDocumentation } from './docSources';
import { purgeCredential, purgeOwnedCredentials } from './credentials';
import { endAccessAtSource, plannedAtSource } from './sourceRevocation';
import type { AccessEnd } from '../src/surfaces/access-identity';
import { sharedByOrganisation } from '../src/surfaces/revokers/plan';
import { cancelTransferInTransaction } from './managerTransfers';
import { credentialsBoundBy } from './surfaces';
import { deleteOwnerLibrary, releaseAuthor } from './skillVersions';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { appendEvent } from './eventLog';
import {
  RETIREMENT_READ_LIMIT,
  ownerRetirements,
  type RetiredClaim,
  type RetiredRejection,
} from './retirements';
import { internal } from './_generated/api';
import { landedWritesOf } from '../src/work/landed-writes';
import { providerReconciliationEntries } from '../src/work/reconciliation';
import {
  MANAGER_TRANSFER_STATES,
  OPEN_MANAGER_TRANSFER_STATES,
  TRANSFER_SETTLE_MS,
  canMoveTransfer,
  isTransferDue,
} from '../src/agent/manager-transfer';

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
  'replacedDecisionRequests',
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
 * a real-mode retire leaves, and the handover requests that name an employee.
 * No reset deletes their rows.
 */
export const RETIRE_RECORD_TABLES = ['retirements', 'managerTransfers'] as const;

/**
 * The tables keyed by owner that outlive one employee and go with the owner's data: the owner's
 * skill library (K1). A single retire keeps its versions, which other employees may hold, and
 * clears the retired employee from their author (`releaseAuthor`); the whole-owner deletion
 * deletes them (`deleteOwnerLibrary`).
 */
export const OWNER_LIBRARY_TABLES = ['skillVersions'] as const;

/**
 * The tables of the organisation as a whole (wave 11, 11-AK; the access plan, section 4.1): the
 * systems IT connected at install and their ledger. They belong to no owner, so neither a retire
 * nor an owner's deletion touches them, and the organisation's secrets they name are
 * `credentials` rows under the reserved organisation key, which every owner read and purge here
 * misses by index. Only an administrator's revoke ends a connection (11-AO).
 */
export const DEPLOYMENT_ACCESS_TABLES = ['organisationConnections', 'connectionEvents'] as const;

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
  replacedDecisionRequests: (db, { agentId }, limit) =>
    upTo(
      db
        .query('replacedDecisionRequests')
        .withIndex('by_agent_decision', (q) => q.eq('agentId', agentId)),
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
 * boundaries and the tables keyed by item are all read from, and a handover's too.
 *
 * @param db - Any database reader.
 * @param agentId - The employee.
 * @param limit - The most items read.
 */
export async function employeeWorkItems(
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

/** The states whose item holds nothing it wrote: the manager turned it down, or it was never taken. */
const NEVER_WROTE_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set([
  'cancelled',
  'skipped',
]);

/**
 * Whether a leaving employee's item may have written its provider item: it is writing or wrote,
 * or its output carries a landed write, or a write whose outcome is unknown (an apply stopped
 * part way, by the dead-man switch, a handover's deadline or the manager's Stop), which may have
 * landed. The output is read in every state but the two that never wrote: a Retry moves a row
 * that landed writes back to `plan-approved`, `claimed` or `plan-pending` with them carried (the
 * wave 3.5 review's M2).
 *
 * @param item - The holding work item.
 */
function mayHaveWritten(item: Doc<'workItems'>): boolean {
  if (WRITING_HOLDER_STATES.has(item.state)) return true;
  if (NEVER_WROTE_STATES.has(item.state)) return false;
  return (
    landedWritesOf(item.output).length > 0 ||
    providerReconciliationEntries(item.output).some((entry) => entry.outcome === 'outcome-unknown')
  );
}

/** The longest item title a kept claim carries, for the holder's name in a refusal. */
const RETIRED_TITLE_LENGTH = 200;

/**
 * The most claims and rejections one retirement keeps: far past any
 * employee's own work, and inside one document's size.
 */
const RETIRED_BOUNDARY_LIMIT = 2_000;

/**
 * What a single employee leaving its owner keeps binding its colleagues, and the claims it lets
 * go: by a retire, or by a handover to another manager (decision D11).
 */
export interface Boundaries {
  readonly claims: RetiredClaim[];
  readonly rejections: RetiredRejection[];
  readonly released: Id<'externalClaims'>[];
  /** Every live claim the employee's items hold, as read, so a handover decides each in one pass. */
  readonly live: Doc<'externalClaims'>[];
}

/**
 * Nothing kept binding: a whole-owner retire, whose every employee the boundaries protected is
 * gone too, and any mock-mode departure.
 */
export const NO_BOUNDARIES: Boundaries = { claims: [], rejections: [], released: [], live: [] };

/** One card a retire deleted or a handover cut, with the credentials it bound. */
export interface RetiredCard {
  readonly surfaceId: Id<'surfaces'>;
  readonly displayName: string;
  readonly bound: ReadonlySet<Id<'credentials'>>;
}

/** What one employee's retire deleted and revoked, for its tombstone. */
interface Retired {
  readonly rowCounts: Record<string, number>;
  readonly boundCredentials: ReadonlySet<Id<'credentials'>>;
  /** Each deleted card with what it bound, so each system's end has its own ledger line. */
  readonly cards: readonly RetiredCard[];
  /** The employee's id and every row id deleted with it, for the jobs that name them. */
  readonly deletedIds: ReadonlySet<string>;
}

/**
 * The newest scheduled-function records a reset reads for jobs it cancels.
 * The backend keeps finished records for a week beside the pending ones, so
 * this is far past a team deployment's queue. A pending job older than the
 * window still runs against a missing row: most steps end as a no-op, and a
 * few (`workRuns.setFailed`, `work.decidePlan`) throw into the backend log.
 */
const SCHEDULED_JOB_SCAN_LIMIT = 4_000;

/**
 * The claims and rejections a leaving employee's colleagues must still meet,
 * read before its rows are deleted or it moves to another owner: a live claim
 * on an item it may already have written is kept, any other is let go, and
 * every rejection of its plan or held actions is kept by the item's names
 * (decision N3's sibling hold).
 *
 * @param db - The retire's, the handover's or a preview's reader.
 * @param items - The employee's work items: every one for the retire and the handover, the first
 *   few for a preview.
 * @param now - When it leaves, the settle time of a write-target claim it keeps.
 * @returns What its retirement or departure keeps, and the claims to release.
 */
export async function boundariesOf(
  db: DatabaseReader,
  items: readonly Doc<'workItems'>[],
  now: number,
): Promise<Boundaries> {
  const claims: RetiredClaim[] = [];
  const rejections: RetiredRejection[] = [];
  const released: Id<'externalClaims'>[] = [];
  const held: Doc<'externalClaims'>[] = [];
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
    held.push(...live);
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
  return { claims, rejections, released, live: held };
}

/**
 * Refuse a retire or a handover whose boundaries one retirement row cannot keep.
 *
 * @param boundaries - What the retire or the handover would keep.
 * @throws ConvexError when there are more than `RETIRED_BOUNDARY_LIMIT` claims and rejections.
 */
export function assertKeepable(boundaries: Boundaries): void {
  const { claims, rejections } = boundaries;
  if (claims.length + rejections.length <= RETIRED_BOUNDARY_LIMIT) return;
  throw new ConvexError(
    `This employee holds ${claims.length} items and ${rejections.length} rejections, more than one retirement keeps (${RETIRED_BOUNDARY_LIMIT}).`,
  );
}

/**
 * Wake what each released claim refused: a colleague's row skipped because
 * the leaving employee held its item is evaluated again. Each colleague and
 * claim is its own scheduled pass, so a retire or a handover that releases
 * many claims never reads every colleague's parked rows in its own transaction.
 *
 * @param ctx - The retire's or the handover's mutation context.
 * @param userId - The owner whose employees the claims refused.
 * @param released - The claims let go.
 */
export async function wakeReleasedClaims(
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
  const cards = await Promise.all(
    surfaces.map(async (surface) => ({
      surfaceId: surface._id,
      displayName: surface.displayName,
      bound: await credentialsBoundBy(ctx.db, [surface]),
    })),
  );
  return {
    rowCounts,
    boundCredentials: new Set(cards.flatMap((card) => [...card.bound])),
    cards,
    deletedIds,
  };
}

/**
 * The rows a reset deleted or a handover cut, and the employees they were
 * deleted or cut for: what makes a pending job one to cancel.
 */
export interface NamedRows {
  /** Every row id the jobs to cancel may name: deleted rows, or a handover's cut surfaces. */
  readonly ids: ReadonlySet<string>;
  /**
   * The employees the reset or the handover acts on. A job whose `agentId` names another
   * employee is that employee's and stays, even when it names one of `ids` (a colleague's wake
   * keyed on a retired claim is still the colleague's).
   */
  readonly employees: ReadonlySet<string>;
}

/**
 * Whether a scheduled job's arguments make it one the reset or the handover
 * ends: they name one of its rows, and no employee outside it through `agentId`.
 *
 * @param args - The job's arguments.
 * @param named - The rows and the employees acted on.
 */
function namesRow(args: readonly unknown[], named: NamedRows): boolean {
  return args.some((arg: unknown): boolean => {
    if (typeof arg !== 'object' || arg === null) return false;
    const fields = arg as Record<string, unknown>;
    if (typeof fields.agentId === 'string' && !named.employees.has(fields.agentId)) return false;
    return Object.values(fields).some(
      (value: unknown) => typeof value === 'string' && named.ids.has(value),
    );
  });
}

/**
 * The module whose jobs end access at the vendor (11-AR): an attempt to revoke what Day0 obtained,
 * or the token store's forget. Each reads what it needs off the credential row, never off the card,
 * so it outlives the card it names; cancelling one leaves the row to wait for the hourly sweep and
 * close `failed` with no further try (the wave 11 review's m5).
 */
const VENDOR_END_MODULE = 'sourceRevocationActions';

/**
 * Cancel every pending job that names a row a reset deleted or a handover cut:
 * an evaluation, a draft, an apply's recovery, a probe or a note scheduled
 * ahead of time for a retired employee would otherwise run against nothing
 * (P4-7), and a probe or a poll of a cut surface would act on a connection the
 * new manager has not approved. A job that ends access at the vendor is kept
 * ({@link VENDOR_END_MODULE}).
 *
 * @param ctx - The reset's or the handover's mutation context.
 * @param named - The ids it deleted or cut, and the employees it acted on.
 * @returns How many jobs were cancelled.
 */
export async function cancelJobsFor(ctx: MutationCtx, named: NamedRows): Promise<number> {
  if (named.ids.size === 0) return 0;
  const recent = await ctx.db.system
    .query('_scheduled_functions')
    .order('desc')
    .take(SCHEDULED_JOB_SCAN_LIMIT);
  const doomed = recent.filter(
    (job) =>
      job.state.kind === 'pending' &&
      !job.name.startsWith(`${VENDOR_END_MODULE}:`) &&
      !job.name.startsWith(`${VENDOR_END_MODULE}.js:`) &&
      namesRow(job.args, named),
  );
  await Promise.all(doomed.map((job) => ctx.scheduler.cancel(job._id)));
  return doomed.length;
}

/**
 * Whether anything that outlives a retire or a handover still binds a credential: another
 * employee's surface, as its connection or as a Slack app's client secret, or one of the owner's
 * documentation sources (decision N1, and D5 (a) for a handover).
 *
 * @param db - The retire's, the handover's or a preview's reader.
 * @param userId - The owner.
 * @param credentialId - The credential a leaving employee binds.
 * @param leaving - The employees being retired or handed over, whose own surfaces do not count;
 *   after the retire has deleted them there are none to skip.
 */
export async function stillBound(
  db: DatabaseReader,
  userId: string,
  credentialId: Id<'credentials'>,
  leaving: ReadonlySet<Id<'agents'>>,
): Promise<boolean> {
  const connections = await db
    .query('surfaces')
    .withIndex('by_credentialId', (q) => q.eq('credentialId', credentialId))
    .collect();
  if (connections.some((surface) => !leaving.has(surface.agentId))) return true;
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
    if (leaving.has(employee._id)) continue;
    const surfaces = await db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', employee._id))
      .collect();
    if ((await credentialsBoundBy(db, surfaces)).has(credentialId)) return true;
  }
  return false;
}

/**
 * Which of a leaving employee's credentials a retire or a handover would revoke and which it
 * would keep for what still binds them; a credential that is gone, or neither the owner's nor a
 * per-employee identity the organisation holds for the owner's employee (the wave 11 common
 * rules), is in neither, so the organisation's own rows never are.
 *
 * @param db - The retire's, the handover's or a preview's reader.
 * @param userId - The owner.
 * @param bound - The credentials the leaving employees bind.
 * @param leaving - The employees being retired or handed over.
 */
export async function sortCredentials(
  db: DatabaseReader,
  userId: string,
  bound: ReadonlySet<Id<'credentials'>>,
  leaving: ReadonlySet<Id<'agents'>>,
): Promise<{ revoke: Doc<'credentials'>[]; kept: Set<Id<'credentials'>> }> {
  const revoke: Doc<'credentials'>[] = [];
  const kept = new Set<Id<'credentials'>>();
  for (const credentialId of bound) {
    const credential = await db.get(credentialId);
    if (!credential) continue;
    const employeeIdentity = credential.holder !== undefined && !sharedByOrganisation(credential);
    if (credential.userId !== userId && !employeeIdentity) continue;
    if (await stillBound(db, userId, credentialId, leaving)) kept.add(credentialId);
    else revoke.push(credential);
  }
  return { revoke, kept };
}

/**
 * End, at the vendor and in Day0, each credential nothing binds any more, card by card (11-AR;
 * the access plan, section 4.4): what Day0 obtained is revoked at once and held for its vendor
 * call (`endAccessAtSource`), its ciphertext kept until the call is final; a pasted key that
 * nothing else binds is revoked with its ciphertext deleted, and never sent to a vendor (D5,
 * AC4); a pasted key a colleague or a documentation source still binds is kept. Each card's end
 * writes its system's ledger line on the retired employee's record, which real mode keeps.
 *
 * @param ctx - The reset's mutation context.
 * @param userId - The owner.
 * @param retired - The retired employees with the cards each deleted.
 * @param end - `retire`, `owner-deletion` when the owner's data goes with it, or `transfer` for a
 *   handover's cut, which revokes what Day0 obtained as a Disconnect does (the wave 11 review's
 *   M1).
 * @param now - The retire time.
 * @param leaving - The employees whose own surfaces do not count as still binding: a handover's
 *   employee, which still exists; after a retire has deleted them there are none to skip.
 * @returns The credentials revoked and the ones kept for what still binds them.
 */
export async function revokeUnbound(
  ctx: MutationCtx,
  userId: string,
  retired: readonly { readonly agentId: Id<'agents'>; readonly cards: readonly RetiredCard[] }[],
  end: AccessEnd,
  now: number,
  leaving: ReadonlySet<Id<'agents'>> = new Set(),
): Promise<{ revoked: Set<Id<'credentials'>>; kept: Set<Id<'credentials'>> }> {
  const bound = new Set(retired.flatMap(({ cards }) => cards.flatMap((card) => [...card.bound])));
  const { revoke, kept } = await sortCredentials(ctx.db, userId, bound, leaving);
  const revoking = new Map(revoke.map((credential) => [credential._id, credential]));
  const ended = new Set<Id<'credentials'>>();
  for (const { agentId, cards } of retired) {
    for (const card of cards) {
      const rows: Doc<'credentials'>[] = [];
      for (const id of card.bound) {
        if (ended.has(id)) continue;
        ended.add(id);
        const row = revoking.get(id) ?? (await ctx.db.get(id));
        // A row kept for what still binds it is the owner's to keep; only a pasted one says so.
        if (row === null || (kept.has(id) && row.issuedBy !== undefined)) continue;
        rows.push(row);
      }
      if (rows.length === 0) continue;
      await endAccessAtSource(ctx, {
        agentId,
        surfaceId: card.surfaceId,
        surfaceName: card.displayName,
        credentials: rows.filter(
          (row) => revoking.has(row._id) || kept.has(row._id) || row.holder !== undefined,
        ),
        end,
        now,
      });
    }
  }
  for (const credential of revoke) {
    if (credential.issuedBy === undefined) await purgeCredential(ctx, credential, now);
  }
  return { revoked: new Set(revoking.keys()), kept };
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
 * cancelled, so nothing scheduled ahead of time for a retired employee runs afterwards. In both
 * modes the owner's skill library ({@link OWNER_LIBRARY_TABLES}) outlives a single retire, which
 * only clears the employee from the versions it wrote, and goes with the owner's data when every
 * employee does.
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
  if (options.single) {
    for (const agent of agents) await releaseAuthor(ctx, agent._id);
  } else {
    await deleteOwnerLibrary(ctx, userId);
  }
  await cancelJobsFor(ctx, {
    ids: new Set([...retired.values()].flatMap((entry) => [...entry.deletedIds])),
    employees: new Set(agents.map((agent) => agent._id)),
  });
  // Unlinked before the retire counts, so a credential the unlink purges is
  // counted revoked rather than kept for a source that is gone.
  const unlinkedSources = options.unlinkDocumentation
    ? await deleteOwnedDocumentation(ctx, userId)
    : 0;
  if (!real) {
    if (options.unlinkDocumentation) await purgeOwnedCredentials(ctx, userId);
    return { unlinkedSources };
  }
  if (!options.single) await releaseRetiredBoundaries(ctx, userId);
  const { revoked, kept } = await revokeUnbound(
    ctx,
    userId,
    [...retired.entries()].map(([agentId, entry]) => ({ agentId, cards: entry.cards })),
    options.unlinkDocumentation ? 'owner-deletion' : 'retire',
    now,
  );
  // The owner's other values go with the deletion only now, once what Day0 obtained is held for
  // its vendor call: the purge leaves a held row's ciphertext for that call (F19).
  if (options.unlinkDocumentation) await purgeOwnedCredentials(ctx, userId);
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
 * The refusal for retiring an employee whose handover the named manager accepted and whose runs
 * in flight are finishing: from then on the employee is theirs to keep or retire. A
 * `ConvexError`'s data, which the retire dialog shows.
 *
 * @param name - The employee's name.
 * @param toAddress - The address of the manager taking it on.
 */
export function retireDuringHandoverRefusal(name: string, toAddress: string): string {
  return `${name} is being handed over to ${toAddress}, who has accepted, so ${name} can no longer be retired.`;
}

/**
 * The refusal for deleting an owner's data while one of its employees' handovers is finishing,
 * with the wait named. A `ConvexError`'s data, which the reset dialog shows.
 *
 * @param name - The employee being handed over.
 * @param toAddress - The address of the manager taking it on.
 */
export function deleteDuringHandoverRefusal(name: string, toAddress: string): string {
  const minutes = TRANSFER_SETTLE_MS / 60_000;
  return `Your data cannot be deleted while ${name} is being handed over to ${toAddress}. The handover finishes when the work ${name} has in progress ends, within ${minutes} minutes; delete your data after that.`;
}

/**
 * Close the open handover requests of employees about to be retired (the transfer plan, section
 * 10.5): an `asked` request is cancelled with the retire as its reason, in the retire's own
 * transaction, through the request's own cancel (`cancelTransferInTransaction`, which writes the
 * `manager.transfer-cancelled` event); an `accepting` one refuses the whole retire, before
 * anything is written, since its acceptance is irrevocable. An asked request past its expiry is
 * no longer open and is left to the expiry sweep. A request the owner is named in is not
 * touched: its employee is not the owner's until it moves.
 *
 * @param ctx - The retire's mutation context.
 * @param agents - The employees to retire.
 * @param refusal - The words for an employee whose handover is finishing.
 * @param now - The retire time.
 * @returns What is left to do once the employees are deleted: in real mode the cancels, written
 *   after the deletion so their events stay in the record beside `agent.retired`; nothing
 *   otherwise.
 * @throws ConvexError with `refusal`'s words when any employee's handover is `accepting`.
 */
async function closeOpenTransfers(
  ctx: MutationCtx,
  agents: readonly Doc<'agents'>[],
  refusal: (name: string, toAddress: string) => string,
  now: number,
): Promise<() => Promise<void>> {
  const open = (
    await Promise.all(
      agents.flatMap((agent) =>
        OPEN_MANAGER_TRANSFER_STATES.map(async (state) =>
          (
            await ctx.db
              .query('managerTransfers')
              .withIndex('by_agent_state', (q) => q.eq('agentId', agent._id).eq('state', state))
              .collect()
          ).map((transfer) => ({ agent, transfer })),
        ),
      ),
    )
  ).flat();
  const finishing = open.find(({ transfer }) => !canMoveTransfer(transfer.state, 'cancelled'));
  if (finishing) {
    throw new ConvexError(refusal(finishing.agent.name, finishing.transfer.toAddress));
  }
  const cancel = async (): Promise<void> => {
    for (const { transfer } of open) {
      if (isTransferDue(transfer, now)) continue;
      await cancelTransferInTransaction(ctx, transfer, 'retired', now);
    }
  };
  // Real mode keeps the employee's record beside its retirement, so the cancel follows the
  // deletion there and its event stays in it; the hosted office wipes the record, cancel and all.
  if (SURFACE_MODE === 'real') return cancel;
  await cancel();
  return async (): Promise<void> => undefined;
}

/**
 * Retire one employee (decisions Q15 and N1): the Manage tab's Retire, once the manager has
 * typed its confirmation. Public; the caller must own the employee, and one already retired is
 * refused as not found. Real mode revokes what only it bound, deletes its working rows and
 * keeps one retirement row with an `agent.retired` event; the hosted office wipes it. What it
 * would do is `retirePreview`'s answer. Owner-level documentation and credentials are never
 * touched here: unlinking them retires every employee (`deleteMyData`). An open handover request
 * for it is cancelled (reason `retired`); one the named manager has accepted and that is still
 * finishing refuses the retire.
 *
 * @returns The retired employee's name.
 * @throws ConvexError when the employee holds more than one retirement keeps, or its handover is
 *   finishing ({@link retireDuringHandoverRefusal}).
 */
export const retire = mutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ agentName: string }> => {
    const identity = await getCallerOrThrow(ctx);
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const cancelAfter = await closeOpenTransfers(
      ctx,
      [agent],
      retireDuringHandoverRefusal,
      Date.now(),
    );
    await retireEmployees(ctx, identity.ownerKey, [agent], {
      single: true,
      unlinkDocumentation: false,
    });
    await cancelAfter();
    return { agentName: agent.name };
  },
});

/** The most handover requests of one party, per state and side, one page of the scrub reads. */
const HANDOVER_SCRUB_PAGE = 200;

/** Whose handover requests a deletion scrubs: the ones it asked, and the ones naming its address. */
const handoverPartyValidator = v.object({
  ownerKey: v.string(),
  address: v.optional(v.string()),
});

/** A handover request still carrying words a deletion scrubs: its note or its decline's reason. */
function carryingWords(
  q: FilterBuilder<NamedTableInfo<DataModel, 'managerTransfers'>>,
): ExpressionOrValue<boolean> {
  return q.or(q.neq(q.field('note'), undefined), q.neq(q.field('declineReason'), undefined));
}

/**
 * Scrub the words a person wrote into the handover requests a deletion keeps (decision 7, a
 * product call taken as recommended): the note on each request the owner asked, and both the
 * note and the decline's reason on each that named the owner's verified address, so neither the
 * owner's own words nor what was written to them outlives their data. The rows stay with both
 * addresses, the employee's name and the outcome: the other manager's record of where the
 * employee went or what it took on. Paged by state over the two indexes, the rows still carrying
 * a note or a reason only; a full page schedules the next.
 *
 * @param ctx - The deletion's mutation context.
 * @param party - The deleting owner and their verified address, when they have one.
 * @returns How many requests were scrubbed in this page.
 */
async function scrubHandoverWords(
  ctx: MutationCtx,
  party: Infer<typeof handoverPartyValidator>,
): Promise<number> {
  const { address } = party;
  const pages = await Promise.all(
    MANAGER_TRANSFER_STATES.flatMap((state) => [
      ctx.db
        .query('managerTransfers')
        .withIndex('by_from_owner_state', (q) =>
          q.eq('fromOwnerKey', party.ownerKey).eq('state', state),
        )
        .filter(carryingWords)
        .take(HANDOVER_SCRUB_PAGE),
      address === undefined
        ? Promise.resolve([])
        : ctx.db
            .query('managerTransfers')
            .withIndex('by_to_address_state', (q) => q.eq('toAddress', address).eq('state', state))
            .filter(carryingWords)
            .take(HANDOVER_SCRUB_PAGE),
    ]),
  );
  const rows = new Map(pages.flat().map((row) => [row._id, row]));
  for (const row of rows.values()) {
    await ctx.db.patch(row._id, { note: undefined, declineReason: undefined });
  }
  if (pages.some((page) => page.length === HANDOVER_SCRUB_PAGE)) {
    await ctx.scheduler.runAfter(0, internal.reset.scrubHandoverWordsPage, party);
  }
  return rows.size;
}

/**
 * The next page of a deletion's scrub of handover words ({@link scrubHandoverWords}).
 *
 * Internal, scheduled by the scrub itself when a page was full. Writes the scrubbed fields.
 *
 * @returns How many requests this page scrubbed.
 */
export const scrubHandoverWordsPage = internalMutation({
  args: handoverPartyValidator,
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => await scrubHandoverWords(ctx, args),
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
 *
 * Every open handover request of the owner's employees is cancelled (reason `retired`); while one
 * is `accepting` nothing is deleted and the refusal names the wait. A request naming the caller
 * leaves its employee alone, since it is not the caller's until it moves. Every request kept,
 * asked by the caller or naming them, loses its note and its decline's reason
 * ({@link scrubHandoverWords}, decision 7).
 *
 * @throws ConvexError with {@link deleteDuringHandoverRefusal}'s words while a handover is finishing.
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
    const cancelAfter = await closeOpenTransfers(
      ctx,
      agents,
      deleteDuringHandoverRefusal,
      Date.now(),
    );
    const { unlinkedSources } = await retireEmployees(ctx, userId, agents, {
      single: false,
      unlinkDocumentation: args.alsoUnlinkDocumentation === true,
    });
    await cancelAfter();
    const address = verifiedAddressOf(identity);
    await scrubHandoverWords(ctx, {
      ownerKey: userId,
      ...(address === undefined ? {} : { address }),
    });
    return { deleted: agents.length, unlinkedSources };
  },
});

/** Whether the owner holds each kind of row a deletion of their data removes or changes. */
const holdingsValidator = v.object({
  employees: v.boolean(),
  skillLibrary: v.boolean(),
  handoverWords: v.boolean(),
  retiredBoundaries: v.boolean(),
  documentation: v.boolean(),
});

/**
 * What {@link deleteMyData} would take from one owner, each kind as whether any is held: an
 * employee (evaluation agents included), a version in the owner's skill library, a handover
 * request carrying words the scrub clears (one the owner asked, or one naming their verified
 * address), and in real mode a retirement still keeping a claim or a rejection, which the deletion
 * releases; and the documentation only the unlink choice takes. Each read stops at its first
 * match, the handover reads scanning the party's requests of one state until one carries words,
 * and the retirements read stops at their cap, so the home page can subscribe to it.
 *
 * @param db - The query's reader.
 * @param party - The owner and their verified address, when they have one.
 */
async function deletionHoldings(
  db: DatabaseReader,
  party: Infer<typeof handoverPartyValidator>,
): Promise<Infer<typeof holdingsValidator>> {
  const { ownerKey, address } = party;
  const [employee, version, source, requests, retirements] = await Promise.all([
    db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', ownerKey))
      .first(),
    db
      .query('skillVersions')
      .withIndex('by_owner_shape', (q) => q.eq('userId', ownerKey))
      .first(),
    db
      .query('docSources')
      .withIndex('by_user', (q) => q.eq('userId', ownerKey))
      .first(),
    Promise.all(
      MANAGER_TRANSFER_STATES.flatMap((state) => [
        db
          .query('managerTransfers')
          .withIndex('by_from_owner_state', (q) =>
            q.eq('fromOwnerKey', ownerKey).eq('state', state),
          )
          .filter(carryingWords)
          .first(),
        address === undefined
          ? Promise.resolve(null)
          : db
              .query('managerTransfers')
              .withIndex('by_to_address_state', (q) =>
                q.eq('toAddress', address).eq('state', state),
              )
              .filter(carryingWords)
              .first(),
      ]),
    ),
    // The newest up to the cap, without `ownerRetirements`' refusal past it: a subscribed read
    // that threw would take the whole home page down. Past the cap the deletion itself refuses.
    SURFACE_MODE === 'real'
      ? db
          .query('retirements')
          .withIndex('by_user', (q) => q.eq('userId', ownerKey))
          .order('desc')
          .take(RETIREMENT_READ_LIMIT)
      : Promise.resolve([]),
  ]);
  return {
    employees: employee !== null,
    skillLibrary: version !== null,
    handoverWords: requests.some((request) => request !== null),
    retiredBoundaries: retirements.some(
      (retirement) => retirement.claims.length > 0 || retirement.rejections.length > 0,
    ),
    documentation: source !== null,
  };
}

/**
 * Public, any caller; reads only the caller's own: whether each kind of row a deletion of their
 * data would remove is held ({@link deletionHoldings}), so the deletion's control is live
 * whenever the deletion has something to take, an employee or not (the v0.13.0 walk). Writes
 * nothing. An anonymous caller gets `null`.
 */
export const holdings = query({
  args: {},
  returns: v.union(v.null(), holdingsValidator),
  handler: async (ctx): Promise<Infer<typeof holdingsValidator> | null> => {
    const identity = await getCaller(ctx);
    if (!identity) return null;
    const address = verifiedAddressOf(identity);
    return await deletionHoldings(ctx.db, {
      ownerKey: identity.ownerKey,
      ...(address === undefined ? {} : { address }),
    });
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

/** What the retire will do at the vendor for one connection (11-AR). */
const previewOutcome = v.object({
  slug: v.string(),
  displayName: v.string(),
  /** The system the outcome is at: `issuedBy.system`, or the connection's name for a key. */
  system: v.string(),
  outcome: v.union(
    v.literal('token-revoked'),
    v.literal('app-deleted'),
    v.literal('app-uninstalled'),
    v.literal('not-supported'),
    v.literal('failed'),
    v.literal('shared'),
    v.literal('not-at-vendor'),
    v.literal('pasted-key'),
    v.literal('kept'),
  ),
  /** Why no vendor is called, in the plan's own words, where the plan gives them (R41V-11). */
  reason: v.optional(v.string()),
});

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
  /**
   * What the retire will do at the vendor, one entry per connection that binds a credential
   * (11-AR): the token revoked or the app deleted or uninstalled there, no call the system offers,
   * a token Day0 can no longer revoke (`failed`: its value is gone), a token the organisation
   * shares, a pasted key deleted from Day0 and never sent, or a key kept for what still binds it.
   */
  outcomes: v.array(previewOutcome),
  /** The items it may already have written, whose claims its retirement keeps. */
  keptClaims: v.number(),
  /** Whether the claims were counted over the first `RETIRE_PREVIEW_ROW_LIMIT` items only, so the count is a floor. */
  keptClaimsAtLeast: v.boolean(),
  /** Whether a retirement row outlives it: real mode only. */
  tombstone: v.boolean(),
});

/**
 * What retiring one employee would do, for the retire dialog to say before the manager
 * confirms: the rows each table would lose, the connections whose credential would be revoked or
 * kept, the claims its retirement would keep and whether a tombstone stays. What waits on the
 * manager is `work.needsYouForAgent`'s answer, the inbox's own rule. Public, owner-guarded;
 * reads by index, at most `RETIRE_PREVIEW_ROW_LIMIT` rows a table, the work items once for the
 * counts and the claims; writes nothing. Guarded by `ownedAgentOrNull`, as the employee page's own
 * read is: an employee already gone answers `null`, another owner's is refused.
 */
export const retirePreview = query({
  args: { agentId: v.id('agents') },
  returns: v.union(v.null(), retirePreviewValidator),
  handler: async (ctx, args): Promise<Infer<typeof retirePreviewValidator> | null> => {
    const agent = await ownedAgentOrNull(ctx, args.agentId);
    if (agent === null) return null;
    const identity = await getCallerOrThrow(ctx);
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
        outcomes: [],
        keptClaims: 0,
        keptClaimsAtLeast: false,
        tombstone: false,
      };
    }
    const surfaces = await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
      .take(RETIRE_PREVIEW_ROW_LIMIT);
    const cards = await Promise.all(
      surfaces.map(async (surface) => ({
        surface,
        bound: await credentialsBoundBy(ctx.db, [surface]),
      })),
    );
    const { revoke, kept } = await sortCredentials(
      ctx.db,
      identity.ownerKey,
      new Set(cards.flatMap((card) => [...card.bound])),
      new Set([agent._id]),
    );
    const revokedIds = new Set(revoke.map((credential) => credential._id));
    const named = (holds: (id: Id<'credentials'>) => boolean) =>
      cards
        .filter((card) => [...card.bound].some(holds))
        .map(({ surface }) => ({ slug: surface.slug, displayName: surface.displayName }));
    const outcomes: Infer<typeof previewOutcome>[] = [];
    for (const { surface, bound } of cards) {
      const rows = (await Promise.all([...bound].map(async (id) => await ctx.db.get(id)))).filter(
        (row): row is Doc<'credentials'> => row !== null,
      );
      const planned = await plannedAtSource(
        ctx.db,
        {
          surfaceName: surface.displayName,
          ended: rows.filter((row) => revokedIds.has(row._id) || row.holder !== undefined),
          kept: rows.filter((row) => kept.has(row._id)),
        },
        'retire',
      );
      if (planned !== null) {
        outcomes.push({ slug: surface.slug, displayName: surface.displayName, ...planned });
      }
    }
    const boundaries = await boundariesOf(ctx.db, items, Date.now());
    return {
      mode: 'real',
      rowCounts,
      atLeast,
      revoked: named((id) => revokedIds.has(id)),
      kept: named((id) => kept.has(id)),
      outcomes,
      keptClaims: boundaries.claims.length,
      keptClaimsAtLeast: items.length >= RETIRE_PREVIEW_ROW_LIMIT,
      tombstone: true,
    };
  },
});
