/**
 * A request to hand an employee to another manager: its states, the bounds a
 * request is held to and the pure rules over them. The schema's
 * `managerTransfers` table, the request's mutations and the acceptance all
 * read these, so the rules are stated once (the transfer plan, sections 4.1,
 * 4.2, 6.4 and 10.3).
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Every state a request can be in. `asked` waits for the named manager;
 * `accepting` has their acceptance and waits for runs in flight to end; the
 * other four are final.
 */
export const MANAGER_TRANSFER_STATES = [
  'asked',
  'accepting',
  'accepted',
  'declined',
  'cancelled',
  'expired',
] as const;

/** One of {@link MANAGER_TRANSFER_STATES}. */
export type ManagerTransferState = (typeof MANAGER_TRANSFER_STATES)[number];

/** The states of an open request: at most one per employee is in one of these. */
export const OPEN_MANAGER_TRANSFER_STATES = [
  'asked',
  'accepting',
] as const satisfies readonly ManagerTransferState[];

/** One of {@link OPEN_MANAGER_TRANSFER_STATES}. */
export type OpenManagerTransferState = (typeof OPEN_MANAGER_TRANSFER_STATES)[number];

/** Why an asked request was cancelled: by its owner, by the employee's retire, or replaced by a new address. */
export const TRANSFER_CANCEL_REASONS = ['owner', 'retired', 'address-changed'] as const;

/** One of {@link TRANSFER_CANCEL_REASONS}. */
export type TransferCancelReason = (typeof TRANSFER_CANCEL_REASONS)[number];

/**
 * The states each state may move to. There is no reopening: a declined or
 * expired request is asked again as a new row, so the record keeps each
 * attempt, and an acceptance once given is irrevocable.
 */
const TRANSFER_MOVES: Readonly<Record<ManagerTransferState, readonly ManagerTransferState[]>> = {
  asked: ['accepting', 'accepted', 'declined', 'cancelled', 'expired'],
  accepting: ['accepted'],
  accepted: [],
  declined: [],
  cancelled: [],
  expired: [],
};

/** How long a request waits for its answer before the sweep expires it (D4). */
export const TRANSFER_EXPIRY_MS = 14 * DAY_MS;

/**
 * How long an accepted request waits for runs in flight before it stops them
 * and moves the employee (D18): past the ten-minute step lease, the
 * twelve-minute stall bound and the six-minute apply recovery.
 */
export const TRANSFER_SETTLE_MS = 15 * MINUTE_MS;

/** At most this many open requests for one employee. */
export const MAX_OPEN_TRANSFERS_PER_EMPLOYEE = 1;

/** At most this many open requests one owner has asked (D16). */
export const MAX_OPEN_TRANSFERS_PER_OWNER = 5;

/** At most this many asks by one owner in any {@link TRANSFER_ASK_WINDOW_MS} (D16). */
export const MAX_TRANSFER_ASKS_PER_WINDOW = 20;

/** The rolling window the ask count is taken over. */
export const TRANSFER_ASK_WINDOW_MS = DAY_MS;

/** At most this many open requests naming one address, from all owners together (D16). */
export const MAX_OPEN_TRANSFERS_PER_ADDRESS = 10;

/** The longest handover note the old manager may leave. */
export const MAX_TRANSFER_NOTE_LENGTH = 1_000;

/** The longest reason the named manager may give for declining. */
export const MAX_DECLINE_REASON_LENGTH = 500;

/** How long a finished request stays among the old manager's notices. */
export const TRANSFER_DEPARTURES_WINDOW_MS = 30 * DAY_MS;

/** Whether a request in this state is still open. */
export function isOpenTransferState(
  state: ManagerTransferState,
): state is OpenManagerTransferState {
  return (OPEN_MANAGER_TRANSFER_STATES as readonly ManagerTransferState[]).includes(state);
}

/** Whether a request in this state is final: nothing moves it again. */
export function isFinalTransferState(state: ManagerTransferState): boolean {
  return TRANSFER_MOVES[state].length === 0;
}

/**
 * Whether a request may move from one state to another.
 *
 * @param from - The state the row is in when the transaction reads it.
 * @param to - The state the caller would write.
 */
export function canMoveTransfer(from: ManagerTransferState, to: ManagerTransferState): boolean {
  return TRANSFER_MOVES[from].includes(to);
}

/**
 * When a request asked at this moment expires.
 *
 * @param requestedAt - When it was asked, in epoch milliseconds.
 */
export function transferExpiresAt(requestedAt: number): number {
  return requestedAt + TRANSFER_EXPIRY_MS;
}

/**
 * The deadline for runs in flight of a request accepted at this moment.
 *
 * @param acceptedAt - When the named manager accepted, in epoch milliseconds.
 */
export function transferSettleBy(acceptedAt: number): number {
  return acceptedAt + TRANSFER_SETTLE_MS;
}

/**
 * Whether the expiry sweep should expire a request now. Only an asked
 * request expires: an accepting one already has its answer.
 */
export function isTransferDue(
  request: { readonly state: ManagerTransferState; readonly expiresAt: number },
  now: number,
): boolean {
  return request.state === 'asked' && request.expiresAt <= now;
}

/**
 * Whether an ask made at `requestedAt` still counts toward the owner's
 * rolling-day bound at `now`.
 */
export function isWithinAskWindow(requestedAt: number, now: number): boolean {
  return now - requestedAt < TRANSFER_ASK_WINDOW_MS;
}

/** The refusal for a request that no longer exists. A `ConvexError`'s data, so the dialog can show it. */
export const TRANSFER_NOT_FOUND = 'This handover no longer exists.';

/** The refusal for an account the request does not name. A `ConvexError`'s data. */
export const NOT_NAMED_IN_TRANSFER = 'This handover is addressed to someone else.';

/**
 * The refusal for a caller whose sign-in asserts no verified address: a
 * request names an address, and only that address, verified, may answer it.
 * A `ConvexError`'s data.
 */
export const UNVERIFIED_FOR_TRANSFER =
  'Your sign-in does not carry a verified email address, so no handover can be addressed to you. Verify your address, then sign in again.';

/**
 * The refusal for the account that asked, signed in with the named address: one account
 * cannot both give an employee and take it on, whatever its addresses. A `ConvexError`'s data.
 */
export const OWN_TRANSFER =
  'This handover was asked from your own account, so your account cannot take it on.';
