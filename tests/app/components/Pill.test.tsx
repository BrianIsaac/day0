import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Pill } from '../../../app/components/Pill';

describe('Pill', () => {
  it("draws the employee's state fully rounded in its tone", () => {
    const html = renderToStaticMarkup(<Pill tone="ok">Active · Supervised</Pill>);
    expect(html).toContain('>Active · Supervised</span>');
    expect(html).toMatch(/\brounded-full\b/);
    expect(html).toContain('text-[var(--color-ok)]');
  });

  it('outlines a plain pill on the page, with no fill', () => {
    const html = renderToStaticMarkup(<Pill>mock office</Pill>);
    expect(html).toContain('border-[var(--color-border)]');
    expect(html).not.toContain('/15');
  });
});
