import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GitHubMark } from '../../../app/marketing/GitHubMark';

describe('the GitHub mark', () => {
  const html = renderToStaticMarkup(<GitHubMark />);

  it('links the repository and is named by its label, not by a word on screen', () => {
    expect(html).toContain('href="https://github.com/BrianIsaac/day0"');
    expect(html).toContain('aria-label="Day0 on GitHub"');
    expect(html.replace(/<[^>]+>/g, '')).toBe('');
  });

  it('draws the mark in the link colour and hides the drawing itself', () => {
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*class="[^"]*fill-current/);
  });
});
