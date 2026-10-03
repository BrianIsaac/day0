import { describe, expect, it } from 'vitest';
import {
  cardIdentity,
  keyOriginOf,
  listedCardIdentity,
  type IdentityConnection,
} from '../../../src/surfaces/card-identity';

const SLACK = { endpoint: 'https://slack.com/api/', path: 'documented-api' } as const;
const LINEAR = { endpoint: 'https://mcp.linear.app/mcp', path: 'mcp' } as const;
const DOCS_MCP = { endpoint: 'https://docs.acme.test/mcp', path: 'mcp' } as const;

/** A connection IT landed for a system, active unless the test says otherwise. */
function connection(fields: Partial<IdentityConnection> & Pick<IdentityConnection, 'system'>) {
  // The kind an issuer of Day0's acts through for the system, unless a test names another.
  const kind =
    fields.system === 'slack'
      ? ('slack-configuration' as const)
      : fields.system.startsWith('mcp:')
        ? ('mcp-client' as const)
        : ('oauth-app' as const);
  return { mode: 'per-employee' as const, status: 'active' as const, kind, ...fields };
}

describe("a card that lost its credential names no landed identity (the wave 11 review's M8)", (): void => {
  it("says whom an own-app card will act as once IT's connection is revoked, not the app it no longer holds", (): void => {
    const identity = cardIdentity(
      { ...SLACK, actsAs: { kind: 'own-app', label: 'Leo (Day0)', providerIdentityId: 'U1' } },
      undefined,
      { selfProvisions: false },
    );
    expect(identity).toEqual({ kind: 'shared-key', planned: true });
  });

  it("says a delegated card on a revoked server's connection acts as nobody's consent now", (): void => {
    expect(
      cardIdentity(
        { ...DOCS_MCP, actsAs: { kind: 'delegated', label: 'sam@acme.test' } },
        undefined,
        {
          selfProvisions: false,
        },
      ),
    ).toEqual({ kind: 'shared-key', planned: true });
  });

  it('names the identity IT landed in the other mode for a disconnected card, not the old one', (): void => {
    expect(
      cardIdentity(
        { ...LINEAR, actsAs: { kind: 'own-app', label: 'Day0 Leo' } },
        connection({ system: 'linear', mode: 'shared' }),
        { selfProvisions: false },
      ),
    ).toEqual({ kind: 'shared-app', planned: true });
  });

  it('keeps reading an identity the card still holds a credential for', (): void => {
    expect(
      cardIdentity(
        { ...LINEAR, actsAs: { kind: 'own-app', label: 'Day0 Leo' }, credentialId: 'cred-1' },
        connection({ system: 'linear', mode: 'shared' }),
        { selfProvisions: false },
      ),
    ).toEqual({ kind: 'own-app', label: 'Day0 Leo', planned: false });
  });
});

describe('where a held key came from', (): void => {
  it('tells a documentation page from a paste, and an install from neither', (): void => {
    expect(keyOriginOf({ sourceId: 'wiki', ref: 'linear.md' })).toBe('documentation');
    expect(keyOriginOf('entered')).toBe('paste');
    expect(keyOriginOf('oauth')).toBeUndefined();
  });
});

describe('whom a listed card acts as, answered once for the card (cockpit item 1)', (): void => {
  it("names a Slack card's own app where it registers one itself, and the shared key where it cannot", (): void => {
    const card = {
      ...SLACK,
      request: { credential: { found: 'none', method: 'oauth' } },
    };
    expect(listedCardIdentity({ card, hasPublicUrl: true }).identity).toEqual({
      kind: 'own-app',
      planned: true,
    });
    expect(listedCardIdentity({ card, hasPublicUrl: false }).identity).toEqual({
      kind: 'shared-key',
      planned: true,
    });
  });

  it("answers whom IT's connection would make the card act as, for the move off a key", (): void => {
    const listed = listedCardIdentity({
      card: {
        ...LINEAR,
        actsAs: { kind: 'shared-key', label: 'Linear API key' },
        credentialId: 'cred-1',
      },
      connection: connection({ system: 'linear', mode: 'shared' }),
      heldCredentialSource: { sourceId: 'wiki', ref: 'linear.md' },
      hasPublicUrl: true,
    });
    expect(listed).toEqual({
      identity: {
        kind: 'shared-key',
        label: 'Linear API key',
        planned: false,
        keyFrom: 'documentation',
      },
      connectionIdentity: { kind: 'shared-app', planned: true },
    });
  });

  it('answers no connection identity where no active connection covers the card', (): void => {
    expect(
      listedCardIdentity({
        card: LINEAR,
        connection: connection({ system: 'linear', status: 'needs-attention' }),
        hasPublicUrl: true,
      }),
    ).toEqual({ identity: { kind: 'shared-key', planned: true } });
  });
});

describe("a connection no issuer of Day0's acts through (11-AC's item 8)", (): void => {
  it('covers no card: the card plans to act as the key it takes, not as an app IT never gave it', (): void => {
    const notion = {
      slug: 'notion',
      displayName: 'Notion',
      path: 'documented-api',
      endpoint: 'https://api.notion.com/v1',
    };
    expect(
      cardIdentity(
        notion,
        { system: 'notion', kind: 'static-key', mode: 'shared', status: 'active' },
        {
          selfProvisions: false,
        },
      ),
    ).toEqual({ kind: 'shared-key', planned: true });
  });

  it("covers no card where IT landed a static key for a system an issuer serves (D6, the round review's m11)", (): void => {
    expect(
      cardIdentity(
        LINEAR,
        { system: 'linear', kind: 'static-key', mode: 'shared', status: 'active' },
        { selfProvisions: false },
      ),
    ).toEqual({ kind: 'shared-key', planned: true });
  });
});
