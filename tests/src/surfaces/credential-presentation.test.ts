import { describe, expect, it } from 'vitest';
import {
  OAUTH_FALLBACK_LABEL,
  OAUTH_FALLBACK_NOTE,
  presentChannelsNotJoined,
  presentProvisioning,
  presentSurfaceCredential,
  PROVISION_LABEL,
  PROVISION_NOTE,
} from '../../../src/surfaces/credential-presentation';

describe('surface credential presentation', (): void => {
  it('uses encrypted-store metadata for a shared-page marker', (): void => {
    expect(
      presentSurfaceCredential({
        credential: {
          found: 'value',
          method: 'api-key',
          governanceFinding: 'credential found in a shared page - rotate into a vault',
        },
        credentialId: 'credential-1',
        sourceLabel: 'Revenue operations',
        summary: {
          _id: 'credential-1',
          label: 'linear service token',
          source: { sourceId: 'source-1', ref: 'Linear automation' },
        },
      }),
    ).toEqual({
      canLand: false,
      governanceFinding: 'credential found in a shared page - rotate into a vault',
      kind: 'masked',
      label: 'linear service token',
      text: 'located in Revenue operations / Linear automation (masked)',
    });
  });

  it('offers landing only when documentation names a credential location', (): void => {
    expect(
      presentSurfaceCredential({
        credential: {
          found: 'location',
          method: 'bot-token',
          location: 'Ask the messaging administrator for the scoped bot token.',
        },
      }),
    ).toMatchObject({
      canLand: true,
      kind: 'landing',
      text: 'not in the docs - Ask the messaging administrator for the scoped bot token.',
    });
  });

  it('shows an OAuth procedure with the labelled shared-token fallback landing', (): void => {
    expect(
      presentSurfaceCredential({
        credential: {
          found: 'location',
          method: 'oauth',
          location: 'Ask IT to approve the Day0 app, then follow the install link.',
        },
      }),
    ).toEqual({
      canLand: true,
      detail: undefined,
      governanceFinding: undefined,
      kind: 'oauth',
      label: undefined,
      landingLabel: OAUTH_FALLBACK_LABEL,
      landingNote: OAUTH_FALLBACK_NOTE,
      text: 'Ask IT to approve the Day0 app, then follow the install link.',
    });
    expect(OAUTH_FALLBACK_LABEL).toBe('Land a shared bot token (fallback)');
    expect(OAUTH_FALLBACK_NOTE).toContain('shared credential');
  });

  it('shows the stored metadata, not the fallback, once a token is landed on an OAuth surface', (): void => {
    expect(
      presentSurfaceCredential({
        credential: { found: 'none', method: 'oauth', label: 'Slack OAuth access' },
        credentialId: 'credential-2',
        summary: { _id: 'credential-2', label: 'Slack shared bot token', source: 'entered' },
      }),
    ).toEqual({
      canLand: false,
      governanceFinding: undefined,
      kind: 'masked',
      label: 'Slack shared bot token',
      text: 'entered by IT (masked)',
    });
  });

  it('shows a documented OAuth flow as a procedure when nothing was found', (): void => {
    expect(
      presentSurfaceCredential({
        credential: {
          found: 'none',
          method: 'oauth',
          label: 'Slack OAuth access',
          location: 'The automation registers its app from the team manifest template.',
        },
        credentialLocation: 'OAuth install flow documented in Slack automation policy',
      }),
    ).toEqual({
      canLand: true,
      detail: 'The automation registers its app from the team manifest template.',
      governanceFinding: undefined,
      kind: 'oauth',
      label: 'Slack OAuth access',
      landingLabel: OAUTH_FALLBACK_LABEL,
      landingNote: OAUTH_FALLBACK_NOTE,
      text: 'OAuth install flow documented in Slack automation policy',
    });
    const long = 'x'.repeat(900);
    expect(
      presentSurfaceCredential({
        credential: { found: 'none', method: 'oauth', location: long },
        credentialLocation: 'OAuth install flow documented in policy',
      }).detail,
    ).toBe(`${'x'.repeat(400)}...`);
  });

  it('never substitutes orientation request labels for store metadata', (): void => {
    expect(
      presentSurfaceCredential({
        credential: { found: 'value', label: 'request label', method: 'api-key' },
      }),
    ).toEqual({
      canLand: false,
      governanceFinding: undefined,
      kind: 'unresolved',
      text: 'Stored credential marker could not be resolved - re-sync the documentation.',
    });
  });

  it('does not treat a missing owner summary as permission to replace a stored row', (): void => {
    expect(
      presentSurfaceCredential({
        credential: { found: 'value', label: 'request label', method: 'api-key' },
        credentialId: 'credential-1',
      }),
    ).toEqual({
      canLand: false,
      governanceFinding: undefined,
      kind: 'unresolved',
      text: 'Stored credential metadata is unavailable.',
    });
  });

  it('does not invite secret entry when documentation names no location', (): void => {
    expect(
      presentSurfaceCredential({
        credential: { found: 'none', method: 'unknown' },
      }),
    ).toEqual({
      canLand: false,
      governanceFinding: undefined,
      kind: 'unresolved',
      label: undefined,
      text: 'not in the docs - location not documented',
    });
  });
});

describe('the dedicated-app procedure on the card', (): void => {
  const oauth = { found: 'none', method: 'oauth' } as const;

  it('says nothing for a system whose docs describe no install procedure', (): void => {
    expect(
      presentProvisioning({ credential: { found: 'value', method: 'api-key' }, hasPublicUrl: true }),
    ).toMatchObject({ offerProvisioning: false, stage: 'not-applicable' });
  });

  it('offers to register an app when the deployment can receive the redirect', (): void => {
    const shown = presentProvisioning({ credential: oauth, hasPublicUrl: true });
    expect(shown.stage).toBe('offer');
    expect(shown.offerProvisioning).toBe(true);
    expect(shown.title).toBe(PROVISION_LABEL);
    expect(shown.note).toBe(PROVISION_NOTE);
    expect(shown.installUrl).toBeUndefined();
  });

  it('refuses to offer one when no install could return here', (): void => {
    const shown = presentProvisioning({ credential: oauth, hasPublicUrl: false });
    expect(shown.stage).toBe('unavailable');
    expect(shown.offerProvisioning).toBe(false);
    expect(shown.note).toContain('DAY0_PUBLIC_URL');
  });

  it('shows the install link and stops offering once the app exists', (): void => {
    const shown = presentProvisioning({
      credential: oauth,
      hasPublicUrl: true,
      provisioning: {
        appId: 'A1',
        appName: 'ops worker (Day0)',
        installUrl: 'https://slack.com/oauth/v2/authorize?client_id=1',
      },
    });
    expect(shown.stage).toBe('awaiting-install');
    expect(shown.offerProvisioning).toBe(false);
    expect(shown.installUrl).toBe('https://slack.com/oauth/v2/authorize?client_id=1');
    expect(shown.note).toContain('ops worker (Day0) is registered');
    expect(shown.note).toContain('single-use');
  });

  it('names the failure and offers a fresh link after a failed install', (): void => {
    const shown = presentProvisioning({
      credential: oauth,
      hasPublicUrl: true,
      provisioning: {
        appId: 'A1',
        appName: 'ops worker (Day0)',
        installUrl: 'https://slack.com/oauth/v2/authorize?client_id=1',
        lastError: 'Slack oauth.v2.access failed: invalid_code.',
      },
    });
    expect(shown.stage).toBe('failed');
    expect(shown.offerProvisioning).toBe(true);
    expect(shown.note).toContain('invalid_code');
  });

  it('reports the dedicated identity once the install has landed', (): void => {
    const shown = presentProvisioning({
      credential: oauth,
      hasPublicUrl: true,
      provisioning: {
        appId: 'A1',
        appName: 'ops worker (Day0)',
        installUrl: 'https://slack.com/oauth/v2/authorize?client_id=1',
        installedAt: 1_787_800_000_000,
      },
    });
    expect(shown.stage).toBe('installed');
    expect(shown.offerProvisioning).toBe(false);
    expect(shown.installUrl).toBeUndefined();
    expect(shown.note).toContain('acts as its own app');
  });

  it('keeps the shared-token fallback beside the procedure until one is stored', (): void => {
    expect(presentSurfaceCredential({ credential: oauth })).toMatchObject({
      canLand: true,
      kind: 'oauth',
      landingLabel: OAUTH_FALLBACK_LABEL,
    });
  });

  it('shows an installed token as the app\'s own, with no landing field', (): void => {
    expect(
      presentSurfaceCredential({
        credentialId: 'cred1',
        provisioning: {
          appId: 'A1',
          appName: 'ops worker (Day0)',
          installUrl: 'https://slack.com/oauth/v2/authorize',
          installedAt: 1,
        },
        summary: { _id: 'cred1', label: 'Slack bot token', source: 'oauth' },
      }),
    ).toEqual({
      canLand: false,
      governanceFinding: undefined,
      kind: 'masked',
      label: 'Slack bot token',
      text: 'delivered by the install of ops worker (Day0) (masked)',
    });
  });
});

describe('channels the app has not been invited to', (): void => {
  it('says nothing when the app is in every documented channel', (): void => {
    expect(presentChannelsNotJoined([])).toBeUndefined();
    expect(presentChannelsNotJoined(undefined)).toBeUndefined();
  });

  it('names the channels and the step only a human can take', (): void => {
    const line = presentChannelsNotJoined(['#revops-asks', '#revops'], 'ops worker (Day0)');
    expect(line).toContain('Not in #revops-asks, #revops');
    expect(line).toContain('not in channel');
    expect(line).toContain('Invite ops worker (Day0)');
    expect(line).toContain('probe again');
  });

  it('falls back to the employee when there is no dedicated app', (): void => {
    expect(presentChannelsNotJoined(['#revops'])).toContain('Invite this employee to #revops');
  });
});
