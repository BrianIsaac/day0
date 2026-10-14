'use node';

import { v } from 'convex/values';
import { action, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgentAction, getCallerOrThrow } from './ownership';
import { ownerKnownValues, scrubKnownValues } from '../src/redaction/known-values';
import { redactFloorFor } from '../src/redaction/redact';
import {
  OWNER_SECTIONS,
  rowIdPieces,
  TRACE_SECTIONS,
  type CountedOwnerExportHead,
  type OwnerAgentsPage,
  type OwnerCursor,
  type OwnerExportHead,
  type OwnerPage,
  type OwnerSection,
  type TraceHead,
  type TracePage,
} from '../src/export/trace';

/*
 * The redacted trace one owner exports for an audit, a report or the pilot's
 * figures (decisions Q14 and A9), one bounded call at a time.
 *
 * The synchronous trace queries apply the structural floor but cannot
 * decrypt, so the export is an action: it checks ownership, runs the internal
 * query under the same identity (which checks ownership again), then removes
 * every value the owner stores, every structural secret, and the e-mail,
 * phone, address, id number and date of birth its policy row redacts, from
 * every string before returning. Nothing decrypted is returned or persisted; the
 * values exist only to be removed.
 *
 * No call returns the whole trace: the pinned backend image refuses an array
 * past 8,192 elements, which one agent's events pass. `exportForAgent`
 * returns the head and where the pages start; `exportPage` returns one page
 * and where the next starts. `scripts/export-trace.ts` calls both until
 * nothing is left and writes the one file `metrics:recompute` reads.
 *
 * The owner export (wave 16, 16-F) is the same, one level up: `exportForOwner` returns its head,
 * `exportOwnerAgents` the rest of the owner's agents a page at a time, `exportOwnerPage` the
 * owner's own rows a page at a time, and each employee's trace follows through the two above,
 * written into one file as it arrives (`streamOwnerExport`).
 */

/**
 * Every string in a value with the owner's stored values, every structural
 * secret and the personal data the export's policy row redacts replaced.
 *
 * An employee's id is the file's own bearing, never data (W16-R32): a string that is one of
 * `employeeIds`, whole, is left as it stands, so a short stored value that occurs inside an id
 * cannot break the id the next call, the recompute and the file's own rows are keyed by.
 *
 * @param value - What a call answers, before it leaves.
 * @param known - The owner's stored values.
 * @param employeeIds - The ids of the employees the value is about.
 */
function redactStrings<T>(
  value: T,
  known: readonly string[],
  employeeIds: ReadonlySet<string> = new Set(),
): T {
  // The scrub keeps the value's shape, so the two are walked side by side.
  const walk = (entry: unknown, original: unknown): unknown => {
    if (typeof original === 'string') {
      return employeeIds.has(original) ? original : redactFloorFor(entry as string, 'export');
    }
    if (Array.isArray(entry)) {
      return entry.map((item: unknown, index) =>
        walk(item, (original as readonly unknown[])[index]),
      );
    }
    if (entry !== null && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([key, item]) => [
          key,
          walk(item, (original as Record<string, unknown>)[key]),
        ]),
      );
    }
    return entry;
  };
  return walk(scrubKnownValues(value, known), value) as T;
}

/**
 * The fields of the owner's rows that hold an employee's id, as the schema types them
 * (`v.id('agents')` on `retirements`, `managerTransfers`, `skillVersions`, `relationships` and
 * `workingAgreements`): the ids a page of the owner's rows is about.
 */
export const OWNER_ROW_EMPLOYEE_ID_FIELDS = ['agentId', 'authorAgentId', 'fromAgentId'] as const;

/** The employees' ids a page of the owner's rows names, in the fields the schema keeps them in. */
function employeeIdsOf(rows: readonly unknown[]): Set<string> {
  return new Set(
    rows.flatMap((row) =>
      row === null || typeof row !== 'object'
        ? []
        : OWNER_ROW_EMPLOYEE_ID_FIELDS.flatMap((field) => {
            const id = (row as Record<string, unknown>)[field];
            return typeof id === 'string' ? [id] : [];
          }),
    ),
  );
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
      exportedAt: Date.now(),
    });
    return { ...redactStrings(head, known, new Set([args.agentId])), next: head.next };
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
    // The cursor is the backend's own position, never data: redacting it
    // could turn it into one the next call cannot read.
    return { ...page, rows: redactStrings(page.rows, known, new Set([args.agentId])) };
  },
});

/** The caller's stored values, for the owner export's redaction. */
async function knownValuesOfCaller(ctx: ActionCtx): Promise<readonly string[]> {
  const { ownerKey } = await getCallerOrThrow(ctx);
  return await ownerKnownValues(ctx, ownerKey);
}

/** The ids of the agents a page of the owner's agents names, employees and set aside. */
function agentIdsOf(page: Pick<OwnerAgentsPage, 'employees' | 'setAside'>): Set<string> {
  return new Set([...page.employees, ...page.setAside].map((agent) => agent.id));
}

/**
 * The ids of the caller's own rows, section by section, read by the export's own pages from where
 * they start to their end (wave 18, 18-F; F16): the counts the file's manifest carries before the
 * rows are written. Each page is read and let go; only the ids are kept, redacted as
 * `exportOwnerPage` redacts its rows, so each is the id the file will name (a short stored value
 * inside an id is scrubbed there too).
 *
 * @param known - The caller's stored values, as `exportOwnerPage` reads them.
 * @throws Error when a page answers a cursor it gave before, which would read the same pages for
 *   ever.
 */
async function ownerRowIds(
  ctx: ActionCtx,
  from: OwnerCursor,
  known: readonly string[],
): Promise<CountedOwnerExportHead['rowIds']> {
  const ids = Object.fromEntries(
    OWNER_SECTIONS.map((section): [OwnerSection, Set<string>] => [section, new Set()]),
  ) as Record<OwnerSection, Set<string>>;
  const asked = new Set<string>();
  let next: OwnerCursor | null = from;
  while (next !== null) {
    const printed = JSON.stringify(next);
    if (asked.has(printed)) {
      throw new Error(`the export answered the same cursor of the owner’s ${next.section} twice`);
    }
    asked.add(printed);
    const page: OwnerPage = await ctx.runQuery(internal.events.exportOwnerPage, next);
    const read = page.rows.map((row) => String((row as { _id?: unknown })._id));
    for (const id of redactStrings(read, known, employeeIdsOf(page.rows))) {
      ids[page.section].add(id);
    }
    next = page.next;
  }
  return Object.fromEntries(
    OWNER_SECTIONS.map((section): [OwnerSection, string[][]] => [
      section,
      rowIdPieces([...ids[section]]),
    ]),
  ) as Record<OwnerSection, string[][]>;
}

/**
 * The head of the caller's owner export (wave 16, 16-F; decision F-1): its manifest, the first
 * page of the employees the caller holds, whose traces follow through `exportForAgent` and
 * `exportPage`, and of the agents the figures set aside, with where the next page of them starts
 * (`exportOwnerAgents`), where the owner's rows start, and the ids of those rows section by
 * section, read first so the file can carry their counts before them and write them as they are
 * read (wave 18, F16). Public, any signed-in caller, for the caller's own rows only
 * (`getCallerOrThrow`; every read is keyed by the caller's owner key); reads, writes nothing.
 */
export const exportForOwner = action({
  args: {},
  handler: async (ctx): Promise<CountedOwnerExportHead> => {
    const known = await knownValuesOfCaller(ctx);
    const head: OwnerExportHead = await ctx.runQuery(internal.events.exportOwnerHead, {
      exportedAt: Date.now(),
    });
    // The owner key, the cursors and the rows' ids are the file's own bearings, never data to
    // redact.
    return {
      ...redactStrings(head, known, agentIdsOf(head)),
      manifest: { ...redactStrings(head.manifest, known), ownerKey: head.manifest.ownerKey },
      moreAgents: head.moreAgents,
      next: head.next,
      rowIds: await ownerRowIds(ctx, head.next, known),
    };
  },
});

/**
 * One later page of the caller's agents for the owner export, redacted, from the cursor the head
 * or the page before handed out (null after the last), so the export names every agent the caller
 * holds (wave 17, W16-R32). Public, any signed-in caller, for the caller's own rows only; reads,
 * writes nothing.
 */
export const exportOwnerAgents = action({
  args: { cursor: v.string() },
  handler: async (ctx, args): Promise<OwnerAgentsPage> => {
    const known = await knownValuesOfCaller(ctx);
    const page: OwnerAgentsPage = await ctx.runQuery(internal.events.exportOwnerAgents, args);
    return { ...redactStrings(page, known, agentIdsOf(page)), moreAgents: page.moreAgents };
  },
});

/**
 * One page of one section of the caller's own rows, redacted, with where the next page starts
 * (null after the last). Public, any signed-in caller, for the caller's own rows only; reads,
 * writes nothing.
 */
export const exportOwnerPage = action({
  args: {
    section: v.union(...OWNER_SECTIONS.map((section) => v.literal(section))),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<OwnerPage> => {
    const known = await knownValuesOfCaller(ctx);
    const page: OwnerPage = await ctx.runQuery(internal.events.exportOwnerPage, args);
    return { ...page, rows: redactStrings(page.rows, known, employeeIdsOf(page.rows)) };
  },
});
