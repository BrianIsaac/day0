import { describe, expect, it } from 'vitest';
import { isDay0FixedEndpoint, LINEAR_MCP_ENDPOINT } from '../../../src/surfaces/fixed-endpoints';

describe('isDay0FixedEndpoint', (): void => {
  it('answers true for the addresses Day0 fixes itself', (): void => {
    expect(isDay0FixedEndpoint(LINEAR_MCP_ENDPOINT)).toBe(true);
    expect(isDay0FixedEndpoint('https://slack.com/api/')).toBe(true);
    expect(isDay0FixedEndpoint('https://slack.com/api')).toBe(true);
  });

  it('answers false for a documented address, a tenant’s host or a look-alike, and for none', (): void => {
    expect(isDay0FixedEndpoint('https://acme-fin.my.salesforce.com/services/data/')).toBe(false);
    expect(isDay0FixedEndpoint('https://acme.mcp.linear.app/mcp')).toBe(false);
    expect(isDay0FixedEndpoint('https://mcp.linear.app/mcp/')).toBe(false);
    expect(isDay0FixedEndpoint(undefined)).toBe(false);
  });
});
