import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  credentialStatusLine,
  SurfaceCard,
  type AccessRequestView,
  type ListedSurface,
  type SurfaceCardActions,
  type SurfaceCardContext,
} from '../../../../../app/agent/[agentId]/surfaces/SurfaceCard';
import { AgentZoneContext } from '../../../../../app/components/time';
import { issuerKindFor } from '../../../../../src/surfaces/access-request';
import type { OrganisationSystem } from '../../../../../app/agent/[agentId]/surfaces/card-words';
import { withListedIdentity } from './fakes/listed-identity';

const DAY = 24 * 60 * 60 * 1000;
/** 29 Sep 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 8, 29, 12);

const context: SurfaceCardContext = {
  now: NOW,
  sourceLabels: new Map(),
  credentials: new Map(),
  installRedirectConfigured: false,
  browserPresent: true,
  employeeName: 'Maya',
  organisation: new Map(),
  managerDmReachable: false,
};

const actions: SurfaceCardActions = {
  approve: (): void => undefined,
  reject: (): void => undefined,
  probe: (): void => undefined,
  land: (): void => undefined,
  provision: (): void => undefined,
  landSocketToken: (): void => undefined,
  confirmMessagesTab: (): void => undefined,
  setDays: async () => ({ expiresAt: NOW + 90 * DAY }),
  approveTools: async () => undefined,
  disconnect: async () => undefined,
  draftAccessRequest: async () => undefined,
  recordAccessRequestSent: async () => undefined,
};

/** A listed surface with the fields a card state needs. */
function listed(fields: Partial<ListedSurface>): ListedSurface {
  return {
    _id: 'surface-linear',
    _creationTime: 1,
    agentId: 'agent-1',
    slug: 'linear',
    displayName: 'Linear',
    class: 'kanban',
    verdict: 'proposed',
    path: 'mcp',
    endpoint: 'https://mcp.linear.app/mcp',
    whereFound: [],
    credentialLanded: false,
    createdAt: 1,
    ...fields,
  } as ListedSurface;
}

/** One card rendered in the employee's zone, with the entities React escapes read back. */
function render(
  surface: ListedSurface,
  overrides: Partial<SurfaceCardContext> = {},
  extra: { accessRequest?: AccessRequestView | null; connect?: () => void } = {},
): string {
  const cardContext = { ...context, ...overrides };
  return renderToStaticMarkup(
    <AgentZoneContext value="UTC">
      <SurfaceCard
        surface={withListedIdentity(surface, cardContext)}
        context={cardContext}
        operation={undefined}
        actions={{ ...actions, ...(extra.connect ? { connect: extra.connect } : {}) }}
        accessRequest={extra.accessRequest}
      />
    </AgentZoneContext>,
  ).replace(/&#x27;/g, "'");
}

/** The card's state chip, by its classes. */
function chip(markup: string): string | undefined {
  return /<span class="inline-flex h-\[22px\][^"]*">([^<]*)<\/span>/.exec(markup)?.[1];
}

describe('a surface card in each of its states (round two section 3.9)', (): void => {
  it('proposed: one Approve, the manager as the one approver, and no access clock yet', (): void => {
    const markup = render(
      listed({ request: { blastRadius: 'read only, one team', scopeRequested: ['read:issues'] } }),
    );
    expect(chip(markup)).toBe('Proposed · MCP');
    expect(markup).toContain('data-verdict="proposed"');
    expect(markup.match(/<button[^>]*>Approve<\/button>/g)).toHaveLength(1);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(markup).toContain('You approve; there is no second approver.');
    expect(markup).toMatch(/Blast radius<\/dt><dd[^>]*>read only, one team<\/dd>/);
    expect(markup).not.toContain('Access lasts until');
  });

  it('connected: the rung it is reached on, who approved it, and the expiry block', (): void => {
    const markup = render(
      listed({
        verdict: 'connected',
        credentialLanded: true,
        managerApprovedAt: Date.UTC(2026, 8, 26, 14, 24),
        expiresAt: Date.UTC(2026, 11, 25, 14, 24),
        accessSetBy: 'approval',
        toolAllowlist: ['list_issues'],
      }),
    );
    expect(chip(markup)).toBe('Connected over MCP');
    expect(markup).toContain('border-[var(--color-ok-line)]');
    expect(markup).toContain(
      'Approved</dt><dd class="min-w-0 text-sm break-words text-[var(--color-fg-2)]">by you, <time dateTime="2026-09-26T14:24:00.000Z">26 Sep 2026, 14:24</time>. You approve; there is no second approver.</dd>',
    );
    expect(markup).toContain('>Access lasts until</p>');
    expect(markup).toContain('25 Dec 2026, 14:24</time> (set when you approved the card).');
    expect(markup).toContain('a working probe never extends it.');
    expect(markup).toMatch(/>Renew for 90 days<\/button>/);
    expect(markup).toMatch(/>Check the connection<\/button>/);
    expect(markup).not.toMatch(/>Approve<\/button>/);
  });

  it('expiring: the days left on the chip, the card in the warn tone, the renewal first', (): void => {
    const markup = render(
      listed({
        verdict: 'connected',
        credentialLanded: true,
        managerApprovedAt: NOW - 84 * DAY,
        expiresAt: NOW + 6 * DAY,
        accessSetBy: 'approval',
      }),
    );
    expect(chip(markup)).toBe('Expires in 6 days');
    expect(markup).toContain('border-[var(--color-warn-line)]');
    expect(markup).toContain(
      'After that, nothing is read or sent through this card until you renew it.',
    );
    expect(markup).toMatch(
      /border-\[var\(--color-accent\)\] bg-\[var\(--color-accent\)\][^"]*">Renew for 90 days<\/button>/,
    );
  });

  it('expired: access ended, said as ended, with the renewal that brings it back', (): void => {
    const markup = render(
      listed({
        verdict: 'approved',
        reason: 'expired',
        credentialLanded: false,
        managerApprovedAt: NOW - 100 * DAY,
        expiresAt: NOW - 10 * DAY,
        accessSetBy: 'approval',
      }),
    );
    expect(chip(markup)).toBe('Access ended');
    expect(markup).toContain('>Access ended</p>');
    expect(markup).toContain('Nothing is read or sent through this card until you renew it.');
    // The sweep's `expired` is said by the block, not printed as a bare reason.
    expect(markup).not.toContain('>expired<');
    expect(markup).toMatch(/>Renew for 90 days<\/button>/);
  });

  it('browser rung: proposed in a browser, and once approved the field names the sign-in it takes', (): void => {
    const looker = {
      slug: 'looker-pipeline-tile',
      displayName: 'Looker pipeline tile',
      class: 'analytics',
      path: 'browser-driven',
      endpoint: 'http://looker-tile:8080/',
      request: {
        credential: {
          found: 'location',
          label: 'looker pipeline tile dashboard login',
          location: 'Looker / Access',
        },
      },
      credentialLocation: 'Looker / Access',
    } as Partial<ListedSurface>;
    const proposed = render(listed(looker));
    expect(chip(proposed)).toBe('Proposed · browser');
    expect(proposed).toContain(
      'Once you approve, the card asks for the looker pipeline tile dashboard login the browser session signs in with.',
    );
    expect(proposed).not.toContain('type="password"');

    const approved = render(
      listed({ ...looker, verdict: 'approved', managerApprovedAt: NOW - DAY }),
    );
    expect(chip(approved)).toBe('Needs its credential');
    expect(approved).toContain(
      '>The looker pipeline tile dashboard login the browser session signs in with</label>',
    );
    expect(approved).toMatch(/<input id="credential-[^"\s]+" type="password"/);
    expect(approved).toContain("types it only into the sign-in form's credential field");
  });

  it('refused: Approve disabled with the reason the server gives, beside it (E-63)', (): void => {
    const refusal =
      'A documented intake queue changed; reject this card and re-run orientation before approval.';
    const markup = render(listed({ approvalRefusal: refusal }));
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(markup).toContain(`${refusal}</p>`);
    expect(markup).toMatch(/aria-describedby="[^"]+"[^>]*>Approve<\/button>/);
    expect(markup).toMatch(/<button[^>]*>Reject<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Reject<\/button>/);
  });

  it('refused for an absent browser component: said once, in words, not by its code', (): void => {
    const markup = render(
      listed({
        path: 'browser-driven',
        approvalRefusal: 'BROWSER_DRIVER_ABSENT: day0 has no browser component',
      }),
      { browserPresent: false },
    );
    expect(markup.match(/This system is reached through its web UI\./g)).toHaveLength(1);
    expect(markup).not.toContain('BROWSER_DRIVER_ABSENT');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    // Said beside the disabled control, which names it as its description (review L9).
    const reason = /aria-describedby="([^"]+)"[^>]*>Approve<\/button>/.exec(markup)?.[1];
    expect(markup).toMatch(
      new RegExp(`<p id="${reason}"[^>]*>This system is reached through its web UI\\.`),
    );
  });

  it('carries the id, the verdict and the name the rehearsal driver and focus return read', (): void => {
    // The card is the one section, named by its heading: no article wrapped around it (m29).
    expect(render(listed({}))).toMatch(
      /^<section id="surface-linear" aria-labelledby="[^"]+" tabindex="-1" data-verdict="proposed"/,
    );
    expect(render(listed({}))).not.toContain('<article');
  });

  it('draws no empty facts list for a declared card', (): void => {
    const markup = render(listed({ verdict: 'declared', path: undefined, endpoint: undefined }));
    expect(chip(markup)).toBe('No proposal yet');
    expect(markup).not.toContain('<dl');
  });
});

describe("the stored credential's status (U19 D5)", (): void => {
  it('says what the store says of a credential that is not simply live, with its reason', (): void => {
    expect(
      credentialStatusLine({
        status: 'superseded',
        statusReason: 'No longer detected in synced documentation.',
      }),
    ).toBe('Superseded: No longer detected in synced documentation.');
    expect(credentialStatusLine({ status: 'suspect', statusReason: 'rotated on the page' })).toBe(
      'Suspect: rotated on the page.',
    );
    expect(credentialStatusLine({ revokedAt: 5, statusReason: undefined })).toBe('Revoked.');
    expect(credentialStatusLine({})).toBeUndefined();
    expect(credentialStatusLine(undefined)).toBeUndefined();
  });
});

/** The organisation's connections a manager's summary lists, by system. */
function organisation(
  ...systems: Array<Partial<OrganisationSystem> & Pick<OrganisationSystem, 'system'>>
) {
  return new Map(
    systems.map((fields): [string, OrganisationSystem] => [
      fields.system,
      {
        displayName: fields.system.charAt(0).toUpperCase() + fields.system.slice(1),
        // The kind an issuer acts through for the system, else a static key (D6).
        kind: issuerKindFor(fields.system) ?? 'static-key',
        mode: 'per-employee',
        status: 'active',
        connectedAt: Date.UTC(2026, 9, 1, 9),
        ...fields,
      },
    ]),
  );
}

/** The card's facts' labels, in the order the card draws them. */
function factLabels(markup: string): string[] {
  return [...markup.matchAll(/<dt class="[^"]*">([^<]*)<\/dt>/g)].map((match) => match[1]);
}

/** What one fact says, by its label. */
function fact(markup: string, label: string): string | undefined {
  return new RegExp(`<dt class="[^"]*">${label}</dt><dd[^>]*>(.*?)</dd>`).exec(markup)?.[1];
}

/** A Linear card whose documentation names a key, approved and waiting for its access. */
const LINEAR_APPROVED = {
  verdict: 'approved',
  managerApprovedAt: NOW - DAY,
  expiresAt: NOW + 89 * DAY,
  request: { credential: { found: 'location', label: 'Linear API key', location: 'Access' } },
  credentialLocation: 'Access',
} as Partial<ListedSurface>;

const SLACK_CARD = {
  _id: 'surface-slack',
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  request: { credential: { method: 'oauth', label: 'Slack OAuth access' } },
} as Partial<ListedSurface>;

/** An access request as `accessRequests.forCard` answers it, not yet drafted. */
const REQUEST: AccessRequestView = {
  system: 'linear',
  reason: 'no-connection',
  scopes: ['linear:read', 'linear:write'],
  subject: 'Day0 access request: Linear for Maya',
  text: 'Maya, a Day0 employee, needs access to Linear.\nAccess needed: linear:read, linear:write.',
  mailto: 'mailto:?subject=Day0%20access%20request',
};

describe('whom the card acts as, and how it connects (wave 11, 11-AC)', (): void => {
  it("puts Acts as first among the facts before approval, naming the employee's own Slack app IT's connection makes", (): void => {
    const markup = render(listed({ ...SLACK_CARD, request: { blastRadius: 'one workspace' } }), {
      organisation: organisation({ system: 'slack' }),
    });
    expect(factLabels(markup)[0]).toBe('Acts as');
    expect(fact(markup, 'Acts as')).toBe('Maya, its own Slack app');
  });

  it('keeps Acts as first after approval, read from the identity the connect path wrote', (): void => {
    const markup = render(
      listed({
        verdict: 'connected',
        credentialLanded: true,
        credentialId: 'cred-1' as ListedSurface['credentialId'],
        managerApprovedAt: NOW - DAY,
        expiresAt: NOW + 80 * DAY,
        actsAs: { kind: 'shared-app', label: 'Linear' },
      }),
      { organisation: organisation({ system: 'linear', mode: 'shared' }) },
    );
    expect(factLabels(markup).slice(0, 2)).toEqual(['Acts as', 'Reached']);
    expect(fact(markup, 'Acts as')).toBe(
      'the Day0 app shared by your employees; Day0 records which employee did what',
    );
  });

  it('draws the warning chip beside a pasted key and a delegated grant, and none beside an own app', (): void => {
    const pasted = render(listed({ verdict: 'proposed' }));
    expect(fact(pasted, 'Acts as')).toContain(
      "a key someone pastes here; its writes show that key's owner, and Day0 adds Maya's name to each write",
    );
    expect(fact(pasted, 'Acts as')).toMatch(
      /text-\[var\(--color-warn\)\][^"]*">Pasted key<\/span>/,
    );
    const delegated = render(
      listed({ endpoint: 'https://docs.acme.test/mcp', displayName: 'Acme docs' }),
      { organisation: organisation({ system: 'mcp:docs.acme.test' }) },
    );
    expect(fact(delegated, 'Acts as')).toContain(
      'you in Acme docs: what it touches shows your name',
    );
    expect(fact(delegated, 'Acts as')).toContain('>Delegated</span>');
    const own = render(listed(SLACK_CARD), { organisation: organisation({ system: 'slack' }) });
    expect(fact(own, 'Acts as')).not.toContain('</span>');
  });

  it("offers no credential field where the organisation's connection covers the system, and Connect instead", (): void => {
    const markup = render(
      listed(LINEAR_APPROVED),
      { organisation: organisation({ system: 'linear', mode: 'shared' }) },
      { connect: (): void => undefined },
    );
    expect(markup).not.toContain('type="password"');
    expect(fact(markup, 'Connection')).toBe('Connected for your organisation by IT on 1 October');
    expect(markup).toMatch(/<button[^>]*>Connect<\/button>/);
    expect(markup).not.toContain('Once you approve, the card asks for');
  });

  it("says a card still on a pasted key does not use IT's connection yet (the wave 11 review's m19)", (): void => {
    const pasted = render(
      listed({
        ...LINEAR_APPROVED,
        verdict: 'connected',
        credentialId: 'credential-1' as ListedSurface['credentialId'],
        credentialLanded: true,
        actsAs: { kind: 'shared-key', label: 'Linear API key' },
      }),
      {
        organisation: organisation({ system: 'linear', mode: 'shared' }),
        credentials: new Map([
          ['credential-1', { _id: 'credential-1', label: 'Linear API key', source: 'entered' }],
        ]),
      },
      { connect: (): void => undefined },
    );
    expect(pasted).toContain('a key someone pasted');
    expect(fact(pasted, 'Connection')).toBe(
      'Connected for your organisation by IT on 1 October. This card does not use it yet.',
    );
  });

  it('keeps the credential field where no organisation connection covers the system', (): void => {
    const markup = render(listed(LINEAR_APPROVED));
    expect(markup).toMatch(/<input id="credential-[^"\s]+" type="password"/);
    expect(markup).not.toMatch(/<button[^>]*>Connect<\/button>/);
  });

  it("creates a Slack card's own app through IT's connection with nothing to paste", (): void => {
    const markup = render(
      listed({ ...SLACK_CARD, verdict: 'approved', managerApprovedAt: NOW - DAY }),
      { organisation: organisation({ system: 'slack' }), installRedirectConfigured: true },
    );
    expect(markup).not.toContain('type="password"');
    expect(markup).toMatch(/<button[^>]*>Connect<\/button>/);
  });

  it('says what a covered Slack card is missing when its documentation describes no install of the app (W12V-1)', (): void => {
    // The walk's Vela: the company bed's page says "The shared bot token is landed on your Slack
    // card by the messaging administrator", so the card had no way on and said nothing of why.
    const markup = render(
      listed({
        ...SLACK_CARD,
        verdict: 'ungranted',
        reason: 'Skipped: credential not in the docs; location not documented',
        managerApprovedAt: NOW - DAY,
        request: {
          credential: {
            found: 'none',
            method: 'value',
            label: 'shared bot token',
          },
        },
      } as Partial<ListedSurface>),
      { organisation: organisation({ system: 'slack' }), installRedirectConfigured: true },
    );
    expect(markup).not.toMatch(/<button[^>]*>Connect<\/button>/);
    expect(markup).toContain(
      'Day0 cannot create Maya’s own Slack app from this card: the linked documentation describes no install procedure for it.',
    );
    expect(markup).toContain(
      'A Slack page saying Maya’s app is created with the organisation’s configuration token, or carrying the app’s manifest (docs/running/access-slack.md, section 2), lets this card create it.',
    );
  });

  it('shows the access request with its three ways to send it while IT has not acted', (): void => {
    const markup = render(
      listed({ verdict: 'approved', managerApprovedAt: NOW - DAY, expiresAt: NOW + 89 * DAY }),
      { managerDmReachable: true },
      { accessRequest: REQUEST },
    );
    expect(markup).toContain('Ask IT to connect Linear');
    expect(markup).toContain('Maya, a Day0 employee, needs access to Linear.');
    expect(markup).toMatch(/<button[^>]*>Copy<\/button>/);
    expect(markup).toMatch(
      /<a[^>]*href="mailto:\?subject=Day0%20access%20request"[^>]*>Email it<\/a>/,
    );
    expect(markup).toMatch(/<button[^>]*>Send to me in Slack<\/button>/);
  });

  it('says when the request went to IT and to the manager, and offers the Slack message no more once drafted', (): void => {
    const drafted = {
      ...REQUEST,
      draftedAt: Date.UTC(2026, 9, 3, 9),
      copiedAt: Date.UTC(2026, 9, 3, 10),
      messagedAt: Date.UTC(2026, 9, 3, 9, 1),
    };
    const markup = render(
      listed({ verdict: 'approved', managerApprovedAt: NOW - DAY, expiresAt: NOW + 89 * DAY }),
      {},
      { accessRequest: drafted },
    );
    expect(markup).toContain('Sent to IT on 3 October');
    expect(markup).toContain('Sent to you in Slack on 3 October');
    expect(markup).not.toMatch(/>Send to me in Slack<\/button>/);
  });

  it('offers Disconnect on a card that holds a credential, and none on one that holds none', (): void => {
    const held = render(
      listed({
        verdict: 'connected',
        credentialLanded: true,
        credentialId: 'cred-1' as ListedSurface['credentialId'],
        managerApprovedAt: NOW - DAY,
        expiresAt: NOW + 80 * DAY,
      }),
    );
    expect(held).toMatch(/<button[^>]*>Disconnect<\/button>/);
    const none = render(
      listed({ verdict: 'approved', managerApprovedAt: NOW - DAY, expiresAt: NOW + 89 * DAY }),
    );
    expect(none).not.toMatch(/>Disconnect<\/button>/);
  });

  it('says an authorisation that was started and not finished, and that Connect starts it again', (): void => {
    const markup = render(
      listed({
        endpoint: 'https://docs.acme.test/mcp',
        displayName: 'Acme docs',
        verdict: 'approved',
        managerApprovedAt: NOW - DAY,
        expiresAt: NOW + 89 * DAY,
        pendingAuthorisation: {
          startedAt: Date.UTC(2026, 8, 29, 11, 50),
        } as ListedSurface['pendingAuthorisation'],
      }),
      { organisation: organisation({ system: 'mcp:docs.acme.test' }) },
      { connect: (): void => undefined },
    );
    expect(markup.replace(/<[^>]+>/g, '')).toContain(
      'Authorisation started 29 Sep 2026, 11:50 and not finished: Connect starts it again.',
    );
  });

  it("says once a Slack own-app card's access ended that its bot left its channels, by RM4's rule", (): void => {
    const markup = render(
      listed({
        ...SLACK_CARD,
        verdict: 'approved',
        reason: 'expired',
        managerApprovedAt: NOW - 100 * DAY,
        expiresAt: NOW - DAY,
        actsAs: { kind: 'own-app', label: 'Maya (Day0)' },
      }),
      { organisation: organisation({ system: 'slack' }) },
    );
    expect(markup).toContain(
      "Slack: Maya's bot is switched off and removed from its channels. Renewing turns it back on; it re-joins its public channels itself, and someone in each private channel adds it again.",
    );
  });

  it('offers a pasted-key card the move to its own identity in its last week, once IT connected the system (A27)', (): void => {
    const markup = render(
      listed({
        verdict: 'connected',
        credentialLanded: true,
        credentialId: 'cred-1' as ListedSurface['credentialId'],
        managerApprovedAt: NOW - 85 * DAY,
        expiresAt: NOW + 3 * DAY,
        actsAs: { kind: 'shared-key', label: 'Linear API key' },
      }),
      { organisation: organisation({ system: 'linear', mode: 'shared' }) },
      { connect: (): void => undefined },
    );
    expect(markup).toContain(
      'IT has connected Linear. Maya can use the Day0 app your employees share instead of the pasted key, which keeps working until you move it.',
    );
    expect(markup).toMatch(/<button[^>]*>Move off the pasted key<\/button>/);
  });

  it("draws the Slack app's provisioning row only on an approved Slack card, never on an MCP card or before approval (bed, 2 Oct)", (): void => {
    const mcp = render(
      listed({
        endpoint: 'https://docs.acme.test/mcp',
        displayName: 'Acme docs',
        verdict: 'approved',
        managerApprovedAt: NOW - DAY,
        expiresAt: NOW + 89 * DAY,
        request: { credential: { found: 'none', method: 'oauth', label: 'Acme docs access' } },
      }),
      { installRedirectConfigured: true },
    );
    expect(mcp).not.toContain('Provision a dedicated app');
    expect(mcp).not.toContain('configuration-token');
    const proposed = render(listed(SLACK_CARD), {
      organisation: organisation({ system: 'slack' }),
      installRedirectConfigured: true,
    });
    expect(proposed).not.toContain('Provision a dedicated app');
    expect(proposed).not.toMatch(/<button[^>]*>Connect<\/button>/);
  });

  it('says on its chip that a card waits on IT or is ready to connect, never that it needs a credential nobody pastes (bed, 2 Oct)', (): void => {
    const waiting = render(listed(LINEAR_APPROVED), {}, { accessRequest: REQUEST });
    expect(chip(waiting)).toBe('Waiting on IT');
    const ready = render(
      listed(LINEAR_APPROVED),
      { organisation: organisation({ system: 'linear', mode: 'shared' }) },
      { connect: (): void => undefined },
    );
    expect(chip(ready)).toBe('Ready to connect');
    expect(chip(render(listed(LINEAR_APPROVED)))).toBe('Needs its credential');
  });

  it("keeps a card its approval's own probe found with no credential waiting, never Not granted with the docs' gap (the wave 11 review's m23)", (): void => {
    const probed = {
      ...LINEAR_APPROVED,
      verdict: 'ungranted',
      reason: 'credential not in the docs; Access',
    } as Partial<ListedSurface>;
    const waiting = render(listed(probed), {}, { accessRequest: REQUEST });
    expect(chip(waiting)).toBe('Waiting on IT');
    expect(waiting).not.toContain('credential not in the docs');
    expect(waiting).toContain('Maya reads nothing from Linear until IT gives it access.');
    const ready = render(
      listed(probed),
      { organisation: organisation({ system: 'linear', mode: 'shared' }) },
      { connect: (): void => undefined },
    );
    expect(chip(ready)).toBe('Ready to connect');
    expect(ready).not.toContain('credential not in the docs');
    expect(ready).toContain('Maya reads nothing from Linear until you connect it.');
    const refused = render(
      listed({ ...probed, credentialId: 'credential-1' as ListedSurface['credentialId'] }),
    );
    expect(chip(refused)).toBe('Not granted');
    expect(refused).toContain('Skipped: credential not in the docs; Access');
  });

  it("draws no credential lines on a covered card, whose identity the Acts as row names, unless the manager's own key is stored there (bed, 2 Oct)", (): void => {
    const covered = render(
      listed({
        ...LINEAR_APPROVED,
        request: { credential: { found: 'none', method: 'oauth', label: 'Linear access' } },
      }),
      { organisation: organisation({ system: 'linear', mode: 'shared' }) },
      { connect: (): void => undefined },
    );
    expect(covered).not.toContain('Follow the documented OAuth approval procedure');
    const organisationHeld = render(
      listed({
        verdict: 'connected',
        credentialLanded: true,
        credentialId: 'cred-org' as ListedSurface['credentialId'],
        managerApprovedAt: NOW - DAY,
        expiresAt: NOW + 80 * DAY,
        actsAs: { kind: 'shared-app', label: 'Linear' },
      }),
      { organisation: organisation({ system: 'linear', mode: 'shared' }) },
    );
    expect(organisationHeld).not.toContain('Stored credential metadata is unavailable');
  });

  it("says the Slack channels' rule once on an ended card whose reinstall row already says it (bed, 2 Oct)", (): void => {
    const markup = render(
      listed({
        ...SLACK_CARD,
        verdict: 'approved',
        reason: 'expired',
        managerApprovedAt: NOW - 100 * DAY,
        expiresAt: NOW - DAY,
        actsAs: { kind: 'own-app', label: 'Maya (Day0)' },
        provisioning: {
          appId: 'A1',
          appName: 'Maya (Day0)',
          clientId: '1.2',
          clientSecretCredentialId: 'cred-secret',
          installUrl: 'https://slack.test/install',
          redirectUrl: 'https://day0.test/api/slack/oauth',
          scopes: ['chat:write'],
          createdAt: 1,
          installedAt: 2,
        } as ListedSurface['provisioning'],
      }),
      { organisation: organisation({ system: 'slack' }), installRedirectConfigured: true },
    );
    expect(markup.match(/re-joins (its|the) public channels/g)).toHaveLength(1);
  });

  it("takes the card's own key where IT connected a system no issuer of Day0's acts through, and says why (11-AC's item 8, a product call)", (): void => {
    const markup = render(
      listed({
        displayName: 'Notion',
        endpoint: 'https://api.notion.com/v1',
        path: 'documented-api',
        verdict: 'approved',
        managerApprovedAt: NOW - DAY,
        expiresAt: NOW + 80 * DAY,
        request: {
          credential: {
            found: 'location',
            label: 'Notion integration token',
            location: 'IT / Integrations',
          },
        },
        credentialLocation: 'IT / Integrations',
      }),
      { organisation: organisation({ system: 'notion', displayName: 'Notion', mode: 'shared' }) },
    );
    expect(chip(markup)).not.toBe('Waiting on IT');
    expect(markup).not.toContain('Ask IT how Maya should reach it.');
    expect(markup).toContain(
      'IT connected Notion for the organisation in a way Day0 cannot act through, so this card takes a key of its own.',
    );
    expect(markup).toMatch(/<input[^>]*type="password"/);
  });

  it("takes the card's own key where IT landed a static key for Linear, which no issuer of Day0's acts through (D6, a product call)", (): void => {
    const markup = render(
      listed({
        displayName: 'Linear',
        endpoint: 'https://api.linear.app/graphql',
        path: 'documented-api',
        verdict: 'approved',
        managerApprovedAt: NOW - DAY,
        expiresAt: NOW + 80 * DAY,
        request: {
          credential: { found: 'location', label: 'Linear API key', location: 'IT / Keys' },
        },
        credentialLocation: 'IT / Keys',
      }),
      {
        organisation: organisation({
          system: 'linear',
          displayName: 'Linear',
          kind: 'static-key',
          mode: 'shared',
        }),
      },
    );
    expect(chip(markup)).not.toBe('Waiting on IT');
    expect(markup).toContain(
      'IT connected Linear for the organisation in a way Day0 cannot act through, so this card takes a key of its own.',
    );
    expect(markup).toMatch(/<input[^>]*type="password"/);
  });

  it('names an installed Slack app once, in the Acts as row, and asks IT nothing on an ended card (second pass)', (): void => {
    const installed = render(
      listed({
        ...SLACK_CARD,
        verdict: 'connected',
        credentialLanded: true,
        credentialId: 'cred-bot' as ListedSurface['credentialId'],
        managerApprovedAt: NOW - DAY,
        expiresAt: NOW + 80 * DAY,
        actsAs: { kind: 'own-app', label: 'Maya (Day0)' },
        provisioning: {
          appId: 'A1',
          appName: 'Maya (Day0)',
          clientId: '1.2',
          clientSecretCredentialId: 'cred-secret',
          installUrl: 'https://slack.test/install',
          redirectUrl: 'https://day0.test/api/slack/oauth',
          scopes: ['chat:write'],
          createdAt: 1,
          installedAt: 2,
        } as ListedSurface['provisioning'],
      }),
      { organisation: organisation({ system: 'slack' }), installRedirectConfigured: true },
    );
    expect(installed).not.toContain('Dedicated app installed');
    const ended = render(
      listed({ ...LINEAR_APPROVED, reason: 'expired', expiresAt: NOW - DAY }),
      {},
      { accessRequest: REQUEST },
    );
    expect(ended).not.toContain('Ask IT to connect Linear');
  });

  it('says on a Slack card whose app takes no messages that no typed code reaches it, the toggle by name, and its control (W12V-7)', (): void => {
    const card = (typedCode: ListedSurface['typedCode']): string =>
      render(
        listed({
          ...SLACK_CARD,
          verdict: 'connected',
          credentialLanded: true,
          credentialId: 'cred-bot' as ListedSurface['credentialId'],
          managerApprovedAt: NOW - DAY,
          expiresAt: NOW + 80 * DAY,
          managerDmChannelId: 'D0MANAGER',
          actsAs: { kind: 'own-app', label: 'Iris (Day0)' },
          provisioning: {
            appId: 'A1',
            appName: 'Iris (Day0)',
            clientId: '1.2',
            clientSecretCredentialId: 'cred-secret',
            installUrl: 'https://slack.test/install',
            redirectUrl: 'https://day0.test/api/slack/oauth',
            scopes: ['chat:write'],
            createdAt: 1,
            installedAt: 2,
          } as ListedSurface['provisioning'],
          decisionButtons: { available: false, why: 'no-app-level-token' },
          typedCode,
        }),
        { organisation: organisation({ system: 'slack' }), installRedirectConfigured: true },
      );
    const closed = card({ state: 'needs-toggle', appName: 'Iris (Day0)' });
    expect(closed).toContain('Typed code: off until this app takes messages');
    expect(closed).toContain(
      '“Allow users to send Slash commands and messages from the messages tab”',
    );
    expect(closed).toContain('It is on in Slack');
    expect(closed).toContain('Requests reach you with no buttons and no typed code');
    expect(closed).not.toContain('typed code only');
    const open = card({ state: 'open' });
    expect(open).not.toContain('Typed code: off');
    expect(open).toContain('Requests reach you with a typed code only.');
  });

  it("says on a renewed Slack card what its bot re-joined and what needs a person (11-AC's item 5)", (): void => {
    const renewed = {
      ...SLACK_CARD,
      verdict: 'connected' as const,
      credentialLanded: true,
      credentialId: 'cred-bot' as ListedSurface['credentialId'],
      managerApprovedAt: NOW - DAY,
      expiresAt: NOW + 80 * DAY,
      actsAs: { kind: 'own-app' as const, label: 'Maya (Day0)' },
      provisioning: {
        appId: 'A1',
        appName: 'Maya (Day0)',
        clientId: '1.2',
        clientSecretCredentialId: 'cred-secret',
        installUrl: 'https://slack.test/install',
        redirectUrl: 'https://day0.test/api/slack/oauth',
        scopes: ['chat:write'],
        createdAt: 1,
        installedAt: 2,
      } as ListedSurface['provisioning'],
      lastRejoin: { joined: ['#revops'], needsPerson: ['#revops-leads'], at: 3 },
    };
    const markup = render(listed(renewed), {
      organisation: organisation({ system: 'slack' }),
      installRedirectConfigured: true,
    });
    expect(markup).toContain(
      'After the renewal, Maya rejoined #revops itself; #revops-leads needs someone in it to add Maya.',
    );
    const ended = render(listed({ ...renewed, credentialId: undefined }), {
      organisation: organisation({ system: 'slack' }),
      installRedirectConfigured: true,
    });
    expect(ended).not.toContain('After the renewal');
  });

  it("says once, on a card an administrator's revoke ended, what happened, whose reason it is and whom it acts as (the design pass's majors)", (): void => {
    const markup = render(
      listed({
        displayName: 'Acme docs',
        endpoint: 'https://docs.acme.test/mcp',
        path: 'mcp',
        verdict: 'approved',
        managerApprovedAt: NOW - DAY,
        expiresAt: NOW + 80 * DAY,
        reason: 'The docs server is moving to a new host.',
        connectionRevoked: true,
      }),
    );
    expect(markup).toContain("IT's reason: The docs server is moving to a new host.");
    expect(fact(markup, 'Acts as')).toBe(
      "nobody until IT connects Acme docs again; then Maya, through IT's connection",
    );
    expect(markup).not.toContain('Pasted key');
    expect(markup).not.toMatch(/Renew for/);
    expect(markup).toContain(
      'Nothing is read or sent through this card until IT connects Acme docs again.',
    );
  });

  it("offers no reinstall on a Slack card whose own app's creating connection IT revoked, and says what is true before and after IT connects Slack again (W12X-4)", (): void => {
    // The re-walk on real Slack: Dara's ended card offered "Install Dara's own app again", which
    // the server refuses (`KEPT_APP_CONNECTION_REVOKED`), and promised "then Dara, through IT's
    // connection", which the server rules out for that app.
    const ended = {
      ...SLACK_CARD,
      verdict: 'approved',
      managerApprovedAt: NOW - DAY,
      expiresAt: NOW + 80 * DAY,
      reason: 'The re-walk ends the bed connection.',
      keptAppNotReinstalled: true,
      // The server still reads such a card as carrying decisions (`carriesDecisions` reads the
      // install), as the bed showed once IT connected Slack again.
      decisionButtons: { available: true },
      typedCode: { state: 'day0-opens', appName: 'Maya (Day0)' },
      provisioning: {
        appId: 'A1',
        appName: 'Maya (Day0)',
        clientId: '1.2',
        clientSecretCredentialId: 'cred-secret',
        installUrl: 'https://slack.test/install',
        redirectUrl: 'https://day0.test/api/slack/oauth',
        scopes: ['chat:write'],
        createdAt: 1,
        installedAt: 2,
      } as ListedSurface['provisioning'],
    } as Partial<ListedSurface>;
    // While no Slack connection is active the card's access request is drafted (the bed's).
    const slackRequest: AccessRequestView = {
      ...REQUEST,
      system: 'slack',
      subject: 'Day0 access request: Slack for Maya',
      text: 'Maya, a Day0 employee, needs access to Slack.',
    };
    const revoked = render(
      listed({ ...ended, connectionRevoked: true }),
      { installRedirectConfigured: true },
      { accessRequest: slackRequest },
    );
    const reconnected = render(listed(ended), {
      organisation: organisation({ system: 'slack' }),
      installRedirectConfigured: true,
    });
    for (const markup of [revoked, reconnected]) {
      expect(markup).not.toContain("Install Maya's own app again");
      expect(markup).not.toContain("through IT's connection");
      expect(fact(markup, 'Acts as')).toBe('nobody');
      expect(markup).toContain("Maya's own app is not installed again");
      expect(markup).toContain(
        "Maya's own app, Maya (Day0), was created through the organisation's Slack connection, which IT revoked. Day0 does not install it again and cannot delete it: IT deletes it in Slack's app settings. Connecting Slack again does not bring it back or give Maya a new app.",
      );
      expect(markup).toContain('Nothing is read or sent through this card.');
      expect(markup).not.toMatch(/Renew for/);
      expect(chip(markup)).toBe('Ended');
      // IT connecting Slack again does not bring the card back, so it asks IT for nothing.
      expect(markup).not.toContain('Ask IT to connect Slack');
      expect(markup).not.toContain('until IT gives it access');
      expect(markup).not.toContain('the control above');
      // Nothing goes through the card, so it says nothing of requests, buttons or typed codes.
      expect(markup).not.toContain('Decisions in Slack');
      expect(markup).not.toContain('Typed code');
      expect(markup).not.toContain('app-level token');
    }
    // Re-pinned for 13-FS: the reason is IT's whether or not Slack is connected again, and the
    // card offers no check that could only overwrite it.
    for (const markup of [revoked, reconnected]) {
      expect(markup).toContain("IT's reason: The re-walk ends the bed connection.");
      expect(markup).not.toContain('Check the connection');
    }
  });

  it("offers Send to me in Slack only where a connected Slack card can carry the manager's DM (code pass, M2)", (): void => {
    const unreachable = render(listed(LINEAR_APPROVED), {}, { accessRequest: REQUEST });
    expect(unreachable).not.toMatch(/>Send to me in Slack<\/button>/);
    const reachable = render(
      listed(LINEAR_APPROVED),
      { managerDmReachable: true },
      { accessRequest: REQUEST },
    );
    expect(reachable).toMatch(/>Send to me in Slack<\/button>/);
  });

  it('offers no move to a per-employee Linear app before IT has recorded one, since Connect then refuses (code pass, M3)', (): void => {
    const markup = render(
      listed({
        verdict: 'connected',
        credentialLanded: true,
        credentialId: 'cred-1' as ListedSurface['credentialId'],
        managerApprovedAt: NOW - 85 * DAY,
        expiresAt: NOW + 3 * DAY,
        actsAs: { kind: 'shared-key', label: 'Linear API key' },
      }),
      { organisation: organisation({ system: 'linear', mode: 'per-employee' }) },
      { connect: (): void => undefined },
    );
    expect(markup).not.toContain('Move off the pasted key');
  });

  it('offers Connect on an employee’s own Linear app card Linear refused to renew, which still holds the refused pair (R41X-4)', (): void => {
    const refused = listed({
      verdict: 'ungranted',
      credentialLanded: false,
      credentialId: 'cred-refused' as ListedSurface['credentialId'],
      managerApprovedAt: NOW - DAY,
      expiresAt: NOW + 89 * DAY,
      // The re-walk's card after Linear's 400 "Refresh token revoked" (row 3).
      reason:
        'Linear refused to renew the token: Linear refused the token or code it was shown: Refresh token revoked. Day0 is unauthorised in Linear until a Linear administrator installs the app again from the card.',
      actsAs: { kind: 'own-app', label: 'Leo (Day0)' },
      provisioning: { appId: 'lin-client', appName: 'Leo (Day0)', clientId: 'lin-client' },
    } as Partial<ListedSurface>);
    const markup = render(
      refused,
      { organisation: organisation({ system: 'linear', mode: 'per-employee' }) },
      { connect: (): void => undefined },
    );
    expect(markup).toMatch(/>Connect<\/button>/);
    expect(chip(markup)).toBe('Not granted');
    // Its lead says what Connect does for this card, not the first connection's generic words
    // (the second pre-tag's recorded item).
    expect(markup).toContain('Connect Linear again');
    expect(markup).toContain(
      "Maya's own app no longer has access to Linear: Connect installs it again through IT's connection, with nothing to paste.",
    );
    expect(markup).not.toContain('Nothing to paste: Connect gives');
    // Only an employee's own app installs again: through a shared connection Connect is not it.
    expect(
      render(
        refused,
        { organisation: organisation({ system: 'linear', mode: 'shared' }) },
        { connect: (): void => undefined },
      ),
    ).not.toMatch(/>Connect<\/button>/);
  });

  it('says whom a disconnected pasted-key card will act as, not the key it no longer holds (code pass, m1)', (): void => {
    const markup = render(
      listed({
        ...LINEAR_APPROVED,
        reason: 'Disconnected by the manager.',
        actsAs: { kind: 'shared-key', label: 'Linear API key' },
      }),
      { organisation: organisation({ system: 'linear', mode: 'shared' }) },
      { connect: (): void => undefined },
    );
    expect(fact(markup, 'Acts as')).toBe(
      'the Day0 app shared by your employees; Day0 records which employee did what',
    );
  });
});

describe('a key found in the documentation (B1, decision 1 (a))', (): void => {
  const documented = {
    request: { credential: { found: 'value', label: 'Linear API key' } },
  } as Partial<ListedSurface>;
  const wikiKey = new Map([
    [
      'cred-wiki',
      { _id: 'cred-wiki', label: 'Linear API key', source: { sourceId: 'wiki', ref: 'linear.md' } },
    ],
  ]);

  it("names IT's connection where it covers the system, and says the documented key was found and is not used", (): void => {
    const markup = render(listed(documented), {
      organisation: organisation({ system: 'linear', mode: 'shared' }),
    });
    expect(fact(markup, 'Acts as')).toBe(
      'the Day0 app shared by your employees; Day0 records which employee did what',
    );
    expect(fact(markup, 'Key in your docs')).toBe(
      "Found and not used: Maya acts through IT's connection.",
    );
  });

  it('claims no documented key the orientation could not resolve to a stored one (second pass)', (): void => {
    const markup = render(
      listed({
        ...documented,
        credentialLocation:
          'Ask the system administrator to land a valid credential; the stored marker could not be resolved.',
      }),
      { organisation: organisation({ system: 'linear', mode: 'shared' }) },
    );
    expect(fact(markup, 'Key in your docs')).toBeUndefined();
  });

  it('stamps a documented key bound with no connection a shared key, never one someone pasted', (): void => {
    const markup = render(
      listed({
        ...documented,
        credentialId: 'cred-wiki' as ListedSurface['credentialId'],
        credentialKind: 'value',
        actsAs: { kind: 'shared-key', label: 'Linear API key' },
      }),
      { credentials: wikiKey },
    );
    const actsAs = fact(markup, 'Acts as') ?? '';
    expect(actsAs).toContain(
      "a key found in your documentation; its writes show that key's owner, and Day0 adds Maya's name to each write",
    );
    expect(actsAs).toContain('>Documented key</span>');
    expect(actsAs).not.toMatch(/past/i);
    expect(fact(markup, 'Key in your docs')).toBeUndefined();
  });

  it('offers the move off a documented key in its own words once IT connected the system', (): void => {
    const markup = render(
      listed({
        ...documented,
        verdict: 'connected',
        credentialLanded: true,
        credentialId: 'cred-wiki' as ListedSurface['credentialId'],
        managerApprovedAt: NOW - 85 * DAY,
        expiresAt: NOW + 3 * DAY,
        actsAs: { kind: 'shared-key', label: 'Linear API key' },
      }),
      { credentials: wikiKey, organisation: organisation({ system: 'linear', mode: 'shared' }) },
      { connect: (): void => undefined },
    );
    expect(markup).toContain('instead of the key found in your documentation');
    expect(markup).toMatch(/<button[^>]*>Move off the documented key<\/button>/);
  });
});

describe("the administrator's reason on a card a revoke ended (the wave 11 review's M13)", (): void => {
  it('draws the reason whatever else the card skips', (): void => {
    const reason = 'The docs server is being moved; ask IT before reconnecting.';
    const markup = render(
      listed({
        endpoint: 'https://docs.acme.test/mcp',
        displayName: 'Acme docs',
        verdict: 'approved',
        managerApprovedAt: NOW - DAY,
        expiresAt: NOW + 80 * DAY,
        reason,
        intakeSkipReason: 'no intake reader for connected docs surface',
        actsAs: { kind: 'delegated', label: 'sam@acme.test' },
      }),
    );
    expect(markup).toContain('Skipped: no intake reader for connected docs surface');
    expect(markup).toContain(reason);
    // The reason comes first: it is why the card ended (design pass).
    expect(markup.indexOf(reason)).toBeLessThan(markup.indexOf('Skipped:'));
  });

  it('says a reason that is the skip line once', (): void => {
    const markup = render(
      listed({ verdict: 'listed-dead', reason: 'Slack policy does not allow required methods' }),
    );
    expect(markup.split('Slack policy does not allow required methods')).toHaveLength(2);
  });
});
