import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent } from './ownership';
import { collectLedgerObservations } from './metrics';
import { redactTokenShapes } from '../src/surfaces/redact';

/**
 * Events feed — append-only, drives the live UI ticker. The reading side
 * enforces per-account ownership; the writing side is internal-only.
 */

export const recent = query({
  args: { agentId: v.id('agents'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    const limit = args.limit ?? 50;
    return await ctx.db
      .query('events')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .take(limit);
  },
});

/** Payload keys that identify a person rather than describe an action. */
const PERSONAL_KEYS = new Set(['bossEmail', 'email', 'managerEmail']);

/**
 * Redact one value for export: personal keys are dropped, every string has
 * its recognisable credential shapes replaced, and containers are walked.
 *
 * Args:
 *   value: A stored payload, ledger entry or nested part of one.
 *
 * Returns:
 *   The same shape with nothing a judge should not receive.
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

/** The judge-facing trace, as the export action returns it. */
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
      [...new Set(surfaces.flatMap((surface) => (surface.credentialId ? [surface.credentialId] : [])))]
        .map(async (credentialId) => await ctx.db.get(credentialId)),
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
