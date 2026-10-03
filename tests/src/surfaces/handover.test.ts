import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import { surfaceHandoverOf } from '../../../src/surfaces/handover';

/** A surface row's fields the decision reads, with no approval and no credential. */
function bareSurface(
  verdict: Doc<'surfaces'>['verdict'],
): Pick<Doc<'surfaces'>, 'verdict' | 'credentialId' | 'provisioning' | 'managerApprovedAt'> {
  return { verdict };
}

describe('the per-surface decision at a handover (D5 (a), A25)', (): void => {
  it("cuts a surface bound to the old owner's credential or a Slack app's client secret", (): void => {
    const credentialId = 'credential' as Id<'credentials'>;
    expect(surfaceHandoverOf({ ...bareSurface('declared'), credentialId }, [])).toBe('cut');
    expect(
      surfaceHandoverOf(
        {
          ...bareSurface('declared'),
          provisioning: {
            clientSecretCredentialId: credentialId,
          } as Doc<'surfaces'>['provisioning'],
        },
        [],
      ),
    ).toBe('cut');
  });

  it('cuts a surface the old manager approved even when no credential is bound yet', (): void => {
    expect(surfaceHandoverOf(bareSurface('approved'), [])).toBe('cut');
    expect(surfaceHandoverOf({ ...bareSurface('proposed'), managerApprovedAt: 5 }, [])).toBe('cut');
    for (const verdict of ['connected', 'ungranted', 'listed-dead'] as const) {
      expect(surfaceHandoverOf(bareSurface(verdict), [])).toBe('cut');
    }
  });

  it('cuts a surface whose bound credential row it is given, whatever its verdict says', (): void => {
    const credential = { _id: 'credential', userId: 'owner' } as unknown as Doc<'credentials'>;
    expect(surfaceHandoverOf(bareSurface('declared'), [credential])).toBe('cut');
  });

  it('carries a surface nothing of the old manager acts through', (): void => {
    for (const verdict of ['declared', 'proposed', 'absent'] as const) {
      expect(surfaceHandoverOf(bareSurface(verdict), [])).toBe('carry');
    }
  });
});

describe("the employee's own identity at a handover (A25; the access plan, section 4.12)", (): void => {
  const connectionId = 'connection' as Id<'organisationConnections'>;
  const tokenId = 'token' as Id<'credentials'>;

  /** A connected card on IT's organisation connection, acting as the employee's own app. */
  function ownIdentityCard(): Parameters<typeof surfaceHandoverOf>[0] {
    return {
      verdict: 'connected',
      credentialId: tokenId,
      managerApprovedAt: 5,
      organisationConnectionId: connectionId,
      actsAs: { kind: 'own-app', label: 'Leo (Day0)' },
    };
  }

  /** A credential row issued through the organisation connection. */
  const issuedThroughConnection = {
    _id: tokenId,
    userId: 'owner',
    issuedBy: { system: 'slack', grant: 'oauth-install', organisationConnectionId: connectionId },
  } as unknown as Doc<'credentials'>;

  it('keeps an identity obtained through the organisation connection, for the new manager to re-approve', (): void => {
    expect(surfaceHandoverOf(ownIdentityCard(), [issuedThroughConnection])).toBe('reapprove');
    // The page reads no credential rows: the card's own link and identity decide.
    expect(surfaceHandoverOf(ownIdentityCard())).toBe('reapprove');
  });

  it('cuts a card whose bound rows were read and are gone: there is no identity left to keep', (): void => {
    expect(surfaceHandoverOf(ownIdentityCard(), [])).toBe('cut');
  });

  it('cuts a card on the connection that binds a key someone pasted (D5)', (): void => {
    const pasted = { _id: tokenId, userId: 'owner' } as unknown as Doc<'credentials'>;
    expect(surfaceHandoverOf(ownIdentityCard(), [pasted])).toBe('cut');
    expect(
      surfaceHandoverOf({ ...ownIdentityCard(), actsAs: { kind: 'shared-key', label: 'Key' } }),
    ).toBe('cut');
  });

  it("keeps an own app whose access ended on the page as the move keeps it, by the app's secret (11-AC's item 15)", (): void => {
    const secretId = 'secret' as Id<'credentials'>;
    // An expiry or a Disconnect cleared the bot token; the app the connection created stays.
    const ended = {
      ...ownIdentityCard(),
      verdict: 'approved' as const,
      credentialId: undefined,
      provisioning: {
        appId: 'A1',
        appName: 'Leo (Day0)',
        clientId: '1.2',
        clientSecretCredentialId: secretId,
        organisationConnectionId: connectionId,
      },
    } as Parameters<typeof surfaceHandoverOf>[0];
    const secret = {
      _id: secretId,
      userId: 'organisation',
      holder: 'organisation',
      issuedBy: { system: 'slack', grant: 'app-created', organisationConnectionId: connectionId },
    } as unknown as Doc<'credentials'>;

    expect(surfaceHandoverOf(ended, [secret])).toBe('reapprove');
    expect(surfaceHandoverOf(ended)).toBe('reapprove');
  });

  it('cuts an own app Day0 made without an organisation connection, as before', (): void => {
    const card = { ...ownIdentityCard(), organisationConnectionId: undefined };
    const unlinkedIssue = {
      ...issuedThroughConnection,
      issuedBy: { system: 'slack', grant: 'oauth-install' },
    } as unknown as Doc<'credentials'>;
    expect(surfaceHandoverOf(card, [unlinkedIssue])).toBe('cut');
  });
});
