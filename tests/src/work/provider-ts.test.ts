import { describe, expect, it } from 'vitest';
import { compareProviderTs } from '../../../src/work/provider-ts';

describe('compareProviderTs', (): void => {
  it('orders provider timestamps by their digits, keeping the microsecond a float would round', (): void => {
    expect(compareProviderTs('1787770800.000001', '1787770800.000002')).toBeLessThan(0);
    expect(compareProviderTs('1787770801.000000', '1787770800.999999')).toBeGreaterThan(0);
    expect(compareProviderTs('1787770800.0001', '1787770800.000100')).toBe(0);
  });
});
