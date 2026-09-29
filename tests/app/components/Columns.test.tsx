import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Columns } from '../../../app/components/Columns';

describe('Columns', () => {
  it('sets an aside a third as wide beside the main column on a wide window', () => {
    const html = renderToStaticMarkup(
      <Columns aside={<p>aside</p>}>
        <p>main</p>
      </Columns>,
    );
    expect(html).toContain('lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]');
    expect(html.indexOf('main')).toBeLessThan(html.indexOf('aside'));
  });

  it('gives the main column the whole width without an aside', () => {
    const html = renderToStaticMarkup(
      <Columns>
        <p>main</p>
      </Columns>,
    );
    expect(html).not.toContain('lg:grid-cols');
    expect(html.match(/<div data-cards|<div class/g)).toHaveLength(2);
  });

  it('marks both columns for the arrival only while the page is arriving', () => {
    const arriving = renderToStaticMarkup(
      <Columns arriving aside={<p>aside</p>}>
        <p>main</p>
      </Columns>,
    );
    expect(arriving.match(/data-cards=""/g)).toHaveLength(2);
    expect(
      renderToStaticMarkup(
        <Columns aside={<p>aside</p>}>
          <p>main</p>
        </Columns>,
      ),
    ).not.toContain('data-cards');
  });
});
