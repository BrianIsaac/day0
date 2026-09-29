import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  credentialStatusLine,
  SurfaceCard,
  type ListedSurface,
  type SurfaceCardActions,
  type SurfaceCardContext,
} from '../../../../../app/agent/[agentId]/surfaces/SurfaceCard';
import { AgentZoneContext } from '../../../../../app/agent/[agentId]/time';

const DAY = 24 * 60 * 60 * 1000;
/** 29 Sep 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 8, 29, 12);

const context: SurfaceCardContext = {
  now: NOW,
  sourceLabels: new Map(),
  credentials: new Map(),
  installRedirectConfigured: false,
  browserPresent: true,
};

const actions: SurfaceCardActions = {
  approve: (): void => undefined,
  reject: (): void => undefined,
  probe: (): void => undefined,
  land: (): void => undefined,
  provision: (): void => undefined,
  setDays: async () => ({ expiresAt: NOW + 90 * DAY }),
  approveTools: async () => undefined,
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
function render(surface: ListedSurface, overrides: Partial<SurfaceCardContext> = {}): string {
  return renderToStaticMarkup(
    <AgentZoneContext value="UTC">
      <SurfaceCard
        surface={surface}
        context={{ ...context, ...overrides }}
        operation={undefined}
        actions={actions}
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
  });

  it('carries the id, the verdict and the name the rehearsal driver and focus return read', (): void => {
    expect(render(listed({}))).toMatch(
      /^<article id="surface-linear" tabindex="-1" aria-label="Linear" data-verdict="proposed"/,
    );
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
