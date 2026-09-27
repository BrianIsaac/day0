import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent } from './ownership';
import { collectLedgerObservations } from './metrics';
import { redactTokenShapes } from '../src/surfaces/redact';
import { WORK_LISTED_EVENT } from './work';

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

/**
 * The newest events of one agent for the dashboard ticker, newest first,
 * intake listings left out. Public; owner-guarded; reads at most
 * `TICKER_SCAN_LIMIT` events.
 */
export const recent = query({
  args: { agentId: v.id('agents'), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Doc<'events'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    const limit = args.limit ?? 50;
    const shown: Doc<'events'>[] = [];
    let scanned = 0;
    for await (const event of ctx.db
      .query('events')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')) {
      scanned += 1;
      if (!TICKER_HIDDEN_TYPES.has(event.type)) shown.push(event);
      if (shown.length >= limit || scanned >= Math.max(limit, TICKER_SCAN_LIMIT)) break;
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
    const events = await ctx.db
      .query('events')
      .withIndex('by_agent_type', (q) =>
        q.eq('agentId', args.agentId).eq('type', 'agent.autonomy-changed'),
      )
      .collect();
    return events.map((event) => ({
      at: event.createdAt,
      on: (event.payload as { to?: unknown } | undefined)?.to === true,
    }));
  },
});

/** Payload keys that identify a person rather than describe an action. */
const PERSONAL_KEYS = new Set(['assigneeEmail', 'bossEmail', 'email', 'managerEmail']);

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

/** One agent's redacted trace, as the export action returns it. */
export interface AgentTrace {
  version: 1;
  agent: { id: Id<'agents'>; name: string };
  events: Doc<'events'>[];
  ledger: ReturnType<typeof collectLedgerObservations>;
  credentialNames: Array<{ label: string }>;
}

/**
 * The complete trace with the synchronous floor applied, for the export
 * action only.
 *
 * A query cannot decrypt the owner's stored values, so this is internal:
 * `exportActions.exportForAgent` runs it under the caller's identity (the
 * ownership check below still runs) and removes every stored value before
 * anything leaves the deployment.
 */
export const exportForAgent = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<AgentTrace> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const [events, workItems, surfaces] = await Promise.all([
      ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('workItems')
        .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
        .collect(),
    ]);
    const credentials = await Promise.all(
      [
        ...new Set(
          surfaces.flatMap((surface) => (surface.credentialId ? [surface.credentialId] : [])),
        ),
      ].map(async (credentialId) => await ctx.db.get(credentialId)),
    );
    return {
      version: 1,
      agent: { id: agent._id, name: agent.name },
      events: events.map((event) => ({ ...event, payload: redactForExport(event.payload) })),
      ledger: collectLedgerObservations(events, workItems).map((observation) => ({
        ...observation,
        entry: redactForExport(observation.entry) as typeof observation.entry,
      })),
      credentialNames: credentials.flatMap((credential) =>
        credential ? [{ label: credential.label }] : [],
      ),
    };
  },
});

export const log = internalMutation({
  args: { agentId: v.id('agents'), type: v.string(), payload: v.optional(v.any()) },
  handler: async (ctx, args) => {
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: args.type,
      payload: args.payload ?? {},
      createdAt: Date.now(),
    });
  },
});
