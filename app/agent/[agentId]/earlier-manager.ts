import { sameManagerAddress } from '@/agent/manager-address';

/** One handover that moved the employee, as `managerTransfers.earlierManagers` lists it. */
export interface EarlierManager {
  readonly fromAddress: string;
  readonly decidedAt: number;
}

/**
 * Who managed the employee at a moment, as the page's reader sees it: the reader, or the earlier
 * manager a later handover took the employee from (decision 5; the wave 10 review, M8).
 */
export type ManagerAt =
  | { readonly kind: 'reader' }
  | { readonly kind: 'earlier'; readonly address: string };

/** The reader managed the employee: every event no handover followed. */
export const READER_MANAGED: ManagerAt = { kind: 'reader' };

/**
 * Who managed the employee at a moment: the manager who handed it over at the first handover
 * after it, or the reader when none followed or it came from the reader's own address. A
 * handover is dated by its acceptance, the moment the record and the figures cut it.
 *
 * @param at - The moment, in epoch milliseconds.
 * @param earlier - The employee's handovers, oldest first.
 * @param reader - The reader's address, the employee's manager now.
 */
export function managerAt(
  at: number,
  earlier: readonly EarlierManager[],
  reader: string,
): ManagerAt {
  const handover = earlier.find((moved) => moved.decidedAt > at);
  return handover === undefined || sameManagerAddress(handover.fromAddress, reader)
    ? READER_MANAGED
    : { kind: 'earlier', address: handover.fromAddress };
}
