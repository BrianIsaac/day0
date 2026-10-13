import { ConvexError } from 'convex/values';
import type { PaginationOptions, PaginationResult } from 'convex/server';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { ownerScope } from './ownership';
import { sha256OfText } from '../src/lib/sha256';
import type {
  OwnerDeparture,
  OwnerDocPage,
  OwnerDocRelation,
  OwnerDocSource,
  OwnerPageRef,
  OwnerSection,
} from '../src/export/trace';

/*
 * The owner export's helpers (wave 16, 16-F; a module of their own since wave 17, 17-s, the wave
 * 16 review's D-6 (a)): its limits, the readers of one page of each section of the owner's rows,
 * the fields a row leaves out, and the opaque key a page and a relation's ends are named by. It
 * reads rows and writes none, registers no function, and imports no other `convex/` module but
 * `ownership`, so it sits below `convex/events.ts` and below `convex/work.ts`.
 *
 * The two registered queries stay in `convex/events.ts` (`exportOwnerHead`, `exportOwnerPage`),
 * which authorise the caller, read a page through `OWNER_SECTION_PAGES` and redact it there, as
 * the employee's trace is redacted; `exportActions.exportForOwner` and
 * `exportActions.exportOwnerPage` run them.
 */

/**
 * The most of an owner's agents one owner export reads: far above the twenty the figures count
 * and the 51 of a large bed (V16-4); past it the head says how many were left out.
 */
export const OWNER_EXPORT_AGENT_LIMIT = 500;

/** The most stored pages one page of the owner export reads: each row holds its page's text. */
const OWNER_EXPORT_PAGE_ROWS = 25;

/** The bytes one page of stored pages may read, so a library of long pages pages on. */
const OWNER_EXPORT_PAGE_BYTES = 4 * 1024 * 1024;

/** A retirement row without its owner key, the one field the export never carries. */
export function withoutOwner(row: Doc<'retirements'>): Omit<Doc<'retirements'>, 'userId'> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'userId')) as Omit<
    Doc<'retirements'>,
    'userId'
  >;
}

/**
 * Where a walk of the owner's stored pages stands: the source it is in, by id and by when it was
 * linked (so the walk goes on past a source unlinked between two pages), and the backend's cursor
 * inside it.
 */
interface PagesCursor {
  readonly sourceId: string;
  readonly linkedAt: number;
  readonly cursor: string | null;
}

/** Why a pages cursor is refused: it is not one this export handed out. */
const NOT_A_PAGES_CURSOR = 'not a cursor of the owner export’s stored pages';

/** A pages cursor read back from the string the export hands out, or a refusal a client reads. */
function pagesCursorOf(cursor: string): PagesCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    // Not JSON: not a cursor this export handed out, refused below in the client's words.
    parsed = undefined;
  }
  const fields =
    parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  if (
    typeof fields.sourceId !== 'string' ||
    typeof fields.linkedAt !== 'number' ||
    (fields.cursor !== null && typeof fields.cursor !== 'string')
  ) {
    throw new ConvexError(NOT_A_PAGES_CURSOR);
  }
  return { sourceId: fields.sourceId, linkedAt: fields.linkedAt, cursor: fields.cursor };
}

/** A row without the named fields, the rest as stored. */
function withoutKeys<Row extends object>(row: Row, keys: ReadonlySet<string>): Partial<Row> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.has(key))) as Partial<Row>;
}

/** The field of a relation the owner export never carries: the address of who decided it. */
const RELATION_FIELDS_LEFT_OUT = new Set(['decidedBy']);

/**
 * The fields of a stored page the owner export never carries: its text and what is read off it,
 * and its locators, the ref and the address (W16-R18), which for a list of URLs is the address
 * with any query-string credential; the page carries an opaque key in their place.
 */
const PAGE_FIELDS_LEFT_OUT = new Set([
  'markdown',
  'contentHash',
  'marker',
  'decidedBy',
  'ref',
  'url',
  'supersededBy',
]);

/** How many hex characters of the digest a page's key keeps: 96 bits, unique over any library. */
const OWNER_PAGE_KEY_CHARS = 24;

/**
 * A page's opaque key in one owner's exports (W16-R18): a digest of the owner, the source and the
 * ref, so the same page has the same key wherever the file names it, with nothing read to find
 * it and nothing of the ref or the address left in the file.
 */
function ownerPageRef(
  ownerKey: string,
  named: { readonly sourceId: Id<'docSources'>; readonly ref: string },
): OwnerPageRef {
  return {
    sourceId: named.sourceId,
    page: sha256OfText(
      `day0-owner-export-page\0${ownerKey}\0${named.sourceId}\0${named.ref}`,
    ).slice(0, OWNER_PAGE_KEY_CHARS),
  };
}

/** One stored page without its text, its keyed hash, a marker's words, who decided it or its ref. */
function pageWithoutText(ownerKey: string, page: Doc<'docPages'>): OwnerDocPage {
  const kept = withoutKeys(page, PAGE_FIELDS_LEFT_OUT) as Omit<OwnerDocPage, 'page'>;
  return {
    ...kept,
    page: ownerPageRef(ownerKey, page).page,
    ...(page.marker !== undefined
      ? { marker: { status: page.marker.status, judgedAt: page.marker.judgedAt } }
      : {}),
    ...(page.supersededBy !== undefined
      ? { supersededBy: ownerPageRef(ownerKey, page.supersededBy) }
      : {}),
  };
}

/** One relation without who decided it, its ends named by their pages' keys (W16-R18). */
function relationWithoutRefs(ownerKey: string, relation: Doc<'docRelations'>): OwnerDocRelation {
  const kept = withoutKeys(relation, RELATION_FIELDS_LEFT_OUT) as Omit<
    Doc<'docRelations'>,
    'decidedBy'
  >;
  return {
    ...kept,
    from: ownerPageRef(ownerKey, relation.from),
    to: ownerPageRef(ownerKey, relation.to),
  };
}

/** The owner's first source linked after a moment, in the order the owner linked them. */
async function sourceLinkedAfter(
  ctx: QueryCtx,
  ownerKey: string,
  linkedAt: number,
): Promise<Doc<'docSources'> | null> {
  return await ctx.db
    .query('docSources')
    .withIndex('by_user', (q) => q.eq('userId', ownerKey).gt('_creationTime', linkedAt))
    .first();
}

/**
 * One page of the owner's stored pages, source by source in the order the owner linked them,
 * each without its text. The cursor names the source, when it was linked and the backend's cursor
 * inside it; a source unlinked between two pages is passed over, the walk going on with the next.
 */
async function ownerPagesPage(
  ctx: QueryCtx,
  ownerKey: string,
  cursor: string | null,
): Promise<{ rows: OwnerDocPage[]; next: string | null }> {
  const at = cursor === null ? undefined : pagesCursorOf(cursor);
  const current = at === undefined ? null : ctx.db.normalizeId('docSources', at.sourceId);
  const held = current === null ? null : await ctx.db.get(current);
  const source =
    held !== null && held.userId === ownerKey
      ? held
      : await sourceLinkedAfter(ctx, ownerKey, at?.linkedAt ?? -1);
  if (source === null) return { rows: [], next: null };
  const page = await ctx.db
    .query('docPages')
    .withIndex('by_source', (q) => q.eq('sourceId', source._id))
    .paginate({
      // A cursor inside a source that went is no cursor in the next one.
      cursor: source === held ? (at?.cursor ?? null) : null,
      numItems: OWNER_EXPORT_PAGE_ROWS,
      maximumBytesRead: OWNER_EXPORT_PAGE_BYTES,
    });
  const following = page.isDone
    ? await sourceLinkedAfter(ctx, ownerKey, source._creationTime)
    : source;
  const next: PagesCursor | null =
    following === null
      ? null
      : {
          sourceId: following._id,
          linkedAt: following._creationTime,
          cursor: following === source ? page.continueCursor : null,
        };
  return {
    rows: page.page.map((row) => pageWithoutText(ownerKey, row)),
    next: next === null ? null : JSON.stringify(next),
  };
}

/** One page of a section of the owner's rows: its rows before redaction, and the next cursor. */
interface OwnerSectionPage {
  readonly rows: unknown[];
  readonly next: string | null;
}

/** A paginated read as an owner section's page. */
function asOwnerPage<Row>(
  page: PaginationResult<Row>,
  map: (row: Row) => unknown[] = (row) => [row],
): OwnerSectionPage {
  return { rows: page.page.flatMap(map), next: page.isDone ? null : page.continueCursor };
}

/** One page of each section of the owner's rows, every read keyed by the caller's owner key. */
export const OWNER_SECTION_PAGES: Readonly<
  Record<
    OwnerSection,
    (ctx: QueryCtx, ownerKey: string, options: PaginationOptions) => Promise<OwnerSectionPage>
  >
> = {
  retirements: async (ctx, ownerKey, options) =>
    asOwnerPage(
      await ctx.db
        .query('retirements')
        .withIndex('by_user', (q) => q.eq('userId', ownerKey))
        .paginate(options),
      (row) => [withoutOwner(row)],
    ),
  departures: async (ctx, ownerKey, options) =>
    asOwnerPage(
      await ctx.db
        .query('managerTransfers')
        .withIndex('by_from_owner_state', (q) => q.eq('fromOwnerKey', ownerKey))
        .paginate(options),
      (row): OwnerDeparture[] =>
        row.state === 'accepting' || row.state === 'accepted'
          ? [
              {
                _id: row._id,
                agentId: row.agentId,
                agentName: row.agentName,
                state: row.state,
                requestedAt: row.requestedAt,
                ...(row.decidedAt !== undefined ? { decidedAt: row.decidedAt } : {}),
              },
            ]
          : [],
    ),
  docSources: async (ctx, ownerKey, options) =>
    asOwnerPage(
      await ctx.db
        .query('docSources')
        .withIndex('by_user', (q) => q.eq('userId', ownerKey))
        .paginate(options),
      (row): OwnerDocSource[] => [
        {
          _id: row._id,
          _creationTime: row._creationTime,
          label: row.label,
          kind: row.kind,
          ...(row.authority !== undefined ? { authority: row.authority } : {}),
          ...(row.defaultStatus !== undefined ? { defaultStatus: row.defaultStatus } : {}),
          status: row.status,
          ...(row.lastSyncAt !== undefined ? { lastSyncAt: row.lastSyncAt } : {}),
          createdAt: row.createdAt,
        },
      ],
    ),
  docPages: async (ctx, ownerKey, options) => await ownerPagesPage(ctx, ownerKey, options.cursor),
  // Who decided a relation is the manager's address, left out as a page's is.
  docRelations: async (ctx, ownerKey, options) =>
    asOwnerPage(
      await ctx.db
        .query('docRelations')
        .withIndex('by_user_status', (q) => q.eq('userId', ownerKey))
        .paginate(options),
      (relation) => [relationWithoutRefs(ownerKey, relation)],
    ),
  skillVersions: async (ctx, ownerKey, options) =>
    asOwnerPage(
      await ctx.db
        .query('skillVersions')
        .withIndex('by_owner_name_version', (q) => q.eq('userId', ownerKey))
        .paginate(options),
    ),
  people: async (ctx, ownerKey, options) =>
    asOwnerPage(
      await ctx.db
        .query('people')
        .withIndex('by_user_status', (q) => q.eq('userId', ownerScope({ ownerKey })))
        .paginate(options),
    ),
  personIdentities: async (ctx, ownerKey, options) =>
    asOwnerPage(
      await ctx.db
        .query('personIdentities')
        .withIndex('by_user_provider_external', (q) => q.eq('userId', ownerScope({ ownerKey })))
        .paginate(options),
    ),
  relationships: async (ctx, ownerKey, options) =>
    asOwnerPage(
      await ctx.db
        .query('relationships')
        .withIndex('by_user_type', (q) => q.eq('userId', ownerScope({ ownerKey })))
        .paginate(options),
    ),
  workingAgreements: async (ctx, ownerKey, options) =>
    asOwnerPage(
      await ctx.db
        .query('workingAgreements')
        .withIndex('by_user_status', (q) => q.eq('userId', ownerScope({ ownerKey })))
        .paginate(options),
    ),
};
