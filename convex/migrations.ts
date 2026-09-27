/**
 * The upgrade's migrations and the release stamp it compares (Q12, N10).
 *
 * A schema change that existing rows do not fit ships as two releases: the
 * first declares both shapes and runs a migration here, the second removes
 * the old declaration once every deployment has run it. Each migration reads
 * one bounded page per transaction and keeps its cursor in the `migrations`
 * table, so a deployment of any size migrates inside the transaction limits,
 * an interrupted run resumes where it stopped, and a finished migration is
 * never run again.
 *
 * The upgrade (`./setup.sh upgrade`, or any setup run over an existing
 * volume) pushes the functions, then runs
 *
 *   npx convex run migrations:runPending
 *
 * until nothing is pending, and only then stamps the release with
 * `migrations:recordRelease`, which refuses while a migration is unfinished.
 * The demo bed's `up` and the hosted deployment take the same two calls.
 */
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { backfillAccessSetByPage, restartAccessClocksPage } from './surfaces';
import { keepTicketListing, WORK_LISTED_EVENT } from './work';
import type { TicketSnapshot } from '../src/work/ticket-ownership';
import { AGENT_RETIRED_EVENT } from './reset';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { avatarById } from '../src/agent/avatar-pets';
import { deploymentZone } from '../src/lib/zone';

/**
 * Every migration, in the order the upgrade runs them. The access clocks come
 * first, so the hourly sweep has the least time to end a card on the clock
 * they restart; owners come before the inclusion-list conversion, which reads
 * an adopted agent's sources.
 */
export const MIGRATION_NAMES = [
  'surfaces-access-clock',
  'agents-owner',
  'credentials-sync-revoke',
  'ticket-listings',
  'agents-zone',
  'retirements-from-tombstones',
  'surfaces-approved-tools',
  'surfaces-access-set-by',
  'agents-avatar-digest',
] as const;

/** One migration's name. */
export type MigrationName = (typeof MIGRATION_NAMES)[number];

/** What a migration does, the release that ships it and what the next release may then remove. */
export interface MigrationDescription {
  readonly release: string;
  readonly does: string;
  /** The declaration or dual-read the release after `release` removes, once this has run everywhere. */
  readonly thenRemoves: string;
}

/** The release that ships the first set of migrations. */
const FIRST_MIGRATIONS_RELEASE = '0.4.0';

/** The release after it, which gives every agent a zone and a mode (N12, the M2 backfill). */
const ZONE_RELEASE = '0.5.0';

/** The schema step after that: retirements, the freeze's approved list, the attempt count. */
const SCHEMA_STEP_RELEASE = '0.6.0';

/** Every migration's description, keyed by name. */
export const MIGRATIONS: Readonly<Record<MigrationName, MigrationDescription>> = {
  'agents-owner': {
    release: FIRST_MIGRATIONS_RELEASE,
    does: 'gives an agent with no owner to the deployment’s one owner, when it has exactly one',
    thenRemoves: 'nothing: agents.userId stays optional until the customer profile keys owners',
  },
  'credentials-sync-revoke': {
    release: FIRST_MIGRATIONS_RELEASE,
    does: 'clears the revokedAt a documentation sync stamped when it superseded a credential, so the value revives when it returns; a person’s revoke stays',
    thenRemoves: 'nothing: revokedAt is a person’s revoke from here on',
  },
  'ticket-listings': {
    release: FIRST_MIGRATIONS_RELEASE,
    does: 'copies each kept work.listed snapshot into ticketListings, where the re-read before apply now looks',
    thenRemoves: 'nothing: work.listed events stay as the feed’s record',
  },
  'agents-zone': {
    release: ZONE_RELEASE,
    does: 'gives an agent with no zone the deployment’s current zone, and one with no mode the deployment’s mode; the status note names the zone',
    thenRemoves: 'nothing: an absent zone still reads as the deployment’s',
  },
  'retirements-from-tombstones': {
    release: SCHEMA_STEP_RELEASE,
    does: 'copies each retire tombstone an older release wrote as an agent.retired payload into the owner’s retirements table, where the export’s owner section now reads it',
    thenRemoves: 'nothing: the agent.retired events stay as the ledger’s record',
  },
  'surfaces-approved-tools': {
    release: SCHEMA_STEP_RELEASE,
    does: 'copies the tool list of each card that stores one into its approved list, which every later probe is frozen against and only the manager widens',
    thenRemoves: 'the fallback to toolAllowlist in surfaces.frozenTools',
  },
  'surfaces-access-set-by': {
    release: SCHEMA_STEP_RELEASE,
    does: 'records on each card with an access end date who set it, from its newest surface.access-set event, or the upgrade when it has none',
    thenRemoves: 'nothing: accessSetBy is written wherever the clock is set from here on',
  },
  'agents-avatar-digest': {
    release: SCHEMA_STEP_RELEASE,
    does: 'rewrites an avatar id the gallery no longer lists, the handle-keyed ids of earlier builds, to the face the dashboard already shows for it',
    thenRemoves: 'nothing: avatarById keeps its digest fallback for an id a client sends',
  },
  'surfaces-access-clock': {
    release: FIRST_MIGRATIONS_RELEASE,
    does: 'restarts an approved card’s access clock, which the old code started at proposal, at the default length from the upgrade',
    thenRemoves: 'nothing: the surface.access-set event it writes is the record',
  },
};

const migrationName = v.union(...MIGRATION_NAMES.map((name) => v.literal(name)));

/** Rows one page of a migration reads. */
const MIGRATION_PAGE = 100;

/**
 * Events one page of the listing copy reads. Event payloads are the largest
 * rows (a run's output rides on them), so the page is small enough that ten
 * documents at the 1 MiB document ceiling stay inside the 16 MiB read limit.
 * A byte bound on the page is not used: a page it cuts short may leave rows
 * unread, and a migration must not skip one.
 */
const EVENT_PAGE = 10;

/** How long one `runPending` call migrates before it hands back what is left. */
const RUN_BUDGET_MS = 8 * 60 * 1_000;

/** One page of one migration. */
interface MigrationPage {
  readonly read: number;
  readonly changed: number;
  readonly cursor: string;
  readonly isDone: boolean;
  /** What the migration chose where it had to choose, kept on its row. */
  readonly note?: string;
}

/** A migration as far as it has got. */
export interface MigrationProgress {
  readonly name: MigrationName;
  readonly release: string;
  readonly read: number;
  readonly changed: number;
  readonly completedAt?: number;
  /** What the migration chose where it had to choose. */
  readonly note?: string;
  /** Set when the migration had already finished before this call, so nothing ran. */
  readonly finishedEarlier?: true;
}

/**
 * The owner every owned agent shares, or undefined when there are none or
 * more than one. Two reads of the owner index, first and last.
 */
async function soleOwner(ctx: QueryCtx): Promise<string | undefined> {
  const [first, last] = await Promise.all([
    ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.gt('userId', ''))
      .first(),
    ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.gt('userId', ''))
      .order('desc')
      .first(),
  ]);
  return first?.userId !== undefined && first.userId === last?.userId ? first.userId : undefined;
}

/**
 * Give ownerless agents to the deployment's one owner. An agent from before
 * owners existed is driven by the crons and reachable by nobody; on a
 * deployment with one owner it can only be theirs. With several owners it is
 * read and left, and the upgrade reports how many.
 */
async function adoptOwnerless(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const owner = await soleOwner(ctx);
  const page = await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', undefined))
    .paginate({ cursor, numItems: MIGRATION_PAGE });
  if (owner !== undefined) {
    for (const agent of page.page) await ctx.db.patch(agent._id, { userId: owner });
  }
  return {
    read: page.page.length,
    changed: owner === undefined ? 0 : page.page.length,
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/**
 * Clear `revokedAt` where a documentation sync stamped it, not a person.
 *
 * Before 27 September the sync superseded a credential that left its page by
 * stamping `revokedAt` with the moment the run completed, and that stamp kept
 * the row dead when the value came back (U2 decision 1). Convex freezes
 * `Date.now()` inside a mutation, so the sync's stamp equals the superseding
 * run's `completedAt` exactly; a person's revoke, made in its own mutation,
 * carries a different moment and is left alone.
 */
async function clearSyncRevokes(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('credentials').paginate({ cursor, numItems: MIGRATION_PAGE });
  let changed = 0;
  for (const credential of page.page) {
    const { revokedAt, source } = credential;
    if (credential.status !== 'superseded' || revokedAt === undefined) continue;
    if (typeof source === 'string') continue;
    const run = await ctx.db
      .query('docSyncRuns')
      .withIndex('by_source_completed_at', (q) =>
        q.eq('sourceId', source.sourceId).eq('completedAt', revokedAt),
      )
      .first();
    if (run?.state !== 'completed') continue;
    await ctx.db.patch(credential._id, { revokedAt: undefined });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/** A kept listing's ticket, read field by field from an untyped event payload. */
function snapshotOf(value: unknown): TicketSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const tracker = value as Record<string, unknown>;
  if (typeof tracker.assigned !== 'boolean' || typeof tracker.doNotAutomate !== 'boolean') {
    return undefined;
  }
  const text = (field: string): string | undefined =>
    typeof tracker[field] === 'string' ? tracker[field] : undefined;
  return {
    assigned: tracker.assigned,
    doNotAutomate: tracker.doNotAutomate,
    ...(text('assigneeId') !== undefined ? { assigneeId: text('assigneeId') } : {}),
    ...(text('assigneeEmail') !== undefined ? { assigneeEmail: text('assigneeEmail') } : {}),
    ...(text('state') !== undefined ? { state: text('state') } : {}),
    ...(text('stateType') !== undefined ? { stateType: text('stateType') } : {}),
  };
}

/** Copy the listings kept as `work.listed` events into `ticketListings`. */
async function copyListings(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('events').paginate({ cursor, numItems: EVENT_PAGE });
  let changed = 0;
  for (const event of page.page) {
    if (event.type !== WORK_LISTED_EVENT) continue;
    const payload = event.payload as { workItemId?: unknown; tracker?: unknown; refused?: unknown };
    const tracker = snapshotOf(payload.tracker);
    const workItemId =
      typeof payload.workItemId === 'string'
        ? ctx.db.normalizeId('workItems', payload.workItemId)
        : null;
    if (tracker === undefined || workItemId === null) continue;
    const item = await ctx.db.get(workItemId);
    if (item === null) continue;
    const kept = await keepTicketListing(ctx, item, {
      tracker,
      refused: typeof payload.refused === 'string' ? payload.refused : undefined,
      listedAt: event.createdAt,
    });
    if (kept) changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/**
 * Give every agent without one the deployment's zone and mode (N12's M2
 * backfill). The deployment's zone is the backend process's own, UTC on the
 * pinned image unless `TZ` is set; the manager changes it on the card.
 */
async function stampZoneAndMode(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const zone = deploymentZone();
  const page = await ctx.db.query('agents').paginate({ cursor, numItems: MIGRATION_PAGE });
  const missing = page.page.filter((agent) => agent.zone === undefined || agent.mode === undefined);
  for (const agent of missing) {
    await ctx.db.patch(agent._id, {
      ...(agent.zone === undefined ? { zone } : {}),
      ...(agent.mode === undefined ? { mode: SURFACE_MODE } : {}),
    });
  }
  return {
    read: page.page.length,
    changed: missing.length,
    cursor: page.continueCursor,
    isDone: page.isDone,
    note: `agents with no zone given the deployment’s zone, ${zone}; with no mode, ${SURFACE_MODE}`,
  };
}

/**
 * Copy the retire tombstones older releases kept on `agent.retired` events
 * into `retirements`. A tombstone this release wrote names its row already
 * and is passed over; so is one without an owner, which no owner section
 * could list.
 */
async function copyRetirements(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db
    .query('events')
    .withIndex('by_type', (q) => q.eq('type', AGENT_RETIRED_EVENT))
    .paginate({ cursor, numItems: EVENT_PAGE });
  let changed = 0;
  for (const event of page.page) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (payload.retirementId !== undefined || typeof payload.userId !== 'string') continue;
    const count = (value: unknown): number => (typeof value === 'number' ? value : 0);
    const rowCounts = Object.fromEntries(
      Object.entries(
        typeof payload.rowCounts === 'object' && payload.rowCounts !== null
          ? (payload.rowCounts as Record<string, unknown>)
          : {},
      ).flatMap(([table, rows]) => (typeof rows === 'number' ? [[table, rows]] : [])),
    );
    await ctx.db.insert('retirements', {
      userId: payload.userId,
      agentId: event.agentId,
      retiredAt: typeof payload.retiredAt === 'number' ? payload.retiredAt : event.createdAt,
      rowCounts,
      revokedCredentials: count(payload.revokedCredentials),
      keptCredentials: count(payload.keptCredentials),
      claims: [],
      rejections: [],
    });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/**
 * Give each card that stores a tool list an approved list of the same tools,
 * stamped at its last verification, so the freeze reads the approved list
 * whatever became of the stored one. A card with an approved list already is
 * left alone.
 */
async function copyApprovedTools(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('surfaces').paginate({ cursor, numItems: MIGRATION_PAGE });
  const carrying = page.page.filter(
    (surface) => surface.toolAllowlist !== undefined && surface.approvedToolAllowlist === undefined,
  );
  for (const surface of carrying) {
    await ctx.db.patch(surface._id, {
      approvedToolAllowlist: surface.toolAllowlist,
      toolAllowlistApprovedAt: surface.lastVerifiedAt ?? surface.createdAt,
    });
  }
  return {
    read: page.page.length,
    changed: carrying.length,
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/**
 * Rewrite every stored avatar id the gallery does not list to the listed face
 * `avatarById` already shows for it (U15 D1 (a)): an earlier build keyed faces
 * by a person's handle (`tw-<handle>`), which an export would otherwise carry.
 */
async function rewriteAvatarIds(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('agents').paginate({ cursor, numItems: MIGRATION_PAGE });
  let changed = 0;
  for (const agent of page.page) {
    if (agent.avatarId === undefined) continue;
    const listed = avatarById(agent.avatarId).id;
    if (listed === agent.avatarId) continue;
    await ctx.db.patch(agent._id, { avatarId: listed });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/** Each migration's page, keyed by name, so a name with no page fails the typecheck. */
const MIGRATION_PAGES: Readonly<
  Record<MigrationName, (ctx: MutationCtx, cursor: string | null) => Promise<MigrationPage>>
> = {
  'agents-owner': adoptOwnerless,
  'credentials-sync-revoke': clearSyncRevokes,
  'ticket-listings': copyListings,
  'agents-zone': stampZoneAndMode,
  'retirements-from-tombstones': copyRetirements,
  'surfaces-approved-tools': copyApprovedTools,
  'surfaces-access-set-by': async (ctx, cursor) => await backfillAccessSetByPage(ctx, cursor),
  'agents-avatar-digest': rewriteAvatarIds,
  'surfaces-access-clock': async (ctx, cursor) =>
    await restartAccessClocksPage(ctx, cursor, Date.now()),
};

/** A migration's row, if it has started. */
async function migrationRow(ctx: QueryCtx, name: MigrationName): Promise<Doc<'migrations'> | null> {
  return await ctx.db
    .query('migrations')
    .withIndex('by_name', (q) => q.eq('name', name))
    .unique();
}

/** A migration's progress as the upgrade reports it. */
function progressOf(
  name: MigrationName,
  row: Pick<Doc<'migrations'>, 'read' | 'changed' | 'completedAt' | 'note'> | null,
): MigrationProgress {
  return {
    name,
    release: MIGRATIONS[name].release,
    read: row?.read ?? 0,
    changed: row?.changed ?? 0,
    ...(row?.completedAt !== undefined ? { completedAt: row.completedAt } : {}),
    ...(row?.note !== undefined ? { note: row.note } : {}),
  };
}

/**
 * Run the next page of one migration and record where it reached. Internal;
 * called by `runPending`. A finished migration reads nothing and writes
 * nothing.
 */
export const runMigrationPage = internalMutation({
  args: { name: migrationName },
  handler: async (ctx, args): Promise<MigrationProgress> => {
    const row = await migrationRow(ctx, args.name);
    if (row?.completedAt !== undefined) {
      return { ...progressOf(args.name, row), finishedEarlier: true };
    }
    const page = await MIGRATION_PAGES[args.name](ctx, row?.cursor ?? null);
    const now = Date.now();
    const reached = {
      cursor: page.isDone ? undefined : page.cursor,
      read: (row?.read ?? 0) + page.read,
      changed: (row?.changed ?? 0) + page.changed,
      completedAt: page.isDone ? now : undefined,
      note: page.note ?? row?.note,
    };
    if (row === null) {
      await ctx.db.insert('migrations', {
        name: args.name,
        release: MIGRATIONS[args.name].release,
        startedAt: now,
        ...reached,
      });
    } else {
      await ctx.db.patch(row._id, reached);
    }
    return progressOf(args.name, reached);
  },
});

/**
 * Run every unfinished migration to the end, in order, and say what each
 * one this call ran changed; a migration finished by an earlier call is not
 * reported again. Internal; the upgrade calls it through `npx convex run`. A call
 * that reaches its time budget returns with the rest still pending, and the
 * next call carries on from the stored cursor.
 */
export const runPending = internalAction({
  args: {},
  handler: async (ctx): Promise<{ migrations: MigrationProgress[]; pending: MigrationName[] }> => {
    const startedAt = Date.now();
    const migrations: MigrationProgress[] = [];
    for (const [index, name] of MIGRATION_NAMES.entries()) {
      // One transaction per page, so no migration meets the per-transaction
      // read and write limits however many rows the deployment holds.
      let progress = await ctx.runMutation(internal.migrations.runMigrationPage, { name });
      while (progress.completedAt === undefined) {
        if (Date.now() - startedAt > RUN_BUDGET_MS) {
          return { migrations, pending: MIGRATION_NAMES.slice(index) };
        }
        progress = await ctx.runMutation(internal.migrations.runMigrationPage, { name });
      }
      if (progress.finishedEarlier !== true) migrations.push(progress);
    }
    return { migrations, pending: [] };
  },
});

/** The release stamp as the upgrade reads it. */
export interface ReleaseStamp {
  readonly release: string;
  readonly commit?: string;
  readonly recordedAt: number;
}

/** The newest release stamp, or null on a deployment that has none. */
async function latestRelease(ctx: QueryCtx): Promise<ReleaseStamp | null> {
  const row = await ctx.db.query('deploymentVersions').order('desc').first();
  if (row === null) return null;
  return {
    release: row.release,
    recordedAt: row.recordedAt,
    ...(row.commit !== undefined ? { commit: row.commit } : {}),
  };
}

/**
 * Every migration's progress and the release the rows are at. Internal;
 * `npx convex run migrations:status` prints it.
 */
export const status = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    release: ReleaseStamp | null;
    migrations: MigrationProgress[];
    pending: MigrationName[];
  }> => {
    const migrations = await Promise.all(
      MIGRATION_NAMES.map(async (name) => progressOf(name, await migrationRow(ctx, name))),
    );
    return {
      release: await latestRelease(ctx),
      migrations,
      pending: migrations.flatMap((row) => (row.completedAt === undefined ? [row.name] : [])),
    };
  },
});

/**
 * Stamp the release the rows are now at. Internal; the upgrade calls it last.
 * Refused while any migration is unfinished, so a stamp always means every
 * row has the shape that release expects. Stamping the release and commit the
 * deployment already carries writes nothing.
 *
 * @throws Error naming the unfinished migrations.
 */
export const recordRelease = internalMutation({
  args: { release: v.string(), commit: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ release: string; previous: string | null }> => {
    const unfinished: MigrationName[] = [];
    for (const name of MIGRATION_NAMES) {
      if ((await migrationRow(ctx, name))?.completedAt === undefined) unfinished.push(name);
    }
    if (unfinished.length > 0) {
      throw new Error(
        `migrations still to run (${unfinished.join(', ')}); run \`npx convex run migrations:runPending\` first`,
      );
    }
    const latest = await latestRelease(ctx);
    if (latest?.release !== args.release || latest.commit !== args.commit) {
      await ctx.db.insert('deploymentVersions', {
        release: args.release,
        recordedAt: Date.now(),
        ...(args.commit !== undefined ? { commit: args.commit } : {}),
      });
    }
    return { release: args.release, previous: latest?.release ?? null };
  },
});
