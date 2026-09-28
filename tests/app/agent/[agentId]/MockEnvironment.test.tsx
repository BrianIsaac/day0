/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const queries = vi.hoisted(() => ({
  mode: 'mock' as 'mock' | 'real' | undefined,
  surfacesLoaded: true,
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown => {
    const name = getFunctionName(reference as never);
    if (name === 'config:surfaceMode') {
      if (queries.mode === undefined) return undefined;
      return { mode: queries.mode, label: queries.mode === 'real' ? 'real (local)' : 'mock' };
    }
    if (args === 'skip') return undefined;
    if (
      !queries.surfacesLoaded &&
      ['surfaces:listForAgent', 'docSources:pagesForAgent'].includes(name)
    ) {
      return undefined;
    }
    if (name === 'surfaces:listForAgent') return [{ slug: 'linear' }];
    if (name === 'mock:listDocs') {
      return [
        {
          _id: 'doc-1',
          slug: 'doc',
          title: 'Operating handbook',
          body: 'How the team works.',
          category: 'team-doc',
        },
        {
          _id: 'doc-2',
          slug: 'doc-2',
          title: 'Linear automation',
          body: 'How work enters the queue.',
          category: 'how-to-guide',
        },
      ];
    }
    return [];
  },
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

import type { Id } from '../../../../convex/_generated/dataModel';
import {
  activeTabForEnvironment,
  MockEnvironment,
  tabFromHash,
} from '../../../../app/agent/[agentId]/MockEnvironment';
import { LOADING_SURFACES } from '../../../../app/agent/[agentId]/mock/SurfacesTab';

const agentId = 'agent-1' as Id<'agents'>;

describe('MockEnvironment caption and tabs', (): void => {
  it('says the surfaces are mock and shows no Surfaces tab in mock mode', (): void => {
    queries.mode = 'mock';
    const markup = renderToStaticMarkup(<MockEnvironment agentId={agentId} />);
    expect(markup).toContain('Mock work environment');
    expect(markup).toContain('Mock surfaces - when the agent runs a skill');
    expect(markup).not.toContain('Surfaces');
    expect(markup).not.toContain('real mode');
    expect(markup).toContain('Q4 Revenue Tracker');
    expect(markup).toContain('Linear-style queue');
  });

  it('shows only readable documentation and discovered surfaces in real mode', (): void => {
    queries.mode = 'real';
    const markup = renderToStaticMarkup(<MockEnvironment agentId={agentId} />);
    expect(markup).toContain('>Enterprise context<');
    expect(markup).toContain(
      'Documentation day0 can read, and the connection status of every system it has discovered',
    );
    expect(markup).toContain('>Docs<');
    expect(markup).toContain('>Surfaces<');
    expect(markup).toContain('linked documentation');
    expect(markup).toContain('connections + evidence');
    expect(markup).toContain('Operating handbook');
    expect(markup).not.toContain('>Slack<');
    expect(markup).not.toContain('>Spreadsheet<');
    expect(markup).not.toContain('>Twitter<');
    expect(markup).not.toContain('>Tickets<');
    expect(markup).not.toContain('mock-only');
  });
});

describe('the tab strip and the panel for a keyboard and a screen reader (step 45, P10-4)', (): void => {
  it('marks the selected tab in words, not colour alone, gives each tab a 44 px target and names the panel', (): void => {
    queries.mode = 'real';
    const markup = renderToStaticMarkup(<MockEnvironment agentId={agentId} />);
    expect(markup).toMatch(/<nav aria-label="Work environment"/);
    const tabs = [
      ...markup.matchAll(/<button type="button" aria-pressed="(true|false)" class="([^"]*)"/g),
    ];
    expect(tabs.map((tab) => tab[1])).toEqual(['true', 'false']);
    for (const tab of tabs) expect(tab[2]).toMatch(/\bmin-h-11\b/);
    expect(markup).toMatch(/<div id="surfaces" tabindex="0" role="region" aria-label="Docs tab"/);
  });
});

describe('the hash links the work cards carry', (): void => {
  // Resolved by path: under jsdom, Vite rewrites `new URL(path, import.meta.url)`
  // into a served asset address rather than a file.
  const dashboard = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../app/agent/[agentId]/AgentDashboard.tsx',
    ),
    'utf8',
  );
  const hashes = [...dashboard.matchAll(/href="#([a-z-]+)"/g)].map((match) => match[1]);

  it('each name an element the environment panel renders, so the link scrolls as well as switching the tab', (): void => {
    expect(hashes).toContain('surfaces');
    queries.mode = 'real';
    const markup = renderToStaticMarkup(<MockEnvironment agentId={agentId} />);
    for (const hash of new Set(hashes)) {
      expect(markup).toContain(`id="${hash}"`);
    }
  });
});

describe('tab selection from the location hash', (): void => {
  it('names a tab from the hash the card link carries', (): void => {
    expect(tabFromHash('#surfaces', true)).toBe('surfaces');
    expect(tabFromHash('surfaces', true)).toBe('surfaces');
    expect(tabFromHash('#Docs', true)).toBe('docs');
    expect(tabFromHash('#tickets', false)).toBe('tickets');
  });

  it('ignores hashes that name no tab, and the Surfaces tab outside real mode', (): void => {
    expect(tabFromHash('', true)).toBeUndefined();
    expect(tabFromHash('#work-item-1', true)).toBeUndefined();
    expect(tabFromHash('#%E0%A4%A', true)).toBeUndefined();
    expect(tabFromHash('#surfaces', false)).toBeUndefined();
    expect(tabFromHash('#slack', true)).toBeUndefined();
    expect(tabFromHash('#spreadsheet', true)).toBeUndefined();
    expect(tabFromHash('#tweet', true)).toBeUndefined();
    expect(tabFromHash('#tickets', true)).toBeUndefined();
  });

  it('keeps the active tab valid when the resolved mode changes', (): void => {
    expect(activeTabForEnvironment('surfaces', '#surfaces', false)).toBe('slack');
    expect(activeTabForEnvironment('docs', '#unknown', false)).toBe('docs');
    expect(activeTabForEnvironment('slack', '#surfaces', true)).toBe('surfaces');
    expect(activeTabForEnvironment('slack', '#unknown', true)).toBe('docs');
    expect(activeTabForEnvironment('tickets', '', true)).toBe('docs');
  });
});

describe('a cold load whose hash names a tab', (): void => {
  const scrolled: Element[] = [];
  let root: Root | undefined;
  let container: HTMLElement | undefined;

  function mount(): void {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView = function (this: Element): void {
      scrolled.push(this);
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act((): void => root?.render(<MockEnvironment agentId={agentId} />));
  }

  afterEach((): void => {
    act((): void => root?.unmount());
    container?.remove();
    scrolled.length = 0;
    queries.surfacesLoaded = true;
    window.history.replaceState(null, '', '/');
  });

  it('selects the tab and scrolls to the panel, as the Slack OAuth redirect needs', (): void => {
    queries.mode = 'real';
    queries.surfacesLoaded = false;
    window.history.replaceState(null, '', '/agent/agent-1?install=installed#surfaces');
    mount();
    expect(container?.textContent).toContain(LOADING_SURFACES);
    expect(scrolled.map((element) => element.id)).toEqual(['surfaces']);
  });

  it('scrolls once the deployment mode resolves, and not again on a later hash change', (): void => {
    queries.mode = undefined;
    queries.surfacesLoaded = false;
    window.history.replaceState(null, '', '/agent/agent-1#surfaces');
    mount();
    expect(scrolled).toEqual([]);
    queries.mode = 'real';
    act((): void => root?.render(<MockEnvironment agentId={agentId} />));
    expect(container?.textContent).toContain(LOADING_SURFACES);
    expect(scrolled.map((element) => element.id)).toEqual(['surfaces']);
    act((): void => {
      window.history.replaceState(null, '', '/agent/agent-1#docs');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(scrolled.map((element) => element.id)).toEqual(['surfaces']);
  });

  it('does not scroll when the hash names no tab', (): void => {
    queries.mode = 'real';
    window.history.replaceState(null, '', '/agent/agent-1#work-item-1');
    mount();
    expect(scrolled).toEqual([]);
  });
});
