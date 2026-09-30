import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RecordLine } from '../../../app/components/RecordLine';

const AT = Date.UTC(2026, 8, 26, 6, 41);

describe('RecordLine', () => {
  it('is a list item: a dot, the event in words, and its time', () => {
    const html = renderToStaticMarkup(
      <RecordLine kind="landed" time={{ at: AT, label: '14:41' }}>
        One message posted to DM · Manager.
      </RecordLine>,
    );
    expect(html).toMatch(/^<li /);
    expect(html).toContain('One message posted to DM · Manager.');
    expect(html).toContain(`<time dateTime="${new Date(AT).toISOString()}"`);
    expect(html).toContain('>14:41</time>');
  });

  it('sets its time in a right-hand column where the line has room, and under the words where it has not (E D12)', () => {
    const html = renderToStaticMarkup(
      <RecordLine kind="landed" time={{ at: AT, label: '26 Sep 2026, 14:41' }}>
        One message posted to DM · Manager.
      </RecordLine>,
    );
    expect(html).toMatch(/^<li class="@container"><div class="/);
    const line = /^<li [^>]*><div class="([^"]*)"/.exec(html)?.[1].split(' ') ?? [];
    expect(line).toEqual(
      expect.arrayContaining([
        'grid-cols-[16px_minmax(0,1fr)]',
        '@md:grid-cols-[16px_minmax(0,1fr)_auto]',
        'items-baseline',
      ]),
    );
    const time = /<time [^>]*class="([^"]*)"/.exec(html)?.[1].split(' ') ?? [];
    expect(time).toEqual(
      expect.arrayContaining([
        'col-start-2',
        '@md:col-start-3',
        '@md:row-start-1',
        '@md:whitespace-nowrap',
      ]),
    );
    // Read after the words, as it was: the column is drawn, not reordered.
    expect(html.indexOf('One message')).toBeLessThan(html.indexOf('<time'));
  });

  it('holds its body in a div, so a line can carry a disclosure (m3)', () => {
    const html = renderToStaticMarkup(
      <RecordLine kind="noted">
        Payload kept.
        <details>
          <summary>Payload</summary>
        </details>
      </RecordLine>,
    );
    expect(html).toMatch(
      /<div class="[^"]*"><span class="sr-only">Noted: <\/span>Payload kept\.<details>/,
    );
  });

  it('carries no time for a line about a standing state', () => {
    expect(
      renderToStaticMarkup(<RecordLine kind="withheld">Skipped “Refresh the view”.</RecordLine>),
    ).not.toContain('<time');
  });

  it('colours the dot by what happened and says it for a reader who cannot see it', () => {
    const cases = [
      ['landed', '--color-ok', 'Landed'],
      ['refused', '--color-danger', 'Refused'],
      ['withheld', '--color-muted', 'Withheld'],
      ['held', '--color-warn', 'Held'],
      ['noted', '--color-accent', 'Noted'],
    ] as const;
    for (const [kind, colour, said] of cases) {
      const html = renderToStaticMarkup(
        <RecordLine kind={kind} time={{ at: AT, label: '14:41' }}>
          x
        </RecordLine>,
      );
      expect(html).toMatch(new RegExp(`<span aria-hidden="true" class="[^"]*${colour}`));
      expect(html).toContain(`<span class="sr-only">${said}: </span>`);
    }
  });
});
