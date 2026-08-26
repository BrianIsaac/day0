import { describe, expect, it } from 'vitest';
import {
  OAUTH_FALLBACK_LABEL,
  OAUTH_FALLBACK_NOTE,
  presentSurfaceCredential,
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
