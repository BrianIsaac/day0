import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandMark } from '../../../app/marketing/BrandMark';

/** Every `<rect>` in a piece of SVG markup, as its geometry attributes in document order. */
function rects(svg: string): string[] {
  return [...svg.matchAll(/<rect\b([^>]*)\/?>/g)].map((match) =>
    ['x', 'y', 'width', 'height', 'rx']
      .map((name) => `${name}=${new RegExp(`\\b${name}="([^"]*)"`).exec(match[1] ?? '')?.[1]}`)
      .join(' '),
  );
}

describe('the header mark', () => {
  const icon = readFileSync(new URL('../../../app/icon.svg', import.meta.url), 'utf8');
  const mark = renderToStaticMarkup(<BrandMark className="size-5" />);

  it('draws exactly the geometry of the favicon, on the same 16-unit grid', () => {
    expect(rects(mark)).toEqual(rects(icon));
    expect(mark).toContain('viewBox="0 0 16 16"');
  });

  it('takes its colours from the theme and hides itself from assistive technology', () => {
    expect(mark).toContain('fill-[var(--color-accent)]');
    expect(mark).toContain('fill-[var(--color-bg)]');
    expect(mark).toContain('aria-hidden="true"');
  });
});
