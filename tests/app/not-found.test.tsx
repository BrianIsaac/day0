import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import NotFound from '../../app/not-found';

describe('the page for an address Day0 does not have', (): void => {
  const html = renderToStaticMarkup(<NotFound />);

  it('says so in a heading of its own, on the page and not on a blank sheet', (): void => {
    expect(html).toMatch(/<h1[^>]*>This page is not here<\/h1>/);
    expect(html).toContain('Check the address for a typing slip.');
  });

  it('gives one way back, to the home', (): void => {
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Back to Day0<\/a>/);
  });
});
