import { describe, expect, it } from 'vitest';
import {
  awaitLeaseHolder,
  LEASE_POLLS,
  leaseDecision,
  REFRESH_LEASE_MS,
  type LeasedRow,
} from '../../../src/surfaces/refresh-lease';
import { LINEAR_REQUEST_TIMEOUT_MS } from '../../../src/surfaces/identity-issuers/linear';
import { OAUTH_REQUEST_TIMEOUT_MS } from '../../../src/surfaces/mcp-oauth';

const NOW = 1_800_000_000_000;

describe('leaseDecision', (): void => {
  it('takes the lease on a row at the generation read that no refresh holds', (): void => {
    expect(leaseDecision({}, 0, NOW)).toEqual({
      kind: 'claim',
      leaseUntil: NOW + REFRESH_LEASE_MS,
    });
    expect(leaseDecision({ generation: 2, refreshingUntil: NOW }, 2, NOW)).toEqual({
      kind: 'claim',
      leaseUntil: NOW + REFRESH_LEASE_MS,
    });
  });

  it('sends a refresh whose generation a rotation moved on to the winner’s token', (): void => {
    expect(leaseDecision({ generation: 3, refreshingUntil: NOW + 5 }, 2, NOW)).toEqual({
      kind: 'moved',
    });
  });

  it('makes a refresh wait while another holds an unexpired lease', (): void => {
    expect(leaseDecision({ generation: 1, refreshingUntil: NOW + 5 }, 1, NOW)).toEqual({
      kind: 'leased',
      until: NOW + 5,
    });
  });

  it('outlasts the slowest exchange a holder makes under the lease', (): void => {
    expect(REFRESH_LEASE_MS).toBeGreaterThan(LINEAR_REQUEST_TIMEOUT_MS);
    expect(REFRESH_LEASE_MS).toBeGreaterThan(OAUTH_REQUEST_TIMEOUT_MS);
  });
});

describe('awaitLeaseHolder', (): void => {
  /** A waiter over scripted reads, its clock fixed unless a read moves it. */
  function waiter(reads: ReadonlyArray<LeasedRow | null>, clock: { now: number } = { now: NOW }) {
    let index = 0;
    const slept: number[] = [];
    return {
      slept,
      wait: {
        read: async (): Promise<LeasedRow | null> => reads[Math.min(index++, reads.length - 1)]!,
        now: (): number => clock.now,
        sleep: async (ms: number): Promise<void> => {
          slept.push(ms);
        },
      },
    };
  }

  it('answers moved once the holder’s rotation lands, or the row is gone', async (): Promise<void> => {
    const held = { generation: 0, refreshingUntil: NOW + 10 };
    const rotated = waiter([held, held, { generation: 1 }]);
    await expect(awaitLeaseHolder(rotated.wait, { generation: 0, until: NOW + 10 })).resolves.toBe(
      'moved',
    );
    expect(rotated.slept).toHaveLength(2);
    const gone = waiter([null]);
    await expect(awaitLeaseHolder(gone.wait, { generation: 0, until: NOW + 10 })).resolves.toBe(
      'moved',
    );
  });

  it('answers free once the holder releases its lease, or another takes a new one', async (): Promise<void> => {
    const released = waiter([{ generation: 0 }]);
    await expect(awaitLeaseHolder(released.wait, { generation: 0, until: NOW + 10 })).resolves.toBe(
      'free',
    );
    const retaken = waiter([{ generation: 0, refreshingUntil: NOW + 99 }]);
    await expect(awaitLeaseHolder(retaken.wait, { generation: 0, until: NOW + 10 })).resolves.toBe(
      'free',
    );
  });

  it('answers free at the lease’s end, and after its bound of reads whatever the clock says', async (): Promise<void> => {
    const lapsed = waiter([{ generation: 0, refreshingUntil: NOW + 10 }], { now: NOW + 10 });
    await expect(awaitLeaseHolder(lapsed.wait, { generation: 0, until: NOW + 10 })).resolves.toBe(
      'free',
    );
    expect(lapsed.slept).toEqual([]);
    const stuck = waiter([{ generation: 0, refreshingUntil: NOW + 10 }]);
    await expect(awaitLeaseHolder(stuck.wait, { generation: 0, until: NOW + 10 })).resolves.toBe(
      'free',
    );
    expect(stuck.slept).toHaveLength(LEASE_POLLS);
  });
});
