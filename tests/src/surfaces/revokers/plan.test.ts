import { describe, expect, it } from 'vitest';
import { ACCESS_ENDS, type AccessEnd } from '../../../../src/surfaces/access-identity';
import {
  endRemovesApp,
  revocationPlanFor,
  sharedByOrganisation,
  type RevocationMeans,
  type RevocationSubject,
} from '../../../../src/surfaces/revokers/plan';

const SLACK_BOT: RevocationSubject = {
  issuedBy: { system: 'slack', grant: 'oauth-install', appId: 'A0W11AR', clientId: '1234.5678' },
  role: 'access',
};

const SLACK_SECRET: RevocationSubject = {
  issuedBy: { system: 'slack', grant: 'app-created', appId: 'A0W11AR', clientId: '1234.5678' },
  role: 'access',
};

const LINEAR_ACCESS: RevocationSubject = {
  issuedBy: { system: 'linear', grant: 'authorisation-code', clientId: 'lin-client' },
  role: 'access',
};

const EVERYTHING: RevocationMeans = { configurationToken: true, clientSecret: true };

describe('which ends remove the app and which keep it (S1, S4; the 1 October correction)', (): void => {
  it('removes the app at a retire, a rejection and an owner deletion, and keeps it otherwise', (): void => {
    const removes = ACCESS_ENDS.filter((end) => endRemovesApp(end));
    expect(removes).toEqual(['retire', 'reject', 'owner-deletion']);
  });
});

describe('the Slack plan: two calls with two meanings', (): void => {
  it.each<AccessEnd>(['disconnect', 'expiry', 'organisation-revoked'])(
    'revokes the bot token and keeps the app at %s',
    (end): void => {
      expect(revocationPlanFor(SLACK_BOT, end, EVERYTHING)).toEqual({
        kind: 'call',
        calls: [{ kind: 'slack-revoke-token' }],
      });
    },
  );

  it('deletes the app at a retire, falling back to the uninstall and then to the token itself', (): void => {
    expect(revocationPlanFor(SLACK_BOT, 'retire', EVERYTHING)).toEqual({
      kind: 'call',
      calls: [
        { kind: 'slack-delete-app', appId: 'A0W11AR' },
        { kind: 'slack-uninstall-app', clientId: '1234.5678' },
        { kind: 'slack-revoke-token' },
      ],
    });
  });

  it('uninstalls where the configuration connection is gone (S4: apps.uninstall revokes every token)', (): void => {
    expect(
      revocationPlanFor(SLACK_BOT, 'retire', { configurationToken: false, clientSecret: true }),
    ).toEqual({
      kind: 'call',
      calls: [
        { kind: 'slack-uninstall-app', clientId: '1234.5678' },
        { kind: 'slack-revoke-token' },
      ],
    });
  });

  it('deletes an app that was never installed with the configuration token, and says so where Day0 holds none', (): void => {
    expect(revocationPlanFor(SLACK_SECRET, 'retire', EVERYTHING)).toEqual({
      kind: 'call',
      calls: [{ kind: 'slack-delete-app', appId: 'A0W11AR' }],
    });
    expect(
      revocationPlanFor(SLACK_SECRET, 'retire', { configurationToken: false, clientSecret: true }),
    ).toEqual({
      kind: 'none',
      outcome: 'not-supported',
      words:
        "Day0 holds no configuration token to delete the app; delete it in Slack's app settings.",
    });
  });
});

describe('the Linear plan (L2, L3)', (): void => {
  it('revokes an access token and its refresh token, each named by its hint', (): void => {
    expect(revocationPlanFor(LINEAR_ACCESS, 'disconnect', EVERYTHING)).toEqual({
      kind: 'call',
      calls: [{ kind: 'linear-revoke', hint: 'access_token' }],
    });
    expect(revocationPlanFor({ ...LINEAR_ACCESS, role: 'refresh' }, 'retire', EVERYTHING)).toEqual({
      kind: 'call',
      calls: [{ kind: 'linear-revoke', hint: 'refresh_token' }],
    });
  });

  it("never revokes the shared app-actor token: the app's other employees use it", (): void => {
    const shared: RevocationSubject = {
      issuedBy: { system: 'linear', grant: 'client-credentials' },
      role: 'access',
    };
    expect(revocationPlanFor(shared, 'retire', EVERYTHING)).toEqual({
      kind: 'none',
      outcome: 'shared',
      words: "Shared app token: not revoked (the app's other employees use it).",
    });
  });
});

describe("the organisation's own rows, and an employee's identity it holds (wave 11 common rules)", (): void => {
  it("shares an organisation connection's secret and its app-actor token, never an owner's row", (): void => {
    expect(sharedByOrganisation({ holder: 'organisation' })).toBe(true);
    expect(
      sharedByOrganisation({ holder: 'organisation', issuedBy: { grant: 'client-credentials' } }),
    ).toBe(true);
    expect(sharedByOrganisation({})).toBe(false);
    expect(sharedByOrganisation({ issuedBy: { grant: 'authorisation-code' } })).toBe(false);
  });

  it("leaves a per-employee identity the organisation holds to the employee's end, revoked as any", (): void => {
    for (const grant of [
      'oauth-install',
      'authorisation-code',
      'token-rotation',
      'app-created',
    ] as const) {
      expect(sharedByOrganisation({ holder: 'organisation', issuedBy: { grant } })).toBe(false);
    }
    expect(revocationPlanFor(LINEAR_ACCESS, 'retire', EVERYTHING)).toEqual({
      kind: 'call',
      calls: [{ kind: 'linear-revoke', hint: 'access_token' }],
    });
  });
});

describe('the RFC 7009 plan for an MCP authorisation server', (): void => {
  const mcp: RevocationSubject = {
    issuedBy: { system: 'mcp:mcp.example.com', grant: 'authorisation-code', clientId: 'day0' },
    role: 'access',
  };

  it('revokes at the advertised revocation endpoint with the client id', (): void => {
    expect(
      revocationPlanFor(mcp, 'disconnect', {
        ...EVERYTHING,
        revocationEndpoint: 'https://auth.example.com/revoke',
      }),
    ).toEqual({
      kind: 'call',
      calls: [
        {
          kind: 'oauth-revoke',
          endpoint: 'https://auth.example.com/revoke',
          hint: 'access_token',
          clientId: 'day0',
        },
      ],
    });
  });

  it('says there is no endpoint where the server advertises none', (): void => {
    expect(revocationPlanFor(mcp, 'disconnect', EVERYTHING)).toEqual({
      kind: 'none',
      outcome: 'not-supported',
      words: "mcp.example.com advertises no revocation endpoint; Day0's copy is deleted.",
    });
  });
});

describe('the ends that never call a vendor', (): void => {
  it('does nothing at the vendor at a handover (A25)', (): void => {
    expect(revocationPlanFor(SLACK_BOT, 'transfer', EVERYTHING)).toEqual({
      kind: 'none',
      outcome: 'not-at-vendor',
      words: 'A handover changes nothing at the vendor; the new manager re-approves the system.',
    });
  });

  it('names a system with no revoker as such', (): void => {
    expect(
      revocationPlanFor(
        { issuedBy: { system: 'zendesk', grant: 'authorisation-code' }, role: 'access' },
        'disconnect',
        EVERYTHING,
      ),
    ).toEqual({
      kind: 'none',
      outcome: 'not-supported',
      words: "zendesk: no revocation endpoint; Day0's copy is deleted.",
    });
  });
});
