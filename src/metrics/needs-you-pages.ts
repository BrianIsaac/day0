/*
 * The needs-you inbox read by pages (wave 18, 18-F): `work.needsYou` answers twenty employees a
 * page, each page with its employees' longest waits, their counts and, on the first page, the
 * handovers naming the manager; the home reads every page and puts them together here, so the
 * inbox reaches every employee the roster lists and not the newest twenty.
 */

/** The most entries the inbox lists; its `total` says how many there are in all. */
export const NEEDS_YOU_LIMIT = 50;

/** What the inbox needs of an entry to order it, and whether it is a handover (`transfer`). */
export interface WaitingEntry {
  readonly key: string;
  readonly waitingSince: number;
  readonly kind?: string;
}

/** How many entries wait on one employee, every one counted. */
export interface EmployeeWaiting<AgentId extends string = string> {
  readonly agentId: AgentId;
  readonly waiting: number;
}

/** The inbox as one read answered it, and as the pages put together answer it. */
export interface NeedsYouInboxOf<Entry extends WaitingEntry, AgentId extends string = string> {
  readonly entries: readonly Entry[];
  readonly total: number;
  readonly waitingByEmployee: ReadonlyArray<EmployeeWaiting<AgentId>>;
}

/**
 * The inbox's one order: the longest wait first, ties by key so the order is stable. The same as
 * `longestWaitFirst` in `convex/needsYou.ts`, which the backend sorts each page by; a test holds
 * the two to one order.
 */
export function byLongestWait(left: WaitingEntry, right: WaitingEntry): number {
  return left.waitingSince - right.waitingSince || left.key.localeCompare(right.key);
}

/**
 * The pages of the inbox put together: every handover, then the longest waits of every page to
 * {@link NEEDS_YOU_LIMIT} in all, in one order, the totals summed and every employee's count, as
 * one read of the inbox answered before 0.22.0 (no employee's page lists a handover, so none is
 * cut, however recent). Each page holds its own employees' longest waits up to the limit, and the
 * first holds every handover, so the longest waits of all are among them. An employee two pages
 * both answered (one deployed between the reads moves the rest along) is counted once, as the
 * later page has it.
 *
 * @param pages - Every page, in the order they were read.
 * @returns The whole inbox.
 */
export function inboxOfPages<Entry extends WaitingEntry, AgentId extends string>(
  pages: ReadonlyArray<NeedsYouInboxOf<Entry, AgentId>>,
): NeedsYouInboxOf<Entry, AgentId> {
  const waiting = new Map<AgentId, number>();
  const entries = new Map<string, Entry>();
  let handed = 0;
  for (const page of pages) {
    const counted = page.waitingByEmployee.reduce((sum, employee) => sum + employee.waiting, 0);
    // What a page counts beyond its employees' waits is the handovers, which no employee holds.
    handed += page.total - counted;
    for (const employee of page.waitingByEmployee) waiting.set(employee.agentId, employee.waiting);
    for (const entry of page.entries) entries.set(entry.key, entry);
  }
  const waitingByEmployee = [...waiting].map(([agentId, count]) => ({ agentId, waiting: count }));
  const all = [...entries.values()];
  const handovers = all.filter((entry) => entry.kind === 'transfer');
  const waits = all.filter((entry) => entry.kind !== 'transfer').sort(byLongestWait);
  return {
    entries: [
      ...handovers,
      ...waits.slice(0, Math.max(0, NEEDS_YOU_LIMIT - handovers.length)),
    ].sort(byLongestWait),
    total: handed + waitingByEmployee.reduce((sum, employee) => sum + employee.waiting, 0),
    waitingByEmployee,
  };
}
