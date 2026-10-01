import { describe, expect, it } from 'vitest';
import {
  MANAGER_TRANSFER_STATES,
  MAX_DECLINE_REASON_LENGTH,
  MAX_OPEN_TRANSFERS_PER_ADDRESS,
  MAX_OPEN_TRANSFERS_PER_EMPLOYEE,
  MAX_OPEN_TRANSFERS_PER_OWNER,
  MAX_TRANSFER_ASKS_PER_WINDOW,
  MAX_TRANSFER_NOTE_LENGTH,
  OPEN_MANAGER_TRANSFER_STATES,
  TRANSFER_ASK_WINDOW_MS,
  TRANSFER_CANCEL_REASONS,
  TRANSFER_DEPARTURES_WINDOW_MS,
  TRANSFER_EXPIRY_MS,
  TRANSFER_SETTLE_MS,
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
