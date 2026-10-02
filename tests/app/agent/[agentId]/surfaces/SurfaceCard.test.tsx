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
import type { OrganisationSystem } from '../../../../../app/agent/[agentId]/surfaces/card-words';

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
};

const actions: SurfaceCardActions = {
  approve: (): void => undefined,
  reject: (): void => undefined,
  probe: (): void => undefined,
  land: (): void => undefined,
  provision: (): void => undefined,
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
  return renderToStaticMarkup(
    <AgentZoneContext value="UTC">
      <SurfaceCard
        surface={surface}
        context={{ ...context, ...overrides }}
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
      "a key someone pastes here; its writes show that key's owner, and Day0 adds Maya's name to each",
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

  it('shows the access request with its three ways to send it while IT has not acted', (): void => {
    const markup = render(
      listed({ verdict: 'approved', managerApprovedAt: NOW - DAY, expiresAt: NOW + 89 * DAY }),
      {},
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
      { organisation: organisation({ system: 'linear' }) },
      { connect: (): void => undefined },
    );
    expect(markup).toContain(
      'IT connected Linear for your organisation: Maya can act as Maya, its own Linear app, instead of the pasted key, which keeps working until you move.',
    );
    expect(markup).toMatch(/<button[^>]*>Move to its own identity<\/button>/);
  });
});
