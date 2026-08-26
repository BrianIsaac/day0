import { describe, expect, it } from 'vitest';
import { credentialKindFor, toSurfaceRecord } from '../../../src/surfaces/records';

const base = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected' as const,
  credentialLanded: true,
  lastVerifiedAt: 10,
};

describe('surface row narrowing', (): void => {
  it('reads a stored credential kind first', (): void => {
    expect(credentialKindFor({ ...base, credentialKind: 'oauth' })).toBe('oauth');
    expect(credentialKindFor({ ...base, credentialKind: 'location' })).toBe('location');
  });

  it('falls back to the connect request method, sharing by default', (): void => {
    expect(credentialKindFor({ ...base, request: { credential: { method: 'oauth' } } })).toBe(
      'oauth',
    );
    expect(credentialKindFor({ ...base, request: { credential: { method: 'api-key' } } })).toBe(
      'value',
    );
    expect(credentialKindFor({ ...base, credentialKind: 'unknown' })).toBe('value');
    expect(credentialKindFor(base)).toBe('value');
  });

  it('keeps only the executor-facing fields and a valid path', (): void => {
    const record = toSurfaceRecord({
      ...base,
      path: 'mcp',
      endpoint: 'https://mcp.linear.app/mcp',
      toolAllowlist: ['save_comment'],
      credentialId: 'cred-1',
      managerDmChannelId: 'D1',
      request: { target: { reasoning: 'secret-bearing prose' } },
    });
    expect(record).toEqual({
      ...base,
      path: 'mcp',
      endpoint: 'https://mcp.linear.app/mcp',
      toolAllowlist: ['save_comment'],
      credentialId: 'cred-1',
      credentialKind: 'value',
      managerDmChannelId: 'D1',
    });
    expect(toSurfaceRecord({ ...base, path: 'unknown' }).path).toBeUndefined();
  });
});
