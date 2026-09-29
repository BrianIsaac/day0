import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Chip } from '../../../app/components/Chip';

describe('Chip', () => {
  it('draws the label in its tone on a fill of the same hue', () => {
    const html = renderToStaticMarkup(<Chip tone="warn">Held</Chip>);
    expect(html).toContain('>Held</span>');
    expect(html).toContain('bg-[var(--color-warn)]/15');
    expect(html).toContain('text-[var(--color-warn)]');
  });

  it('reads as a label, upper case at the 12 px floor, never as a control', () => {
    const html = renderToStaticMarkup(<Chip>Skipped</Chip>);
    expect(html).toMatch(/^<span /);
    expect(html).toMatch(/\buppercase\b/);
    expect(html).toMatch(/\btext-xs\b/);
  });

  it('leads with a dot only when asked, hidden from a screen reader', () => {
    expect(renderToStaticMarkup(<Chip>Idle</Chip>)).not.toContain('<i');
    expect(renderToStaticMarkup(<Chip dot>Working</Chip>)).toMatch(/<i aria-hidden="true"/);
  });

  it("marks the manager's own row in the page's text colour", () => {
    expect(renderToStaticMarkup(<Chip tone="you">you</Chip>)).toContain('text-[var(--color-fg)]');
  });
});
