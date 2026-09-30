import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HostedDemoNotice } from '../../app/HostedDemoNotice';
import { HOSTED_DEMO_NOTICE } from '../../src/demo/hosted-notice';

describe('HostedDemoNotice', () => {
  const html = renderToStaticMarkup(<HostedDemoNotice />).replace(/&#x27;/g, "'");

  it('is a note with the heading, every paragraph and the link to the disclosures', () => {
    expect(html).toMatch(/^<div role="note"/);
    expect(html).toContain(
      `<strong class="font-semibold text-[var(--color-fg)]">${HOSTED_DEMO_NOTICE.heading}</strong>`,
    );
    for (const paragraph of HOSTED_DEMO_NOTICE.paragraphs)
      expect(html).toContain(`<p>${paragraph}</p>`);
    expect(html).toContain(`href="${HOSTED_DEMO_NOTICE.link.href}"`);
    // Inside a sentence, so the link keeps the text's size under WCAG's inline exception.
    expect(html).toContain(
      `<p>${HOSTED_DEMO_NOTICE.link.before}<a href="${HOSTED_DEMO_NOTICE.link.href}"`,
    );
    expect(html).toContain(
      `>${HOSTED_DEMO_NOTICE.link.label}</a>${HOSTED_DEMO_NOTICE.link.after}</p>`,
    );
  });

  it('underlines its link in the link line, turning accent on hover (second review w5)', () => {
    const link = new RegExp(`<a href="${HOSTED_DEMO_NOTICE.link.href}"[^>]*>`).exec(html)?.[0];
    expect(link).toContain('decoration-[var(--color-link-line)]');
    expect(link).toContain('hover:decoration-[var(--color-accent)]');
  });
});
