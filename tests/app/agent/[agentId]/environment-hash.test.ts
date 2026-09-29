import { describe, expect, it } from 'vitest';
import {
  activeTabForEnvironment,
  addressesEnvironment,
  tabFromHash,
} from '../../../../app/agent/[agentId]/environment-hash';

describe('tab selection from the location hash', (): void => {
  it('names a tab from the hash the card link carries', (): void => {
    expect(tabFromHash('#surfaces', true)).toBe('surfaces');
    expect(tabFromHash('surfaces', true)).toBe('surfaces');
    expect(tabFromHash('#Docs', true)).toBe('docs');
    expect(tabFromHash('#tickets', false)).toBe('tickets');
  });

  it('ignores hashes that name no tab, and the Surfaces tab outside real mode', (): void => {
    expect(tabFromHash('', true)).toBeUndefined();
    expect(tabFromHash('#work-item-1', true)).toBeUndefined();
    expect(tabFromHash('#%E0%A4%A', true)).toBeUndefined();
    expect(tabFromHash('#surfaces', false)).toBeUndefined();
    expect(tabFromHash('#slack', true)).toBeUndefined();
    expect(tabFromHash('#spreadsheet', true)).toBeUndefined();
    expect(tabFromHash('#tweet', true)).toBeUndefined();
    expect(tabFromHash('#tickets', true)).toBeUndefined();
  });

  it('keeps the active tab valid when the resolved mode changes', (): void => {
    expect(activeTabForEnvironment('surfaces', '#surfaces', false)).toBe('slack');
    expect(activeTabForEnvironment('docs', '#unknown', false)).toBe('docs');
    expect(activeTabForEnvironment('slack', '#surfaces', true)).toBe('surfaces');
    expect(activeTabForEnvironment('slack', '#unknown', true)).toBe('docs');
    expect(activeTabForEnvironment('tickets', '', true)).toBe('docs');
  });

  it('addresses the environment by its panel or any of its tabs, in either mode', (): void => {
    expect(addressesEnvironment('#surfaces')).toBe(true);
    expect(addressesEnvironment('#slack')).toBe(true);
    expect(addressesEnvironment('#Docs')).toBe(true);
    expect(addressesEnvironment('')).toBe(false);
    expect(addressesEnvironment('#item-j57item')).toBe(false);
    expect(addressesEnvironment('#%E0%A4%A')).toBe(false);
  });
});
