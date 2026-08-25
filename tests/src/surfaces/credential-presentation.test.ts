import { describe, expect, it } from 'vitest';
import { presentSurfaceCredential } from '../../../src/surfaces/credential-presentation';

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

  it('shows an OAuth procedure without offering a plaintext field', (): void => {
    expect(
      presentSurfaceCredential({
        credential: {
          found: 'location',
          method: 'oauth',
          location: 'Ask IT to approve the Day0 app, then follow the install link.',
        },
      }),
    ).toEqual({
      canLand: false,
      governanceFinding: undefined,
      kind: 'oauth',
      text: 'Ask IT to approve the Day0 app, then follow the install link.',
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
      canLand: false,
      governanceFinding: undefined,
      kind: 'oauth',
      text: 'The automation registers its app from the team manifest template.',
    });
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
