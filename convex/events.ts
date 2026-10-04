import { v } from 'convex/values';
import {
  paginationOptsValidator,
  type PaginationOptions,
  type PaginationResult,
} from 'convex/server';
import { internalQuery, query, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent } from './ownership';
import { handoversFromTransfers, isEvaluationAgent } from './metrics';
import { ownerRetirements } from './retirements';
import { redactTokenShapes } from '../src/surfaces/redact';
import { agentZone, dayKey } from '../src/lib/zone';
import {
  ownerKeyDigest,
  sectionAfter,
  TRACE_FORMAT,
  TRACE_PAGE_ROWS,
  TRACE_SECTIONS,
  TRACE_VERSION,
  type TraceHandover,
  type TraceHead,
  type TraceLedgerLine,
  type TracePage,
  type TraceRetirement,
  type TraceRows,
  type TraceSection,
} from '../src/export/trace';
import { WORK_LISTED_EVENT } from './work';
import {
  EVENT_TYPES,
  isConnectionEventType,
  isEventOf,
  type ConnectionEventType,
} from '../src/events/contract';
import { eventTypesIn, RECORD_FILTERS, type RecordEntry } from '../src/events/record-filters';
import { eventsOfType } from './eventLog';
import { CREDENTIAL_VALUE_REDACTION, isCredentialKey } from '../src/lib/credential-keys';

/**
 * Events feed - inserted only through `eventLog.ts` (`appendEvent` in a
 * mutation's own transaction, or the internal `log` from an action), and
 * patched in place by the server when a later phase completes a row
 * (`work.ts`); drives the live UI ticker. The reading side enforces
 * per-account ownership; the writing side is internal-only.
 */

/**
 * Event types the ticker leaves out: each intake listing of a changed ticket
 * is a record for the re-read before apply, not something the agent did
 * (U19 D6), and one poll can write one per ticket.
 */
const TICKER_HIDDEN_TYPES = new Set([WORK_LISTED_EVENT]);

/** The most events one ticker read walks to fill its window. */
const TICKER_SCAN_LIMIT = 500;

/** The ticker's window when the caller names none. */
const TICKER_DEFAULT_WINDOW = 50;

/**
 * The window a ticker read fills: the caller's, whole, between one and the
 * scan bound, since the limit comes from the client and one read may not
 * walk more than `TICKER_SCAN_LIMIT` events whatever it asks (review m17).
 */
function tickerWindow(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return TICKER_DEFAULT_WINDOW;
  return Math.min(Math.max(1, Math.floor(limit)), TICKER_SCAN_LIMIT);
}

/**
 * The newest events of one agent for the dashboard ticker, newest first,
 * intake listings left out. Public; owner-guarded; reads at most
 * `TICKER_SCAN_LIMIT` events.
 */
export const recent = query({
  args: { agentId: v.id('agents'), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Doc<'events'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    const limit = tickerWindow(args.limit);
    const shown: Doc<'events'>[] = [];
    let scanned = 0;
    for await (const event of ctx.db
      .query('events')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')) {
      scanned += 1;
      if (!TICKER_HIDDEN_TYPES.has(event.type)) shown.push(event);
      if (shown.length >= limit || scanned >= TICKER_SCAN_LIMIT) break;
    }
    return shown;
  },
});

/** A string field of a stored payload, or undefined when the row carries none. */
function payloadField(event: Doc<'events'>, field: 'workItemId' | 'surfaceId'): string | undefined {
  const value: unknown = (event.payload as Record<string, unknown> | null | undefined)?.[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * What a page of events names, by id: the titles of its work items and the names of its
 * connections. An id an older row carries in some other shape, or one whose row is gone, has none.
 */
async function namesFor(
  ctx: QueryCtx,
  events: readonly Doc<'events'>[],
): Promise<{ items: ReadonlyMap<string, string>; connections: ReadonlyMap<string, string> }> {
  const itemIds = new Set<Id<'workItems'>>();
  const surfaceIds = new Set<Id<'surfaces'>>();
  for (const event of events) {
    const item = payloadField(event, 'workItemId');
    const itemId = item === undefined ? null : ctx.db.normalizeId('workItems', item);
    if (itemId !== null) itemIds.add(itemId);
    const surface = payloadField(event, 'surfaceId');
    const surfaceId = surface === undefined ? null : ctx.db.normalizeId('surfaces', surface);
    if (surfaceId !== null) surfaceIds.add(surfaceId);
  }
  const [items, surfaces] = await Promise.all([
    Promise.all([...itemIds].map(async (id) => await ctx.db.get(id))),
    Promise.all([...surfaceIds].map(async (id) => await ctx.db.get(id))),
  ]);
  return {
    items: new Map(items.flatMap((row) => (row ? [[row._id as string, row.title]] : []))),
    connections: new Map(
      surfaces.flatMap((row) => (row ? [[row._id as string, row.displayName]] : [])),
    ),
  };
}

/**
 * The most events one page of the record reads. A filter that matches few types (the charter's
 * history) would otherwise walk every event the employee has to fill a page, and hold them all in
 * the query's read set; bounded, the page comes back short and Show older reads further back.
 */
export const RECORD_SCAN_ROWS = 1000;

/**
 * One page of an employee's whole record for the Record tab, newest first, each event with the
 * title of the work item and the name of the connection it names. With a filter, only the event
 * types that filter shows (`src/events/record-filters.ts`); without one, every event, intake
 * listings included, since the record leaves nothing out. A page reads at most
 * `RECORD_SCAN_ROWS` events, so a selective filter returns a short page with a cursor rather than
 * walking the whole record. Public; owner-guarded; reads through the agent's index and writes
 * nothing.
 */
export const record = query({
  args: {
    agentId: v.id('agents'),
    filter: v.optional(v.union(...RECORD_FILTERS.map((filter) => v.literal(filter)))),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<PaginationResult<RecordEntry>> => {
    await assertOwnsAgent(ctx, args.agentId);
    const newestFirst = ctx.db
      .query('events')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc');
    const types = args.filter === undefined ? undefined : eventTypesIn(args.filter);
    const page = await (
      types === undefined
        ? newestFirst
        : newestFirst.filter((q) => q.or(...types.map((type) => q.eq(q.field('type'), type))))
    ).paginate({
      ...args.paginationOpts,
      maximumRowsRead: Math.min(
        args.paginationOpts.maximumRowsRead ?? RECORD_SCAN_ROWS,
        RECORD_SCAN_ROWS,
      ),
    });
    const names = await namesFor(ctx, page.page);
    // A page cut at the scan bound is an ordinary short page with its cursor: the client's
    // paginated hook waits for a split that is never offered when told the split is required.
    return {
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      page: page.page.map((event): RecordEntry => {
        const item = payloadField(event, 'workItemId');
        const surface = payloadField(event, 'surfaceId');
        const itemTitle = item === undefined ? undefined : names.items.get(item);
        const connection = surface === undefined ? undefined : names.connections.get(surface);
        return {
          event,
          ...(itemTitle !== undefined ? { itemTitle } : {}),
          ...(connection !== undefined ? { connection } : {}),
        };
      }),
    };
  },
});

/**
 * Every flip of the employee's autonomous-actions switch, oldest first.
 *
 * The feed's `recent` window rolls past a flip within one run, and a finished
 * card has to say when the switch changed relative to its plan for as long as
 * the card is on the page, so the flips are read by type rather than out of
 * the feed.
 */
export const autonomyChanges = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Array<{ at: number; on: boolean }>> => {
    await assertOwnsAgent(ctx, args.agentId);
    const events = await eventsOfType(ctx, args.agentId, 'agent.autonomy-changed').collect();
    return events.map((event) => ({
      at: event.createdAt,
      on: (event.payload as { to?: unknown } | undefined)?.to === true,
    }));
  },
});

/**
 * Keys an export never carries: those that identify a person rather than
 * describe an action (a ticket's author, requester and branch, which carries
 * its assignee's handle; the charter's manager and named colleagues; a
 * manager change's previous manager as well as the new one; both addresses
 * of a handover request; the colleague who wrote an adopted or offered skill,
 * decision 4), and a surface's live install claim (a single-use
 * state nonce and the URL that spends it). The export's policy keeps names as
 * working material in text (U12 D1 (c)); a key whose whole value is a name has
 * none to keep.
 */
const PERSONAL_KEYS = new Set([
  'assigneeEmail',
  'authorName',
  'boss',
  'bossEmail',
  'createdBy',
  'email',
  'fromAddress',
  'gitBranchName',
  'managerEmail',
  'managerName',
  'managerUserId',
  'namedCollaborators',
  'previousManagerUserId',
  'provisioning',
  'requester',
  'toAddress',
]);

/** What an export writes in place of a personal key's value quoted inside a text. */
export const PERSONAL_VALUE_REDACTION = '<redacted: personal>';

/**
 * A personal key as a JSON text quotes it, with its value: a string (escapes kept whole, and one
 * the ledger's bound cut short running to the end of the text), or an object or array holding no
 * other. The key must stand alone in its quotes, so `"notCreatedBy"` and prose that names a key
 * are left. Out of its reach, and left to the export's other floors: a value nested two objects
 * deep, and JSON quoted inside a JSON string (`\"createdBy\"`).
 */
const EMBEDDED_PERSONAL_VALUE = new RegExp(
  `("(?:${[...PERSONAL_KEYS].join('|')})"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*(?:"|$)|\\{[^{}]*\\}|\\[[^\\[\\]]*\\])`,
  'g',
);

/**
 * A text with the value of every personal key it quotes replaced: a provider's answer the ledger
 * keeps as text (a Linear read's `gitBranchName`, which carries the Linear user's handle, and its
 * `createdBy`; the real-Linear walk's m4), which the key filter of `redactForExport` never sees.
 */
function withoutEmbeddedPersonalValues(text: string): string {
  return text.replace(EMBEDDED_PERSONAL_VALUE, `$1"${PERSONAL_VALUE_REDACTION}"`);
}

/**
 * Redact one value for export: personal keys are dropped, a value under a
 * credential-class key is blanked (`src/lib/credential-keys.ts`, the list the
 * record's payload floor reads), every other string has the personal values
 * it quotes and its recognisable credential shapes replaced, and containers
 * are walked.
 *
 * Args:
 *   value: A stored payload, ledger entry or nested part of one.
 *
 * Returns:
 *   The same shape with nothing an export should not carry.
 */
export function redactForExport(value: unknown): unknown {
  if (typeof value === 'string') return redactTokenShapes(withoutEmbeddedPersonalValues(value));
  if (Array.isArray(value)) return value.map(redactForExport);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !PERSONAL_KEYS.has(key))
        .map(([key, entry]) => [
          key,
          isCredentialKey(key) ? CREDENTIAL_VALUE_REDACTION : redactForExport(entry),
        ]),
    );
  }
  return value;
}

/** A retirement row without its owner key, the one field the export never carries. */
function withoutOwner(row: Doc<'retirements'>): Omit<Doc<'retirements'>, 'userId'> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'userId')) as Omit<
    Doc<'retirements'>,
    'userId'
  >;
}

/**
 * The owner's retired employees, newest first, each its `retirements` row
 * redacted for export: what the retire deleted and revoked, and the claims
 * and rejections its colleagues still meet (N1's owner-keyed tombstone). The
 * row's owner key is `ownerKeyOf` the owner's identity and never leaves; the
 * trace's agent names the owner once, as the recompute needs it.
 */
async function retiredEmployees(
  ctx: QueryCtx,
  owner: string | undefined,
): Promise<TraceRetirement[]> {
  if (owner === undefined) return [];
  return (await ownerRetirements(ctx, owner)).map(
    (row): TraceRetirement => redactForExport(withoutOwner(row)) as TraceRetirement,
  );
}

/** The request states a handover is accepted in, moved or still waiting for its runs (D18). */
const ACCEPTED_HANDOVER_STATES = ['accepting', 'accepted'] as const;

/**
 * An employee's accepted handovers for its trace's manifest, oldest first, read as
 * `metrics:forOwner` reads them: so a recompute from the trace cuts each manager's figures at the
 * acceptance. Each owner key goes as its digest salted with the export's time
 * (`ownerKeyDigest`; decision 2, the wave 10 review, M6), since the file is made to be shared
 * and names no account but the exporter's own. The per-account bounds keep an employee's
 * requests far under one page.
 */
async function acceptedHandoversOf(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  exportedAt: number,
): Promise<TraceHandover[]> {
  const byState = await Promise.all(
    ACCEPTED_HANDOVER_STATES.map(
      async (state) =>
        await ctx.db
          .query('managerTransfers')
          .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
          .take(TRACE_PAGE_ROWS),
    ),
  );
  return handoversFromTransfers(byState.flat())
    .toSorted((left, right) => left.acceptedAt - right.acceptedAt)
    .map(
      (handover): TraceHandover => ({
        agentId: handover.agentId,
        fromOwnerDigest: ownerKeyDigest(handover.fromOwnerKey, exportedAt),
        toOwnerDigest: ownerKeyDigest(handover.toOwnerKey, exportedAt),
        acceptedAt: handover.acceptedAt,
      }),
    );
}

/** The newest lines of one connection's ledger the export reads, far above one employee's share. */
const LEDGER_EXPORT_LIMIT = 500;

/**
 * One connection's ledger as the export reads it: its newest {@link LEDGER_EXPORT_LIMIT} lines and
 * its first, the landing, which a busy connection's later lines would otherwise push out.
 *
 * @param ctx - Query context.
 * @param organisationConnectionId - The connection.
 */
async function connectionLedgerOf(
  ctx: QueryCtx,
  organisationConnectionId: Id<'organisationConnections'>,
): Promise<Doc<'connectionEvents'>[]> {
  const ledger = () =>
    ctx.db
      .query('connectionEvents')
      .withIndex('by_connection', (q) =>
        q.eq('organisationConnectionId', organisationConnectionId),
      );
  const [newest, first] = await Promise.all([
    ledger().order('desc').take(LEDGER_EXPORT_LIMIT),
    ledger().order('asc').first(),
  ]);
  return first === null || newest.some((line) => line._id === first._id)
    ? newest
    : [...newest, first];
}

/**
 * The organisation's ledger lines about the connections an employee's cards use (F17; the access
 * plan, section 8, cross-unit test 4), oldest first: each connection's landing, rotations and
 * revoke, and of the vendor calls made with a connection's secret only those that ended this
 * employee's own credentials (the cards' and those its record says were revoked at the source) and
 * the configuration token's creation of this employee's own app.
 * Each payload is redacted as the export redacts, and the administrator's address is left out.
 */
async function organisationLedgerOf(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  surfaces: readonly Doc<'surfaces'>[],
): Promise<TraceLedgerLine[]> {
  const connectionIds = [
    ...new Set(
      surfaces.flatMap((surface) =>
        [surface.organisationConnectionId, surface.provisioning?.organisationConnectionId].filter(
          (id): id is Id<'organisationConnections'> => id !== undefined,
        ),
      ),
    ),
  ];
  if (connectionIds.length === 0) return [];
  const [ended, ...ledgers] = await Promise.all([
    eventsOfType(ctx, agentId, 'credential.revoked-at-source').order('desc').take(TRACE_PAGE_ROWS),
    ...connectionIds.map(
      async (organisationConnectionId) => await connectionLedgerOf(ctx, organisationConnectionId),
    ),
  ]);
  const own = new Set<string>([
    ...surfaces.flatMap((surface) => (surface.credentialId ? [surface.credentialId] : [])),
    ...ended.flatMap((event) =>
      isEventOf(event, 'credential.revoked-at-source') ? [event.payload.credentialId] : [],
    ),
  ]);
  const ownApps = new Set<string>(
    surfaces.flatMap((surface) =>
      surface.provisioning?.appId ? [surface.provisioning.appId] : [],
    ),
  );
  return ledgers
    .flat()
    .filter((line) => isConnectionEventType(line.type))
    .filter((line) => {
      if (line.type === 'organisation.configuration-used') {
        // Only the creation of this employee's own app is its: another employee's app, a renewal
        // of the token and its revoke are the organisation's (the wave 11 review's m1).
        const appId = (line.payload as { readonly appId?: unknown }).appId;
        return typeof appId === 'string' && ownApps.has(appId);
      }
      if (line.type !== 'organisation.revoked-at-source') return true;
      const credentialId = (line.payload as { readonly credentialId?: unknown }).credentialId;
      return typeof credentialId === 'string' && own.has(credentialId);
    })
    .toSorted((left, right) => left.createdAt - right.createdAt)
    .map(
      (line): TraceLedgerLine => ({
        type: line.type as ConnectionEventType,
        organisationConnectionId: line.organisationConnectionId,
        createdAt: line.createdAt,
        payload: redactForExport(line.payload) as TraceLedgerLine['payload'],
      }),
    );
}

/**
 * The head of an agent's trace: the manifest, the agent, the owner section,
 * the credential labels and the organisation's ledger about its connections,
 * and where the first page starts. Internal; the
 * export action runs it under the caller's identity, with the moment of the
 * export (a query reads no clock), and the ownership check here runs again.
 */
export const exportHead = internalQuery({
  args: { agentId: v.id('agents'), exportedAt: v.number() },
  handler: async (ctx, args): Promise<TraceHead> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const { exportedAt } = args;
    const zone = agentZone(agent);
    const [stamp, surfaces, retired, handovers] = await Promise.all([
      ctx.db.query('deploymentVersions').order('desc').first(),
      ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
        .take(TRACE_PAGE_ROWS),
      retiredEmployees(ctx, agent.userId),
      acceptedHandoversOf(ctx, args.agentId, exportedAt),
    ]);
    const credentials = await Promise.all(
      [
        ...new Set(
          surfaces.flatMap((surface) => (surface.credentialId ? [surface.credentialId] : [])),
        ),
      ].map(async (credentialId) => await ctx.db.get(credentialId)),
    );
    return {
      manifest: {
        format: TRACE_FORMAT,
        version: TRACE_VERSION,
        exportedAt,
        exportedOn: dayKey(exportedAt, zone),
        zone,
        release: stamp?.release ?? null,
        commit: stamp?.commit ?? null,
        pageRows: TRACE_PAGE_ROWS,
        eventTypes: EVENT_TYPES,
        handovers,
      },
      agent: {
        id: agent._id,
        name: agent.name,
        ...(agent.userId !== undefined ? { userId: agent.userId } : {}),
        state: agent.state,
        ...(agent.arm !== undefined ? { arm: agent.arm } : {}),
        ...(agent.mode !== undefined ? { mode: agent.mode } : {}),
        zone,
        evaluation: isEvaluationAgent(agent),
        createdAt: agent.createdAt,
        creationTime: agent._creationTime,
      },
      owner: { retired },
      credentialNames: credentials.flatMap((credential) =>
        credential ? [{ label: credential.label }] : [],
      ),
      organisationLedger: await organisationLedgerOf(ctx, args.agentId, surfaces),
      next: { section: TRACE_SECTIONS[0], cursor: null },
    };
  },
});

type SectionPage = PaginationResult<Record<string, unknown>>;

/** One page of each section, read through the agent's own index. */
const SECTION_PAGES: Readonly<
  Record<
    TraceSection,
    (ctx: QueryCtx, agentId: Id<'agents'>, options: PaginationOptions) => Promise<SectionPage>
  >
> = {
  charters: async (ctx, agentId, options) =>
    await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .paginate(options),
  // By creation, not by state: a row that changes state between two pages
  // would otherwise be read twice or not at all.
  workItems: async (ctx, agentId, options) =>
    await ctx.db
      .query('workItems')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .paginate(options),
  skills: async (ctx, agentId, options) =>
    await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) => q.eq('agentId', agentId))
      .paginate(options),
  questions: async (ctx, agentId, options) =>
    await ctx.db
      .query('managerQuestions')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .paginate(options),
  corrections: async (ctx, agentId, options) =>
    await ctx.db
      .query('corrections')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .paginate(options),
  surfaces: async (ctx, agentId, options) =>
    await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .paginate(options),
  managerNotes: async (ctx, agentId, options) =>
    await ctx.db
      .query('managerNotes')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .paginate(options),
  decisionNotices: async (ctx, agentId, options) =>
    await ctx.db
      .query('managerDecisionNotices')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .paginate(options),
  events: async (ctx, agentId, options) =>
    await ctx.db
      .query('events')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .paginate(options),
};

const traceSection = v.union(...TRACE_SECTIONS.map((section) => v.literal(section)));

/**
 * One page of one section of an agent's trace, redacted, with where the next
 * page starts. At most `TRACE_PAGE_ROWS` rows, so no call nears the
 * backend's 8,192-element return bound. Internal; the export action runs it
 * under the caller's identity and the ownership check here runs again.
 */
export const exportPage = internalQuery({
  args: { agentId: v.id('agents'), section: traceSection, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<TracePage> => {
    await assertOwnsAgent(ctx, args.agentId);
    const page = await SECTION_PAGES[args.section](ctx, args.agentId, {
      cursor: args.cursor,
      numItems: TRACE_PAGE_ROWS,
    });
    const following = sectionAfter(args.section);
    return {
      section: args.section,
      rows: page.page.map((row) => redactForExport(row)) as TraceRows[TraceSection],
      next: !page.isDone
        ? { section: args.section, cursor: page.continueCursor }
        : following !== undefined
          ? { section: following, cursor: null }
          : null,
    };
  },
});
