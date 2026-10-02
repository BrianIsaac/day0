import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusRegion } from '../../../app/components/StatusRegion';

describe('StatusRegion', (): void => {
  it('is in the page before anything is said, so the first outcome is announced', (): void => {
    const markup = renderToStaticMarkup(<StatusRegion outcome={null} />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toMatch(/<p [^>]*><\/p>/);
    // Empty, it holds no space in a spaced column, and it is still in the page.
    expect(markup).toContain('empty:sr-only');
  });

  it('says what a change came to, and marks a refusal as one', (): void => {
    expect(
      renderToStaticMarkup(<StatusRegion outcome={{ tone: 'done', text: 'Access renewed.' }} />),
    ).toContain('>Access renewed.</p>');
    expect(
      renderToStaticMarkup(<StatusRegion outcome={{ tone: 'refused', text: 'Not a zone.' }} />),
    ).toContain('text-[var(--color-danger)]');
  });

  it('says it at the 12 px floor, never below it (round two section 4.2)', (): void => {
    const markup = renderToStaticMarkup(
      <StatusRegion outcome={{ tone: 'done', text: 'Saved.' }} />,
    );
    expect(markup).toMatch(/\btext-xs\b/);
    expect(markup).not.toMatch(/text-\[(9|10|11)px\]/);
  });

  it('wraps a long unbroken name rather than widen the page at 390 px (the second pass)', (): void => {
    const markup = renderToStaticMarkup(
      <StatusRegion outcome={{ tone: 'done', text: 'kanban-comment-and-close-everywhere.' }} />,
    );
    expect(markup).toMatch(/\bbreak-words\b/);
  });
});
