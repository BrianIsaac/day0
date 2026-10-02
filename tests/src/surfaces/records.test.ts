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

  it('treats a row without a stored kind as a shared key, whatever the request expected', (): void => {
    expect(
      credentialKindFor({ ...base, request: { credential: { method: 'oauth' } } } as never),
    ).toBe('value');
    expect(credentialKindFor({ ...base, credentialKind: 'unknown' })).toBe('value');
    expect(credentialKindFor(base)).toBe('value');
  });

  it('keeps only the executor-facing fields and a valid path', (): void => {
    const record = toSurfaceRecord({
      ...base,
      path: 'mcp',
      endpoint: 'https://mcp.linear.app/mcp',
      toolAllowlist: ['save_comment'],
      toolArguments: [{ tool: 'save_comment', arguments: ['issueId', 'body'] }],
      credentialId: 'cred-1',
      managerDmChannelId: 'D1',
      managerUserId: 'U1',
      managerName: 'Sam',
      request: { target: { reasoning: 'secret-bearing prose' } },
    } as never);
    expect(record).toEqual({
      ...base,
      path: 'mcp',
      endpoint: 'https://mcp.linear.app/mcp',
      toolAllowlist: ['save_comment'],
      toolArguments: [{ tool: 'save_comment', arguments: ['issueId', 'body'] }],
      credentialId: 'cred-1',
      credentialKind: 'value',
      managerDmChannelId: 'D1',
      managerUserId: 'U1',
      managerName: 'Sam',
    });
    expect(toSurfaceRecord({ ...base, path: 'unknown' }).path).toBeUndefined();
  });
});

describe('the attribution a record carries (join 14)', (): void => {
  it('reads it off the identity the card acts as, and carries none for a card that names none', (): void => {
    expect(
      toSurfaceRecord({ ...base, credentialKind: 'oauth', actsAs: { kind: 'delegated' } })
        .attribution,
    ).toBe('trailer');
    expect(
      toSurfaceRecord({ ...base, credentialKind: 'oauth', actsAs: { kind: 'own-app' } })
        .attribution,
    ).toBe('identity');
    expect(toSurfaceRecord({ ...base, credentialKind: 'value' })).not.toHaveProperty('attribution');
    expect(toSurfaceRecord({ ...base, actsAs: { kind: 'not-a-kind' } })).not.toHaveProperty(
      'attribution',
    );
  });
});

describe('an identity its credential contradicts (join 14, the second pass)', (): void => {
  it('carries no attribution, so the credential’s kind decides as before wave 11', (): void => {
    expect(
      toSurfaceRecord({ ...base, credentialKind: 'oauth', actsAs: { kind: 'shared-key' } }),
    ).not.toHaveProperty('attribution');
    expect(
      toSurfaceRecord({ ...base, credentialKind: 'value', actsAs: { kind: 'own-app' } }),
    ).not.toHaveProperty('attribution');
    expect(
      toSurfaceRecord({ ...base, credentialKind: 'value', actsAs: { kind: 'shared-app' } })
        .attribution,
    ).toBe('trailer');
  });
});
