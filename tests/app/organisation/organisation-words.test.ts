import { describe, expect, it } from 'vitest';
import {
  connectionStatusChip,
  kindWords,
  ledgerLineWords,
  modeWords,
  ORGANISATION_REFUSED,
  registeredWords,
  revokeLines,
  rotateNote,
  secretWords,
  type ConnectionView,
} from '../../../app/organisation/organisation-words';

const AT = Date.UTC(2026, 9, 1, 9, 30);

/** A connection as `organisationConnections.listForAdministrator` lists it. */
function view(fields: Partial<ConnectionView> = {}): ConnectionView {
  return {
    _id: 'connection-1',
    system: 'slack',
    displayName: 'Slack',
    kind: 'slack-configuration',
    mode: 'per-employee',
    scopes: ['chat:write'],
    registeredBy: { via: 'organisation-page', address: 'ines@acme.test', at: AT },
    status: 'active',
    createdAt: AT,
    hasSecret: true,
    ...fields,
  } as ConnectionView;
}

describe("the organisation page's words (B8; the access plan, section 4.1)", (): void => {
  it('refuses a manager in words, saying who manages the connections and where an employee is approved', (): void => {
    expect(ORGANISATION_REFUSED.title).toBe("This page is for your organisation's administrators");
    expect(ORGANISATION_REFUSED.lines).toEqual([
      'IT named the administrators when Day0 was installed. Ask one of them when a system needs connecting, a new secret or revoking.',
      "Each employee's access is still yours to approve, on its card.",
    ]);
  });

  it('says each mode in words', (): void => {
    expect(modeWords('per-employee')).toBe('Each employee gets its own identity');
    expect(modeWords('shared')).toBe(
      'Every employee shares one identity; Day0 records who did what',
    );
  });

  it('says each kind of registration in words', (): void => {
    expect(kindWords(view())).toBe("Slack configuration token, which creates each employee's app");
    expect(kindWords(view({ kind: 'oauth-app' }))).toBe('OAuth app');
    expect(kindWords(view({ kind: 'mcp-client', clientRegistration: 'pre-registered' }))).toBe(
      'MCP client, registered by IT',
    );
    expect(kindWords(view({ kind: 'mcp-client', clientRegistration: 'dynamic' }))).toBe(
      'MCP client, registered by Day0 with the server',
    );
    expect(kindWords(view({ kind: 'service-account' }))).toBe('Service account');
    expect(kindWords(view({ kind: 'static-key' }))).toBe('API key');
  });

  it('chips each status in its tone', (): void => {
    expect(connectionStatusChip('active')).toEqual({ text: 'Active', tone: 'ok' });
    expect(connectionStatusChip('needs-attention')).toEqual({ text: 'Needs IT', tone: 'warn' });
    expect(connectionStatusChip('revoked')).toEqual({ text: 'Revoked', tone: 'muted' });
  });

  it('says who registered a connection and when, an administrator by address and the setup command by name', (): void => {
    expect(registeredWords(view().registeredBy, 'UTC')).toBe(
      'ines@acme.test, on this page, 1 Oct 2026, 09:30',
    );
    expect(registeredWords({ via: 'setup-cli', at: AT }, 'UTC')).toBe(
      'The setup command, 1 Oct 2026, 09:30',
    );
  });

  it('says whether a secret is held and when it expires, never the secret', (): void => {
    expect(secretWords(view({ secretExpiresAt: AT + 12 * 3_600_000 }), 'UTC')).toBe(
      'Held encrypted; it expires 1 Oct 2026, 21:30',
    );
    expect(secretWords(view(), 'UTC')).toBe('Held encrypted');
    expect(secretWords(view({ kind: 'oauth-app', hasSecret: false }), 'UTC')).toBe(
      "None for the organisation: each employee's own app holds its own",
    );
    expect(secretWords(view({ hasSecret: false, status: 'revoked' }), 'UTC')).toBe('None held');
  });

  it('says before a revoke that every card on the connection ends with the reason, and no card on another system', (): void => {
    expect(
      revokeLines(view({ kind: 'oauth-app', system: 'linear', displayName: 'Linear' })),
    ).toEqual([
      "Every employee's Linear card connected through it ends now, each with your reason, and what Day0 obtained through it is revoked at Linear.",
      'No card on any other system changes. Each manager sees the reason on the card.',
      'IT can connect it again with ./setup.sh access.',
    ]);
  });

  it("says before a Slack revoke that Slack cannot end the configuration token's refresh token, and what IT deletes (R41V-10)", (): void => {
    expect(revokeLines(view())).toEqual([
      "Every employee's Slack card connected through it ends now, each with your reason, and what Day0 obtained through it is revoked at Slack.",
      'No card on any other system changes. Each manager sees the reason on the card.',
      'Day0 revokes the configuration token at Slack, but Slack offers no call that ends its refresh token: once this is revoked, IT deletes the token\'s row under "Your App Configuration Tokens" on api.slack.com, signed in as the account that generated it.',
      'IT can connect it again with ./setup.sh access.',
    ]);
  });

  it("says how many cards a revoke ends once the count is read, naming no employee (11-AC's item 3)", (): void => {
    expect(revokeLines(view(), { cards: 3, atLeast: false })[0]).toBe(
      '3 employee cards connected through it end now, each with your reason, and what Day0 obtained through it is revoked at Slack.',
    );
    expect(revokeLines(view(), { cards: 1, atLeast: false })[0]).toBe(
      'One employee card connected through it ends now, with your reason, and what Day0 obtained through it is revoked at Slack.',
    );
    expect(revokeLines(view(), { cards: 0, atLeast: false })[0]).toBe(
      'No employee card is connected through it, so none ends; what Day0 obtained through it is revoked at Slack.',
    );
    expect(revokeLines(view(), { cards: 1000, atLeast: true })[0]).toBe(
      'More than 1000 employee cards are connected through it, too many to end at once: Day0 refuses the revoke until some are removed.',
    );
  });

  it("says each manager sees the reason only where a card ends (the round review's m17)", (): void => {
    expect(revokeLines(view(), { cards: 0, atLeast: false })[1]).toBe(
      'No card on any other system changes.',
    );
    // A revoke of more cards than one ends is refused, so nothing after the count is said.
    expect(revokeLines(view(), { cards: 1000, atLeast: true })).toHaveLength(1);
    expect(revokeLines(view(), { cards: 2, atLeast: false })[1]).toBe(
      'No card on any other system changes. Each manager sees the reason on the card.',
    );
  });

  it("says before a Slack rotation that the old configuration token's refresh token outlives it, as the revoke does (the round review's m17)", (): void => {
    expect(rotateNote(view())).toBe(
      'No card is affected. Day0 seals the new secret, switches to it and revokes the old ' +
        "configuration token. Slack cannot end that token's refresh token, so IT then deletes its " +
        'row under "Your App Configuration Tokens" on api.slack.com, signed in as the account that ' +
        'generated it.',
    );
    expect(rotateNote(view({ kind: 'oauth-app', system: 'linear', displayName: 'Linear' }))).toBe(
      'No card is affected. Day0 seals the new secret, switches to it and revokes the old one.',
    );
  });

  it("says a ledger line in the record's words, with the administrator who made the change", (): void => {
    expect(
      ledgerLineWords({
        _id: 'line-1',
        organisationConnectionId: 'connection-1',
        type: 'organisation.connection-revoked',
        payload: {
          organisationConnectionId: 'connection-1',
          system: 'slack',
          displayName: 'Slack',
          via: 'organisation-page',
          reason: 'Moving to a new workspace',
        },
        actorAddress: 'ines@acme.test',
        createdAt: AT,
      } as never),
    ).toBe(
      "The organisation's Slack connection was revoked by an administrator: Moving to a new workspace. By ines@acme.test.",
    );
  });
});
