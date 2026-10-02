import { describe, expect, it } from 'vitest';
import {
  accessRequestReason,
  draftAccessRequest,
  isOrganisationSystemKey,
  mcpSystemKey,
  organisationConnectedRefusal,
  organisationSystemOf,
} from '../../../src/surfaces/access-request';

describe('the organisation system a key names (the access plan, section 4.1)', (): void => {
  it('takes a plain lower-case system or an MCP server by host', (): void => {
    for (const key of ['slack', 'linear', 'github', 'google-workspace', 'mcp:mcp.notion.com']) {
      expect(isOrganisationSystemKey(key), key).toBe(true);
    }
  });

  it('refuses anything else: case, spaces, a URL, an empty host or a bare prefix', (): void => {
    for (const key of [
      '',
      'Slack',
      'slack ',
      'https://slack.com',
      'mcp:',
      'mcp:https://mcp.notion.com',
      'mcp:MCP.notion.com',
      'linear:read',
      '-slack',
    ]) {
      expect(isOrganisationSystemKey(key), key).toBe(false);
    }
  });
});

describe('one MCP system key, for the cards, the connections and the kit', (): void => {
  it('keeps a non-default port, since two MCP servers on one host are two systems', (): void => {
    expect(organisationSystemOf({ path: 'mcp', endpoint: 'https://mcp.acme.com:8443/mcp' })).toBe(
      'mcp:mcp.acme.com:8443',
    );
    expect(mcpSystemKey(new URL('https://MCP.Acme.com:8443/mcp'))).toBe('mcp:mcp.acme.com:8443');
    expect(isOrganisationSystemKey('mcp:mcp.acme.com:8443')).toBe(true);
  });

  it('drops the default port, which names the same server as no port', (): void => {
    expect(organisationSystemOf({ path: 'mcp', endpoint: 'https://mcp.acme.com:443/mcp' })).toBe(
      'mcp:mcp.acme.com',
    );
    expect(mcpSystemKey(new URL('https://mcp.acme.com:443/mcp'))).toBe('mcp:mcp.acme.com');
  });

  it('keys an endpoint the same way whichever reader keys it, its case and trailing dot aside', (): void => {
    for (const endpoint of [
      'https://MCP.Acme.com/sse',
      'https://mcp.acme.com.:9000/mcp',
      'https://10.1.2.3:8443/mcp',
    ]) {
      const system = organisationSystemOf({ path: 'mcp', endpoint });
      expect(system, endpoint).toBe(mcpSystemKey(new URL(endpoint)));
      expect(isOrganisationSystemKey(system ?? ''), endpoint).toBe(true);
    }
  });

  it('refuses a key no endpoint produces: the default port, port zero, a padded or out-of-range port', (): void => {
    for (const key of [
      'mcp:mcp.acme.com:443',
      'mcp:mcp.acme.com:0',
      'mcp:mcp.acme.com:08443',
      'mcp:mcp.acme.com:65536',
      'mcp:mcp.acme.com:',
      'mcp::8443',
    ]) {
      expect(isOrganisationSystemKey(key), key).toBe(false);
    }
  });
});

describe('the organisation system a card needs', (): void => {
  const card = { path: 'documented-api' };

  it('reads Slack off the Web API base and Linear off its hosts, whatever the slug', (): void => {
    expect(organisationSystemOf({ ...card, endpoint: 'https://slack.com/api/' })).toBe('slack');
    expect(organisationSystemOf({ ...card, endpoint: 'https://api.linear.app/graphql' })).toBe(
      'linear',
    );
    expect(organisationSystemOf({ ...card, endpoint: 'https://mcp.linear.app/mcp' })).toBe(
      'linear',
    );
  });

  it('reads the systems the kit knows by their API hosts', (): void => {
    expect(organisationSystemOf({ ...card, endpoint: 'https://api.github.com/repos' })).toBe(
      'github',
    );
    expect(organisationSystemOf({ ...card, endpoint: 'https://acme.atlassian.net/rest' })).toBe(
      'atlassian',
    );
    expect(organisationSystemOf({ ...card, endpoint: 'https://api.notion.com/v1' })).toBe('notion');
    expect(organisationSystemOf({ ...card, endpoint: 'https://graph.microsoft.com/v1.0' })).toBe(
      'microsoft',
    );
    expect(organisationSystemOf({ ...card, endpoint: 'https://sheets.googleapis.com/v4' })).toBe(
      'google',
    );
  });

  it('names any other MCP server by its host, and a look-alike host as nobody’s', (): void => {
    expect(
      organisationSystemOf({ ...card, path: 'mcp', endpoint: 'https://mcp.Example.com/sse' }),
    ).toBe('mcp:mcp.example.com');
    expect(
      organisationSystemOf({ ...card, endpoint: 'https://api.linear.app.evil.test/graphql' }),
    ).toBeUndefined();
    // A fully qualified host's trailing dot names the same host, Slack's API base included.
    expect(organisationSystemOf({ ...card, endpoint: 'https://slack.com./api/' })).toBe('slack');
    expect(organisationSystemOf({ ...card, endpoint: 'https://api.linear.app./graphql' })).toBe(
      'linear',
    );
    expect(
      organisationSystemOf({ ...card, path: 'mcp', endpoint: 'https://mcp.acme.test./mcp' }),
    ).toBe('mcp:mcp.acme.test');
    expect(organisationSystemOf({ ...card, endpoint: 'https://slack.com.evil.test/api/' })).toBe(
      undefined,
    );
  });

  it('names no system for a card with no endpoint, one it cannot parse, or a host the kit does not know', (): void => {
    expect(organisationSystemOf(card)).toBeUndefined();
    expect(organisationSystemOf({ ...card, endpoint: 'not a url' })).toBeUndefined();
    expect(
      organisationSystemOf({ ...card, endpoint: 'https://intranet.acme.test/api' }),
    ).toBeUndefined();
  });
});

describe('the refusal of a pasted key on a system the organisation connected', (): void => {
  it('names the system and says nothing was stored', (): void => {
    expect(organisationConnectedRefusal('Linear')).toBe(
      'Linear is connected for your organisation by IT, so this card connects through that connection, never a pasted key. Nothing was stored.',
    );
  });
});

describe('when a card asks IT for access instead of offering Connect (A24)', (): void => {
  const linearCard = {
    slug: 'linear',
    displayName: 'Linear',
    endpoint: 'https://api.linear.app/graphql',
    managerApprovedAt: 1,
  };
  const linear = {
    system: 'linear',
    displayName: 'Linear',
    kind: 'oauth-app' as const,
    mode: 'shared' as const,
    scopes: ['read', 'write'],
  };

  it('asks when the system has no connection, or a per-employee one IT must install', (): void => {
    expect(accessRequestReason(linearCard, null)).toBe('no-connection');
    expect(accessRequestReason(linearCard, { ...linear, mode: 'per-employee' })).toBe(
      'install-needed',
    );
    expect(accessRequestReason(linearCard, linear)).toBeUndefined();
  });

  it('asks for a per-employee app only until an administrator records it, then offers Connect and never a lapsed link', (): void => {
    const perEmployee = { ...linear, mode: 'per-employee' as const };
    expect(accessRequestReason(linearCard, perEmployee)).toBe('install-needed');
    const recorded = {
      ...linearCard,
      provisioning: {
        clientId: 'leo-app',
        installUrl: 'https://linear.app/oauth/authorize?client_id=leo-app',
      },
    };
    expect(accessRequestReason(recorded, perEmployee)).toBeUndefined();
  });

  it('asks nothing of an MCP card whose server is connected: its manager authorises it (AM6)', (): void => {
    const mcpCard = {
      slug: 'docs',
      displayName: 'Acme docs',
      path: 'mcp',
      endpoint: 'https://mcp.acme.com:8443/mcp',
      managerApprovedAt: 1,
    };
    const server = {
      system: 'mcp:mcp.acme.com:8443',
      displayName: 'mcp.acme.com',
      kind: 'mcp-client' as const,
      mode: 'per-employee' as const,
      scopes: [],
    };
    expect(accessRequestReason(mcpCard, server)).toBeUndefined();
    expect(accessRequestReason(mcpCard, null)).toBe('no-connection');
  });

  it('asks for a scope the registration does not hold, when the card names the scopes it needs', (): void => {
    expect(accessRequestReason(linearCard, linear, ['read', 'issues:create'])).toBe(
      'scope-widening',
    );
    expect(accessRequestReason(linearCard, linear, ['read'])).toBeUndefined();
  });

  it('asks Slack’s per-employee connection only for an install link Day0 cannot follow itself', (): void => {
    const slackCard = {
      slug: 'slack',
      displayName: 'Slack',
      endpoint: 'https://slack.com/api/',
      managerApprovedAt: 1,
    };
    const slack = {
      system: 'slack',
      displayName: 'Slack',
      kind: 'slack-configuration' as const,
      mode: 'per-employee' as const,
      scopes: ['chat:write'],
    };
    expect(accessRequestReason(slackCard, slack)).toBeUndefined();
    expect(
      accessRequestReason(
        { ...slackCard, provisioning: { installUrl: 'https://slack.com/oauth/v2/authorize?x=1' } },
        slack,
      ),
    ).toBe('install-needed');
  });

  it("asks nothing of an ended Slack card whose own app is installed: its reinstall is the card's own click (11-AC's cockpit item 9)", (): void => {
    expect(
      accessRequestReason(
        {
          slug: 'slack',
          displayName: 'Slack',
          endpoint: 'https://slack.com/api/',
          managerApprovedAt: 1,
          provisioning: {
            installUrl: 'https://slack.com/oauth/v2/authorize?x=1',
            installedAt: 2,
          },
        },
        {
          system: 'slack',
          displayName: 'Slack',
          kind: 'slack-configuration',
          mode: 'per-employee',
          scopes: ['chat:write'],
        },
      ),
    ).toBeUndefined();
  });

  it('never asks for a card not yet approved, one holding a credential, or one on no organisation system', (): void => {
    expect(accessRequestReason({ ...linearCard, managerApprovedAt: undefined }, null)).toBe(
      undefined,
    );
    expect(accessRequestReason({ ...linearCard, credentialId: 'c1' }, null)).toBeUndefined();
    expect(
      accessRequestReason({ ...linearCard, endpoint: 'https://intranet.acme.test/api' }, null),
    ).toBeUndefined();
  });
});

describe('the access request’s words, the same wherever they are shown', (): void => {
  const card = {
    _id: 'j57card',
    slug: 'linear',
    displayName: 'Linear',
    endpoint: 'https://api.linear.app/graphql',
    managerApprovedAt: 1,
    expiresAt: Date.UTC(2026, 11, 31, 12),
    request: { scopeRequested: ['linear:read', 'linear:write'] },
    discoveryEvidence: [
      { quote: 'Linear is the formal work queue', current: true },
      { quote: 'An old line no page says now', current: false },
      { quote: 'Tickets are triaged every morning', current: true },
    ],
  };
  const base = {
    card,
    connection: null,
    reason: 'no-connection' as const,
    employeeName: 'Maya',
    zone: 'UTC',
  };

  it('carries the system, the scopes, the evidence, the length and how IT connects it', (): void => {
    const draft = draftAccessRequest({ ...base, publicUrl: 'https://day0.acme.test/' });
    expect(draft).toMatchObject({
      system: 'linear',
      reason: 'no-connection',
      scopes: ['linear:read', 'linear:write'],
      subject: 'Day0 access request: Linear for Maya',
    });
    expect(draft.text).toBe(
      [
        'Maya, a Day0 employee, needs access to Linear; Maya’s manager approved it and asks IT to connect it.',
        'Linear is not connected for the organisation yet: an administrator connects it once, and every employee’s card then uses that connection.',
        'Access needed: linear:read, linear:write.',
        'Why Maya needs it, from the team’s documentation: “Linear is the formal work queue”; “Tickets are triaged every morning”.',
        'For how long: until 31 December 2026.',
        'How to connect it: an administrator runs ./setup.sh access for linear, following docs/running/access-linear.md, or uses the organisation page at https://day0.acme.test/organisation.',
        'Nothing changes until IT connects it; then Connect appears on Maya’s card.',
      ].join('\n'),
    );
    expect(draft.mailto).toBe(
      `mailto:?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.text)}`,
    );
  });

  it('gives the install link for an app IT must install, and the default length for a card on no clock', (): void => {
    const draft = draftAccessRequest({
      ...base,
      card: {
        ...card,
        expiresAt: undefined,
        discoveryEvidence: [],
        provisioning: { installUrl: 'https://linear.app/oauth/authorize?client_id=leo' },
      },
      reason: 'install-needed',
      connection: {
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'per-employee',
        scopes: ['read'],
      },
    });
    expect(draft.text).toContain(
      'Linear is connected for each employee, and Maya’s own app needs an administrator to install it.',
    );
    expect(draft.text).toContain('For how long: 90 days from approval, renewed by the manager.');
    expect(draft.text).toContain(
      'How to connect it: install it here: https://linear.app/oauth/authorize?client_id=leo',
    );
    expect(draft.text).not.toContain('documentation:');
  });

  it("names the card on the organisation page for an employee's own Linear app IT must create and record, never the setup verb (M4)", (): void => {
    const draft = draftAccessRequest({
      ...base,
      publicUrl: 'https://day0.acme.test/',
      reason: 'install-needed',
      connection: {
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'per-employee',
        scopes: ['read', 'write'],
      },
    });
    expect(draft.text).toContain(
      'How to connect it: a Linear administrator creates Maya’s own app as docs/running/access-linear.md says, then records it on the organisation page at https://day0.acme.test/organisation?card=j57card; Day0 then opens Linear to install it.',
    );
    expect(draft.text).not.toContain('./setup.sh');
    const noOrigin = draftAccessRequest({
      ...base,
      reason: 'install-needed',
      connection: {
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'per-employee',
        scopes: ['read', 'write'],
      },
    });
    expect(noOrigin.text).toContain('on the organisation page at /organisation?card=j57card;');
  });

  it('never names the setup verb for a system already connected for the organisation (M4)', (): void => {
    const widening = draftAccessRequest({
      ...base,
      publicUrl: 'https://day0.acme.test',
      reason: 'scope-widening',
      scopes: ['issues:create'],
      connection: {
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'shared',
        scopes: ['read'],
      },
    });
    expect(widening.text).not.toContain('./setup.sh');
    expect(widening.text).toContain(
      'How to connect it: an administrator follows docs/running/access-linear.md, on the organisation page at https://day0.acme.test/organisation.',
    );
  });

  it('names the scopes the registration lacks for a widening, and the MCP recipe for a server', (): void => {
    const widening = draftAccessRequest({
      ...base,
      reason: 'scope-widening',
      scopes: ['issues:create'],
      connection: {
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'shared',
        scopes: ['read'],
      },
    });
    expect(widening.scopes).toEqual(['issues:create']);
    expect(widening.text).toContain(
      'Maya’s card needs scopes Linear’s connection does not hold yet.',
    );
    expect(widening.text).toContain('Access needed: issues:create.');
    const mcp = draftAccessRequest({
      ...base,
      card: { ...card, endpoint: 'https://mcp.acme.test/mcp', path: 'mcp', displayName: 'Wiki' },
    });
    expect(mcp.system).toBe('mcp:mcp.acme.test');
    expect(mcp.text).toContain(
      './setup.sh access for mcp:mcp.acme.test, following docs/running/access-mcp.md',
    );
  });

  it('clips a long quote and keeps three at most', (): void => {
    const long = 'x'.repeat(300);
    const draft = draftAccessRequest({
      ...base,
      card: {
        ...card,
        discoveryEvidence: [1, 2, 3, 4].map((n) => ({ quote: `${n} ${long}`, current: true })),
      },
    });
    const quoted = draft.text.split('\n')[3];
    expect(quoted.match(/“/g)).toHaveLength(3);
    expect(quoted).not.toContain('4 x');
    expect(quoted.length).toBeLessThan(700);
  });
});
