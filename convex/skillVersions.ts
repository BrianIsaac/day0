import { v, type Infer } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  query,
  type DatabaseReader,
  type MutationCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, assertOwnsSkill } from './ownership';
import { appendEvent, eventsOfType } from './eventLog';
import { readRefValidator } from './schema';
import { isEventOf } from '../src/events/contract';
import {
  CHECK_NOT_KEPT_REASON,
  HANDED_OVER_AUTHOR_NAME,
  HANDED_OVER_RECHECK_REASON,
  isNewerVersionReason,
  newerVersionReason,
  nextVersionNumber,
  sharedSkillsEnabled,
  surfaceCutReason,
  versionBodyHash,
  type SurfaceTools,
} from '../src/work/skill-library';

/*
 * The owner's skill library (the enhancements plan, section 4.1; K1 to K4).
 *
 * A version is what a verified skill is; an employee's `skills` row is what it holds. Every
 * lookup goes through `ownerVersions`, which leads every index read with the owner key, so a
 * lookup can only ever answer the owner it names: a lookup across owners is impossible by index,
 * not refused by a filter. 13-K re-points that one helper to `ownerScope`.
 *
 * Writers: registration (`skills.completeRegistration`, through `recordRegisteredVersion`), the
 * re-check stamp (`stampRecheckDue`, the helper every trigger calls), the handover's copy
 * (`copyVersionsForMove`), the retire and the whole-owner reset (`releaseAuthor`,
 * `deleteOwnerLibrary`), and the two backfills `migrations:runPending` runs.
 */

/** The most versions one lookup reads: versions of one name or shape under one owner. */
export const LIBRARY_LOOKUP_LIMIT = 200;

/** A page the authoring run read, as a version records it for the page-change triggers. */
export type ReadRef = Infer<typeof readRefValidator>;

/** What one library lookup asks for: the versions of a shape, or of a name. */
export type LibraryLookup =
  | { readonly by: 'shape'; readonly surfaceClass: string; readonly operation: string }
  | { readonly by: 'name'; readonly name: string };

/**
 * Whether skills are shared between an owner's employees (`DAY0_SHARED_SKILLS`, K4): on unless
 * the deployment's flag says off. Read on each call, so a changed deployment setting applies to
 * the next offer without a push.
 */
export function sharedSkillsOn(): boolean {
  return sharedSkillsEnabled(process.env.DAY0_SHARED_SKILLS);
}

/**
 * The owner's versions a lookup names, newest version first: the one place the library is read
 * by owner. Each read leads its index with the owner key, so no other owner's version can be
 * returned whatever the rest of the lookup says.
 *
 * @param db - A query's or a mutation's database.
 * @param ownerKey - The owner key (`agents.userId`).
 * @param lookup - The shape or the name.
 * @returns At most {@link LIBRARY_LOOKUP_LIMIT} versions.
 */
export async function ownerVersions(
  db: DatabaseReader,
  ownerKey: string,
  lookup: LibraryLookup,
): Promise<Doc<'skillVersions'>[]> {
  const rows =
    lookup.by === 'name'
      ? await db
          .query('skillVersions')
          .withIndex('by_owner_name_version', (q) =>
            q.eq('userId', ownerKey).eq('name', lookup.name),
          )
          .order('desc')
          .take(LIBRARY_LOOKUP_LIMIT)
      : await db
          .query('skillVersions')
          .withIndex('by_owner_shape', (q) =>
            q
              .eq('userId', ownerKey)
              .eq('surfaceClass', lookup.surfaceClass)
              .eq('operation', lookup.operation),
          )
          .order('desc')
          .take(LIBRARY_LOOKUP_LIMIT);
  return rows.sort((left, right) => right.version - left.version);
}

/**
 * Every employee's row that holds a version. A version's holders are one owner's employees, so
 * the set is as small as that owner's staff.
 *
 * @param db - A query's or a mutation's database.
 * @param versionId - The version.
 */
export async function holdersOf(
  db: DatabaseReader,
  versionId: Id<'skillVersions'>,
): Promise<Doc<'skills'>[]> {
  return await db
    .query('skills')
    .withIndex('by_version', (q) => q.eq('versionId', versionId))
    .collect();
}

/**
 * Stamp "Re-check due" on a registered row, with the trigger's reason (A13: every re-check is
 * event-driven). The chip is never cleared here: only a passing re-check clears it
 * (`skills.completeRegistration`), and only of a stamp made before the check began. A row
 * already due keeps its first reason, so the earliest cause stays on the card, and its first
 * stamp unless a check is running, whose pass must not clear a change it never saw; every
 * trigger still lands on the record as a `skill.recheck-due` event. A row that is not registered runs nothing and is left alone.
 *
 * @param ctx - The trigger's mutation context.
 * @param stamp - The holder row, why it is due in the card's words, and the trigger's time.
 * @returns Whether the row was stamped by this call.
 */
export async function stampRecheckDue(
  ctx: MutationCtx,
  stamp: { readonly skillId: Id<'skills'>; readonly reason: string; readonly now: number },
): Promise<boolean> {
  const { skillId, reason, now } = stamp;
  const row = await ctx.db.get(skillId);
  if (row?.state !== 'registered') return false;
  const fresh = row.recheckDueAt === undefined;
  if (fresh) {
    await ctx.db.patch(skillId, { recheckDueAt: now, recheckReason: reason });
  } else if (row.authoringRunId !== undefined) {
    // A check is running and did not see this change: the stamp moves to now, so its pass
    // leaves the chip; the first reason stays the card's.
    await ctx.db.patch(skillId, { recheckDueAt: now });
  }
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'skill.recheck-due',
    payload: {
      skillId,
      name: row.name,
      reason,
      ...(row.versionId !== undefined ? { versionId: row.versionId } : {}),
    },
    createdAt: now,
  });
  return fresh;
}

/**
 * Stamp "Re-check due" on every registered skill of one employee that acts on one of the given
 * surfaces: the trigger for a surface whose connection or allowlist changed under it.
 *
 * @param ctx - The trigger's mutation context.
 * @param args - The employee, the surfaces' slugs, the reason for each slug, and the time.
 * @returns How many rows this call stamped.
 */
export async function stampRecheckDueOnSurfaces(
  ctx: MutationCtx,
  args: {
    readonly agentId: Id<'agents'>;
    readonly slugs: readonly string[];
    readonly reasonFor: (slug: string) => string;
    readonly now: number;
  },
): Promise<number> {
  if (args.slugs.length === 0) return 0;
  const slugs = new Set(args.slugs);
  const registered = await ctx.db
    .query('skills')
    .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'registered'))
    .collect();
  let stamped = 0;
  for (const row of registered) {
    if (row.targetSurface === undefined || !slugs.has(row.targetSurface)) continue;
    const reason = args.reasonFor(row.targetSurface);
    if (await stampRecheckDue(ctx, { skillId: row._id, reason, now: args.now })) {
      stamped += 1;
    }
  }
  return stamped;
}

/** What a registration did to the library. */
export type RegisteredVersion =
  | { readonly kind: 'outside' }
  | {
      readonly kind: 'linked' | 'inserted';
      readonly versionId: Id<'skillVersions'>;
      readonly version: number;
      /** Whether the row registered as a version another employee wrote. */
      readonly adopted: boolean;
      /** The version a revision replaced, when this registration superseded one. */
      readonly superseded?: { readonly versionId: Id<'skillVersions'>; readonly version: number };
    };

/** What registration hands the library: the verified body, its passing check and what it read. */
export interface VerifiedContent {
  readonly body: string;
  /** The smoke test that passed, or undefined when the caller did not keep one. */
  readonly smokeTest: string | undefined;
  readonly harnessTools: readonly string[];
  /** The same tools surface by surface; absent where the caller knows no surfaces. */
  readonly harnessToolsBySurface?: readonly SurfaceTools[];
  readonly readRefs: readonly ReadRef[];
  readonly now: number;
  /**
   * Whether a new version stamps the holders of the older versions of its name. True for a
   * registration; false for the backfill, whose versions were all verified before this release
   * and none of which is newer than another in any sense a holder could act on.
   */
  readonly stampsOlderHolders: boolean;
}

/**
 * The owner key of a row the library holds versions for: an agent-authored shaped skill of an
 * owned employee. A builtin, an unshaped legacy row and a row of an employee with no owner stay
 * outside the library.
 */
async function libraryOwnerOf(
  db: DatabaseReader,
  row: Doc<'skills'>,
): Promise<{ ownerKey: string; agent: Doc<'agents'> } | undefined> {
  if (row.sourceType !== 'agent-authored') return undefined;
  if (row.surfaceClass === undefined || row.operation === undefined) return undefined;
  const agent = await db.get(row.agentId);
  if (!agent?.userId) return undefined;
  return { ownerKey: agent.userId, agent };
}

/**
 * Record a registration in the owner's library, in the registration's transaction: link the row
 * to the version it was verified as, or write the next version of its name.
 *
 * In order: the row's own version verified again with the same body (a re-check) keeps its link,
 * and a version whose check was not kept keeps the smoke test that just passed (K3); a version
 * of the name holding exactly this body and smoke test (an adoption's stored body, or a retry of
 * one) is linked, never copied; anything else is version `n+1`. A new version made by a revision
 * (`revisionOf`) supersedes the replaced row's version, and the holders of every older version of
 * the name but the replaced row are stamped "Re-check due" with the newer number.
 *
 * @param ctx - The registration's mutation context.
 * @param row - The holder row as the registration read it.
 * @param content - The verified body, its passing check, the tools it names and the pages read.
 * @returns What the library did, or `outside` for a row the library does not hold.
 */
export async function recordRegisteredVersion(
  ctx: MutationCtx,
  row: Doc<'skills'>,
  content: VerifiedContent,
): Promise<RegisteredVersion> {
  const owner = await libraryOwnerOf(ctx.db, row);
  if (owner === undefined) return { kind: 'outside' };
  const existing = await ownerVersions(ctx.db, owner.ownerKey, { by: 'name', name: row.name });
  const own = existing.find((version) => version._id === row.versionId);
  if (own !== undefined && own.body === content.body) {
    if (own.smokeTest === undefined && content.smokeTest !== undefined) {
      await ctx.db.patch(own._id, {
        smokeTest: content.smokeTest,
        bodyHash: versionBodyHash(own.body, content.smokeTest),
        harnessTools: [...content.harnessTools],
        ...toolsBySurface(content.harnessToolsBySurface),
        verifiedAt: content.now,
      });
    }
    return {
      kind: 'linked',
      versionId: own._id,
      version: own.version,
      adopted: row.adoptedAt !== undefined,
    };
  }
  const bodyHash = versionBodyHash(content.body, content.smokeTest);
  const same = existing.find(
    (version) => version.revokedAt === undefined && version.bodyHash === bodyHash,
  );
  if (same !== undefined) {
    return {
      kind: 'linked',
      versionId: same._id,
      version: same.version,
      // Adopted means the row took the version it was offered, or an adopted row moved onto a
      // version another employee wrote; never a coincidence of content.
      adopted:
        row.offeredVersionId === same._id ||
        (row.adoptedAt !== undefined && same.authorAgentId !== row.agentId),
    };
  }
  const readRefs = await ownedReadRefs(ctx.db, owner.ownerKey, content.readRefs);
  return await insertNextVersion(ctx, row, owner, existing, { ...content, readRefs, bodyHash });
}

/** The optional per-surface tools as a patch: written only when the caller knows them. */
function toolsBySurface(tools: readonly SurfaceTools[] | undefined): {
  harnessToolsBySurface?: SurfaceTools[];
} {
  return tools === undefined || tools.length === 0
    ? {}
    : { harnessToolsBySurface: tools.map((entry) => ({ ...entry, tools: [...entry.tools] })) };
}

/**
 * The pages a run read that are the owner's own documentation. A run that began before a
 * handover read the previous owner's pages and may register after it; those pages are not this
 * library's to name.
 */
async function ownedReadRefs(
  db: DatabaseReader,
  ownerKey: string,
  readRefs: readonly ReadRef[],
): Promise<ReadRef[]> {
  const owned: ReadRef[] = [];
  for (const readRef of readRefs) {
    if ((await db.get(readRef.sourceId))?.userId === ownerKey) owned.push({ ...readRef });
  }
  return owned;
}

/** Write version `n+1` of a row's name, supersede what its revision replaced, stamp older holders. */
async function insertNextVersion(
  ctx: MutationCtx,
  row: Doc<'skills'>,
  owner: { readonly ownerKey: string; readonly agent: Doc<'agents'> },
  existing: readonly Doc<'skillVersions'>[],
  content: VerifiedContent & { readonly bodyHash: string },
): Promise<RegisteredVersion> {
  const { now } = content;
  const version = nextVersionNumber(existing.map((entry) => entry.version));
  const replaced = await replacedVersionOf(ctx.db, row, existing);
  const versionId = await ctx.db.insert('skillVersions', {
    userId: owner.ownerKey,
    name: row.name,
    description: row.description,
    surfaceClass: row.surfaceClass!,
    operation: row.operation!,
    version,
    body: content.body,
    ...(content.smokeTest !== undefined ? { smokeTest: content.smokeTest } : {}),
    bodyHash: content.bodyHash,
    requiredScopes: [...(row.requiredScopes ?? [])],
    harnessTools: [...content.harnessTools],
    ...toolsBySurface(content.harnessToolsBySurface),
    ...(row.targetSurface !== undefined ? { targetSurface: row.targetSurface } : {}),
    authorAgentId: row.agentId,
    authorName: owner.agent.name,
    readRefs: [...content.readRefs],
    verifiedAt: now,
    ...(replaced !== undefined ? { supersedes: replaced._id } : {}),
    createdAt: now,
  });
  if (replaced !== undefined) await ctx.db.patch(replaced._id, { supersededAt: now });
  for (const older of content.stampsOlderHolders ? existing : []) {
    if (older.revokedAt !== undefined) continue;
    for (const holder of await holdersOf(ctx.db, older._id)) {
      if (holder._id === row._id || holder._id === row.revisionOf) continue;
      const reason = newerVersionReason(version, older.version);
      await stampRecheckDue(ctx, { skillId: holder._id, reason, now });
    }
  }
  return {
    kind: 'inserted',
    versionId,
    version,
    adopted: false,
    ...(replaced !== undefined
      ? { superseded: { versionId: replaced._id, version: replaced.version } }
      : {}),
  };
}

/** The version a revision replaces: the version its replaced row (`revisionOf`) holds, if any. */
async function replacedVersionOf(
  db: DatabaseReader,
  row: Doc<'skills'>,
  existing: readonly Doc<'skillVersions'>[],
): Promise<Doc<'skillVersions'> | undefined> {
  if (row.revisionOf === undefined) return undefined;
  const replacedRow = await db.get(row.revisionOf);
  if (replacedRow?.agentId !== row.agentId || replacedRow.versionId === undefined) return undefined;
  return existing.find((version) => version._id === replacedRow.versionId);
}

/**
 * The retire's rule for an author (the plan's "retire and transfer, with the library"): the
 * owner's versions stay, since other employees may hold them, and stop naming the departed
 * employee; `authorName` keeps the name for the card.
 *
 * @param ctx - The retire's or the move's mutation context.
 * @param agentId - The departing employee.
 * @param keptBy - An owner whose versions keep naming the employee: the new owner of a moved
 *   one, whose copies it wrote. Omitted at a retire, which keeps none.
 * @returns How many versions stopped naming it.
 */
export async function releaseAuthor(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  keptBy?: string,
): Promise<number> {
  const authored = await ctx.db
    .query('skillVersions')
    .withIndex('by_author', (q) => q.eq('authorAgentId', agentId))
    .collect();
  const released = authored.filter((version) => version.userId !== keptBy);
  for (const version of released) await ctx.db.patch(version._id, { authorAgentId: undefined });
  return released.length;
}

/**
 * Delete an owner's whole library: the whole-owner reset, which retires every holder with it.
 * Read in pages of the shape index's owner prefix, so every version is reached however many
 * names the owner has.
 *
 * @param ctx - The reset's mutation context.
 * @param ownerKey - The owner.
 * @returns How many versions were deleted.
 */
export async function deleteOwnerLibrary(ctx: MutationCtx, ownerKey: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const batch = await ctx.db
      .query('skillVersions')
      .withIndex('by_owner_shape', (q) => q.eq('userId', ownerKey))
      .take(LIBRARY_LOOKUP_LIMIT);
    for (const version of batch) await ctx.db.delete(version._id);
    deleted += batch.length;
    if (batch.length < LIBRARY_LOOKUP_LIMIT) return deleted;
  }
}

/**
 * The handover's library step (K2), inside the move: copy every version the moving employee's
 * rows hold into the new owner's library and re-point each row, drop any adoption offer the old
 * owner's library made to it, then stamp "Re-check due" on its
 * registered skills whose surface the move cut. Nothing names the old owner afterwards: each copy
 * is keyed on the new owner, numbered in the new owner's library, keeps its author only when the
 * mover wrote it (any other author is {@link HANDED_OVER_AUTHOR_NAME}), and drops the pages the
 * old owner's documentation gave it (`readRefs`), which the mover no longer reads; a chip whose
 * reason named the old library's version numbers keeps its stamp under
 * {@link HANDED_OVER_RECHECK_REASON}. The old owner's versions stop naming the mover as author and are
 * otherwise untouched, with their other holders.
 *
 * @param ctx - The move's mutation context.
 * @param args - The mover, the new owner, the surfaces the move cut, and the move's time.
 * @returns How many versions were copied and how many rows were stamped.
 */
export async function copyVersionsForMove(
  ctx: MutationCtx,
  args: {
    readonly agentId: Id<'agents'>;
    readonly toOwnerKey: string;
    readonly cutSlugs: readonly string[];
    readonly now: number;
  },
): Promise<{ copied: number; stamped: number }> {
  const { agentId, toOwnerKey, now } = args;
  const rows = await ctx.db
    .query('skills')
    .withIndex('by_agent_name', (q) => q.eq('agentId', agentId))
    .collect();
  const copies = new Map<Id<'skillVersions'>, Id<'skillVersions'> | null>();
  for (const row of rows) {
    // An offer is the old owner's library speaking, not something the employee holds: it goes.
    // A run holding the row finishes under its fence, as the transfer plan's table has it
    // (6.4); a stored verification's registration refuses a version the move left behind.
    if (row.offeredVersionId !== undefined) {
      await ctx.db.patch(row._id, { offeredVersionId: undefined });
    }
    // A newer-version chip names the old library's numbers, which the new one does not use.
    if (row.recheckReason !== undefined && isNewerVersionReason(row.recheckReason)) {
      await ctx.db.patch(row._id, { recheckReason: HANDED_OVER_RECHECK_REASON });
    }
    const versionId = row.versionId;
    if (versionId === undefined) continue;
    if (!copies.has(versionId)) {
      copies.set(versionId, await copyVersion(ctx, versionId, { agentId, toOwnerKey, now }));
    }
    await ctx.db.patch(row._id, { versionId: copies.get(versionId) ?? undefined });
  }
  await releaseAuthor(ctx, agentId, toOwnerKey);
  const stamped = await stampRecheckDueOnSurfaces(ctx, {
    agentId,
    slugs: args.cutSlugs,
    reasonFor: surfaceCutReason,
    now,
  });
  return { copied: [...copies.values()].filter((id) => id !== null).length, stamped };
}

/** One version copied into the new owner's library, or null when it no longer exists. */
async function copyVersion(
  ctx: MutationCtx,
  versionId: Id<'skillVersions'>,
  args: { readonly agentId: Id<'agents'>; readonly toOwnerKey: string; readonly now: number },
): Promise<Id<'skillVersions'> | null> {
  const source = await ctx.db.get(versionId);
  if (source === null) return null;
  if (source.userId === args.toOwnerKey) return source._id;
  const existing = await ownerVersions(ctx.db, args.toOwnerKey, { by: 'name', name: source.name });
  const same = existing.find(
    (version) => version.revokedAt === undefined && version.bodyHash === source.bodyHash,
  );
  if (same !== undefined) return same._id;
  const wroteIt = source.authorAgentId === args.agentId;
  const author = wroteIt ? await ctx.db.get(args.agentId) : null;
  return await ctx.db.insert('skillVersions', {
    userId: args.toOwnerKey,
    name: source.name,
    description: source.description,
    surfaceClass: source.surfaceClass,
    operation: source.operation,
    version: nextVersionNumber(existing.map((version) => version.version)),
    body: source.body,
    ...(source.smokeTest !== undefined ? { smokeTest: source.smokeTest } : {}),
    bodyHash: source.bodyHash,
    requiredScopes: source.requiredScopes,
    harnessTools: source.harnessTools,
    ...toolsBySurface(source.harnessToolsBySurface),
    ...(source.targetSurface !== undefined ? { targetSurface: source.targetSurface } : {}),
    ...(wroteIt ? { authorAgentId: args.agentId } : {}),
    authorName: author?.name ?? HANDED_OVER_AUTHOR_NAME,
    readRefs: [],
    verifiedAt: source.verifiedAt,
    ...(source.revokedAt !== undefined
      ? { revokedAt: source.revokedAt, revokedReason: source.revokedReason }
      : {}),
    createdAt: args.now,
  });
}

/** Skill rows one page of the library backfill reads. */
const LIBRARY_BACKFILL_PAGE = 50;

/**
 * One page of the `skills-library` migration (K3): give every registered agent-authored shaped
 * skill of an owned employee a version in its owner's library. Its smoke test was cleared at
 * registration, so each version is written without one, which makes it not offerable, and each
 * holder is stamped "Re-check due: its check was not kept". Two holders of the same body share
 * one version; different bodies of one name are numbered in the order the page meets them. A row
 * that already has a version is passed over, so the page is safe to run twice.
 *
 * @param ctx - The migration's mutation context.
 * @param cursor - Where the previous page stopped, or null for the first.
 * @returns What the page read and changed, and where the next one starts.
 */
export async function backfillLibraryPage(
  ctx: MutationCtx,
  cursor: string | null,
): Promise<{ read: number; changed: number; cursor: string; isDone: boolean }> {
  const now = Date.now();
  const page = await ctx.db.query('skills').paginate({ cursor, numItems: LIBRARY_BACKFILL_PAGE });
  let changed = 0;
  for (const row of page.page) {
    if (row.state !== 'registered' || row.versionId !== undefined || row.body === '') continue;
    const recorded = await recordRegisteredVersion(ctx, row, {
      body: row.body,
      smokeTest: undefined,
      harnessTools: [],
      readRefs: [],
      now: row.registeredAt ?? row.createdAt,
      stampsOlderHolders: false,
    });
    if (recorded.kind === 'outside') continue;
    await ctx.db.patch(row._id, { versionId: recorded.versionId });
    await stampRecheckDue(ctx, { skillId: row._id, reason: CHECK_NOT_KEPT_REASON, now });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/** Skill rows one page of the use-count backfill reads: one, since each reads its employee's claims. */
const USE_COUNT_BACKFILL_PAGE = 1;

/**
 * The most execution claims of one employee a count reads. A claim event's payload is a handful
 * of ids, so this stays far inside a transaction's read limit; an employee past it gives each of
 * its skills a floor, which the page's note says.
 */
export const USE_COUNT_SCAN_LIMIT = 4_000;

/**
 * One page of the `skills-use-count` migration: give a skill the number of execution claims that
 * named it, and the time of the newest, the "used N times" an older release never counted. The
 * claims are read from the employee's `work.execution-claimed` events, the same claims
 * `claimForExecution` now counts, with small payloads; the work items' `by_skill` index would
 * count an item once however often it ran, and reads whole items. The count is set to the larger
 * of the row's own and the ledger's, never added to, so a claim landing while the migration runs
 * is counted once either way, and the page is safe to run twice.
 *
 * @param ctx - The migration's mutation context.
 * @param cursor - Where the previous page stopped, or null for the first.
 * @returns What the page read and changed, where the next one starts, and a note when a count
 *   reached its floor.
 */
export async function backfillUseCountPage(
  ctx: MutationCtx,
  cursor: string | null,
): Promise<{ read: number; changed: number; cursor: string; isDone: boolean; note?: string }> {
  const page = await ctx.db.query('skills').paginate({ cursor, numItems: USE_COUNT_BACKFILL_PAGE });
  let changed = 0;
  let floors = 0;
  for (const row of page.page) {
    // Newest first, so an employee past the bound still gives its skills the right last use.
    const claims = await eventsOfType(ctx, row.agentId, 'work.execution-claimed')
      .order('desc')
      .take(USE_COUNT_SCAN_LIMIT);
    if (claims.length === USE_COUNT_SCAN_LIMIT) floors += 1;
    const uses = claims.filter(
      (event) => isEventOf(event, 'work.execution-claimed') && event.payload.skillId === row._id,
    );
    const useCount = Math.max(row.useCount ?? 0, uses.length);
    const newest = uses.reduce((latest, event) => Math.max(latest, event.createdAt), 0);
    const lastUsedAt = Math.max(row.lastUsedAt ?? 0, newest);
    if (useCount === (row.useCount ?? 0) && lastUsedAt === (row.lastUsedAt ?? 0)) continue;
    await ctx.db.patch(row._id, {
      useCount,
      ...(lastUsedAt > 0 ? { lastUsedAt } : {}),
    });
    changed += 1;
  }
  return {
    read: page.page.length,
    changed,
    cursor: page.continueCursor,
    isDone: page.isDone,
    ...(floors > 0
      ? {
          note: `${floors} skills belong to an employee with ${USE_COUNT_SCAN_LIMIT} or more execution claims, so each count is a floor`,
        }
      : {}),
  };
}

/** What a stored verification runs, or why it may not run. */
export type StoredVerificationTarget =
  | {
      readonly kind: 'ready';
      readonly skill: Doc<'skills'>;
      readonly version: Doc<'skillVersions'>;
    }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * The holder row and the version a stored verification runs: the one named, or else the row's
 * own, or else the one offered to it. The version must be the row's owner's and of the row's
 * name, and not withdrawn, since the sandbox runs whatever body this answers.
 *
 * @param db - A query's database.
 * @param skillId - The holder row.
 * @param versionId - A version to verify the row as in place of its own: a newer version of its
 *   name, for a re-check that moves the row onto it.
 */
export async function storedVerificationTargetOf(
  db: DatabaseReader,
  skillId: Id<'skills'>,
  versionId: Id<'skillVersions'> | undefined,
): Promise<StoredVerificationTarget> {
  const skill = await db.get(skillId);
  if (skill === null) return { kind: 'refused', reason: 'the skill no longer exists' };
  const named = versionId ?? skill.versionId ?? skill.offeredVersionId;
  const version = named === undefined ? null : await db.get(named);
  if (version === null) {
    return { kind: 'refused', reason: 'the skill holds no stored version to verify' };
  }
  const refusal = await versionRefusal(db, skill, version);
  return refusal === undefined
    ? { kind: 'ready', skill, version }
    : { kind: 'refused', reason: refusal };
}

/** Why a row may not be verified as a version, or undefined when it may. */
async function versionRefusal(
  db: DatabaseReader,
  skill: Doc<'skills'>,
  version: Doc<'skillVersions'>,
): Promise<string | undefined> {
  const agent = await db.get(skill.agentId);
  if (agent?.userId !== version.userId || version.name !== skill.name) {
    return "the version is not one of this employee's owner's";
  }
  if (version.revokedAt !== undefined) return 'the version was withdrawn from every employee';
  return undefined;
}

/**
 * The same check at registration, for a stored verification whose run waited on the lease and
 * the sandbox: a version withdrawn, or an employee handed over, meanwhile is refused.
 *
 * @param db - The registration's database.
 * @param skill - The holder row.
 * @param versionId - The version the run verified.
 * @returns The refusal, or undefined when the row may register as the version.
 */
export async function storedVersionRefusal(
  db: DatabaseReader,
  skill: Doc<'skills'>,
  versionId: Id<'skillVersions'>,
): Promise<string | undefined> {
  const version = await db.get(versionId);
  if (version === null) return 'the version no longer exists';
  return await versionRefusal(db, skill, version);
}

/**
 * Internal: what `skillActions.verifyStoredSkill` runs ({@link storedVerificationTargetOf}).
 */
export const storedVerificationTarget = internalQuery({
  args: { skillId: v.id('skills'), versionId: v.optional(v.id('skillVersions')) },
  handler: async (ctx, args): Promise<StoredVerificationTarget> =>
    await storedVerificationTargetOf(ctx.db, args.skillId, args.versionId),
});

/**
 * Internal: end a stored verification of a registered row that no sandbox ran (the lease never
 * came, or no backend answered). The row stays registered and keeps running the body it was
 * verified with, with its chip; the claim is released so the next re-check can start, and the
 * skip lands on the record. Fenced like every authoring write: a run that no longer holds the row
 * writes nothing.
 *
 * @returns Whether the run still held the row.
 */
export const releaseStoredVerification = internalMutation({
  args: { skillId: v.id('skills'), runId: v.id('events'), reason: v.string() },
  handler: async (ctx, args): Promise<{ released: boolean }> => {
    const row = await ctx.db.get(args.skillId);
    if (row?.authoringRunId !== args.runId) return { released: false };
    await ctx.db.patch(args.skillId, { authoringRunId: undefined, authoringClaimedAt: undefined });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.sandbox-skipped',
      payload: { skillId: args.skillId, name: row.name, reason: args.reason },
      createdAt: Date.now(),
    });
    return { released: true };
  },
});

/** A version as the owner's screens read it: everything but the smoke test's source. */
export type LibraryEntry = Omit<Doc<'skillVersions'>, 'smokeTest'> & {
  /** Whether the passing check is kept, so the version can be offered once it is current. */
  readonly checkKept: boolean;
};

/** A version without its smoke test, with whether one is kept. */
function libraryEntry(version: Doc<'skillVersions'>): LibraryEntry {
  const { smokeTest, ...entry } = version;
  return { ...entry, checkKept: smokeTest !== undefined };
}

/**
 * Public, guarded by `assertOwnsAgent`: the versions of one shape in the library of the
 * employee's owner, newest first. Reads only; the lookup is the owner's by index.
 */
export const library = query({
  args: { agentId: v.id('agents'), surfaceClass: v.string(), operation: v.string() },
  handler: async (ctx, args): Promise<LibraryEntry[]> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const versions = await ownerVersions(ctx.db, agent.userId!, {
      by: 'shape',
      surfaceClass: args.surfaceClass,
      operation: args.operation,
    });
    return versions.map(libraryEntry);
  },
});

/** One holder of a version, as the Retire dialog names it. */
export interface VersionHolder {
  readonly skillId: Id<'skills'>;
  readonly agentId: Id<'agents'>;
  readonly agentName: string;
  readonly state: Doc<'skills'>['state'];
}

/**
 * Public, guarded by `assertOwnsSkill`: the version a skill row holds and the version offered to
 * it, each with its holders among the owner's employees. Reads only.
 */
export const forSkill = query({
  args: { skillId: v.id('skills') },
  handler: async (
    ctx,
    args,
  ): Promise<{
    held: { version: LibraryEntry; holders: VersionHolder[] } | null;
    offered: LibraryEntry | null;
  }> => {
    const skill = await assertOwnsSkill(ctx, args.skillId);
    const agent = await ctx.db.get(skill.agentId);
    const ownerKey = agent?.userId;
    const readOwn = async (
      versionId: Id<'skillVersions'> | undefined,
    ): Promise<Doc<'skillVersions'> | null> => {
      if (versionId === undefined || ownerKey === undefined) return null;
      const version = await ctx.db.get(versionId);
      return version?.userId === ownerKey ? version : null;
    };
    const [held, offered] = await Promise.all([
      readOwn(skill.versionId),
      readOwn(skill.offeredVersionId),
    ]);
    if (held === null) return { held: null, offered: offered && libraryEntry(offered) };
    const holders: VersionHolder[] = [];
    for (const row of await holdersOf(ctx.db, held._id)) {
      const holder = await ctx.db.get(row.agentId);
      if (holder === null || holder.userId !== ownerKey) continue;
      holders.push({
        skillId: row._id,
        agentId: row.agentId,
        agentName: holder.name,
        state: row.state,
      });
    }
    return {
      held: { version: libraryEntry(held), holders },
      offered: offered && libraryEntry(offered),
    };
  },
});
