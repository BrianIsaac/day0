import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunParagraph } from '../../../app/walkthrough/RunParagraph';

describe('RunParagraph', () => {
  it('renders code spans in the mono face, bold as strong and the rest as text', () => {
    const html = renderToStaticMarkup(
      <p>
        <RunParagraph
          text={[
            { text: 'read at ' },
            { text: 'DAY0_DOCS_HOST_DIR', code: true },
            { text: ' in ' },
            { text: '5 min 8 s', strong: true },
            { text: '.' },
          ]}
        />
      </p>,
    );
    expect(html).toMatch(
      /^<p>read at <code class="[^"]*font-mono[^"]*">DAY0_DOCS_HOST_DIR<\/code> in <strong class="[^"]*">5 min 8 s<\/strong>\.<\/p>$/,
    );
  });

  it('renders nothing for an empty paragraph', () => {
    expect(renderToStaticMarkup(<RunParagraph text={[]} />)).toBe('');
  });
});
