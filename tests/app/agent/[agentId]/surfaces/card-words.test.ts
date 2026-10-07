import { describe, expect, it } from 'vitest';
import { ACTS_AS_KINDS } from '../../../../../src/surfaces/access-identity';
import { issuerKindFor } from '../../../../../src/surfaces/access-request';
import { cardIdentity } from '../../../../../src/surfaces/card-identity';
import {
  forgottenAppWords,
  forgetDoneWords,
  accessStanding,
  actsAsWords,
  connectedForOrganisationWords,
  decisionButtonsWords,
  decisionErrorWords,
  typedCodeWords,
  disconnectLines,
  documentedKeyUnusedWords,
  expectedCredential,
  identityChip,
  moveOfferWords,
  NOT_REINSTALLED_ACCESS,
  NOT_REINSTALLED_ACTS_AS,
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

describe('where decisions reach the manager, on a Slack card (wave 12, 12-M; RM3)', (): void => {
  // Re-pinned for the wave 12 review: the card no longer says the buttons are on whether the
  // bridge runs or not (W12-R16, D-6 (b)), nor that a request asked before they were on has them
  // (W12-R10). Re-pinned again for 13-FS: the card reads the bridge's heartbeat, so it says what
  // it knows (a live connection for the app) rather than a condition it could not read.
  it('says buttons are on while the socket service holds a live connection for the app, with the typed code beside them', (): void => {
    const words = decisionButtonsWords({ available: true }, 'Mateo (Day0)');
    expect(words.title).toBe('Decisions in Slack: buttons are on');
    expect(words.note).toBe(
      // Re-worded for the design pass: the card reads the bridge's last report, not a live one.
      'The Slack socket service last reported a live connection for Mateo (Day0), so each new request to you arrives with Approve and Reject buttons and a typed code. Either one decides it, and the typed code still decides it if a button press does not get through.',
    );
    expect(words.asksForToken).toBe(false);
    expect(words.offersReplacement).toBe(true);
  });

  it('names the socket token an app without one needs, and asks for it', (): void => {
    const words = decisionButtonsWords(
      { available: false, why: 'no-app-level-token' },
      'Mateo (Day0)',
    );
    expect(words.title).toBe("Buttons: needs this app's socket token");
    // Re-pinned for W12V-4: an app Day0 created from its manifest has Socket Mode on already, so
    // the card tells nobody to turn it on; an older app's Enable Socket Mode makes the token itself
    // (the walk's row 15).
    expect(words.note).toBe(
      "Requests reach you with a typed code only. To add Approve and Reject buttons, someone who manages Mateo (Day0) in Slack makes its app-level token, with the connections:write scope, and pastes it below. In the app's settings, if Socket Mode is on (every app Day0 creates from v0.17.0), that is Basic Information, App-Level Tokens, Generate Token and Scopes; if it is off (an app created earlier may have it off), turning on Enable Socket Mode makes the token in the same dialog.",
    );
    expect(words.note).not.toContain('turns on Socket Mode');
    expect(words.asksForToken).toBe(true);
  });

  it('says the buttons are off while the socket service reports no live connection for the app (D-6 (b))', (): void => {
    const words = decisionButtonsWords({ available: false, why: 'bridge-down' }, 'Mateo (Day0)');
    expect(words.title).toBe('Buttons: off until the Slack socket service connects');
    expect(words.note).toBe(
      // Re-worded on the bed: a bridge that stops cleanly reports the app down at once, so the note
      // says what the card knows (no live connection reported lately), not a fixed window.
      'The app-level token of Mateo (Day0) is stored, but the Slack socket service that carries a press has not reported a live connection for it lately, so requests reach you with a typed code only. Buttons come back on new requests once the service reports one again. If they stay off, ask whoever runs this deployment to check the service: pnpm check:access says what is wrong in its socket row.',
    );
    expect(words.asksForToken).toBe(false);
    expect(words.offersReplacement).toBe(true);
    expect(
      decisionButtonsWords({ available: false, why: 'bridge-down' }, 'Iris (Day0)', false).note,
    ).toContain(
      'so requests reach you with no buttons, and with no typed code until Iris (Day0) takes messages: decide them in day0.',
    );
  });

  it('says why the requests carry the typed code alone otherwise, asking for nothing', (): void => {
    for (const buttons of [
      { available: false, why: 'no-bridge', tokenStored: true },
      { available: false, why: 'no-bridge', tokenStored: false },
      { available: false, why: 'no-own-app' },
      { available: false, why: 'not-slack-api' },
    ] as const) {
      const words = decisionButtonsWords(buttons, 'Mateo (Day0)');
      expect(`${words.title} ${words.note}`, buttons.why).toContain('typed code');
      expect(words.asksForToken, buttons.why).toBe(false);
    }
    expect(
      decisionButtonsWords(
        { available: false, why: 'no-bridge', tokenStored: true },
        'Mateo (Day0)',
      ).title,
    ).toBe('Buttons: needs the Slack socket service');
  });

  it('names no typed code for an app that takes no messages, whatever carries the buttons (W12V-7)', (): void => {
    const on = decisionButtonsWords({ available: true }, 'Iris (Day0)', false);
    expect(on.note).toBe(
      'The Slack socket service last reported a live connection for Iris (Day0), so each new request to you arrives with Approve and Reject buttons. Slack does not let you message Iris (Day0) yet, so no typed code reaches it: if a press does not get through, decide in day0.',
    );
    const noToken = decisionButtonsWords(
      { available: false, why: 'no-app-level-token' },
      'Iris (Day0)',
      false,
    );
    expect(
      noToken.note.startsWith(
        'Requests reach you with no buttons and no typed code, so you decide them in day0.',
      ),
    ).toBe(true);
    const noBridge = decisionButtonsWords(
      { available: false, why: 'no-bridge', tokenStored: true },
      'Iris (Day0)',
      false,
    );
    expect(noBridge.note).toContain(
      'so requests reach you with no buttons, and with no typed code until Iris (Day0) takes messages: decide them in day0.',
    );
    for (const words of [on, noToken, noBridge]) {
      expect(words.note).not.toMatch(/typed code (only|still decides|alone)/);
    }
  });

  it('asks for no token while the socket service is missing, and says the token comes after it (W12-R18)', (): void => {
    const words = decisionButtonsWords(
      { available: false, why: 'no-bridge', tokenStored: false },
      'Mateo (Day0)',
    );
    expect(words.title).toBe('Buttons: needs the Slack socket service');
    expect(words.note).toBe(
      'This deployment does not run the Slack socket service that carries a press, so requests reach you with a typed code only. Ask whoever runs this deployment to run ./setup.sh again; that starts the service, and this card then asks for the app-level token of Mateo (Day0).',
    );
    expect(words.asksForToken).toBe(false);
  });
});

describe('whether the typed code reaches the app, on a Slack card (W12V-7)', (): void => {
  it('says nothing while the app takes messages', (): void => {
    expect(typedCodeWords({ state: 'open' })).toBeUndefined();
  });

  it('says Day0 opens the messages tab at the next check, and the toggle if it stays off', (): void => {
    expect(typedCodeWords({ state: 'day0-opens', appName: 'Iris (Day0)' })).toEqual({
      title: 'Typed code: off until this app takes messages',
      note: 'Slack does not let you message Iris (Day0) yet, so no typed code reaches it. Day0 tries to open its messages tab at this card’s next check, or now if you press Check the connection. If it stays off, someone who manages Iris (Day0) in Slack turns on App Home, “Allow users to send Slash commands and messages from the messages tab”, and you say so here.',
      confirm: 'It is on in Slack',
    });
  });

  it('says Slack refused Day0’s opening, that Day0 tries again only when asked, and the toggle (13-FS)', (): void => {
    expect(
      typedCodeWords({
        state: 'refused',
        appName: 'Iris (Day0)',
        reason: 'Slack apps.manifest.update failed: invalid_manifest',
      }),
    ).toEqual({
      title: 'Typed code: off until this app takes messages',
      // Re-worded for the design pass: no doubled brackets, and the two ways out side by side.
      note: 'Slack would not let Day0 open the messages tab of Iris (Day0), so no typed code reaches it. Slack’s answer: Slack apps.manifest.update failed: invalid_manifest. Press Check the connection for Day0 to try again, or have someone who manages Iris (Day0) in Slack turn on App Home, “Allow users to send Slash commands and messages from the messages tab”, and say so here.',
      confirm: 'It is on in Slack',
    });
  });

  it('names the app and the one toggle a person turns on where Day0 cannot change the app', (): void => {
    expect(typedCodeWords({ state: 'needs-toggle', appName: 'Otto (Day0)' })).toEqual({
      title: 'Typed code: off until this app takes messages',
      note: 'Slack does not let you message Otto (Day0) yet, so no typed code reaches it, and Day0 cannot change this app’s settings. Someone who manages Otto (Day0) in Slack turns on App Home, “Allow users to send Slash commands and messages from the messages tab”; then say so here.',
      confirm: 'It is on in Slack',
    });
  });
});

describe('a Slack card whose own app is not installed again (W12X-4)', (): void => {
  it('acts as nobody, says nothing goes through it and reads as ended, whatever it waited on', (): void => {
    expect(NOT_REINSTALLED_ACTS_AS).toBe('nobody');
    expect(NOT_REINSTALLED_ACCESS).toBe('Nothing is read or sent through this card.');
    const card = {
      displayName: 'Slack',
      verdict: 'approved',
      managerApprovedAt: 1,
      expiresAt: Date.UTC(2027, 0, 3),
    } as unknown as WordedSurface;
    for (const waitsOn of [undefined, 'it', 'connect'] as const) {
      expect(
        stateChip(card, Date.UTC(2026, 9, 5), 'UTC', { waitsOn, notReinstalled: true }),
      ).toEqual({
        text: 'Ended',
        tone: 'warn',
      });
    }
  });
});

describe('the app a forget names (13-S)', (): void => {
  it('names it by its Slack app id beside its name, since the new app takes the same name', (): void => {
    expect(forgottenAppWords({ appId: 'A0LEO', appName: 'Leo (Day0)' })).toBe(
      'Leo (Day0) (Slack app A0LEO)',
    );
    expect(forgottenAppWords(undefined)).toBe('The app');
  });
});

describe("a failing manager decision poll in the manager's words (W13-R1)", (): void => {
  it('says a history refusal as a typed code Day0 cannot read, and to decide in day0', (): void => {
    for (const method of ['conversations.history', 'conversations.replies']) {
      expect(
        decisionErrorWords(
          `decision poll failed: Connected Slack surface does not allow ${method}.`,
        ),
      ).toBe(
        "Day0 cannot read a code you type in Slack, because the documentation's Slack page does not let it read your messages there. Decide in day0 until it does.",
      );
    }
  });

  it('passes any other failure through as the poll gave it', (): void => {
    expect(decisionErrorWords('decision poll failed: Slack returned HTTP 502.')).toBe(
      'decision poll failed: Slack returned HTTP 502.',
    );
  });
});

describe('what the forget says of the requests the old app sent (W13-R16)', (): void => {
  it('says a request it already sent is no longer decided in its messages, and where to decide it', (): void => {
    expect(forgetDoneWords({ appId: 'A0LEO', appName: 'Leo (Day0)' })).toBe(
      "Leo (Day0) (Slack app A0LEO) is forgotten. IT deletes it in Slack's app settings. Until then its app-level token, which Day0 no longer holds, still works at Slack. A request it already sent can no longer be decided in its own messages: decide it in day0.",
    );
  });
});
