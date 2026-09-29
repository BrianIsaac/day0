import { describe, expect, it } from 'vitest';
import { PROBE_LEASE_MS, probeInFlight } from '../../../src/surfaces/probe-lease';

describe('the probe lease', (): void => {
  it('holds a card while its probe runs, and frees it once the lease lapses', (): void => {
    expect(probeInFlight({}, 10)).toBe(false);
    expect(probeInFlight({ probeStartedAt: 0 }, PROBE_LEASE_MS - 1)).toBe(true);
    expect(probeInFlight({ probeStartedAt: 0 }, PROBE_LEASE_MS)).toBe(false);
  });
});
