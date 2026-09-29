import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DISCLOSURE_SUMMARY, Disclosure } from '../../../app/components/Disclosure';

describe('Disclosure', () => {
  it('is a native details, closed unless asked, its summary in words', () => {
    const html = renderToStaticMarkup(<Disclosure summary="Exact payload">{'{}'}</Disclosure>);
    expect(html).toMatch(/^<details class="group"><summary/);
    expect(html).toContain('Exact payload</summary>');
    expect(html).not.toContain(' open=""');
    expect(
      renderToStaticMarkup(
        <Disclosure summary="s" open>
          x
        </Disclosure>,
      ),
    ).toContain('open=""');
  });

  it('gives its summary a 44 px target (N14), as the summary a card draws itself does', () => {
    expect(renderToStaticMarkup(<Disclosure summary="s">x</Disclosure>)).toMatch(
      /<summary class="[^"]*\bmin-h-11\b/,
    );
    expect(DISCLOSURE_SUMMARY).toMatch(/\bmin-h-11\b/);
  });

  it('turns its chevron as it opens, never where motion is unwelcome, and hides it from a reader', () => {
    const html = renderToStaticMarkup(<Disclosure summary="s">x</Disclosure>);
    expect(html).toContain('group-open:rotate-45');
    expect(html).toContain('motion-reduce:transition-none');
    expect(html).toMatch(/<span aria-hidden="true"/);
  });
});
