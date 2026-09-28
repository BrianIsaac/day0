import { renderToStaticMarkup } from 'react-dom/server';
import { ConvexError } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { LiveStatus, refusalText } from '../../../../app/agent/[agentId]/live-status';

describe('the live region beside a dashboard control', (): void => {
  it('is in the page before anything is said, so the first outcome is announced', (): void => {
    const markup = renderToStaticMarkup(<LiveStatus outcome={null} />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toMatch(/<p [^>]*><\/p>/);
  });

  it('says what a change came to, and marks a refusal as one', (): void => {
    expect(
      renderToStaticMarkup(<LiveStatus outcome={{ tone: 'done', text: 'Access renewed.' }} />),
    ).toContain('>Access renewed.</p>');
    expect(
      renderToStaticMarkup(<LiveStatus outcome={{ tone: 'refused', text: 'Not a zone.' }} />),
    ).toContain('text-[var(--color-danger)]');
  });
});

describe('the words of a refusal', (): void => {
  it("reads a ConvexError's data, an error's message, and falls back when there are none", (): void => {
    expect(refusalText(new ConvexError('Mars/Olympus is not a time zone.'), 'x')).toBe(
      'Mars/Olympus is not a time zone.',
    );
    expect(refusalText(new Error('Surface not found.'), 'x')).toBe('Surface not found.');
    expect(refusalText(new Error(''), 'The zone was not changed.')).toBe(
      'The zone was not changed.',
    );
    expect(refusalText('boom', 'The zone was not changed.')).toBe('The zone was not changed.');
  });
});
