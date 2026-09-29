import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';

const docs = [
  {
    _id: 'doc-1',
    slug: 'revops-handbook',
    title: 'RevOps handbook',
    category: 'team-doc',
    markdown: '# RevOps handbook\n\nThe team.',
  },
];

// The seam is the Convex client: the page's own query returns one page, and
// the sources query it derives returns none.
vi.mock('convex/react', () => ({
  useQuery: (_query: unknown, args: Record<string, unknown> | undefined): unknown[] =>
    args !== undefined && 'sourceIds' in args ? [] : docs,
}));

import { DocsTab } from '../../../../../app/agent/[agentId]/mock/DocsTab';

const agentId = 'agent-1' as Id<'agents'>;

describe('the Docs pane', (): void => {
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
