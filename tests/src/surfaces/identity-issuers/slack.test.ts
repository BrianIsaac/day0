import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { SLACK_KIT_BOT_SCOPES, slackKitManifest } from '../../../../src/surfaces/access-kit/slack';
import {
  CONFIGURATION_KEEP_CURRENT_BEFORE_MS,
  CONFIGURATION_RENEW_BEFORE_MS,
  CONFIGURATION_TOKEN_LIFETIME_MS,
  KEEP_CURRENT_MIN_DELAY_MS,
  KEPT_APP_CONNECTION_REVOKED,
  configurationRenewal,
  installedBotIssuer,
  isIssuedAs,
  keepCurrentAt,
  parseTokenRotation,
  rejoinPlan,
  rotationRefusal,
  slackActsAs,
  slackAppManifest,
  slackBotTokenIssuer,
  slackClientSecretIssuer,
} from '../../../../src/surfaces/identity-issuers/slack';
import { SLACK_RETIRE_ORPHANED_APP } from '../../../fixtures/real-vendor-rewalk-2026-10-03';
import { ManifestTemplateError } from '../../../../src/surfaces/slack-manifest';

const POLICY = readFileSync(
  resolve(__dirname, '../../../fixtures/notion-pages/slack-day0-app.md'),
  'utf8',
);
const PUBLIC_URL = 'https://day0.example.test';
const NOW = Date.UTC(2026, 9, 2, 9, 0, 0);
const HOUR = 60 * 60 * 1000;

describe('the manifest an employee’s own app is created from', (): void => {
  it("takes the documentation's template where the pages carry one", (): void => {
    const built = slackAppManifest({
      documentation: POLICY,
      employeeName: 'ops worker',
      publicUrl: PUBLIC_URL,
    });
    expect(built.template).toBe('documentation');
    expect(built.appName).toBe('ops worker (Day0)');
    expect(built.redirectUrl).toBe(`${PUBLIC_URL}/api/oauth/slack`);
  });

  it("builds the kit's app where the documentation carries no template", (): void => {
    const built = slackAppManifest({
      documentation: '# RevOps handbook\n\nNo manifest here.',
      employeeName: 'Leo',
      publicUrl: PUBLIC_URL,
    });
    const { template, ...app } = built;
    expect(template).toBe('kit');
    expect(app).toEqual(slackKitManifest({ employeeName: 'Leo', publicUrl: PUBLIC_URL }));
    expect(built.scopes).toEqual([...SLACK_KIT_BOT_SCOPES]);
  });

  it('refuses a plain-http origin whichever template it builds from', (): void => {
    expect(() =>
      slackAppManifest({ documentation: '', employeeName: 'Leo', publicUrl: 'http://day0.test' }),
    ).toThrow(ManifestTemplateError);
  });
});

describe('the configuration token before a use (B9, S2)', (): void => {
  it('uses a token with more than the renewal margin left', (): void => {
    expect(
      configurationRenewal(
        { expiresAt: NOW + CONFIGURATION_RENEW_BEFORE_MS + 1, refreshable: true },
        NOW,
      ),
    ).toBe('use');
  });

  it('rotates a token inside the margin, past its expiry, or of an unknown age', (): void => {
    expect(
      configurationRenewal(
        { expiresAt: NOW + CONFIGURATION_RENEW_BEFORE_MS, refreshable: true },
        NOW,
      ),
    ).toBe('rotate');
    expect(configurationRenewal({ expiresAt: NOW - 1, refreshable: true }, NOW)).toBe('rotate');
    expect(configurationRenewal({ refreshable: true }, NOW)).toBe('rotate');
  });

  it('uses a token it cannot renew as it is: there is no refresh token to rotate with', (): void => {
    expect(configurationRenewal({ refreshable: false }, NOW)).toBe('use');
    expect(configurationRenewal({ expiresAt: NOW - 1, refreshable: false }, NOW)).toBe('use');
  });

  it('keeps an hour of margin inside the twelve hours, wider than the margin before a use', (): void => {
    expect(CONFIGURATION_TOKEN_LIFETIME_MS).toBe(12 * HOUR);
    expect(CONFIGURATION_KEEP_CURRENT_BEFORE_MS).toBe(HOUR);
    expect(CONFIGURATION_KEEP_CURRENT_BEFORE_MS).toBeGreaterThan(CONFIGURATION_RENEW_BEFORE_MS);
  });

  it('keeps the token current an hour before it lapses, and never sooner than a quarter-hour', (): void => {
    const expiresAt = NOW + CONFIGURATION_TOKEN_LIFETIME_MS;
    expect(keepCurrentAt(expiresAt, NOW)).toBe(expiresAt - CONFIGURATION_KEEP_CURRENT_BEFORE_MS);
    expect(keepCurrentAt(NOW + 10_000, NOW)).toBe(NOW + KEEP_CURRENT_MIN_DELAY_MS);
    expect(keepCurrentAt(NOW - HOUR, NOW)).toBe(NOW + KEEP_CURRENT_MIN_DELAY_MS);
    expect(KEEP_CURRENT_MIN_DELAY_MS).toBe(15 * 60 * 1000);
  });
});

describe("reading Slack's rotation", (): void => {
  it('takes the new token, the new refresh token and the expiry Slack stated', (): void => {
    const exp = Math.floor(NOW / 1000) + 12 * 60 * 60;
    expect(
      parseTokenRotation(
        { ok: true, token: 'xoxe-1-abcdefghij', refresh_token: 'xoxe-1-klmnopqrst', exp },
        NOW,
      ),
    ).toEqual({
      token: 'xoxe-1-abcdefghij',
      refreshToken: 'xoxe-1-klmnopqrst',
      expiresAt: exp * 1000,
    });
  });

  it('holds a stated expiry to the documented twelve hours, and one already past to now', (): void => {
    const seconds = Math.floor(NOW / 1000);
    expect(
      parseTokenRotation(
        { ok: true, token: 'xoxe-1-a', refresh_token: 'xoxe-1-b', exp: seconds + 48 * 60 * 60 },
        NOW,
      ).expiresAt,
    ).toBe(NOW + CONFIGURATION_TOKEN_LIFETIME_MS);
    expect(
      parseTokenRotation(
        { ok: true, token: 'xoxe-1-a', refresh_token: 'xoxe-1-b', exp: seconds - 60 },
        NOW,
      ).expiresAt,
    ).toBe(NOW);
  });

  it('takes the documented twelve hours where Slack stated no expiry', (): void => {
    expect(
      parseTokenRotation({ ok: true, token: 'xoxe-1-a', refresh_token: 'xoxe-1-b' }, NOW).expiresAt,
    ).toBe(NOW + CONFIGURATION_TOKEN_LIFETIME_MS);
  });

  it('refuses an answer without both halves of the pair', (): void => {
    expect(() => parseTokenRotation({ ok: true, token: 'xoxe-1-a' }, NOW)).toThrow(
      'returned no new refresh token',
    );
    expect(() => parseTokenRotation({ ok: true, refresh_token: 'xoxe-1-b' }, NOW)).toThrow(
      'returned no new configuration token',
    );
  });

  it('reads a spent or revoked refresh token as one IT must replace, and anything else as passing', (): void => {
    for (const error of [
      'invalid_refresh_token',
      'token_revoked',
      'token_expired',
      'invalid_auth',
    ]) {
      expect(rotationRefusal(error)).toBe('spent');
    }
    for (const error of ['ratelimited', 'internal_error', undefined]) {
      expect(rotationRefusal(error)).toBe('transient');
    }
  });
});

describe('what an issued row says about how Day0 obtained it (11-AR)', (): void => {
  const connection = 'k57connection' as Id<'organisationConnections'>;
  const secret = 'k57secret' as Id<'credentials'>;

  it("names the app's client secret as the app's creation, with the connection that made it", (): void => {
    expect(
      slackClientSecretIssuer({
        appId: 'A1',
        clientId: '1.2',
        organisationConnectionId: connection,
      }),
    ).toEqual({
      system: 'slack',
      grant: 'app-created',
      appId: 'A1',
      clientId: '1.2',
      organisationConnectionId: connection,
    });
  });

  it("names the bot token as the install's, with the secret an uninstall needs", (): void => {
    expect(
      slackBotTokenIssuer({ appId: 'A1', clientId: '1.2', clientSecretCredentialId: secret }),
    ).toEqual({
      system: 'slack',
      grant: 'oauth-install',
      appId: 'A1',
      clientId: '1.2',
      clientSecretCredentialId: secret,
    });
  });

  it("reads the installed bot token's issuer off the card's app, with the connection that made it", (): void => {
    expect(
      installedBotIssuer({
        appId: 'A1',
        clientId: '1.2',
        organisationConnectionId: connection,
        clientSecretCredentialId: secret,
      }),
    ).toEqual({
      system: 'slack',
      grant: 'oauth-install',
      appId: 'A1',
      clientId: '1.2',
      organisationConnectionId: connection,
      clientSecretCredentialId: secret,
    });
  });

  it('knows a stored row by every field of the issuer it was given, and nothing less (the pre-tag item 10)', (): void => {
    const expected = slackClientSecretIssuer({ appId: 'A1', clientId: '1.2' });
    expect(isIssuedAs({ ...expected }, expected)).toBe(true);
    expect(isIssuedAs(undefined, expected)).toBe(false);
    expect(isIssuedAs({ ...expected, appId: 'A2' }, expected)).toBe(false);
    expect(isIssuedAs({ ...expected, grant: 'oauth-install' }, expected)).toBe(false);
    expect(isIssuedAs({ ...expected, organisationConnectionId: connection }, expected)).toBe(false);
  });

  it('acts as its own app, named by the app and its bot user', (): void => {
    expect(slackActsAs({ appName: 'Leo (Day0)', botUserId: 'U1' })).toEqual({
      kind: 'own-app',
      label: 'Leo (Day0)',
      providerIdentityId: 'U1',
    });
    expect(slackActsAs({ appName: 'Leo (Day0)' })).toEqual({
      kind: 'own-app',
      label: 'Leo (Day0)',
    });
  });
});

describe('the re-join after a renewal (RM4)', (): void => {
  const visible = [
    { id: 'C1', name: 'revops', isMember: false },
    { id: 'C2', name: 'revops-asks', isMember: true },
  ];

  it('joins each approved public channel it is not in, and names the rest as needing a person', (): void => {
    expect(rejoinPlan(['#RevOps', 'revops-asks', 'revops-leads', 'revops'], visible)).toEqual({
      join: [{ id: 'C1', name: 'revops' }],
      alreadyIn: ['#revops-asks'],
      needsPerson: ['#revops-leads'],
    });
  });

  it('plans nothing for a scope that names no channel', (): void => {
    expect(rejoinPlan([], visible)).toEqual({ join: [], alreadyIn: [], needsPerson: [] });
  });

  it('reads a blank name as none', (): void => {
    expect(rejoinPlan(['  ', '#'], visible)).toEqual({ join: [], alreadyIn: [], needsPerson: [] });
  });
});

describe('an app whose creating connection IT revoked (R41X-9)', (): void => {
  it('never promises a retire deletes it once IT connects Slack again, since the retire then answers that it cannot', (): void => {
    // Juno's retire with IT's new connection live: SLACK_RETIRE_ORPHANED_APP.
    expect(SLACK_RETIRE_ORPHANED_APP).toContain("delete it in Slack's app settings");
    expect(KEPT_APP_CONNECTION_REVOKED).not.toMatch(/retire the app/i);
    expect(KEPT_APP_CONNECTION_REVOKED).not.toMatch(/Once IT connects Slack again, retire/);
    expect(KEPT_APP_CONNECTION_REVOKED).toBe(
      "IT revoked the organisation's Slack connection this employee's app was created with, so " +
        'the app is not installed again, and Day0 cannot delete it, even once IT connects Slack ' +
        "again: IT deletes it in Slack's app settings.",
    );
  });
});
