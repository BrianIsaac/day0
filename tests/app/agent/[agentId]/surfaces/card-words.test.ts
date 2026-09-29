import { describe, expect, it } from 'vitest';
import {
  accessStanding,
  expectedCredential,
  reachedWords,
  stateChip,
  type WordedSurface,
} from '../../../../../app/agent/[agentId]/surfaces/card-words';

const DAY = 24 * 60 * 60 * 1000;
/** 29 Sep 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 8, 29, 12);

const surface = (fields: Partial<WordedSurface>): WordedSurface => ({
  verdict: 'connected',
  path: 'mcp',
  credentialLanded: true,
  displayName: 'Linear',
  ...fields,
});

describe("where a card's access stands (Q5)", (): void => {
  it('has no clock before the card is approved', (): void => {
    expect(
      accessStanding(surface({ verdict: 'proposed', expiresAt: NOW + DAY }), NOW, 'UTC'),
    ).toEqual({ kind: 'none' });
  });

  it("is ending from the day the week notice is due in the employee's zone, as the server sends it", (): void => {
    // Ends 6 Oct 2026 at 00:30 UTC: the notice is due from 29 Sep in UTC, but in
    // Los Angeles the end is 5 Oct and the notice day 28 Sep, so it is due there too.
    const expiresAt = Date.UTC(2026, 9, 6, 0, 30);
    expect(accessStanding(surface({ expiresAt }), Date.UTC(2026, 8, 28, 23), 'UTC').kind).toBe(
      'running',
    );
    expect(
      accessStanding(surface({ expiresAt }), Date.UTC(2026, 8, 28, 23), 'America/Los_Angeles'),
    ).toMatchObject({ kind: 'ending', daysLeft: 7 });
  });

  it('is ended once the date passes, before the sweep marks it, and whenever the sweep has', (): void => {
    expect(accessStanding(surface({ expiresAt: NOW - 1 }), NOW, 'UTC').kind).toBe('ended');
    expect(
      accessStanding(
        surface({ verdict: 'approved', expiresAt: NOW + 30 * DAY, reason: 'expired' }),
        NOW,
        'UTC',
      ).kind,
    ).toBe('ended');
  });
});

describe('the state chip a card carries', (): void => {
  it.each([
    ['No proposal yet', 'muted', surface({ verdict: 'declared', path: undefined })],
    ['Proposed · browser', 'muted', surface({ verdict: 'proposed', path: 'browser-driven' })],
    ['Needs its credential', 'warn', surface({ verdict: 'approved', credentialLanded: false })],
    ['Checking the connection', 'accent', surface({ verdict: 'approved' })],
    ['Connected over MCP', 'ok', surface({ expiresAt: NOW + 60 * DAY })],
    ['Connected over its API', 'ok', surface({ path: 'documented-api' })],
    ['Not granted', 'warn', surface({ verdict: 'ungranted' })],
    ['Not answering', 'warn', surface({ verdict: 'listed-dead' })],
    ['Not found', 'muted', surface({ verdict: 'absent', path: undefined })],
    ['Expires in 6 days', 'warn', surface({ expiresAt: NOW + 6 * DAY })],
    ['Access ended', 'warn', surface({ expiresAt: NOW - DAY })],
    ['Expires today', 'warn', surface({ expiresAt: NOW + 60 * 60 * 1000 })],
    ['Expires in 1 day', 'warn', surface({ expiresAt: NOW + DAY })],
  ])('says "%s" in the %s tone', (text, tone, row): void => {
    expect(stateChip(row, NOW, 'UTC')).toEqual({ text, tone });
  });

  it('says how each rung reaches its system', (): void => {
    expect(
      ['mcp', 'documented-api', 'browser-driven', 'escalate', 'nonsense', undefined].map(
        reachedWords,
      ),
    ).toEqual(['over MCP', 'over its API', 'in a browser', 'by escalation', undefined, undefined]);
  });
});

describe('whose credential the field expects (Q10, B D6)', (): void => {
  it("asks Slack for the app's bot token and says why a user token is refused", (): void => {
    const slack = expectedCredential(
      { displayName: 'Slack', path: 'documented-api', endpoint: 'https://slack.com/api' },
      'Slack bot token',
    );
    expect(slack.label).toBe("The Slack app's bot token, the one that begins xoxb-");
    expect(slack.hint).toContain('A user token would post as that person');
  });

  it("asks the browser rung for the sign-in its session types, by the documentation's name for it", (): void => {
    expect(
      expectedCredential(
        {
          displayName: 'Looker pipeline tile',
          path: 'browser-driven',
          endpoint: 'http://looker-tile:8080/',
        },
        'looker pipeline tile dashboard login',
      ),
    ).toEqual({
      label: 'The looker pipeline tile dashboard login the browser session signs in with',
      hint: "The browser session types it only into the sign-in form's credential field. It is stored encrypted and never shown again.",
    });
    expect(
      expectedCredential(
        { displayName: 'Looker', path: 'browser-driven', endpoint: undefined },
        undefined,
      ).label,
    ).toBe('The Looker sign-in the browser session signs in with');
  });

  it('asks any other card for the credential the documentation names', (): void => {
    expect(
      expectedCredential(
        { displayName: 'Linear', path: 'mcp', endpoint: 'https://mcp.linear.app/mcp' },
        'Linear service token',
      ).label,
    ).toBe('The Linear service token the documentation names');
    expect(
      expectedCredential({ displayName: 'Linear', path: 'mcp', endpoint: undefined }, undefined)
        .label,
    ).toBe('A Linear credential with the documented permissions');
  });
});
