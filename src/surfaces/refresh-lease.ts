/*
 * The refresh lease (the round after wave 11, R-S; the wave 11 review's m11). A refresh token is
 * presented once per generation: the refresh that would present it first takes a lease on the
 * access token's row (`credentials.refreshingUntil`) in the same transaction that reads the
 * generation, and any other refresh of that row waits for the holder's rotation instead of
 * presenting the same token. A server with refresh-token reuse detection would otherwise end the
 * whole grant. A lease its holder never releases (the action died) lapses by itself.
 */

/**
 * How long one refresh holds the lease. Longer than the slowest exchange a holder makes under it
 * (a Slack or Linear request is cut at 30 s, an MCP token request at 15 s) with its write, so a
 * live holder never loses the lease to a waiter while its exchange is under way.
 */
export const REFRESH_LEASE_MS = 90_000;

/** How long a waiter sleeps between two reads of the lease. */
export const LEASE_POLL_MS = 250;

/** The most reads a waiter makes before it treats the lease as ended, whatever its clock says. */
export const LEASE_POLLS = Math.ceil(REFRESH_LEASE_MS / LEASE_POLL_MS) + 1;

/**
 * The most reads a waiter makes while the token it holds still lives (five seconds): long enough
 * for a live holder's exchange to land, short enough that a read behind a dead holder's lease
 * uses the stored token rather than waiting out the lease.
 */
export const LIVE_TOKEN_LEASE_POLLS = Math.ceil(5_000 / LEASE_POLL_MS);

/** An access token's row as far as the lease reads it. */
export interface LeasedRow {
  /** Absent on the row reads as 0. */
  readonly generation?: number;
  readonly refreshingUntil?: number;
}

/** What a claim of the lease answers, before the refresh token is read. */
export type LeaseDecision =
  | { readonly kind: 'claim'; readonly leaseUntil: number }
  | { readonly kind: 'moved' }
  | { readonly kind: 'leased'; readonly until: number };

/**
 * Whether a refresh may take the lease on a row: not when a rotation has moved the pair past the
 * generation the refresh read (it uses the winner's token), and not while another refresh holds an
 * unexpired lease (it waits for that one).
 *
 * @param row - The access token's row, read in the claiming transaction.
 * @param expectedGeneration - The generation the refresh read.
 * @param now - The claiming transaction's time.
 */
export function leaseDecision(
  row: LeasedRow,
  expectedGeneration: number,
  now: number,
): LeaseDecision {
  if ((row.generation ?? 0) !== expectedGeneration) return { kind: 'moved' };
  if (row.refreshingUntil !== undefined && row.refreshingUntil > now) {
    return { kind: 'leased', until: row.refreshingUntil };
  }
  return { kind: 'claim', leaseUntil: now + REFRESH_LEASE_MS };
}

/** Another refresh of the token held the lease the whole time this one waited for it. */
export class RefreshInProgress extends Error {
  constructor() {
    super('Another refresh of this token is still under way; it is tried again shortly.');
    this.name = 'RefreshInProgress';
  }
}

/** What a waiter reads and how it waits. */
export interface LeaseWait {
  /** The row's generation and lease as they stand, or null once the row is gone. */
  read(): Promise<LeasedRow | null>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Wait for the refresh that holds a row's lease: `moved` once its rotation lands (or the row is
 * gone), `free` once the lease ends without one (released by a holder that failed, or lapsed), so
 * the waiter may claim it itself. Bounded by `polls` reads as well as by the clock.
 *
 * @param wait - How the waiter reads the row and sleeps.
 * @param lease - The generation the waiter read and the end of the lease it found.
 * @param polls - The most reads; {@link LEASE_POLLS}, the whole lease, unless the caller says less.
 */
export async function awaitLeaseHolder(
  wait: LeaseWait,
  lease: { readonly generation: number; readonly until: number },
  polls: number = LEASE_POLLS,
): Promise<'moved' | 'free'> {
  for (let poll = 0; poll < polls; poll += 1) {
    const row = await wait.read();
    if (row === null || (row.generation ?? 0) !== lease.generation) return 'moved';
    if (row.refreshingUntil !== lease.until || wait.now() >= lease.until) return 'free';
    await wait.sleep(LEASE_POLL_MS);
  }
  return 'free';
}

/** Sleep on the runtime's timer; the default for a waiter outside a test. */
export async function sleepFor(ms: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, ms);
  });
}
