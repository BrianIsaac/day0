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
 * The `cancelReason` an accepted handover that ended without its move is stored with (the
 * transfer's decision 4: its settle kept failing, the move would be refused, or the operator
 * ended it), so a reader tells it from an ask's cancel without reading the record. Declared by
 * the wave 11 schema step; rows from before it carry no reason.
 */
export const HANDOVER_ENDED_CANCEL_REASON = 'handover-ended';

/**
 * Every `cancelReason` a request's row may carry: an ask's cancel ({@link TRANSFER_CANCEL_REASONS},
 * which the `manager.transfer-cancelled` event names) or the end of an accepted handover, which
 * that event never names (`manager.transfer-ended` is its record).
 */
export const TRANSFER_ROW_CANCEL_REASONS = [
  ...TRANSFER_CANCEL_REASONS,
  HANDOVER_ENDED_CANCEL_REASON,
] as const;

/** One of {@link TRANSFER_ROW_CANCEL_REASONS}. */
export type TransferRowCancelReason = (typeof TRANSFER_ROW_CANCEL_REASONS)[number];

/**
 * Whether a cancelled request's reason says an accepted handover ended without its move: the
 * end's own reason, or none, which is how a release before the wave 11 schema step stored it.
 *
 * @param reason - The row's `cancelReason`.
 */
export function endedWithoutMove(reason: TransferRowCancelReason | undefined): boolean {
  return reason === undefined || reason === HANDOVER_ENDED_CANCEL_REASON;
}

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
 * How long the identity a handover kept for a card (A25) waits for the new manager to approve the
 * card again before it is ended at the vendor (the wave 11 review's m8): as long as a request waits
 * for its answer. Its scheduled refresh keeps it current meanwhile, so the re-approval stays one
 * click.
 */
export const KEPT_IDENTITY_WAIT_MS = TRANSFER_EXPIRY_MS;

/**
 * How long an accepted request waits for runs in flight before it stops them
 * and moves the employee (D18): past the ten-minute step lease, the
 * twelve-minute stall bound and the six-minute apply recovery.
 */
export const TRANSFER_SETTLE_MS = 15 * MINUTE_MS;

/**
 * The reason the record gives for the settings a handover returns to their defaults (autonomous
 * actions off, run notes one per run): the move set them, not a manager, and the record says so
 * whoever reads it (the wave 10 review, M8).
 */
export const HANDOVER_SETTINGS_REASON = 'handed over to a new manager';

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

/**
 * Whether a request answered at `decidedAt` is still the old manager's to read at `now`: one
 * rule for the home's line and the old link to a handed-over employee (the operator's ruling of
 * 2 October, decision 8), so the link never outlives the "Your home lists the handover for 30
 * days." it says.
 */
export function isDepartureListed(decidedAt: number, now: number): boolean {
  return decidedAt >= now - TRANSFER_DEPARTURES_WINDOW_MS;
}

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

/**
 * The refusal for a request that no longer exists, and for one addressed to another account,
 * which is told nothing more (the wave 9 review's U1-m2). A `ConvexError`'s data, so the dialog
 * can show it.
 */
export const TRANSFER_NOT_FOUND = 'This handover no longer exists.';

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

/*
 * The words a manager meets when a request is refused, as `ConvexError` data the dialogs show
 * (standard 6.3), here rather than in `convex/managerTransfers.ts` so a screen can say the same
 * words without reaching into the backend (standard 1.3). Every string is a wording draft and a
 * product call, flagged in 9-U2's handover.
 */

/** The refusal for an ask on an installation that signs every browser in as one manager. */
export const LOCAL_DEV_TRANSFER_REFUSAL =
  'This installation signs everyone in as one manager. Handing over needs each manager to sign in as themselves (the customer-local profile).';

/** The refusal for handing over an evaluation employee: its address is its run's marker. */
export const EVALUATION_EMPLOYEE_TRANSFER_REFUSAL =
  "An evaluation employee's manager is fixed by its run, so it cannot be handed over.";

/** The refusal for naming an address the evaluation harness reserves, which no person signs in with. */
export const EVALUATION_ADDRESS_TRANSFER_REFUSAL =
  'That address is reserved for evaluation runs, and no manager signs in with it.';

/** The refusal for asking without a verified address: the request tells the new manager who asked. */
export const UNVERIFIED_FOR_ASK =
  'Your sign-in does not carry a verified email address, so you cannot hand an employee over: the new manager is told who asked. Verify your address, then sign in again.';

/** The refusal for more open requests than one owner may have (D16). */
export const OWNER_OPEN_BOUND_REFUSAL = `You have ${MAX_OPEN_TRANSFERS_PER_OWNER} handovers waiting for an answer. Cancel one, or wait for an answer, before you ask for another.`;

/** The refusal for more asks in a rolling day than one owner may make (D16). */
export const OWNER_DAILY_BOUND_REFUSAL = `You have asked for ${MAX_TRANSFER_ASKS_PER_WINDOW} handovers in the last 24 hours. Try again later.`;

/**
 * A count with its thousands separated by commas, `1,000`, without the
 * runtime's locale data, which the Convex runtime need not carry.
 */
function withThousands(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The refusal for a handover note past its bound. */
export const NOTE_TOO_LONG = `The note can be at most ${withThousands(MAX_TRANSFER_NOTE_LENGTH)} characters.`;

/** The refusal for a decline reason past its bound. */
export const DECLINE_REASON_TOO_LONG = `The reason can be at most ${withThousands(MAX_DECLINE_REASON_LENGTH)} characters.`;

/**
 * The refusal for naming the caller's own address.
 *
 * @param name - The employee's name.
 */
export function ownAddressRefusal(name: string): string {
  return `That is your own address. Hand ${name} over to another manager's address.`;
}

/**
 * The refusal for a second request while one is open (the one-open rule), in the open request's
 * own terms: an asked one can be changed or cancelled, an accepting one can be neither (U2-m1).
 *
 * @param name - The employee's name.
 * @param toAddress - The address the open request names.
 * @param state - The open request's state.
 */
export function openTransferRefusal(
  name: string,
  toAddress: string,
  state: OpenManagerTransferState,
): string {
  return state === 'accepting'
    ? `${name}'s handover to ${toAddress} was already accepted: ${name} becomes theirs when its runs end.`
    : `${name} already has a handover open to ${toAddress}. Change the address or cancel it first.`;
}

/**
 * The refusal for an address that already has the most open requests one
 * address may have (D16). It says nothing about who else asked.
 *
 * @param toAddress - The named address.
 */
export function addressBoundRefusal(toAddress: string): string {
  return `${toAddress} has too many handovers waiting. Try again once they have answered some.`;
}

/**
 * The refusal for changing a request's address to the one it already names.
 *
 * @param toAddress - The address the request names.
 */
export function sameAddressRefusal(toAddress: string): string {
  return `The handover is already addressed to ${toAddress}.`;
}

/**
 * The refusal for a move the request's state no longer allows, in the words
 * of the state it is in: the loser of a race re-runs against the new state and
 * reads why (the transfer plan, section 10.1).
 *
 * @param state - The state the request is in, or `expired` for an asked one past its expiry.
 */
export function transferStateRefusal(state: ManagerTransferState): string {
  switch (state) {
    case 'asked':
      return 'This handover is still waiting for an answer.';
    case 'accepting':
    case 'accepted':
      return 'This handover was already accepted.';
    case 'declined':
      return 'This handover was already declined.';
    case 'cancelled':
      return 'This handover was already cancelled.';
    case 'expired':
      return 'This handover expired before it was answered.';
    default: {
      const unknown: never = state;
      throw new Error(`unhandled handover state ${String(unknown)}`);
    }
  }
}
