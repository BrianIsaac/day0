/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';

/** One document as the list names it. */
interface Listed {
  readonly _id: string;
  readonly slug: string;
  readonly title: string;
  readonly category: string;
}

const HANDBOOK: Listed = {
  _id: 'doc-1',
  slug: 'revops-handbook',
  title: 'RevOps handbook',
  category: 'team-doc',
};

const client = vi.hoisted(() => ({
  /** The documents the list has loaded. */
  results: [] as Listed[],
  /** What the next "Show more" adds to them. */
  more: [] as Listed[],
  /** Where the list's paging stands. */
  status: 'Exhausted' as string,
  /** The open document as `getDoc` answers it: undefined while it loads, null once gone. */
  page: { slug: 'revops-handbook', body: '# RevOps handbook\n\nThe team.' } as
    | { slug: string; body: string; sourceUrl?: string }
    | null
    | undefined,
}));

// The seam is the Convex client: the list's one page names one document without its body, the
// open document is read whole, and the sources query the list derives returns none.
vi.mock('convex/react', () => ({
  usePaginatedQuery: () => ({
    results: client.results,
    status: client.status,
    loadMore: (): void => {
      client.results = [...client.results, ...client.more];
    },
  }),
  useQuery: (_query: unknown, args: Record<string, unknown> | 'skip'): unknown =>
    args !== 'skip' && 'sourceIds' in args ? [] : client.page,
}));

import { DocsTab, EMPTY_DOCS, PAGE_STATES } from '../../../../../app/agent/[agentId]/mock/DocsTab';
import { button, mount, unmountAll } from '../../../../fixtures/dom/press';

const agentId = 'agent-1' as Id<'agents'>;

describe('the Docs pane', (): void => {
  beforeEach((): void => {
    client.results = [HANDBOOK];
    client.more = [];
  });

  afterEach((): void => {
    unmountAll();
    client.status = 'Exhausted';
    client.page = { slug: 'revops-handbook', body: '# RevOps handbook\n\nThe team.' };
  });

  it('shows the open document as getDoc reads it, and says so while it loads or once it is gone (M17)', (): void => {
    expect(renderToStaticMarkup(<DocsTab agentId={agentId} mode="real" />)).toContain('The team.');
    client.page = undefined;
    expect(renderToStaticMarkup(<DocsTab agentId={agentId} mode="real" />)).toContain(
      PAGE_STATES.loading,
    );
    client.page = null;
    expect(renderToStaticMarkup(<DocsTab agentId={agentId} mode="real" />)).toContain(
      PAGE_STATES.gone,
    );
  });

  it('offers the next page, not the empty state, when a first page holds none the employee reads (M17)', (): void => {
    client.results = [];
    client.status = 'CanLoadMore';
    const markup = renderToStaticMarkup(<DocsTab agentId={agentId} mode="real" />);
    expect(markup).toContain('Show more documents');
    expect(markup).not.toContain(EMPTY_DOCS.real);
    client.status = 'Exhausted';
    expect(renderToStaticMarkup(<DocsTab agentId={agentId} mode="real" />)).toContain(
      EMPTY_DOCS.real,
    );
  });

  it('keeps the open document when the next page brings one that sorts before it (M17)', (): void => {
    client.status = 'CanLoadMore';
    client.more = [
      { _id: 'doc-0', slug: 'access-policy', title: 'Access policy', category: 'team-doc' },
    ];
    const view = mount(<DocsTab agentId={agentId} mode="real" />);
    act((): void => button(view.container, 'Show more documents').click());
    act((): void => view.root.render(<DocsTab agentId={agentId} mode="real" />));
    expect(view.container.querySelector('article')?.getAttribute('aria-label')).toBe(
      'Page: RevOps handbook',
    );
    expect(view.container.textContent).toContain('Access policy');
  });

  it('offers the next page of documents while there is one, and only then (M17)', (): void => {
    expect(renderToStaticMarkup(<DocsTab agentId={agentId} mode="real" />)).not.toContain(
      'Show more documents',
    );
    client.status = 'CanLoadMore';
    expect(renderToStaticMarkup(<DocsTab agentId={agentId} mode="real" />)).toContain(
      'Show more documents',
    );
    client.status = 'LoadingMore';
    const loading = renderToStaticMarkup(<DocsTab agentId={agentId} mode="real" />);
    expect(loading).toMatch(/<button[^>]*disabled=""[^>]*>Loading…<\/button>/);
  });

  it('makes the page viewer a focusable region named for its page, so a keyboard user can scroll it (wave 3.5 review X2)', (): void => {
    const markup = renderToStaticMarkup(<DocsTab agentId={agentId} mode="real" />);
    const article = /<article[^>]*>/.exec(markup)?.[0];
    expect(article).toBeDefined();
    expect(article).toContain('tabindex="0"');
    expect(article).toContain('aria-label="Page: RevOps handbook"');
  });

  it('puts the documents in a named navigation list beside the page only when the panel is wide, never an aside inside main', (): void => {
    const markup = renderToStaticMarkup(<DocsTab agentId={agentId} mode="real" />);
    expect(markup).not.toContain('<aside');
    expect(markup).toMatch(/<nav aria-label="Documents"/);
    expect(markup).toContain('grid grid-cols-1 @lg:grid-cols-[12rem_1fr]');
    expect(markup).toMatch(/<button type="button" aria-current="true" class="min-h-11 /);
  });

  it('bounds its own two columns in the real-mode card, so the list and the page scroll apart, and fills the office panel in mock mode', (): void => {
    const grid = (mode: 'mock' | 'real'): string =>
      /<div class="(grid grid-cols-1[^"]*)"/.exec(
        renderToStaticMarkup(<DocsTab agentId={agentId} mode={mode} />),
      )?.[1] ?? '';
    expect(grid('real')).toMatch(/(^|\s)@lg:max-h-\[32rem\](\s|$)/);
    expect(grid('real')).not.toMatch(/(^|\s)h-full(\s|$)/);
    expect(grid('mock')).toMatch(/(^|\s)h-full(\s|$)/);
    for (const mode of ['mock', 'real'] as const) {
      expect(grid(mode)).toContain('@lg:grid-rows-[minmax(0,1fr)]');
    }
  });
});
