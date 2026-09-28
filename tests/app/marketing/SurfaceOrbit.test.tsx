import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SurfaceOrbit } from '../../../app/marketing/SurfaceOrbit';

describe('the hero orbit', () => {
  const html = renderToStaticMarkup(<SurfaceOrbit />);

  it('keeps the five surfaces and the Day0 centre the product has always drawn', () => {
    for (const label of ['docs', 'spreadsheet', 'slack', 'tickets', 'twitter', 'DAY0']) {
      expect(html).toContain(`>${label}</text>`);
    }
    expect(html).toContain('role="img"');
  });

  it('puts both rings in the one wrapper that turns with the scroll', () => {
    const rings =
      /<div data-orbit-rings=""[^>]*>([\s\S]*?)<\/div><\/div><div style/.exec(html)?.[1] ?? '';
    expect([...rings.matchAll(/class="absolute inset-0 day0-surface-orbit/g)]).toHaveLength(2);
  });

  it('gives the centre dot its own layer, so it can pulse once without moving the ring', () => {
    expect(html).toMatch(/day0-orbit-dot"><svg[^>]*><circle cx="300" cy="300" r="6"/);
  });

  it('staggers the surfaces and packets in whole milliseconds, with no float noise', () => {
    const delays = [...html.matchAll(/--(?:surface|packet)-delay:([^;"]*)/g)].map(
      ([, value]) => value,
    );
    expect(delays).toEqual([
      '600ms',
      '1050ms',
      '1500ms',
      '1950ms',
      '2400ms',
      '4000ms',
      '6400ms',
      '8800ms',
      '11200ms',
      '13600ms',
    ]);
  });
});
