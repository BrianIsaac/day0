import { describe, expect, it } from 'vitest';
import { compareProviderTs, providerTsToMs } from '../../../src/work/provider-ts';

describe('compareProviderTs', (): void => {
  it('orders provider timestamps by their digits, keeping the microsecond a float would round', (): void => {
    expect(compareProviderTs('1787770800.000001', '1787770800.000002')).toBeLessThan(0);
    expect(compareProviderTs('1787770801.000000', '1787770800.999999')).toBeGreaterThan(0);
    expect(compareProviderTs('1787770800.0001', '1787770800.000100')).toBe(0);
  });
});

describe('providerTsToMs', (): void => {
  it("reads Slack's seconds.fraction as epoch milliseconds", (): void => {
    expect(providerTsToMs('1787770800.123456')).toBeCloseTo(1_787_770_800_123.456, 3);
    expect(providerTsToMs('1787770800')).toBe(1_787_770_800_000);
  });

  it('reads an ISO date as its epoch milliseconds', (): void => {
    expect(providerTsToMs('2026-10-09T03:00:00.000Z')).toBe(Date.UTC(2026, 9, 9, 3));
  });

  it('reads anything else as unknown', (): void => {
    expect(providerTsToMs('not a timestamp')).toBeNull();
    expect(providerTsToMs('')).toBeNull();
  });
});
