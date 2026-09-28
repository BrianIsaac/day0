import { v } from 'convex/values';
import type { PaginationOptions, PaginationResult } from 'convex/server';
import { internalQuery, query, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent } from './ownership';
import { isEvaluationAgent } from './metrics';
import { ownerRetirements } from './retirements';
import { redactTokenShapes } from '../src/surfaces/redact';
import { agentZone, dayKey } from '../src/lib/zone';
import {
  sectionAfter,
  TRACE_FORMAT,
  TRACE_PAGE_ROWS,
  TRACE_SECTIONS,
  TRACE_VERSION,
  type TraceHead,
  type TracePage,
  type TraceRetirement,
  type TraceRows,
  type TraceSection,
} from '../src/export/trace';
import { WORK_LISTED_EVENT } from './work';
import { EVENT_TYPES } from '../src/events/contract';
import { eventsOfType } from './eventLog';

/**
 * Events feed — append-only, drives the live UI ticker. The reading side
 * enforces per-account ownership; the writing side is internal-only.
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
 * manager change's previous manager as well as the new one), and a
 * surface's live install claim (a single-use state nonce and the URL that
 * spends it). The export's policy keeps names as working material in text
 * (U12 D1 (c)); a key whose whole value is a name has none to keep.
 */
const PERSONAL_KEYS = new Set([
  'assigneeEmail',
  'boss',
  'bossEmail',
  'createdBy',
  'email',
  'gitBranchName',
  'managerEmail',
  'managerName',
  'managerUserId',
  'namedCollaborators',
  'previousManagerUserId',
  'provisioning',
  'requester',
]);

/**
 * Redact one value for export: personal keys are dropped, every string has
 * its recognisable credential shapes replaced, and containers are walked.
 *
 * Args:
 *   value: A stored payload, ledger entry or nested part of one.
 *
 * Returns:
 *   The same shape with nothing an export should not carry.
 */
export function redactForExport(value: unknown): unknown {
  if (typeof value === 'string') return redactTokenShapes(value);
  if (Array.isArray(value)) return value.map(redactForExport);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !PERSONAL_KEYS.has(key))
        .map(([key, entry]) => [key, redactForExport(entry)]),
    );
  }
  return value;
}

/**
 * The owner's retired employees, newest first, each its `retirements` row
 * redacted for export: what the retire deleted and revoked, and the claims
 * and rejections its colleagues still meet (N1's owner-keyed tombstone). The
 * row's owner key is the owner's identity subject and never leaves; the
 * trace's agent names the owner once, as the recompute needs it.
 */
async function retiredEmployees(
  ctx: QueryCtx,
  owner: string | undefined,
): Promise<TraceRetirement[]> {
  if (owner === undefined) return [];
  return (await ownerRetirements(ctx, owner)).map((row): TraceRetirement => {
    const { userId: subject, ...rest } = row;
    void subject;
    return redactForExport(rest) as TraceRetirement;
  });
}

/**
 * The head of an agent's trace: the manifest, the agent, the owner section
 * and the credential labels, and where the first page starts. Internal; the
 * export action runs it under the caller's identity, with the moment of the
 * export (a query reads no clock), and the ownership check here runs again.
 */
export const exportHead = internalQuery({
  args: { agentId: v.id('agents'), exportedAt: v.number() },
  handler: async (ctx, args): Promise<TraceHead> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const { exportedAt } = args;
    const zone = agentZone(agent);
    const [stamp, surfaces, retired] = await Promise.all([
      ctx.db.query('deploymentVersions').order('desc').first(),
      ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
        .take(TRACE_PAGE_ROWS),
      retiredEmployees(ctx, agent.userId),
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
