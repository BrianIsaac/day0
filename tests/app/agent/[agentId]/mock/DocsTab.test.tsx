import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';

const client = vi.hoisted(() => ({
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
    results: [
      { _id: 'doc-1', slug: 'revops-handbook', title: 'RevOps handbook', category: 'team-doc' },
    ],
    status: client.status,
    loadMore: (): void => undefined,
  }),
  useQuery: (_query: unknown, args: Record<string, unknown> | 'skip'): unknown =>
    args !== 'skip' && 'sourceIds' in args ? [] : client.page,
}));

import { DocsTab, PAGE_STATES } from '../../../../../app/agent/[agentId]/mock/DocsTab';

const agentId = 'agent-1' as Id<'agents'>;

describe('the Docs pane', (): void => {
  afterEach((): void => {
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
