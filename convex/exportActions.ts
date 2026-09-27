'use node';

import { v } from 'convex/values';
import { action, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgentAction } from './ownership';
import { ownerKnownValues, scrubKnownValues } from '../src/redaction/known-values';
import { redactStructural } from '../src/redaction/redact';
import { TRACE_SECTIONS, type TraceHead, type TracePage } from '../src/export/trace';

/*
 * The redacted trace one owner exports for an audit, a report or the pilot's
 * figures (decisions Q14 and A9), one bounded call at a time.
 *
 * The synchronous trace queries apply the structural floor but cannot
 * decrypt, so the export is an action: it checks ownership, runs the internal
 * query under the same identity (which checks ownership again), then removes
 * every value the owner stores, and every structural secret, from every
 * string before returning. Nothing decrypted is returned or persisted; the
 * values exist only to be removed.
 *
 * No call returns the whole trace: the pinned backend image refuses an array
 * past 8,192 elements, which one agent's events pass. `exportForAgent`
 * returns the head and where the pages start; `exportPage` returns one page
 * and where the next starts. `scripts/export-trace.ts` calls both until
 * nothing is left and writes the one file `metrics:recompute` reads.
 */

/** Every string in a value with the owner's stored values and every structural secret replaced. */
function redactStrings<T>(value: T, known: readonly string[]): T {
  const walk = (entry: unknown): unknown => {
    if (typeof entry === 'string') return redactStructural(entry);
    if (Array.isArray(entry)) return entry.map(walk);
    if (entry !== null && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([key, item]) => [key, walk(item)]),
      );
    }
    return entry;
  };
  return walk(scrubKnownValues(value, known)) as T;
}

/** The owner's stored values, for an agent the caller owns. */
async function knownValuesFor(ctx: ActionCtx, agentId: Id<'agents'>): Promise<readonly string[]> {
  const agent: Doc<'agents'> = await assertOwnsAgentAction(ctx, agentId);
  return agent.userId ? await ownerKnownValues(ctx, agent.userId) : [];
}

/**
 * The head of one agent's trace: its manifest (format, release, commit, the
 * export's date in the agent's zone), the agent with its evaluation flag, the
 * owner's retired employees and the credential labels, and where the first
 * page starts. Public; owner-guarded; reads, writes nothing. The command in
 * the README points here.
 */
export const exportForAgent = action({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<TraceHead> => {
    const known = await knownValuesFor(ctx, args.agentId);
    const head: TraceHead = await ctx.runQuery(internal.events.exportHead, {
      agentId: args.agentId,
    });
    return redactStrings(head, known);
  },
});

/**
 * One page of one section of one agent's trace, redacted, with where the
 * next page starts (null after the last). Public; owner-guarded; reads,
 * writes nothing.
 */
export const exportPage = action({
  args: {
    agentId: v.id('agents'),
    section: v.union(...TRACE_SECTIONS.map((section) => v.literal(section))),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<TracePage> => {
    const known = await knownValuesFor(ctx, args.agentId);
    const page: TracePage = await ctx.runQuery(internal.events.exportPage, args);
    return redactStrings(page, known);
  },
});
