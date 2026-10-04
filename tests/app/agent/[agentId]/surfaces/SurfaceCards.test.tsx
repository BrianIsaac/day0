import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withListedIdentity } from './fakes/listed-identity';

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
    if (name === 'docSources:byIds') return state.sources;
    // A card that makes no access request is answered null, as the backend answers it.
    if (name === 'accessRequests:forCard') return null;
    if (name === 'surfaces:listForAgent') {
      if (state.surfaceResult === 'loading') return undefined;
      if (state.surfaceResult === 'empty') return [];
      // The listing answers whom each card acts as (`listedCardIdentity`), as the backend does.
      if (state.surfaces) return state.surfaces.map((row) => withListedIdentity(row as object));
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
      ].map((row) => withListedIdentity(row));
    }
    return [];
  },
}));

import type { Id } from '../../../../../convex/_generated/dataModel';
import {
  EMPTY_SURFACES,
  LOADING_SURFACES,
  SurfaceCards,
} from '../../../../../app/agent/[agentId]/surfaces/SurfaceCards';
import { pageScanLine } from '../../../../../src/surfaces/intake-scope';

beforeEach((): void => {
  state.browserComponent = true;
  state.reason = undefined;
  state.surfaceResult = 'loaded';
  state.lastDecisionError = undefined;
  state.surfaces = undefined;
  state.charter = null;
  state.sources = [];
});

describe('SurfaceCards and the optional browser component', (): void => {
  const agentId = 'agent-1' as Id<'agents'>;

  it('says which connection context is loading', (): void => {
    state.surfaceResult = 'loading';
    const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />);
    expect(markup).toContain(LOADING_SURFACES);
    expect(markup).not.toContain('Looker pipeline tile');
  });

  it('explains how an empty environment becomes populated', (): void => {
    state.surfaceResult = 'empty';
    const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />);
    expect(markup).toContain(EMPTY_SURFACES);
    expect(markup).not.toContain('Looker pipeline tile');
  });

  it('proposes the path, says the component is not running, and holds approval', (): void => {
    state.browserComponent = false;
    state.reason = undefined;
    const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />);
    // The evidence still stands: the path and the documented address are shown.
    expect(markup).toContain('browser-driven');
    expect(markup).toContain('http://looker-tile:8080/');
    expect(markup).toContain('This system is reached through its web UI.');
    expect(markup).toContain('--profile browser');
    expect(markup.match(/<button[^>]*disabled=""[^>]*>Approve<\/button>/g)).toHaveLength(1);
  });

  it('says the same when a configured driver turned out not to be listening', (): void => {
    state.browserComponent = true;
    state.reason = 'BROWSER_DRIVER_ABSENT: the component is not running';
    const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />);
    expect(markup).toContain('This system is reached through its web UI.');
  });

  it('holds approval while component status is still loading', (): void => {
    state.browserComponent = undefined;
    state.reason = undefined;
    const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />);
    expect(markup.match(/<button[^>]*disabled=""[^>]*>Approve<\/button>/g)).toHaveLength(1);
  });

  it('asks the manager to confirm a registry suggestion before approving, naming no second approver', (): void => {
    state.surfaces = [
      {
        _id: 'surface-slack',
        agentId: 'agent-1',
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'proposed',
        path: 'escalate',
        whereFound: [],
        credentialLanded: false,
        request: {
          openQuestions: [],
          registrySuggestion: { endpoint: 'https://server.example/slack/mcp' },
        },
      },
    ];
    const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />);
    expect(markup).toContain('Not linked evidence; confirm the endpoint before you approve.');
    expect(markup).not.toMatch(/\bIT\b/);
  });

  it('names a failing manager decision poll on the card that stopped answering', (): void => {
    state.lastDecisionError =
      'decision poll failed: Connected Slack surface does not allow conversations.history.';
    const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />);
    expect(markup).toContain('Manager decisions: decision poll failed:');
    expect(markup).toContain('does not allow conversations.history.');
  });

  it('says nothing about manager decisions while the poll is healthy', (): void => {
    expect(
      renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />),
    ).not.toContain('Manager decisions:');
  });

  it('leaves approval alone once the component is running', (): void => {
    state.browserComponent = true;
    state.reason = undefined;
    const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />);
    expect(markup).not.toContain('This system is reached through its web UI.');
    expect(markup.match(/<button[^>]*>Approve<\/button>/g)).toHaveLength(1);
    expect(markup).not.toContain('disabled=""');
  });

  it('offers one Approve on a proposed card and names no second approver (Q10)', (): void => {
    state.browserComponent = true;
    state.reason = undefined;
    const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />);
    expect(markup.match(/<button[^>]*>Approve<\/button>/g)).toHaveLength(1);
    expect(markup).toContain('data-verdict="proposed"');
    expect(markup).toContain('Day0 checks the connection as soon as you approve.');
    for (const gone of ['Approve as', 'IT approved', 'Manager approved', 'same operator', ' IT ']) {
      expect(markup).not.toContain(gone);
    }
  });
});

describe('SurfaceCards and what each employee reads', (): void => {
  const agentId = 'agent-1' as Id<'agents'>;
  const sourceId = 'source-folder';
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
    renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />)
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"');

  beforeEach((): void => {
    state.sources = [{ _id: sourceId, label: 'Kestrel Supply folder' }];
  });

  it('shows what a work-bearing card reads, with the handbook lines that ground it', (): void => {
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
    expect(markup).toMatch(/- Team: <code[^>]*>FIN<\/code>/);
    expect(markup).toMatch(/- Project: <code[^>]*>September close<\/code>/);
    expect(markup).toContain('- Channels: #finance-close, #ops-requests');
    expect(markup).toContain('Kestrel Supply folder / finance/handbook.md');
    expect(markup).not.toContain('Changed since this card was proposed');
  });

  it('says in one line that a card older than the approved scope is read by the page scan, and only there (R-S)', (): void => {
    state.surfaces = [
      card({
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        path: 'mcp',
        verdict: 'connected',
      }),
      card({ slug: 'slack', displayName: 'Slack', class: 'chat', path: 'documented-api' }),
      card({
        slug: 'jira',
        displayName: 'Jira',
        class: 'kanban',
        path: 'mcp',
        verdict: 'declared',
      }),
    ];
    const markup = render();
    expect(markup.split(pageScanLine('Linear'))).toHaveLength(2);
    expect(markup).not.toContain(pageScanLine('Slack'));
    expect(markup).not.toContain(pageScanLine('Jira'));
  });

  it('says why an empty scope reads nothing, and names each dropped pick', (): void => {
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

  it("shows the drift the server found on a card's approved scope (D D4)", (): void => {
    const scopeChange =
      'Changed since this card was proposed: project September close is no longer stated on finance/handbook.md. Intake still reads only what was approved; reject the card and re-run orientation to propose the page as it reads now.';
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
        scopeChange,
      }),
    ];
    expect(render()).toContain(scopeChange);
  });

  it("lists the documented systems this role's charter does not name under the cards, each with Propose", (): void => {
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
    expect(markup).toMatch(
      /<h2[^>]*>Documented, not named in the charter<\/h2><span[^>]*>1<\/span>/,
    );
    expect(markup).toMatch(
      /Looker pipeline tile[\s\S]*aria-label="Propose Looker pipeline tile">Propose<\/button>/,
    );
    expect(markup).toContain('Kestrel Supply folder / systems/looker-pipeline-tile.md');
    // Not a card of its own, and not counted as waiting for orientation.
    expect(markup).not.toContain('id="surface-looker-pipeline-tile"');
    expect(markup).not.toContain('no proposal yet');
    expect(markup).toContain('id="surface-linear"');
  });

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
    expect(markup).not.toContain('Documented, not named in the charter');
  });
});

describe('SurfaceCards and the approved tools', (): void => {
  const agentId = 'agent-1' as Id<'agents'>;

  it("shows a card's withheld tools from its row, with no event in the page's feed (K D2 (b))", (): void => {
    state.surfaces = [
      {
        _id: 'surface-linear',
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'connected',
        path: 'mcp',
        whereFound: [],
        credentialLanded: true,
        toolAllowlist: ['list_issues'],
        approvedToolAllowlist: ['list_issues'],
        withheldTools: ['delete_issue'],
      },
    ];
    try {
      const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />);
      expect(markup).toContain('Withheld, outside your approval: delete_issue.');
    } finally {
      state.surfaces = undefined;
    }
  });

  it('labels the scopes a proposal asks for as requested, and the access as starting at approval', (): void => {
    state.surfaces = [
      {
        _id: 'surface-linear',
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'proposed',
        path: 'mcp',
        whereFound: [],
        credentialLanded: false,
        request: { scopeRequested: ['read:issues'], costBand: 'free' },
      },
    ];
    try {
      const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Maya" />);
      expect(markup).toMatch(/Scopes requested<\/dt><dd[^>]*>read:issues<\/dd>/);
      expect(markup).toMatch(/Cost<\/dt><dd[^>]*>free<\/dd>/);
      expect(markup).toContain('starts when you approve; the end date shows on this card');
      expect(markup).not.toContain('Cost / expiry');
      expect(markup).not.toContain('30 days');
    } finally {
      state.surfaces = undefined;
    }
  });
});

describe('SurfaceCards: where decisions reach the manager on a Slack card (wave 12, 12-M)', (): void => {
  const agentId = 'agent-1' as Id<'agents'>;
  const slackCard = (decisionButtons: unknown): object => ({
    _id: 'surface-slack',
    agentId: 'agent-1',
    slug: 'slack',
    displayName: 'Slack',
    class: 'chat',
    verdict: 'connected',
    path: 'documented-api',
    endpoint: 'https://slack.com/api/',
    whereFound: [],
    credentialLanded: true,
    managerDmChannelId: 'D0MANAGER',
    managerApprovedAt: 1,
    provisioning: {
      appId: 'A0MATEO',
      appName: 'Mateo (Day0)',
      clientId: '1.2',
      clientSecretCredentialId: 'credential-1',
      installUrl: 'https://slack.com/oauth/v2/authorize',
      redirectUrl: 'https://day0.example/api/oauth/slack',
      scopes: [],
      createdAt: 1,
      installedAt: 2,
    },
    decisionButtons,
  });

  it('says the requests carry the typed code until the app’s socket token lands, and asks for it', (): void => {
    state.surfaces = [slackCard({ available: false, why: 'no-app-level-token' })];
    const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Mateo" />);
    expect(markup).toContain('Buttons: needs this app&#x27;s socket token');
    expect(markup).toContain('Mateo (Day0)');
    expect(markup).toContain('id="app-level-token-slack"');
  });

  it('says the requests carry buttons once it has', (): void => {
    state.surfaces = [slackCard({ available: true })];
    const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Mateo" />);
    expect(markup).toContain('Decisions in Slack: buttons are on');
    expect(markup).toContain('Replace the app-level token');
  });

  it('shows no such row on a card that carries no decisions', (): void => {
    state.surfaces = [{ ...slackCard(undefined), decisionButtons: undefined }];
    const markup = renderToStaticMarkup(<SurfaceCards agentId={agentId} employeeName="Mateo" />);
    expect(markup).not.toContain('App-level token');
    expect(markup).not.toContain('Decisions in Slack');
  });
});
