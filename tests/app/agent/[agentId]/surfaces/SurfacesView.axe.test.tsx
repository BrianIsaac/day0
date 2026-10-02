/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Surfaces tab in a document, in each mode, against the accessibility floor (N14): axe at the
 * WCAG 2.2 AA tags and best practice, a 44 px target on every control, and every scroll region
 * focusable and named (the wave 3.5 review's X2 and its siblings). The seam is the Convex client,
 * each query answering from the fixtures below by function name.
 */
const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown => {
    if (args === 'skip') return undefined;
    const name = getFunctionName(reference as never);
    const answer = backend.queries[name];
    return typeof answer === 'function' ? (answer as (args: unknown) => unknown)(args) : answer;
  },
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import { SurfacesView } from '../../../../../app/agent/[agentId]/surfaces/SurfacesView';
import { asEmployee } from '../../../../fixtures/dom/employee';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { mount, settle } from '../../../../fixtures/dom/press';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const agentId = 'agent-1';

/** The seeded office, one of each thing its five surfaces draw. */
const OFFICE: Record<string, unknown> = {
  'mock:listChannels': [
    { _id: 'c1', slug: 'revops', displayName: '#revops', kind: 'channel' },
    { _id: 'c2', slug: 'revops-asks', displayName: '#revops-asks', kind: 'channel' },
    { _id: 'c3', slug: 'dm-manager', displayName: 'DM · Manager', kind: 'dm' },
  ],
  'mock:listMessages': [
    {
      _id: 'm1',
      channelSlug: 'revops-asks',
      threadKey: 'thread-pipeline-coverage',
      sender: 'Priya',
      senderKind: 'requester',
      body: 'What does enterprise pipeline coverage look like?',
      timestamp: NOW - 60_000,
    },
    {
      _id: 'm2',
      channelSlug: 'revops-asks',
      threadKey: 'thread-pipeline-coverage',
      sender: 'Mira (Day0)',
      senderKind: 'agent-draft',
      body: 'Draft for manager review.',
      timestamp: NOW,
    },
  ],
  'mock:listDocs': [
    { _id: 'd1', slug: 'handbook', title: 'Handbook', body: 'How we work.', category: 'team-doc' },
    {
      _id: 'd2',
      slug: 'coverage',
      title: 'Coverage how-to',
      body: 'Read the tracker.',
      category: 'how-to-guide',
      sourceUrl: 'https://docs.example/coverage',
    },
  ],
  'docSources:byIds': [],
  'mock:listSpreadsheets': [{ _id: 's1', slug: 'q4', title: 'Q4 Revenue Tracker' }],
  'mock:getSpreadsheet': {
    sheet: { title: 'Q4 Revenue Tracker', tabs: [{ name: 'Pipeline', headers: ['Deal'] }] },
    rows: [{ _id: 'r1', tabName: 'Pipeline', cells: { Deal: 'Northstar' }, addedBy: 'Day0' }],
  },
  'mock:listTickets': [
    {
      _id: 't1',
      slug: 'REVOPS-1',
      title: 'Coverage check',
      body: 'Weekly.',
      status: 'in-progress',
      priority: 'high',
      comments: [{ author: 'Sara', body: 'Thanks.' }],
    },
  ],
  'mock:listTweets': [
    { _id: 'w1', slug: 'post-1', author: 'Kestrel', handle: '@kestrel', body: 'We shipped.' },
  ],
  'mock:listTweetReplies': [
    { _id: 'wr1', author: 'Mira', handle: '@mira', body: 'Congratulations.', isAgentDraft: true },
  ],
};

/** A surface row as `surfaces.listForAgent` lists it. */
const row = (slug: string, fields: Record<string, unknown>): Record<string, unknown> => ({
  _id: `surface-${slug}`,
  _creationTime: 1,
  agentId,
  slug,
  displayName: slug.charAt(0).toUpperCase() + slug.slice(1),
  class: 'kanban',
  verdict: 'proposed',
  path: 'mcp',
  whereFound: [{ ref: 'runbook.md', quote: 'Use the MCP server.' }],
  discoveryEvidence: [
    {
      kind: 'charter',
      ref: 'manager 1:1',
      quote: 'named',
      current: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    },
  ],
  credentialLanded: false,
  createdAt: 1,
  ...fields,
});

/** Every card state the tab draws, and a system waiting on the manager's Propose. */
const SYSTEMS: Record<string, unknown> = {
  'config:components': { browser: true },
  'surfaces:installRedirectConfigured': true,
  'credentials:summaryForOwner': [],
  'agents:permissionScopes': [
    { scope: 'linear:write', active: true, source: 'deploy' },
    { scope: 'slack:write', active: false, source: 'manager' },
  ],
  'charters:latest': {
    _id: 'charter-1',
    agentId,
    approved: true,
    body: { namedSystems: [{ name: 'Linear', class: 'kanban', whereMentioned: 'named' }] },
  },
  'surfaces:listForAgent': [
    row('linear', {
      request: {
        blastRadius: 'one team',
        scopeRequested: ['read:issues'],
        registrySuggestion: { endpoint: 'https://mcp.example/linear' },
        credential: { found: 'location', label: 'linear service token', location: 'Access' },
      },
      credentialLocation: 'Access',
    }),
    row('slack', {
      class: 'chat',
      verdict: 'connected',
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      credentialLanded: true,
      managerApprovedAt: NOW - 10 * DAY,
      expiresAt: NOW + 80 * DAY,
      accessSetBy: 'approval',
      toolAllowlist: ['chat.postMessage'],
      withheldTools: ['files.upload'],
      intakeScope: {
        channels: [{ value: 'revops-asks', ref: 'runbook.md', quote: '- Channels: #revops-asks' }],
      },
      scopeChange: 'Changed since this card was proposed: #revops-asks is no longer stated.',
      provisioning: undefined,
      request: { credential: { method: 'oauth', label: 'Slack OAuth access' } },
    }),
    row('notion', {
      class: 'docs',
      verdict: 'connected',
      credentialLanded: true,
      managerApprovedAt: NOW - 84 * DAY,
      expiresAt: NOW + 5 * DAY,
      accessSetBy: 'manager',
    }),
    row('jira', {
      verdict: 'approved',
      reason: 'expired',
      managerApprovedAt: NOW - 100 * DAY,
      expiresAt: NOW - 10 * DAY,
      accessSetBy: 'approval',
    }),
    row('looker', {
      class: 'analytics',
      verdict: 'approved',
      path: 'browser-driven',
      endpoint: 'http://looker-tile:8080/',
      managerApprovedAt: NOW - DAY,
      expiresAt: NOW + 89 * DAY,
      accessSetBy: 'approval',
      request: { credential: { found: 'location', label: 'looker login', location: 'Looker' } },
      credentialLocation: 'Looker',
    }),
    row('asana', {
      approvalRefusal:
        'A documented intake queue changed; reject this card and re-run orientation before approval.',
    }),
    row('salesforce', {
      verdict: 'absent',
      path: undefined,
      reason: 'No approved surface found after searching: Salesforce',
    }),
    row('hubspot', {
      verdict: 'declared',
      path: undefined,
      discoveryEvidence: [
        {
          kind: 'documentation',
          ref: 'systems/hubspot.md',
          quote: '# HubSpot',
          current: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
        },
      ],
    }),
  ],
};

// jsdom lays nothing out and has no scrolling; the conversation's scroll to its newest message is
// the browser's.
Element.prototype.scrollTo = (): void => undefined;

afterEach((): void => {
  backend.queries = {};
  document.body.replaceChildren();
});

/** The environment is its own chunk; under a full suite it can take seconds to arrive. */
const CHUNK_WAIT = { timeout: 15_000 };

/** The tab rendered inside a page landmark, settled once its chunk has drawn `ready`. */
async function openTab(surfaceMode: 'mock' | 'real', ready: string) {
  const view = mount(<main>{asEmployee(<SurfacesView />, { surfaceMode })}</main>);
  await settle();
  await vi.waitFor((): void => {
    expect(view.container.textContent).toContain(ready);
  }, CHUNK_WAIT);
  for (const disclosure of view.container.querySelectorAll('details')) disclosure.open = true;
  await settle();
  return view;
}

/** The controls and standalone links whose own box, or the label wrapping them, is under 44 px. */
function underTarget(root: Element): string[] {
  const tall = /(^|\s)(min-h-11|h-11)(\s|$)/;
  const standalone = (control: Element): boolean =>
    control.tagName !== 'A' || control.closest('p, li, dd, td') === null;
  return [...root.querySelectorAll('button, input, select, textarea, summary, a[href]')]
    .filter((control) => (control as HTMLInputElement).type !== 'hidden')
    .filter(standalone)
    .filter(
      (control) =>
        !tall.test(control.getAttribute('class') ?? '') &&
        !tall.test(control.closest('label')?.getAttribute('class') ?? ''),
    )
    .map((control) => `${control.tagName.toLowerCase()} "${control.textContent?.trim()}"`);
}

/**
 * The scroll regions (every element whose class scrolls it, at any width) that are not both
 * named and reachable by keyboard: focusable themselves, or holding a control that is.
 */
function unreachableScrollRegions(root: Element): string[] {
  const scrolls = /(^|\s)(@?[a-z0-9]+:)?overflow(-[xy])?-auto(\s|$)/;
  const focusable = 'a[href], button, input, select, textarea, summary, [tabindex="0"]';
  return [...root.querySelectorAll('[class]')]
    .filter((element) => scrolls.test(element.getAttribute('class') ?? ''))
    .filter((element) => {
      const named = element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby');
      const reachable =
        element.getAttribute('tabindex') === '0' || element.querySelector(focusable) !== null;
      return !(named && reachable);
    })
    .map((element) => `${element.tagName.toLowerCase()}.${element.getAttribute('class')}`);
}

const OFFICE_TABS = ['Slack', 'Spreadsheet', 'Docs', 'Tickets', 'Social'] as const;

describe('the mock office on the Surfaces tab against the floor (N14)', (): void => {
  it.each(OFFICE_TABS)(
    'has no axe violation, 44 px targets and named, reachable scroll regions on its %s tab',
    async (label): Promise<void> => {
      backend.queries = { ...OFFICE };
      const view = await openTab('mock', 'Mock office');
      const tab = [...view.container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
        (candidate) => candidate.textContent?.startsWith(label),
      );
      act((): void => tab?.click());
      await settle();
      expect(tab?.getAttribute('aria-selected')).toBe('true');
      expect(await axeViolations(view.container, ['region'])).toEqual([]);
      expect(underTarget(view.container)).toEqual([]);
      expect(unreachableScrollRegions(view.container)).toEqual([]);
      view.unmount();
    },
    30_000,
  );

  it('opens on Slack at #revops-asks, where the asks arrive', async (): Promise<void> => {
    backend.queries = {
      ...OFFICE,
      'mock:listMessages': (args: unknown) =>
        (OFFICE['mock:listMessages'] as Array<{ channelSlug: string }>).filter(
          (message) => message.channelSlug === (args as { channelSlug: string }).channelSlug,
        ),
    };
    const view = await openTab('mock', 'Mock office');
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toMatch(
      /^Slack/,
    );
    expect(view.container.querySelector('[aria-current="true"]')?.textContent).toBe('#revops-asks');
    expect(view.container.textContent).toContain(
      'What does enterprise pipeline coverage look like?',
    );
    view.unmount();
  }, 30_000);
});

describe('the real-mode Surfaces tab against the floor (N14)', (): void => {
  it('has no axe violation with a card in every state, the office documentation and the permissions', async (): Promise<void> => {
    backend.queries = { ...OFFICE, ...SYSTEMS };
    const view = await openTab('real', 'How a system is reached');
    // The absent system and the one the charter does not name are listed beside the cards.
    expect(view.container.querySelectorAll('section[id^="surface-"]')).toHaveLength(6);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    view.unmount();
  }, 30_000);

  it('gives every control a 44 px target and every scroll region a name and a keyboard way in', async (): Promise<void> => {
    backend.queries = { ...OFFICE, ...SYSTEMS };
    const view = await openTab('real', 'How a system is reached');
    // The tools form and the access period open too, so their controls are checked.
    for (const toggle of view.container.querySelectorAll<HTMLElement>('[aria-expanded="false"]')) {
      act((): void => toggle.click());
    }
    await settle();
    expect(underTarget(view.container)).toEqual([]);
    expect(unreachableScrollRegions(view.container)).toEqual([]);
    view.unmount();
  }, 30_000);
});

/**
 * The access track's card states (wave 11, 11-AC): an MCP card IT connected, waiting on Connect
 * and acting as the manager; a GitHub card with no connection, showing its access request; a
 * connected card holding a credential, with Disconnect; and a Slack card acting as its own app.
 */
const ACCESS: Record<string, unknown> = {
  'organisationConnections:summaryForManager': {
    callerIsAdministrator: false,
    systems: [
      {
        system: 'mcp:docs.acme.test',
        displayName: 'Acme docs',
        mode: 'per-employee',
        status: 'active',
        connectedAt: NOW - 2 * DAY,
      },
      {
        system: 'slack',
        displayName: 'Slack',
        mode: 'per-employee',
        status: 'active',
        connectedAt: NOW - 2 * DAY,
      },
    ],
  },
  'accessRequests:forCard': (args: unknown) =>
    (args as { surfaceId: string }).surfaceId === 'surface-github'
      ? {
          system: 'github',
          reason: 'no-connection',
          scopes: ['github:read'],
          subject: 'Day0 access request: GitHub for Maya',
          text: 'Maya, a Day0 employee, needs access to GitHub.\nAccess needed: github:read.',
          mailto: 'mailto:?subject=Day0%20access%20request',
          draftedAt: NOW - DAY,
          copiedAt: NOW - DAY,
        }
      : null,
  'surfaces:listForAgent': [
    row('docs', {
      displayName: 'Acme docs',
      verdict: 'approved',
      endpoint: 'https://docs.acme.test/mcp',
      managerApprovedAt: NOW - DAY,
      expiresAt: NOW + 89 * DAY,
      accessSetBy: 'approval',
    }),
    row('github', {
      verdict: 'approved',
      path: 'documented-api',
      endpoint: 'https://api.github.com/',
      managerApprovedAt: NOW - DAY,
      expiresAt: NOW + 89 * DAY,
      accessSetBy: 'approval',
      request: { credential: { found: 'location', label: 'GitHub token', location: 'Access' } },
      credentialLocation: 'Access',
    }),
    row('slack', {
      class: 'chat',
      verdict: 'connected',
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      credentialLanded: true,
      credentialId: 'cred-slack',
      managerApprovedAt: NOW - 10 * DAY,
      expiresAt: NOW + 80 * DAY,
      accessSetBy: 'approval',
      actsAs: { kind: 'own-app', label: 'Maya (Day0)', providerIdentityId: 'U1' },
      organisationConnectionId: 'connection-slack',
    }),
  ],
};

describe("the access track's card states against the floor (wave 11, 11-AC; N14)", (): void => {
  it('has no axe violation and a 44 px target on every control with Connect, the request and Disconnect drawn', async (): Promise<void> => {
    backend.queries = { ...OFFICE, ...SYSTEMS, ...ACCESS };
    const view = await openTab('real', 'How a system is reached');
    const text = view.container.textContent ?? '';
    expect(text).toContain('Acts as');
    expect(text).toContain('Ask IT to connect Github');
    expect(text).toContain('Connect Acme docs');
    expect([...view.container.querySelectorAll('button')].map((b) => b.textContent)).toContain(
      'Disconnect',
    );
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  }, 30_000);

  it('opens the Disconnect dialog from the keyboard, against the floor, and Escape gives focus back', async (): Promise<void> => {
    backend.queries = { ...OFFICE, ...SYSTEMS, ...ACCESS };
    const view = await openTab('real', 'How a system is reached');
    const disconnect = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent === 'Disconnect',
    );
    disconnect?.focus();
    act((): void => disconnect?.click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Disconnect Slack?');
    expect(dialog?.textContent).toContain('its bot leaves every channel');
    expect(document.activeElement?.textContent).toBe('Keep it connected');
    expect(await axeViolations(document.body, ['region'])).toEqual([]);
    expect(underTarget(dialog as HTMLElement)).toEqual([]);
    act((): void => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(disconnect);
    view.unmount();
  }, 30_000);
});
