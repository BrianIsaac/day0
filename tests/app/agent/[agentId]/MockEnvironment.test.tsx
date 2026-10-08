/** @vitest-environment jsdom */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withListedIdentity } from './surfaces/fakes/listed-identity';

const queries = vi.hoisted(() => ({
  surfacesLoaded: true,
  /** A third document the employee has just written, when set. */
  newDoc: false,
}));

vi.mock('convex/react', () => {
  /** The office's documents, the list's page and each open document alike. */
  const officeDocs = (): Array<{
    _id: string;
    slug: string;
    title: string;
    body: string;
    category: string;
  }> => [
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
    ...(queries.newDoc
      ? [
          {
            _id: 'doc-3',
            slug: 'doc-3',
            title: 'Close checklist',
            body: 'What the close needs.',
            category: 'how-to-guide',
          },
        ]
      : []),
  ];
  return {
    usePaginatedQuery: (reference: unknown) => ({
      results: getFunctionName(reference as never) === 'mock:listDocs' ? officeDocs() : [],
      status: 'Exhausted',
      loadMore: (): void => undefined,
    }),
    useQuery: (reference: unknown, args: unknown): unknown => {
      const name = getFunctionName(reference as never);
      if (args === 'skip') return undefined;
      if (!queries.surfacesLoaded && name === 'surfaces:listForAgent') return undefined;
      if (name === 'surfaces:listForAgent') {
        return [
          {
            _id: 'surface-linear',
            slug: 'linear',
            displayName: 'Linear',
            class: 'kanban',
            verdict: 'declared',
            whereFound: [],
            credentialLanded: false,
          },
        ].map((row) => withListedIdentity(row));
      }
      if (name === 'charters:latest') return null;
      // The tab reads the list a page at a time and the open document whole (M17).
      if (name === 'mock:getDoc') {
        return officeDocs().find((doc) => doc.slug === (args as { slug: string }).slug) ?? null;
      }
      return [];
    },
    useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
    useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  };
});

import type { Id } from '../../../../convex/_generated/dataModel';
import { MockEnvironment } from '../../../../app/agent/[agentId]/MockEnvironment';
import { ROLL_MS } from '../../../../app/components/RollingCount';
import { LOADING_SURFACES } from '../../../../app/agent/[agentId]/surfaces/SurfaceCards';
import type { SurfaceMode } from '../../../../src/surfaces/types';

const agentId = 'agent-1' as Id<'agents'>;

/** The environment rendered to markup in one mode. */
const markupIn = (mode: SurfaceMode): string =>
  renderToStaticMarkup(<MockEnvironment agentId={agentId} employeeName="Maya" mode={mode} />);

describe('MockEnvironment caption and tabs', (): void => {
  it('says the office is the seeded mock and shows no Surfaces tab in mock mode', (): void => {
    const markup = markupIn('mock');
    expect(markup).toMatch(/<h2[^>]*>Hosted office<\/h2>/);
    expect(markup).toContain('the seeded workplace this employee works in');
    expect([...markup.matchAll(/role="tab"[^>]*>([A-Za-z]+)/g)].map((tab) => tab[1])).toEqual([
      'Slack',
      'Spreadsheet',
      'Docs',
      'Tickets',
      'Social',
    ]);
    expect(markup).not.toContain('Surfaces');
    expect(markup).not.toContain('real mode');
  });

  it('shows only the discovered systems and readable documentation in real mode', (): void => {
    const markup = markupIn('real');
    expect(markup).toContain('<section id="surfaces" aria-label="Systems"');
    expect(markup).toMatch(
      /<section id="surface-linear" aria-labelledby="[^"]+" tabindex="-1" data-verdict="declared"/,
    );
    expect(markup).toMatch(/<h2[^>]*>Documentation it reads<\/h2>/);
    expect(markup).toContain('Operating handbook');
    expect(markup).toMatch(/<h2[^>]*>Permissions<\/h2>/);
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('Hosted office');
    expect(markup).not.toContain('mock-only');
  });

  it('says it is loading, not the mock office, while the mode is unknown', (): void => {
    const markup = renderToStaticMarkup(
      <MockEnvironment agentId={agentId} employeeName="Maya" mode={undefined} />,
    );
    expect(markup).toContain('Loading the work environment');
    expect(markup).not.toContain('Hosted office');
  });
});

describe('whom the employee acts as in the hosted office (wave 11, 11-AC)', (): void => {
  it("says over every mock surface that it acts as the employee's own app in this office", (): void => {
    expect(markupIn('mock')).toContain(
      '<dt class="text-[13px] text-[var(--color-muted)]">Acts as</dt><dd class="min-w-0 text-[var(--color-fg-2)]">Maya, its own app in this office</dd>',
    );
  });
});

describe('the tab strip and the panel for a keyboard and a screen reader (step 45, P10-4)', (): void => {
  it('marks the selected tab in words, not colour alone, gives each tab a 44 px target and names the panel', (): void => {
    const markup = markupIn('mock');
    expect(markup).toMatch(/<div role="tablist" aria-label="Hosted office"/);
    const tabs = [
      ...markup.matchAll(
        /<button id="([^"]+)" type="button" role="tab" aria-selected="(true|false)"[^>]*class="([^"]*)"/g,
      ),
    ];
    expect(tabs.map((tab) => tab[2])).toEqual(['true', 'false', 'false', 'false', 'false']);
    for (const tab of tabs) expect(tab[3]).toMatch(/\bh-11\b/);
    expect(markup).toMatch(
      /<div id="surfaces" role="tabpanel" tabindex="0" aria-labelledby="surfaces-slack"/,
    );
  });

  it('moves along the strip with the arrow keys, Home and End, selecting as it goes', (): void => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act((): void =>
      root.render(<MockEnvironment agentId={agentId} employeeName="Maya" mode="mock" />),
    );
    const tab = (): HTMLElement | null =>
      container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    const press = (key: string): void => {
      act((): void => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    };
    tab()?.focus();
    press('ArrowRight');
    expect(tab()?.textContent).toMatch(/^Spreadsheet/);
    expect(document.activeElement).toBe(tab());
    press('End');
    expect(tab()?.textContent).toMatch(/^Social/);
    press('ArrowRight');
    expect(tab()?.textContent).toMatch(/^Slack/);
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(
      'surfaces-slack',
    );
    act((): void => root.unmount());
    container.remove();
  });
});

describe('the hash links the work cards carry', (): void => {
  // Resolved by path: under jsdom, Vite rewrites `new URL(path, import.meta.url)`
  // into a served asset address rather than a file.
  // Every module of the employee page, since the cards that carry the links live in its tabs.
  const pageDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../app/agent/[agentId]',
  );
  const dashboard = readdirSync(pageDirectory, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => readFileSync(resolve(pageDirectory, file), 'utf8'))
    .join('\n');
  const hashes = [...dashboard.matchAll(/href="#([a-z-]+)"/g)].map((match) => match[1]);

  it('each name an element the environment panel renders, so the link scrolls as well as switching the tab', (): void => {
    expect(hashes).toContain('surfaces');
    const markup = markupIn('real');
    for (const hash of new Set(hashes)) {
      expect(markup).toContain(`id="${hash}"`);
    }
  });
});

describe('a cold load whose hash names a tab', (): void => {
  const scrolled: Element[] = [];
  let root: Root | undefined;
  let container: HTMLElement | undefined;

  function mount(mode: SurfaceMode | undefined): void {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView = function (this: Element): void {
      scrolled.push(this);
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act((): void =>
      root?.render(<MockEnvironment agentId={agentId} employeeName="Maya" mode={mode} />),
    );
  }

  afterEach((): void => {
    act((): void => root?.unmount());
    container?.remove();
    scrolled.length = 0;
    queries.surfacesLoaded = true;
    window.history.replaceState(null, '', '/');
  });

  it('selects the tab and scrolls to the panel, as the Slack OAuth redirect needs', (): void => {
    queries.surfacesLoaded = false;
    window.history.replaceState(null, '', '/agent/agent-1?install=installed#surfaces');
    mount('real');
    expect(container?.textContent).toContain(LOADING_SURFACES);
    expect(scrolled.map((element) => element.id)).toEqual(['surfaces']);
  });

  it('scrolls once the deployment mode resolves, and not again on a later hash change', (): void => {
    queries.surfacesLoaded = false;
    window.history.replaceState(null, '', '/agent/agent-1#surfaces');
    mount(undefined);
    expect(scrolled).toEqual([]);
    act((): void =>
      root?.render(<MockEnvironment agentId={agentId} employeeName="Maya" mode="real" />),
    );
    expect(container?.textContent).toContain(LOADING_SURFACES);
    expect(scrolled.map((element) => element.id)).toEqual(['surfaces']);
    act((): void => {
      window.history.replaceState(null, '', '/agent/agent-1#docs');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(scrolled.map((element) => element.id)).toEqual(['surfaces']);
  });

  it('does not scroll when the hash names no tab', (): void => {
    window.history.replaceState(null, '', '/agent/agent-1#work-item-1');
    mount('real');
    expect(scrolled).toEqual([]);
  });
});

describe('a tab count that changes on the page (v3 section 5.2)', (): void => {
  let root: Root | undefined;

  afterEach((): void => {
    act((): void => root?.unmount());
    root = undefined;
    queries.newDoc = false;
    document.body.replaceChildren();
  });

  /** The Docs tab's badge. */
  const docsBadge = (): Element | null | undefined =>
    [...document.querySelectorAll('[role="tablist"][aria-label="Hosted office"] [role="tab"]')]
      .find((tab) => tab.textContent?.startsWith('Docs'))
      ?.querySelector('span.rounded-full');

  it('shows its first figure still, then rolls the old figure out as the new one rolls in', (): void => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act((): void =>
      root?.render(
        <MockEnvironment agentId={'agent-1' as Id<'agents'>} employeeName="Maya" mode="mock" />,
      ),
    );
    expect(docsBadge()?.innerHTML).toBe('2');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      queries.newDoc = true;
      act((): void =>
        root?.render(
          <MockEnvironment agentId={'agent-1' as Id<'agents'>} employeeName="Maya" mode="mock" />,
        ),
      );
      const roll = docsBadge()?.querySelector('.roll');
      expect(roll?.querySelector('.from')?.textContent).toBe('2');
      expect(roll?.querySelector('.from')?.getAttribute('aria-hidden')).toBe('true');
      expect(roll?.querySelector('.to')?.textContent).toBe('3');

      // Once rolled, the badge holds the new figure alone: nothing to replay, no old width.
      act((): void => {
        vi.advanceTimersByTime(ROLL_MS);
      });
      expect(docsBadge()?.innerHTML).toBe('3');
    } finally {
      vi.useRealTimers();
    }
  });
});
