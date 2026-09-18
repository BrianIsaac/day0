import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One browser-driven surface and this deployment's component status, so the
 * whole tab can be rendered without a backend.
 */
const state = vi.hoisted(() => ({
  browserComponent: true as boolean | undefined,
  reason: undefined as string | undefined,
  surfaceResult: 'loaded' as 'loaded' | 'empty' | 'loading',
  lastDecisionError: undefined as string | undefined,
  /** Replaces the one browser-driven surface when set. */
  surfaces: undefined as unknown[] | undefined,
  /** The newest charter row, when a test needs one. */
  charter: null as unknown,
  pages: [] as unknown[],
  sources: [] as unknown[],
}));

vi.mock('convex/react', () => ({
  useAction: (): (() => void) => (): void => undefined,
  useMutation: (): (() => void) => (): void => undefined,
  useQuery: (reference: unknown): unknown => {
    const name = getFunctionName(reference as never);
    if (name === 'config:components') {
      return state.browserComponent === undefined ? undefined : { browser: state.browserComponent };
    }
    if (name === 'surfaces:installRedirectConfigured') return false;
    if (name === 'charters:latest') return state.charter;
    if (name === 'docSources:pagesForAgent') return state.pages;
    if (name === 'docSources:byIds') return state.sources;
    if (name === 'surfaces:listForAgent') {
      if (state.surfaceResult === 'loading') return undefined;
      if (state.surfaceResult === 'empty') return [];
      if (state.surfaces) return state.surfaces;
      return [
        {
          _id: 'surface-tile',
          agentId: 'agent-1',
          slug: 'looker-pipeline-tile',
          displayName: 'Looker pipeline tile',
          class: 'analytics',
          verdict: 'proposed',
          path: 'browser-driven',
          endpoint: 'http://looker-tile:8080/',
          whereFound: [],
          credentialLanded: false,
          reason: state.reason,
          lastDecisionError: state.lastDecisionError,
        },
      ];
    }
    return [];
  },
}));

import type { Id } from '../../../../../convex/_generated/dataModel';
import {
  CredentialRow,
  EMPTY_SURFACES,
  DiscoveryProvenance,
  EvidenceQuote,
  LOADING_SURFACES,
  ProvisioningRow,
  SurfaceLadder,
  SurfacesTab,
  type CredentialRowProps,
  type ProvisioningRowProps,
} from '../../../../../app/agent/[agentId]/mock/SurfacesTab';
import { companyPage } from '../../../../fixtures/company-bed';
import {
  presentProvisioning,
  type CredentialPresentation,
  type ProvisioningPresentation,
} from '../../../../../src/surfaces/credential-presentation';

beforeEach((): void => {
  state.browserComponent = true;
  state.reason = undefined;
  state.surfaceResult = 'loaded';
  state.lastDecisionError = undefined;
  state.surfaces = undefined;
  state.charter = null;
  state.pages = [];
  state.sources = [];
});

/** Render one isolated credential row without running dashboard hooks. */
function renderCredentialRow(
  presentation: CredentialPresentation,
  overrides: Partial<CredentialRowProps> = {},
): string {
  return renderToStaticMarkup(
    <CredentialRow
      credentialLabel="Linear credential"
      landing={false}
      onLand={(): void => undefined}
      presentation={presentation}
      {...overrides}
    />,
  );
}

describe('SurfacesTab credential row', (): void => {
  it('shows shared-page metadata as masked with its governance finding', (): void => {
    const markup = renderCredentialRow({
      canLand: false,
      governanceFinding: 'credential found in a shared page - rotate into a vault',
      kind: 'masked',
      label: 'linear service token',
      text: 'located in Revenue operations / Linear automation (masked)',
    });
    expect(markup).toContain('located in Revenue operations / Linear automation (masked)');
    expect(markup).toContain('credential found in a shared page - rotate into a vault');
    expect(markup).not.toContain('type="password"');
  });

  it('renders an uncontrolled write-only landing field for IT', (): void => {
    const markup = renderCredentialRow({
      canLand: true,
      kind: 'landing',
      text: 'not in the docs - ask the Linear administrator',
    });
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="new-password"');
    expect(markup).not.toContain('value=');
    expect(markup).toContain('Land credential');
  });

  it('shows the OAuth summary, the procedure and the labelled fallback landing field', (): void => {
    const markup = renderCredentialRow({
      canLand: true,
      detail: 'Ask IT to approve the app and follow the install link.',
      kind: 'oauth',
      label: 'Slack OAuth access',
      landingLabel: 'Land a shared bot token (fallback)',
      landingNote: 'Until the install flow exists the administrator may land the shared token.',
      text: 'OAuth install flow documented in Slack automation policy',
    });
    expect(markup).toContain(
      'Slack OAuth access - OAuth install flow documented in Slack automation policy',
    );
    expect(markup).toContain(
      'OAuth approval procedure: Ask IT to approve the app and follow the install link.',
    );
    expect(markup).toContain(
      'Until the install flow exists the administrator may land the shared token.',
    );
    expect(markup).toContain('type="password"');
    expect(markup).toContain('Land a shared bot token (fallback)');
    expect(markup).not.toContain('>Land credential<');
  });

  it('keeps the OAuth row read-only once the fallback token is stored', (): void => {
    const markup = renderCredentialRow({
      canLand: false,
      kind: 'masked',
      label: 'Slack shared bot token',
      text: 'entered by IT (masked)',
    });
    expect(markup).toContain('Slack shared bot token - entered by IT (masked)');
    expect(markup).not.toContain('type="password"');
  });
});

describe('SurfacesTab evidence quote', (): void => {
  it('renders an index tag as the page title linked to the page', (): void => {
    const markup = renderToStaticMarkup(
      <EvidenceQuote quote='<page url="https://app.notion.com/p/3c7a382da0a080968de5fd7bf18e5f21">Linear Automation</page>' />,
    );
    expect(markup).toBe(
      '<a href="https://app.notion.com/p/3c7a382da0a080968de5fd7bf18e5f21" target="_blank" rel="noreferrer" class="text-[var(--color-fg)] underline decoration-[var(--color-border)]">Linear Automation</a>',
    );
    expect(markup).not.toContain('&lt;page');
  });

  it('leaves every other quote as stored', (): void => {
    expect(renderToStaticMarkup(<EvidenceQuote quote="# Linear automation" />)).toBe(
      '# Linear automation',
    );
    expect(renderToStaticMarkup(<EvidenceQuote quote='<page url="ftp://x">Linear</page>' />)).toBe(
      '&lt;page url=&quot;ftp://x&quot;&gt;Linear&lt;/page&gt;',
    );
    expect(renderToStaticMarkup(<EvidenceQuote quote={undefined} />)).toBe('');
  });
});

describe('SurfacesTab system discovery provenance', (): void => {
  it('shows the manager and documentation page when both named the system', (): void => {
    const markup = renderToStaticMarkup(
      <DiscoveryProvenance
        evidence={[
          {
            kind: 'charter',
            ref: 'manager 1:1',
            quote: 'We use Linear.',
            current: true,
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
          {
            kind: 'documentation',
            sourceId: 'source-1',
            ref: 'systems/linear.md',
            quote: '# Linear',
            url: 'https://notion.example/linear',
            current: true,
            firstSeenAt: 2,
            lastSeenAt: 2,
          },
        ]}
        sourceLabels={new Map([['source-1', 'RevOps handbook']])}
      />,
    );
    expect(markup).toContain('System discovered from');
    expect(markup).toContain('manager 1:1');
    expect(markup).toContain('RevOps handbook / systems/linear.md');
    expect(markup).toContain('href="https://notion.example/linear"');
    expect(markup).toContain('We use Linear.');
    expect(markup).toContain('# Linear');
    // A page link here is the same affordance as a route-evidence page link a
    // few lines down the same card, so it carries the same accent treatment
    // rather than reading as muted and disabled.
    expect(markup).toContain(
      '<a href="https://notion.example/linear" target="_blank" rel="noreferrer" class="text-[var(--color-accent)] underline">',
    );
  });

  it('keeps edited-away documentation provenance visible as historical', (): void => {
    const markup = renderToStaticMarkup(
      <DiscoveryProvenance
        evidence={[
          {
            kind: 'documentation',
            sourceId: 'source-1',
            ref: 'systems/northstar-crm.md',
            quote: '# Northstar CRM',
            current: false,
            firstSeenAt: 1,
            lastSeenAt: 2,
          },
        ]}
        sourceLabels={new Map([['source-1', 'Team folder']])}
      />,
    );
    expect(markup).toContain('Team folder / systems/northstar-crm.md');
    expect(markup).toContain('no longer named in the current page');
  });
});

describe('SurfacesTab approved ladder', (): void => {
  it('shows the ratified route and every failed rung after a successful demotion', (): void => {
    const markup = renderToStaticMarkup(
      <SurfaceLadder
        candidates={[
          { path: 'mcp', endpoint: 'https://mcp.jira.example/mcp' },
          { path: 'browser-driven', endpoint: 'https://jira.example/issues' },
        ]}
        attempts={[
          {
            path: 'mcp',
            endpoint: 'https://mcp.jira.example/mcp',
            outcome: 'demoted',
            reason: 'MCP server returned HTTP 503',
            attemptedAt: 100,
          },
        ]}
      />,
    );

    expect(markup).toContain('Approved ladder:');
    expect(markup).toContain('mcp → browser-driven');
    expect(markup).toContain('mcp attempt failed');
    expect(markup).toContain('MCP server returned HTTP 503');
    expect(markup).toContain('Fell to the next approved rung.');
  });
});

/** Render one isolated provisioning row without running dashboard hooks. */
function renderProvisioningRow(
  presentation: ProvisioningPresentation,
  overrides: Partial<ProvisioningRowProps> = {},
): string {
  return renderToStaticMarkup(
    <ProvisioningRow
      onProvision={(): void => undefined}
      presentation={presentation}
      provisioning={false}
      surfaceSlug="slack"
      {...overrides}
    />,
  );
}

describe('SurfacesTab dedicated-app row', (): void => {
  it('renders nothing for a system whose docs describe no install procedure', (): void => {
    expect(
      renderProvisioningRow(
        presentProvisioning({
          credential: { found: 'value', method: 'api-key' },
          hasPublicUrl: true,
        }),
      ),
    ).toBe('');
  });

  it('offers a write-only configuration-token field beside the shared-token fallback', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({ credential: { found: 'none', method: 'oauth' }, hasPublicUrl: true }),
    );
    expect(markup).toContain('Provision a dedicated app');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="new-password"');
    expect(markup).not.toContain('value=');
    expect(markup).toContain('revoked');
  });

  it('says why it cannot offer one without a public address', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({ credential: { found: 'none', method: 'oauth' }, hasPublicUrl: false }),
    );
    expect(markup).toContain('DAY0_PUBLIC_URL');
    expect(markup).not.toContain('type="password"');
  });

  it('shows the install link and hides the field once the app exists', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({
        credential: { found: 'none', method: 'oauth' },
        hasPublicUrl: true,
        provisioning: {
          appId: 'A1',
          appName: 'ops worker (Day0)',
          installUrl: 'https://slack.com/oauth/v2/authorize?client_id=1&state=abc',
        },
      }),
    );
    expect(markup).toContain('Awaiting the install click');
    expect(markup).toContain('client_id=1&amp;state=abc');
    expect(markup).toContain('Install link for the administrator');
    expect(markup).not.toContain('type="password"');
  });

  it('reports the dedicated identity once the install has landed', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({
        credential: { found: 'none', method: 'oauth' },
        hasPublicUrl: true,
        provisioning: {
          appId: 'A1',
          appName: 'ops worker (Day0)',
          installUrl: 'https://slack.com/oauth/v2/authorize',
          installedAt: 5,
        },
      }),
    );
    expect(markup).toContain('Dedicated app installed');
    expect(markup).toContain('acts as its own app');
    expect(markup).not.toContain('Install link for the administrator');
  });

  it('names a failed install and offers a fresh link', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({
        credential: { found: 'none', method: 'oauth' },
        hasPublicUrl: true,
        provisioning: {
          appId: 'A1',
          appName: 'ops worker (Day0)',
          installUrl: 'https://slack.com/oauth/v2/authorize',
          lastError: 'Slack oauth.v2.access failed: invalid_code.',
        },
      }),
    );
    expect(markup).toContain('Install did not complete');
    expect(markup).toContain('invalid_code');
    expect(markup).toContain('type="password"');
  });

  it('shows an operation error under the row', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({ credential: { found: 'none', method: 'oauth' }, hasPublicUrl: true }),
      { error: 'Slack apps.manifest.create failed: token_expired' },
    );
    expect(markup).toContain('token_expired');
  });

  it('disables the control while an app is being registered', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({ credential: { found: 'none', method: 'oauth' }, hasPublicUrl: true }),
      { provisioning: true },
    );
    expect(markup).toContain('Registering the app...');
    expect(markup).toContain('disabled=""');
  });
});

describe('SurfacesTab and the optional browser component', (): void => {
  const agentId = 'agent-1' as Id<'agents'>;

  it('says which connection context is loading', (): void => {
    state.surfaceResult = 'loading';
    const markup = renderToStaticMarkup(<SurfacesTab agentId={agentId} />);
    expect(markup).toContain(LOADING_SURFACES);
    expect(markup).not.toContain('Looker pipeline tile');
  });

  it('explains how an empty environment becomes populated', (): void => {
    state.surfaceResult = 'empty';
    const markup = renderToStaticMarkup(<SurfacesTab agentId={agentId} />);
    expect(markup).toContain(EMPTY_SURFACES);
    expect(markup).not.toContain('Looker pipeline tile');
  });

  it('proposes the path, says the component is not running, and holds approval', (): void => {
    state.browserComponent = false;
    state.reason = undefined;
    const markup = renderToStaticMarkup(<SurfacesTab agentId={agentId} />);
    // The evidence still stands: the path and the documented address are shown.
    expect(markup).toContain('browser-driven');
    expect(markup).toContain('http://looker-tile:8080/');
    expect(markup).toContain('This system is reached through its web UI.');
    expect(markup).toContain('--profile browser');
    expect(markup).toContain('Approve as manager');
    expect(
      markup.match(/<button[^>]*disabled=""[^>]*>Approve as (manager|IT)<\/button>/g),
    ).toHaveLength(2);
  });

  it('says the same when a configured driver turned out not to be listening', (): void => {
    state.browserComponent = true;
    state.reason = 'BROWSER_DRIVER_ABSENT: the component is not running';
    const markup = renderToStaticMarkup(<SurfacesTab agentId={agentId} />);
    expect(markup).toContain('This system is reached through its web UI.');
  });

  it('holds approval while component status is still loading', (): void => {
    state.browserComponent = undefined;
    state.reason = undefined;
    const markup = renderToStaticMarkup(<SurfacesTab agentId={agentId} />);
    expect(
      markup.match(/<button[^>]*disabled=""[^>]*>Approve as (manager|IT)<\/button>/g),
    ).toHaveLength(2);
  });

  it('names a failing manager decision poll on the card that stopped answering', (): void => {
    state.lastDecisionError =
      'decision poll failed: Connected Slack surface does not allow conversations.history.';
    const markup = renderToStaticMarkup(<SurfacesTab agentId={agentId} />);
    expect(markup).toContain('Manager decisions: decision poll failed:');
    expect(markup).toContain('does not allow conversations.history.');
  });

  it('says nothing about manager decisions while the poll is healthy', (): void => {
    expect(renderToStaticMarkup(<SurfacesTab agentId={agentId} />)).not.toContain(
      'Manager decisions:',
    );
  });

  it('leaves approval alone once the component is running', (): void => {
    state.browserComponent = true;
    state.reason = undefined;
    const markup = renderToStaticMarkup(<SurfacesTab agentId={agentId} />);
    expect(markup).not.toContain('This system is reached through its web UI.');
    expect(markup).toContain('Approve as manager');
    expect(markup).not.toContain('disabled=""');
  });
});

describe('SurfacesTab and what each employee reads', (): void => {
  const agentId = 'agent-1' as Id<'agents'>;
  const FINANCE = companyPage('finance/handbook.md');
  const sourceId = 'source-folder';
  const financePages = [
    { ...FINANCE, _id: 'page-finance', sourceId, sourceLabel: 'Kestrel Supply folder' },
  ];
  const scopeValue = (value: string, quote: string) => ({
    value,
    sourceId,
    ref: 'finance/handbook.md',
    quote,
  });
  const card = (patch: Record<string, unknown>): Record<string, unknown> => ({
    _id: `surface-${String(patch.slug)}`,
    agentId,
    verdict: 'proposed',
    whereFound: [],
    credentialLanded: false,
    discoveryEvidence: [
      {
        kind: 'documentation',
        sourceId,
        ref: 'onboarding.md',
        quote: 'documented',
        current: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
      {
        kind: 'charter',
        ref: 'manager 1:1',
        quote: 'named',
        current: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
    ],
    ...patch,
  });
  /** Render the tab, with the entities React escapes read back as text. */
  const render = (): string =>
    renderToStaticMarkup(<SurfacesTab agentId={agentId} />)
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"');

  beforeEach((): void => {
    state.pages = financePages;
    state.sources = [{ _id: sourceId, label: 'Kestrel Supply folder' }];
  });

  it.fails(
    'shows what a work-bearing card reads, with the handbook lines that ground it',
    (): void => {
      state.surfaces = [
        card({
          slug: 'linear',
          displayName: 'Linear',
          class: 'kanban',
          path: 'mcp',
          intakeScope: {
            team: scopeValue('FIN', '- Team: `FIN`'),
            project: scopeValue('September close', '- Project: `September close`'),
          },
        }),
        card({
          slug: 'slack',
          displayName: 'Slack',
          class: 'chat',
          path: 'documented-api',
          intakeScope: {
            channels: ['finance-close', 'ops-requests'].map((channel) =>
              scopeValue(channel, '- Channels: #finance-close, #ops-requests'),
            ),
          },
        }),
      ];
      const markup = render();
      expect(markup).toContain('Reads: Linear team FIN, project September close');
      expect(markup).toContain('Reads: Slack #finance-close, #ops-requests');
      expect(markup).toContain('- Team: `FIN`');
      expect(markup).toContain('- Project: `September close`');
      expect(markup).toContain('- Channels: #finance-close, #ops-requests');
      expect(markup).toContain('Kestrel Supply folder / finance/handbook.md');
      expect(markup).not.toContain('Changed since this card was proposed');
    },
  );

  it.fails('says why an empty scope reads nothing, and names each dropped pick', (): void => {
    state.surfaces = [
      card({
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        path: 'documented-api',
        intakeScope: { notes: ['Dropped #revops-asks: finance/handbook.md does not state it.'] },
      }),
    ];
    const markup = render();
    expect(markup).toContain(
      'Reads nothing from Slack: no documented channel was picked for this role.',
    );
    expect(markup).toContain('Dropped #revops-asks: finance/handbook.md does not state it.');
  });

  it.fails('flags an approved value whose handbook line has since changed', (): void => {
    state.pages = [
      {
        ...financePages[0],
        markdown: FINANCE.markdown.replace(
          '- Project: `September close`',
          '- Project: `October close`',
        ),
      },
    ];
    state.surfaces = [
      card({
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        path: 'mcp',
        verdict: 'connected',
        intakeScope: {
          team: scopeValue('FIN', '- Team: `FIN`'),
          project: scopeValue('September close', '- Project: `September close`'),
        },
      }),
    ];
    const markup = render();
    expect(markup).toContain(
      'Changed since this card was proposed: project September close is no longer stated on finance/handbook.md. Intake still reads only what was approved; reject the card and re-run orientation to propose the page as it reads now.',
    );
  });

  it.fails(
    "lists the documented systems this role's charter does not name under the cards, each with Propose",
    (): void => {
      state.charter = {
        approved: true,
        body: { namedSystems: [{ name: 'Linear', class: 'kanban', whereMentioned: 'named' }] },
      };
      state.surfaces = [
        card({ slug: 'linear', displayName: 'Linear', class: 'kanban', path: 'mcp' }),
        card({
          slug: 'looker-pipeline-tile',
          displayName: 'Looker pipeline tile',
          class: 'analytics',
          verdict: 'declared',
          discoveryEvidence: [
            {
              kind: 'documentation',
              sourceId,
              ref: 'systems/looker-pipeline-tile.md',
              quote: '# Looker pipeline tile',
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
        }),
      ];
      const markup = render();
      expect(markup).toContain('<details');
      expect(markup).toContain("Documented in the company, not named in this role's charter (1)");
      expect(markup).toMatch(/Looker pipeline tile[\s\S]*>Propose<\/button>/);
      expect(markup).toContain('Kestrel Supply folder / systems/looker-pipeline-tile.md');
      // Not a card of its own, and not counted as waiting for orientation.
      expect(markup).not.toContain('id="surface-looker-pipeline-tile"');
      expect(markup).not.toContain('no proposal yet');
      expect(markup).toContain('id="surface-linear"');
    },
  );

  it('keeps every declared system a card when the charter names no work system', (): void => {
    state.charter = { approved: true, body: { namedSystems: [] } };
    state.surfaces = [
      card({
        slug: 'looker-pipeline-tile',
        displayName: 'Looker pipeline tile',
        class: 'analytics',
        verdict: 'declared',
        discoveryEvidence: [],
      }),
    ];
    const markup = render();
    expect(markup).toContain('id="surface-looker-pipeline-tile"');
    expect(markup).toContain('1 declared system has no proposal yet.');
    expect(markup).not.toContain('<details');
  });
});
