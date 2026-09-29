import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RecordLine } from '../../../app/components/RecordLine';

const AT = Date.UTC(2026, 8, 26, 6, 41);

describe('RecordLine', () => {
  it('is a list item: a dot, the event in words, and its time', () => {
    const html = renderToStaticMarkup(
      <RecordLine kind="landed" at={AT} when="14:41">
        One message posted to DM · Manager.
      </RecordLine>,
    );
    expect(html).toMatch(/^<li /);
    expect(html).toContain('One message posted to DM · Manager.');
    expect(html).toContain(`<time dateTime="${new Date(AT).toISOString()}"`);
    expect(html).toContain('>14:41</time>');
  });

  it('colours the dot by what happened and says it for a reader who cannot see it', () => {
    const cases = [
      ['landed', '--color-ok', 'Landed'],
      ['refused', '--color-danger', 'Refused'],
      ['withheld', '--color-muted', 'Withheld'],
      ['held', '--color-warn', 'Held for you'],
      ['noted', '--color-accent', 'Noted'],
    ] as const;
    for (const [kind, colour, said] of cases) {
      const html = renderToStaticMarkup(
        <RecordLine kind={kind} at={AT} when="14:41">
          x
        </RecordLine>,
      );
      expect(html).toMatch(new RegExp(`<span aria-hidden="true" class="[^"]*${colour}`));
      expect(html).toContain(`<span class="sr-only">${said}: </span>`);
    }
  });
});
