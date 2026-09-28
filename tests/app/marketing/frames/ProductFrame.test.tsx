import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Chip, ProductFrame } from '../../../../app/marketing/frames/ProductFrame';

describe('the product frame', () => {
  it('captions the screen and keeps its window dots from assistive technology', () => {
    const html = renderToStaticMarkup(
      <ProductFrame caption="Documentation · 2 sources">
        <p>body</p>
      </ProductFrame>,
    );
    expect(html).toContain('>Documentation · 2 sources</span>');
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>(<i [^>]*><\/i>){3}<\/span>/);
    expect(html).toContain('<p>body</p>');
  });

  it('draws a chip in the state colour it names', () => {
    expect(renderToStaticMarkup(<Chip tone="danger">Struck</Chip>)).toContain(
      'text-[var(--color-danger)]',
    );
  });
});
