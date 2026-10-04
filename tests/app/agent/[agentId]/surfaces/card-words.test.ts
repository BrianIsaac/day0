import { describe, expect, it } from 'vitest';
import { ACTS_AS_KINDS } from '../../../../../src/surfaces/access-identity';
import { issuerKindFor } from '../../../../../src/surfaces/access-request';
import { cardIdentity } from '../../../../../src/surfaces/card-identity';
import {
  accessStanding,
  actsAsWords,
  connectedForOrganisationWords,
  disconnectLines,
  documentedKeyUnusedWords,
  expectedCredential,
  identityChip,
  moveOfferWords,
  reachedWords,
  rejoinWords,
  stateChip,
  type OrganisationSystem,
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
    ).toBe('The Looker sign-in for the browser session');
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

/** A system the organisation connected, as `organisationConnections.summaryForManager` lists it. */
function connected(
  fields: Partial<OrganisationSystem> & Pick<OrganisationSystem, 'system'>,
): OrganisationSystem {
  return {
    displayName: fields.system,
    // The kind an issuer acts through for the system, else a static key (D6).
    kind: issuerKindFor(fields.system) ?? 'static-key',
    mode: 'per-employee',
    status: 'active',
    connectedAt: Date.UTC(2026, 9, 1, 9),
    ...fields,
  };
}

const SLACK = { endpoint: 'https://slack.com/api/', path: 'documented-api' } as const;
const LINEAR = { endpoint: 'https://mcp.linear.app/mcp', path: 'mcp' } as const;
const DOCS_MCP = { endpoint: 'https://docs.acme.test/mcp', path: 'mcp' } as const;

describe('whom a card acts as, before approval as after (D2; the access plan, section 4.3)', (): void => {
  const names = { employee: 'Maya', system: 'Slack' };

  it('reads the identity the connect path wrote, as it is, and names the app as the system shows it', (): void => {
    // A connect path writes the identity with the credential it lands; the card holds both (M8).
    const identity = cardIdentity(
      {
        ...SLACK,
        actsAs: { kind: 'own-app', label: 'Maya (Day0)', providerIdentityId: 'U1' },
        credentialId: 'cred-1',
      },
      undefined,
      { selfProvisions: false },
    );
    expect(identity).toEqual({ kind: 'own-app', label: 'Maya (Day0)', planned: false });
    expect(actsAsWords(identity, names)).toBe(
      'Maya, its own Slack app, named “Maya (Day0)” in Slack',
    );
  });

  it("says before approval that a Slack card on the organisation's connection acts as the employee's own app", (): void => {
    const identity = cardIdentity(SLACK, connected({ system: 'slack' }), { selfProvisions: false });
    expect(identity).toEqual({ kind: 'own-app', planned: true });
    expect(actsAsWords(identity, names)).toBe('Maya, its own Slack app');
  });

  it("says a Linear card on the organisation's shared app acts as that app, with Day0 recording who did what", (): void => {
    const identity = cardIdentity(LINEAR, connected({ system: 'linear', mode: 'shared' }), {
      selfProvisions: false,
    });
    expect(identity.kind).toBe('shared-app');
    expect(actsAsWords(identity, { employee: 'Maya', system: 'Linear' })).toBe(
      'the Day0 app shared by your employees; Day0 records which employee did what',
    );
  });

  it('says a Linear card on a per-employee connection acts as its own Linear app', (): void => {
    const identity = cardIdentity(LINEAR, connected({ system: 'linear' }), {
      selfProvisions: false,
    });
    expect(actsAsWords(identity, { employee: 'Leo', system: 'Linear' })).toBe(
      'Leo, its own Linear app',
    );
  });

  it("says an MCP card on the organisation's client acts as the manager, delegated, and shows it", (): void => {
    const identity = cardIdentity(
      DOCS_MCP,
      connected({ system: 'mcp:docs.acme.test', displayName: 'Acme docs' }),
      { selfProvisions: false },
    );
    expect(identity.kind).toBe('delegated');
    expect(actsAsWords(identity, { employee: 'Maya', system: 'Acme docs' })).toBe(
      'you in Acme docs: what it touches shows your name',
    );
  });

  it('says a card no organisation connection covers will use a key someone pastes, and once pasted that it does', (): void => {
    const planned = cardIdentity(LINEAR, undefined, { selfProvisions: false });
    expect(planned).toEqual({ kind: 'shared-key', planned: true });
    expect(actsAsWords(planned, { employee: 'Maya', system: 'Linear' })).toBe(
      "a key someone pastes here; its writes show that key's owner, and Day0 adds Maya's name to each write",
    );
    const landed = cardIdentity(
      {
        ...LINEAR,
        actsAs: { kind: 'shared-key', label: 'Linear API key' },
        credentialId: 'cred-1' as never,
      },
      undefined,
      { selfProvisions: false },
    );
    expect(actsAsWords(landed, { employee: 'Maya', system: 'Linear' })).toBe(
      "a key someone pasted; its writes show that key's owner, and Day0 adds Maya's name to each write",
    );
  });

  it("treats a connection that needs IT's attention as no connection: the card can still take a key", (): void => {
    expect(
      cardIdentity(LINEAR, connected({ system: 'linear', status: 'needs-attention' }), {
        selfProvisions: false,
      }).kind,
    ).toBe('shared-key');
  });

  it('says a Slack card that registers its own app without a connection acts as that app', (): void => {
    expect(cardIdentity(SLACK, undefined, { selfProvisions: true }).kind).toBe('own-app');
  });

  it('reads a connection only for the system the card is on', (): void => {
    expect(
      cardIdentity(LINEAR, connected({ system: 'slack' }), { selfProvisions: false }).kind,
    ).toBe('shared-key');
  });

  it('says a dedicated browser seat as the employee signed in as itself', (): void => {
    expect(
      actsAsWords(
        { kind: 'browser-seat', label: 'maya@acme.test', planned: false },
        { employee: 'Maya', system: 'Looker' },
      ),
    ).toBe('Maya, signed in to its own seat in Looker');
  });

  it('has words for every identity kind, planned and landed, with no em dash', (): void => {
    for (const kind of ACTS_AS_KINDS) {
      for (const planned of [true, false]) {
        const words = actsAsWords({ kind, planned }, { employee: 'Maya', system: 'Linear' });
        expect(words.length, kind).toBeGreaterThan(0);
        expect(words).not.toContain('\u2014');
      }
    }
  });
});

describe('a key found in the documentation (B1, decision 1 (a))', (): void => {
  const names = { employee: 'Maya', system: 'Linear' };
  const bound = {
    ...LINEAR,
    actsAs: { kind: 'shared-key' as const, label: 'Linear API key' },
    credentialId: 'cred-1' as never,
  };

  it('says a documented key bound with no connection is a shared key nobody pasted', (): void => {
    const identity = cardIdentity(bound, undefined, {
      selfProvisions: false,
      heldKeyFrom: 'documentation',
    });
    expect(identity).toEqual({
      kind: 'shared-key',
      label: 'Linear API key',
      planned: false,
      keyFrom: 'documentation',
    });
    const words = actsAsWords(identity, names);
    expect(words).toBe(
      "a key found in your documentation; its writes show that key's owner, and Day0 adds Maya's name to each write",
    );
    expect(words).not.toMatch(/past/);
    expect(identityChip(identity)).toBe('Documented key');
  });

  it('still says a key the manager pasted was pasted', (): void => {
    const identity = cardIdentity(bound, undefined, {
      selfProvisions: false,
      heldKeyFrom: 'paste',
    });
    expect(actsAsWords(identity, names)).toMatch(/^a key someone pasted;/);
    expect(identityChip(identity)).toBe('Pasted key');
  });

  it('says the Disconnect leaves a documented key as it is, without calling it pasted', (): void => {
    const identity = cardIdentity(bound, undefined, {
      selfProvisions: false,
      heldKeyFrom: 'documentation',
    });
    const lines = disconnectLines(identity, names, { slack: false });
    expect(lines).toEqual([
      'The key found in your documentation is left as it is at Linear: Day0 stops using it and never revokes a key it did not obtain, and it stays in your stored credentials. Revoke it there if it should end.',
    ]);
  });

  it('offers the move off a documented key in its own words', (): void => {
    expect(moveOfferWords({ kind: 'shared-app', planned: true }, names, 'documentation')).toBe(
      'IT has connected Linear. Maya can use the Day0 app your employees share instead of the key found in your documentation, which keeps working until you move it.',
    );
  });

  it("says a documented key IT's connection replaced was found and is not used", (): void => {
    expect(documentedKeyUnusedWords('Maya')).toBe(
      "Found and not used: Maya acts through IT's connection.",
    );
  });
});

describe("the manager's line for a system IT connected", (): void => {
  it('names the day IT connected it, in the zone given', (): void => {
    expect(
      connectedForOrganisationWords(
        connected({ system: 'linear', connectedAt: Date.UTC(2026, 9, 1, 9) }),
        'UTC',
      ),
    ).toBe('Connected for your organisation by IT on 1 October');
    expect(
      connectedForOrganisationWords({ connectedAt: Date.UTC(2026, 9, 1, 9) }, 'UTC', true),
    ).toBe('Connected for your organisation by IT on 1 October. This card does not use it yet.');
  });
});

describe('the move off a pasted key at its renewal (A27)', (): void => {
  it('names whom the card would act as through the connection, and that the key keeps working', (): void => {
    expect(
      moveOfferWords({ kind: 'own-app', planned: true }, { employee: 'Maya', system: 'Linear' }),
    ).toBe(
      'IT has connected Linear. Maya can use its own Linear app instead of the pasted key, which keeps working until you move it.',
    );
  });

  it("says a delegated target as acting as the manager, never as the employee's own app (code pass, M5)", (): void => {
    expect(
      moveOfferWords(
        { kind: 'delegated', planned: true },
        { employee: 'Maya', system: 'Acme docs' },
      ),
    ).toBe(
      'IT has connected Acme docs. Maya can act as you there instead of the pasted key, which keeps working until you move it.',
    );
  });
});

describe("the latest re-join after a Slack renewal (11-AC's item 5)", (): void => {
  const AFTER = { joined: ['#revops'], needsPerson: ['#revops-leads'], at: 20 };

  it('says what the bot re-joined itself and which channels need a person to add it', (): void => {
    expect(rejoinWords(AFTER, 'Leo', 10)).toBe(
      'After the renewal, Leo rejoined #revops itself; #revops-leads needs someone in it to add Leo.',
    );
    expect(
      rejoinWords(
        { joined: ['#revops', '#sales'], needsPerson: ['#leads', '#finance'], at: 20 },
        'Leo',
        10,
      ),
    ).toBe(
      'After the renewal, Leo rejoined #revops and #sales itself; #leads and #finance need someone in each to add Leo.',
    );
    expect(
      rejoinWords(
        { joined: [], needsPerson: ['#leads'], reason: 'restricted_action', at: 20 },
        'Leo',
        10,
      ),
    ).toBe(
      'After the renewal, #leads needs someone in it to add Leo. Slack said: restricted_action.',
    );
  });

  it('says nothing of a re-join older than the install the card holds now, or of none', (): void => {
    expect(rejoinWords(AFTER, 'Leo', 30)).toBeUndefined();
    expect(rejoinWords(undefined, 'Leo', 10)).toBeUndefined();
    expect(rejoinWords({ joined: [], needsPerson: [], at: 20 }, 'Leo', 10)).toBeUndefined();
  });
});
