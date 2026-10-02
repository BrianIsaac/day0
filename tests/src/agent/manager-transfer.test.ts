import { describe, expect, it } from 'vitest';
import {
  MANAGER_TRANSFER_STATES,
  MAX_DECLINE_REASON_LENGTH,
  MAX_OPEN_TRANSFERS_PER_ADDRESS,
  MAX_OPEN_TRANSFERS_PER_EMPLOYEE,
  MAX_OPEN_TRANSFERS_PER_OWNER,
  MAX_TRANSFER_ASKS_PER_WINDOW,
  MAX_TRANSFER_NOTE_LENGTH,
  OWN_TRANSFER,
  OPEN_MANAGER_TRANSFER_STATES,
  TRANSFER_ASK_WINDOW_MS,
  TRANSFER_CANCEL_REASONS,
  TRANSFER_ROW_CANCEL_REASONS,
  HANDOVER_ENDED_CANCEL_REASON,
  endedWithoutMove,
  TRANSFER_DEPARTURES_WINDOW_MS,
  isDepartureListed,
  TRANSFER_EXPIRY_MS,
  TRANSFER_NOT_FOUND,
  TRANSFER_SETTLE_MS,
  UNVERIFIED_FOR_TRANSFER,
  canMoveTransfer,
  isFinalTransferState,
  isOpenTransferState,
  isTransferDue,
  isWithinAskWindow,
  transferExpiresAt,
  transferSettleBy,
} from '../../../src/agent/manager-transfer';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('the request states', (): void => {
  it('are the six of the plan, two open and four final, with nothing in both', (): void => {
    expect([...MANAGER_TRANSFER_STATES]).toEqual([
      'asked',
      'accepting',
      'accepted',
      'declined',
      'cancelled',
      'expired',
    ]);
    expect([...OPEN_MANAGER_TRANSFER_STATES]).toEqual(['asked', 'accepting']);
    expect(MANAGER_TRANSFER_STATES.filter(isOpenTransferState)).toEqual(['asked', 'accepting']);
    expect(MANAGER_TRANSFER_STATES.filter(isFinalTransferState)).toEqual([
      'accepted',
      'declined',
      'cancelled',
      'expired',
    ]);
  });

  it('cancel for the owner, a retire or a change of address, and for nothing else', (): void => {
    expect([...TRANSFER_CANCEL_REASONS]).toEqual(['owner', 'retired', 'address-changed']);
  });

  it('read an end without the move from its own reason or from none, and never from an ask’s cancel', (): void => {
    expect(endedWithoutMove(HANDOVER_ENDED_CANCEL_REASON)).toBe(true);
    expect(endedWithoutMove(undefined)).toBe(true);
    for (const reason of TRANSFER_CANCEL_REASONS)
      expect(endedWithoutMove(reason), reason).toBe(false);
  });

  it('store on the row every ask cancel and, beside them, the end of an accepted handover that could not move', (): void => {
    expect(HANDOVER_ENDED_CANCEL_REASON).toBe('handover-ended');
    expect([...TRANSFER_ROW_CANCEL_REASONS]).toEqual([
      ...TRANSFER_CANCEL_REASONS,
      HANDOVER_ENDED_CANCEL_REASON,
    ]);
  });
});

describe('canMoveTransfer', (): void => {
  it('leaves asked for every answer, and accepting only for accepted', (): void => {
    for (const to of ['accepting', 'accepted', 'declined', 'cancelled', 'expired'] as const) {
      expect(canMoveTransfer('asked', to), to).toBe(true);
    }
    expect(canMoveTransfer('accepting', 'accepted')).toBe(true);
    for (const to of ['asked', 'declined', 'cancelled', 'expired', 'accepting'] as const) {
      expect(canMoveTransfer('accepting', to), to).toBe(false);
    }
  });

  it('never reopens a final request: a declined or expired one is asked again as a new row', (): void => {
    for (const from of ['accepted', 'declined', 'cancelled', 'expired'] as const) {
      for (const to of MANAGER_TRANSFER_STATES) expect(canMoveTransfer(from, to), to).toBe(false);
    }
  });

  it('never moves a request to the state it is already in', (): void => {
    expect(canMoveTransfer('asked', 'asked')).toBe(false);
  });
});

describe('the clock', (): void => {
  it('expires a request fourteen days after the ask (D4)', (): void => {
    expect(TRANSFER_EXPIRY_MS).toBe(14 * DAY);
    expect(transferExpiresAt(1_000)).toBe(1_000 + 14 * DAY);
  });

  it('gives runs in flight fifteen minutes, past the step lease, the stall bound and the apply recovery (D18)', (): void => {
    expect(TRANSFER_SETTLE_MS).toBe(15 * MINUTE);
    expect(TRANSFER_SETTLE_MS).toBeGreaterThan(12 * MINUTE);
    expect(transferSettleBy(5_000)).toBe(5_000 + 15 * MINUTE);
  });

  it('is due for the expiry sweep only while asked and at or past its expiry', (): void => {
    expect(isTransferDue({ state: 'asked', expiresAt: 100 }, 100)).toBe(true);
    expect(isTransferDue({ state: 'asked', expiresAt: 100 }, 99)).toBe(false);
    expect(isTransferDue({ state: 'accepting', expiresAt: 100 }, 200)).toBe(false);
    expect(isTransferDue({ state: 'declined', expiresAt: 100 }, 200)).toBe(false);
  });

  it('counts an ask toward the rolling day it was made in, and not after', (): void => {
    expect(TRANSFER_ASK_WINDOW_MS).toBe(DAY);
    expect(isWithinAskWindow(1_000, 1_000 + DAY - 1)).toBe(true);
    expect(isWithinAskWindow(1_000, 1_000 + DAY)).toBe(false);
  });

  it("keeps a finished request in the old manager's notices for thirty days", (): void => {
    expect(TRANSFER_DEPARTURES_WINDOW_MS).toBe(30 * DAY);
  });
});

describe('the bounds (D16)', (): void => {
  it('are one open request an employee, five an owner, twenty asks a day and ten an address', (): void => {
    expect(MAX_OPEN_TRANSFERS_PER_EMPLOYEE).toBe(1);
    expect(MAX_OPEN_TRANSFERS_PER_OWNER).toBe(5);
    expect(MAX_TRANSFER_ASKS_PER_WINDOW).toBe(20);
    expect(MAX_OPEN_TRANSFERS_PER_ADDRESS).toBe(10);
  });

  it('bound the handover note at 1,000 characters and a decline reason at 500', (): void => {
    expect(MAX_TRANSFER_NOTE_LENGTH).toBe(1_000);
    expect(MAX_DECLINE_REASON_LENGTH).toBe(500);
  });
});

describe('the refusals the named manager reads', (): void => {
  it('say what is wrong in the words the dialog shows', (): void => {
    expect(TRANSFER_NOT_FOUND).toBe('This handover no longer exists.');
    // One answer for a request that does not exist and one addressed to another account, so an
    // id is confirmed to nobody it does not name (the wave 9 review's U1-m2).
    expect(TRANSFER_NOT_FOUND).not.toMatch(/addressed|someone else/);
    expect(OWN_TRANSFER).toBe(
      'This handover was asked from your own account, so your account cannot take it on.',
    );
    expect(UNVERIFIED_FOR_TRANSFER).toBe(
      'Your sign-in does not carry a verified email address, so no handover can be addressed to you. Verify your address, then sign in again.',
    );
  });
});

describe('isDepartureListed', () => {
  it('keeps a handover for the old manager to read for thirty days from its answer, and not a moment past', () => {
    const answered = Date.UTC(2026, 8, 1);
    expect(isDepartureListed(answered, answered)).toBe(true);
    expect(isDepartureListed(answered, answered + TRANSFER_DEPARTURES_WINDOW_MS)).toBe(true);
    expect(isDepartureListed(answered, answered + TRANSFER_DEPARTURES_WINDOW_MS + 1)).toBe(false);
  });
});
