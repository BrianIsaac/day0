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
 * The stopped rows are read first, within {@link STOPPED_ROWS_BYTES}, so open and parked rows that
 * hold the bound cannot starve the rows Needs you links to (W17-R22).
 */
const UNFINISHED_STATE_READS: ReadonlyArray<readonly [Doc<'workItems'>['state'], number]> = [
  ['failed', 25],
  ...OPEN_WORK_STATES.map((state) => [state, 100] as const),
  ...PARKED_WORK_STATES.map((state) => [state, 100] as const),
  ['discovered', 50],
];

/**
 * Bytes of rows one read of an employee's list holds at most (W16-R31): the list was bounded in
 * rows and not in bytes, and a row carries its run's output, so an employee with a few hundred
 * heavy rows read past what one query may. Half of that, which leaves the names their reads.
 */
export const WORK_LIST_BYTES = 8 * 1024 * 1024;

/**
 * Of {@link WORK_LIST_BYTES}, the most the stopped rows' read may take, so the open and parked
 * rows read after it keep about the other half (a read takes one row at the least, so the share may
 * run past its half by one row): Needs you links to both, and neither may starve the other
 * (W17-R22). A stopped row carries its run's output and can be heavy; an open one rarely is.
 */
export const STOPPED_ROWS_BYTES = WORK_LIST_BYTES / 2;

/** One read of an employee's work items, newest first: those created before a time, at most a count. */
type NewestBefore = (before: number | undefined, count: number) => Promise<Doc<'workItems'>[]>;

/** The reads of one list, which hold {@link WORK_LIST_BYTES} between them. */
interface ListReader {
  /**
   * Rows newest first, a few at a time and never more than fit the room left at a document's
   * largest size, so the bound holds whatever a row weighs; the read ends at its count, at the
   * index's end or with the room, or with `share` bytes when it is given.
   */
  readonly take: (
    newestBefore: NewestBefore,
    limit: number,
    share?: number,
  ) => Promise<Doc<'workItems'>[]>;
  /** The bytes the list may still read. */
  readonly room: () => number;
  /** Whether a read ended with the room (or its share) while rows of its kind may be left. */
  readonly cut: () => boolean;
}

/**
 * A reader of the rows of one list, counted as Convex counts them (a row two reads meet is read
 * twice).
 */
function listReader(): ListReader {
  let room = WORK_LIST_BYTES;
  let cut = false;
  return {
    room: () => room,
    cut: () => cut,
    take: async (newestBefore, limit, share = WORK_LIST_BYTES) => {
      const taken: Doc<'workItems'>[] = [];
      let left = Math.min(room, share);
      while (taken.length < limit) {
        if (left <= 0) {
          // The last read came back full, so more rows of its kind may wait past the room.
          cut = true;
          break;
        }
        const count = Math.min(
          limit - taken.length,
          Math.max(1, Math.floor(left / ROW_BYTES_AT_MOST)),
        );
        const rows = await newestBefore(taken.at(-1)?._creationTime, count);
        for (const row of rows) {
          const size = getDocumentSize(row);
          room -= size;
          left -= size;
        }
        taken.push(...rows);
        if (rows.length < count) break;
      }
      return taken;
    },
  };
}

/**
 * One employee's Work tab list: its rows, and whether the bounds left some of its rows out (the
 * oldest of them, which the owner's export still holds; W17-R22), so the tab can say so.
 */
export interface WorkList {
  readonly items: ListedWorkItem[];
  readonly cut: boolean;
}

/** What `work.listForAgent` takes. */
export const listForAgentArgs = { agentId: v.id('agents') };

/**
 * One employee's work items for its Work tab, the unfinished first and then the newest, within
 * {@link WORK_LIST_BYTES}, each with its people's names, and whether the bounds left rows out: the
 * body of `work.listForAgent`, which guards the employee first.
 */
export async function listForAgentInTransaction(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  args: ObjectType<typeof listForAgentArgs>,
): Promise<WorkList> {
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
        state === 'failed' ? STOPPED_ROWS_BYTES : undefined,
      )),
    );
  }
  const newest =
    reader.room() > 0
      ? await ctx.db
          .query('workItems')
          .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
          .order('desc')
          .paginate({
            // One past the limit, so a full page says whether more rows wait behind it whatever
            // the backend answers for `isDone` at exactly the limit.
            numItems: WORK_LIST_LIMIT + 1,
            cursor: null,
            maximumBytesRead: reader.room(),
          })
      : undefined;
  // With no room left for the newest read, the finished rows are the ones left out.
  const newestRows = newest?.page.slice(0, WORK_LIST_LIMIT) ?? [];
  const cut =
    reader.cut() || newest === undefined || newest.page.length > WORK_LIST_LIMIT || !newest.isDone;
  const byId = new Map([...newestRows, ...open].map((row) => [row._id, row]));
  const items = [...byId.values()].sort((left, right) =>
    left.state === right.state
      ? right._creationTime - left._creationTime
      : left.state < right.state
        ? 1
        : -1,
  );
  return { items: await withRequesterNames(ctx, agent, items), cut };
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

/** How many of the owner's agent rows the inbox reads to find its employees, as the roster does. */
const NEEDS_YOU_SCAN_LIMIT = 100;

/** The most employees the inbox covers, the roster's twenty. */
const NEEDS_YOU_EMPLOYEE_LIMIT = 20;

/** The most entries the inbox returns; `total` says how many there are. */
const NEEDS_YOU_LIMIT = 50;

/** What `work.needsYou` returns: its return validator. */
export const needsYouValidator = v.object({
  entries: v.array(needsYouEntryValidator),
  total: v.number(),
  /** How many entries each employee has, all of them counted, not only the ones returned. */
  waitingByEmployee: v.array(v.object({ agentId: v.id('agents'), waiting: v.number() })),
});

/**
 * Everything waiting on the caller across their employees, and every handover naming their
 * address, longest wait first: the body of `work.needsYou`, which refuses a caller with no
 * identity first.
 */
export async function needsYouInTransaction(
  ctx: QueryCtx,
  caller: Caller,
): Promise<Infer<typeof needsYouValidator>> {
  // A token with an empty subject keys nobody's rows, the malformed ones keyed '' included.
  if (caller.ownerKey === '') return { entries: [], total: 0, waitingByEmployee: [] };
  const employees = (
    await ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', caller.ownerKey))
      .order('desc')
      .take(NEEDS_YOU_SCAN_LIMIT)
  )
    .filter((agent) => !isEvaluationAgent(agent))
    .slice(0, NEEDS_YOU_EMPLOYEE_LIMIT);
  const now = Date.now();
  const [perEmployee, incoming] = await Promise.all([
    Promise.all(employees.map(async (agent) => await needsYouOfEmployee(ctx, agent, now))),
    incomingTransfersOf(ctx, caller, now),
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
