import { paginationOptsValidator } from 'convex/server';
import { getDocumentSize, v, type Infer, type ObjectType } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { employeeOwnerScope, type Caller } from './ownership';
import { confirmedPersonOf } from './itemPeople';
import { resolvePerson } from './people';
import { isEvaluationAgent } from './metrics';
import { incomingTransfersOf } from './managerTransfers';
import { OPEN_WORK_STATES, PARKED_WORK_STATES, ROW_BYTES_AT_MOST } from './workLoop';
import { slackMentionIds, type ListedWorkItem } from '../src/work/item-display';
import { NEEDS_YOU_LIMIT } from '../src/metrics/needs-you-pages';
import {
  longestWaitFirst,
  needsYouEntryValidator,
  needsYouOfEmployee,
  transferEntryOf,
} from './needsYou';

/*
 * The lists a manager reads of the work (wave 18, 18-s): one employee's Work tab
 * (`work.listForAgent`), and what waits on the manager across the employees (`work.needsYou`) and
 * for one of them (`work.needsYouForAgent`). Each stays registered in `convex/work.ts` at the path
 * the app holds (S-1), where it validates, guards and calls its body here; the bodies, their
 * validators and the bounds they alone read moved out of that module as they stood. Below
 * `convex/work.ts`: this module never imports it.
 */

/**
 * The work items one read of an employee's list holds (W14-R51): the list was every row the
 * employee ever had, each a whole row with its run's output and up to ten name lookups, in one
 * query. An employee past this many keeps its newest on the Work tab.
 */
export const WORK_LIST_LIMIT = 300;

/**
 * The states a row is not finished in, each with the most of its newest rows one read takes: a
 * slot-holding or parked row is listed whatever its age, since Needs you links to it and the shell
 * counts it (W15-R14); a stopped row as many as the inbox lists (`NEEDS_YOU_STOPPED_READ_LIMIT`),
 * an unjudged one as many as a page of intake. A row that finished, was cancelled or was skipped is
 * listed only among the newest. Slots are held to the work-in-progress cap, so their bound is never
 * reached; the bounds keep the read near the 300 rows it was, with their outputs (the second pass).
 */
const UNFINISHED_STATE_READS: ReadonlyArray<readonly [Doc<'workItems'>['state'], number]> = [
  ...OPEN_WORK_STATES.map((state) => [state, 100] as const),
  ...PARKED_WORK_STATES.map((state) => [state, 100] as const),
  ['failed', 25],
  ['discovered', 50],
];

/**
 * Bytes of rows one read of an employee's list holds at most (W16-R31): the list was bounded in
 * rows and not in bytes, and a row carries its run's output, so an employee with a few hundred
 * heavy rows read past what one query may. Half of that, which leaves the names their reads.
 */
export const WORK_LIST_BYTES = 8 * 1024 * 1024;

/** One read of an employee's work items, newest first: those created before a time, at most a count. */
type NewestBefore = (before: number | undefined, count: number) => Promise<Doc<'workItems'>[]>;

/** The reads of one list, which hold {@link WORK_LIST_BYTES} between them. */
interface ListReader {
  /**
   * Rows newest first, a few at a time and never more than fit the room left at a document's
   * largest size, so the bound holds whatever a row weighs; the read ends at its count, at the
   * index's end or with the room.
   */
  readonly take: (newestBefore: NewestBefore, limit: number) => Promise<Doc<'workItems'>[]>;
  /** The bytes the list may still read. */
  readonly room: () => number;
}

/**
 * A reader of the rows of one list, counted as Convex counts them (a row two reads meet is read
 * twice).
 */
function listReader(): ListReader {
  let room = WORK_LIST_BYTES;
  return {
    room: () => room,
    take: async (newestBefore, limit) => {
      const taken: Doc<'workItems'>[] = [];
      while (taken.length < limit && room > 0) {
        const count = Math.min(
          limit - taken.length,
          Math.max(1, Math.floor(room / ROW_BYTES_AT_MOST)),
        );
        const rows = await newestBefore(taken.at(-1)?._creationTime, count);
        for (const row of rows) room -= getDocumentSize(row);
        taken.push(...rows);
        if (rows.length < count) break;
      }
      return taken;
    },
  };
}

/** What `work.listForAgent` takes. */
export const listForAgentArgs = { agentId: v.id('agents') };

/**
 * One employee's work items for its Work tab, the unfinished first and then the newest, within
 * {@link WORK_LIST_BYTES}, each with its people's names: the body of `work.listForAgent`, which
 * guards the employee first.
 */
export async function listForAgentInTransaction(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  args: ObjectType<typeof listForAgentArgs>,
): Promise<ListedWorkItem[]> {
  const reader = listReader();
  // One after another, not at once: each read is given what the reads before it left.
  const open: Doc<'workItems'>[] = [];
  for (const [state, limit] of UNFINISHED_STATE_READS) {
    open.push(
      ...(await reader.take(
        async (before, count) =>
          await ctx.db
            .query('workItems')
            .withIndex('by_agent_state', (q) => {
              const ofState = q.eq('agentId', args.agentId).eq('state', state);
              return before === undefined ? ofState : ofState.lt('_creationTime', before);
            })
            .order('desc')
            .take(count),
        limit,
      )),
    );
  }
  const newest =
    reader.room() > 0
      ? (
          await ctx.db
            .query('workItems')
            .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
            .order('desc')
            .paginate({
              numItems: WORK_LIST_LIMIT,
              cursor: null,
              maximumBytesRead: reader.room(),
            })
        ).page
      : [];
  const byId = new Map([...newest, ...open].map((row) => [row._id, row]));
  const items = [...byId.values()].sort((left, right) =>
    left.state === right.state
      ? right._creationTime - left._creationTime
      : left.state < right.state
        ? 1
        : -1,
  );
  return await withRequesterNames(ctx, agent, items);
}

/**
 * Each item with the name of the confirmed person its requester resolved to, where it resolved to
 * one still active in the owner's graph (W13V-7: the Work tab named such an ask "A Slack member"),
 * and the confirmed people its text mentions by Slack user id (W13V-7's second half). Each person
 * is read once.
 */
async function withRequesterNames(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  items: readonly Doc<'workItems'>[],
): Promise<ListedWorkItem[]> {
  const scope = employeeOwnerScope(agent);
  if (scope === undefined) return [...items];
  const names = new Map<string, Promise<string | undefined>>();
  const nameOf = (resolution: Doc<'workItems'>['requesterPerson']): Promise<string | undefined> => {
    if (resolution?.kind !== 'person') return Promise.resolve(undefined);
    const known = names.get(resolution.personId);
    if (known !== undefined) return known;
    const read = confirmedPersonOf(ctx, scope, resolution).then((person) => person?.displayName);
    names.set(resolution.personId, read);
    return read;
  };
  const mentioned = new Map<string, Promise<string | undefined>>();
  const mentionedName = (id: string): Promise<string | undefined> => {
    const known = mentioned.get(id);
    if (known !== undefined) return known;
    const read = resolvePerson(ctx, scope, { provider: 'slack', externalId: id })
      .then(async (resolution) => await confirmedPersonOf(ctx, scope, resolution))
      .then((person) => person?.displayName);
    mentioned.set(id, read);
    return read;
  };
  return await Promise.all(
    items.map(async (item): Promise<ListedWorkItem> => {
      const ids = slackMentionIds(`${item.title}\n${item.contentSummary}`);
      const [requesterName, mentionedNames] = await Promise.all([
        nameOf(item.requesterPerson),
        Promise.all(ids.map(async (id) => [id, await mentionedName(id)] as const)),
      ]);
      const mentionNames = Object.fromEntries(
        mentionedNames.flatMap(([id, name]) => (name === undefined ? [] : [[id, name]])),
      );
      return {
        ...item,
        ...(requesterName === undefined ? {} : { requesterName }),
        ...(Object.keys(mentionNames).length === 0 ? {} : { mentionNames }),
      };
    }),
  );
}

/*
 * The needs-you inbox (v2 section 7 step 3, decision N7): everything waiting
 * on the manager across every employee, one entry per thing to decide,
 * ordered by how long it has waited.
 */

/** The most of the owner's agent rows one page of the inbox reads, the roster's twenty. */
const NEEDS_YOU_EMPLOYEE_LIMIT = 20;

/** What `work.needsYou` takes: where a page starts. With none, the first page, as before 0.22.0. */
export const needsYouArgs = { paginationOpts: v.optional(paginationOptsValidator) };

/** What `work.needsYou` returns: its return validator. */
export const needsYouValidator = v.object({
  entries: v.array(needsYouEntryValidator),
  total: v.number(),
  /** How many entries each employee has, all of them counted, not only the ones returned. */
  waitingByEmployee: v.array(v.object({ agentId: v.id('agents'), waiting: v.number() })),
  /** Whether this page reached the owner's last employee (wave 18, 18-F). */
  isDone: v.boolean(),
  /** Where the next page starts. */
  continueCursor: v.string(),
});

/**
 * Everything waiting on the caller across one page of their employees, newest first, and on the
 * first page every handover naming their address, longest wait first: the body of
 * `work.needsYou`, which refuses a caller with no identity first. The home reads every page and
 * puts them together (`inboxOfPages`), so the inbox reaches every employee and not the newest
 * twenty (wave 18, 18-F); a page loaded before 0.22.0 asks with no cursor and reads the first.
 */
export async function needsYouInTransaction(
  ctx: QueryCtx,
  caller: Caller,
  args: ObjectType<typeof needsYouArgs>,
): Promise<Infer<typeof needsYouValidator>> {
  // A token with an empty subject keys nobody's rows, the malformed ones keyed '' included.
  if (caller.ownerKey === '') {
    return { entries: [], total: 0, waitingByEmployee: [], isDone: true, continueCursor: '' };
  }
  const paging = args.paginationOpts ?? { cursor: null, numItems: NEEDS_YOU_EMPLOYEE_LIMIT };
  const read = await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', caller.ownerKey))
    .order('desc')
    .paginate({
      cursor: paging.cursor,
      numItems: Math.min(paging.numItems, NEEDS_YOU_EMPLOYEE_LIMIT),
    });
  const employees = read.page.filter((agent) => !isEvaluationAgent(agent));
  const now = Date.now();
  const [perEmployee, incoming] = await Promise.all([
    Promise.all(employees.map(async (agent) => await needsYouOfEmployee(ctx, agent, now))),
    // The handovers once, on the first page: no employee's page lists one.
    paging.cursor === null ? incomingTransfersOf(ctx, caller, now) : [],
  ]);
  const waiting = perEmployee.flat().sort(longestWaitFirst);
  // No employee's page lists a handover, so every one stays in the entries
  // returned (at most MAX_OPEN_TRANSFERS_PER_ADDRESS); the longest waits fill the rest.
  const transfers = incoming.map(transferEntryOf);
  const entries = [
    ...transfers,
    ...waiting.slice(0, Math.max(0, NEEDS_YOU_LIMIT - transfers.length)),
  ].sort(longestWaitFirst);
  return {
    entries,
    total: waiting.length + transfers.length,
    waitingByEmployee: employees.map((agent, index) => ({
      agentId: agent._id,
      waiting: perEmployee[index]?.length ?? 0,
    })),
    isDone: read.isDone,
    continueCursor: read.continueCursor,
  };
}

/** What `work.needsYouForAgent` returns: its return validator. */
export const needsYouForAgentValidator = v.object({
  entries: v.array(needsYouEntryValidator),
  total: v.number(),
});

/**
 * What one employee waits on the manager for, longest wait first: the body of
 * `work.needsYouForAgent`, which guards the employee first.
 */
export async function needsYouForAgentInTransaction(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
): Promise<Infer<typeof needsYouForAgentValidator>> {
  const entries = (await needsYouOfEmployee(ctx, agent, Date.now())).sort(longestWaitFirst);
  return { entries: entries.slice(0, NEEDS_YOU_LIMIT), total: entries.length };
}
