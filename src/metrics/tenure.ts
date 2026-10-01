/**
 * The spans of time each owner held an employee, read from its accepted
 * handovers, so the company figures count each employee's events within its
 * owners' tenures: the old owner's past months never change after a handover,
 * and the new owner's figures count from the acceptance (D12 (a), the
 * transfer plan section 6.6). Pure: the figures' query and any recompute read
 * the same rule.
 */

/** One accepted handover of an employee, as the figures read it from its `managerTransfers` row. */
export interface AcceptedHandover {
  readonly agentId: string;
  /** The owner key that held the employee before. */
  readonly fromOwnerKey: string;
  /** The owner key that holds it from the acceptance. */
  readonly toOwnerKey: string;
  /** When the named manager accepted: the boundary between the two tenures. */
  readonly acceptedAt: number;
}

/**
 * A span one owner held an employee: from `from`, inclusive, until `until`,
 * exclusive, in epoch milliseconds. A null bound is unbounded: no handover
 * before it, or none since.
 */
export interface TenureWindow {
  readonly from: number | null;
  readonly until: number | null;
}

/** The span of an employee never handed over: all of its history is its one owner's. */
export const WHOLE_HISTORY: TenureWindow = { from: null, until: null };

/**
 * The spans in which one owner held an employee.
 *
 * The handovers cut its history at each acceptance; the span before the
 * first is held by the first handover's old owner, each span between two by
 * the later one's old owner, and the span since the last by the employee's
 * current owner. An employee never handed over is wholly its current owner's.
 *
 * @param owner - The owner key whose spans are wanted.
 * @param currentOwner - The employee's `userId` now.
 * @param handovers - The employee's accepted handovers, in any order.
 * @returns The owner's spans in time order; none when the owner never held it.
 * @throws Error when the handovers name more than one employee.
 */
export function tenureWindowsOf(
  owner: string,
  currentOwner: string | undefined,
  handovers: readonly AcceptedHandover[],
): TenureWindow[] {
  const agentIds = new Set(handovers.map((handover) => handover.agentId));
  if (agentIds.size > 1) {
    throw new Error(`tenure windows are read for one employee at a time, not ${agentIds.size}`);
  }
  const ordered = [...handovers].sort((left, right) => left.acceptedAt - right.acceptedAt);
  const spans = [
    ...ordered.map((handover, index) => ({
      holder: handover.fromOwnerKey,
      from: index === 0 ? null : ordered[index - 1].acceptedAt,
      until: handover.acceptedAt,
    })),
    { holder: currentOwner, from: ordered.at(-1)?.acceptedAt ?? null, until: null },
  ];
  return spans
    .filter((span) => span.holder === owner)
    .map(({ from, until }): TenureWindow => ({ from, until }));
}

/** Whether a moment falls within any of an owner's spans. */
export function isWithinTenure(at: number, windows: readonly TenureWindow[]): boolean {
  return windows.some(
    (window) =>
      (window.from === null || at >= window.from) && (window.until === null || at < window.until),
  );
}

/** Whether the spans are the employee's whole history, as for one never handed over. */
export function isWholeHistory(windows: readonly TenureWindow[]): boolean {
  return windows.length === 1 && windows[0].from === null && windows[0].until === null;
}
