import { describe, expect, it } from 'vitest';
import {
  ACCESS_ENDS,
  ACCESS_REQUEST_REASONS,
  ACTS_AS_KINDS,
  CREDENTIAL_GRANTS,
  MCP_CLIENT_REGISTRATIONS,
  ORGANISATION_CONNECTION_KINDS,
  ORGANISATION_CONNECTION_MODES,
  ORGANISATION_CONNECTION_STATUSES,
  ORGANISATION_REGISTRARS,
  SOURCE_REVOCATION_STATES,
  TOKEN_STORES,
  actsAsAtUpgrade,
} from '../../../src/surfaces/access-identity';

describe('the access literals the schema declares (11-AK)', (): void => {
  it('names every identity a card can act as, the connection kinds, modes and states, as the access plan does', (): void => {
    expect([...ACTS_AS_KINDS]).toEqual([
      'own-app',
      'shared-app',
      'delegated',
      'shared-key',
      'browser-seat',
    ]);
    expect([...ORGANISATION_CONNECTION_KINDS]).toEqual([
      'slack-configuration',
      'oauth-app',
      'service-account',
      'mcp-client',
      'static-key',
    ]);
    expect([...ORGANISATION_CONNECTION_MODES]).toEqual(['per-employee', 'shared']);
    expect([...ORGANISATION_CONNECTION_STATUSES]).toEqual(['active', 'needs-attention', 'revoked']);
    expect([...ORGANISATION_REGISTRARS]).toEqual(['organisation-page', 'setup-cli']);
    expect([...MCP_CLIENT_REGISTRATIONS]).toEqual(['pre-registered', 'dynamic']);
  });

  it('names how Day0 obtained a credential, where it is kept, and how its revocation at source stands', (): void => {
    expect([...CREDENTIAL_GRANTS]).toEqual([
      'oauth-install',
      'authorisation-code',
      'client-credentials',
      'token-rotation',
      'app-created',
    ]);
    expect([...TOKEN_STORES]).toEqual(['native', 'nango']);
    expect([...SOURCE_REVOCATION_STATES]).toEqual(['pending', 'done', 'not-supported', 'failed']);
    expect([...ACCESS_ENDS]).toEqual([
      'disconnect',
      'expiry',
      'retire',
      'reject',
      'transfer',
      'organisation-revoked',
      'owner-deletion',
    ]);
    expect([...ACCESS_REQUEST_REASONS]).toEqual([
      'no-connection',
      'install-needed',
      'scope-widening',
    ]);
  });
});

describe('the identity an existing card acts as at the upgrade', (): void => {
  const card = { displayName: 'Slack' };

  it('is the employee’s own app for an installed app’s token, named as its app and keeping the bot’s id', (): void => {
    expect(
      actsAsAtUpgrade(
        {
          ...card,
          providerIdentityId: 'U0DAY0BOT',
          provisioning: { appName: 'Maya (Day0)' },
        },
        { kind: 'oauth', label: 'Slack bot token (slack dedicated app)' },
      ),
    ).toEqual({ kind: 'own-app', label: 'Maya (Day0)', providerIdentityId: 'U0DAY0BOT' });
  });

  it('names an installed app with no registration on the card by the card', (): void => {
    expect(actsAsAtUpgrade(card, { kind: 'oauth', label: 'Slack bot token' })).toEqual({
      kind: 'own-app',
      label: 'Slack',
    });
  });

  it('is a shared key for a pasted value and a pasted location, named as the key', (): void => {
    expect(
      actsAsAtUpgrade(
        { displayName: 'Linear', providerIdentityId: undefined },
        { kind: 'value', label: 'Linear access' },
      ),
    ).toEqual({ kind: 'shared-key', label: 'Linear access' });
    expect(
      actsAsAtUpgrade(
        { displayName: 'Slack', providerIdentityId: 'U0SHARED' },
        { kind: 'location', label: 'Slack bot token in the vault' },
      ),
    ).toEqual({
      kind: 'shared-key',
      label: 'Slack bot token in the vault',
      providerIdentityId: 'U0SHARED',
    });
  });

  it('names a key with an empty label by the card', (): void => {
    expect(actsAsAtUpgrade({ displayName: 'Linear' }, { kind: 'value', label: '  ' })).toEqual({
      kind: 'shared-key',
      label: 'Linear',
    });
  });
});
