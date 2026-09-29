import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StateGlossary } from '../../../../../app/agent/[agentId]/work/StateGlossary';

describe('the states glossary', (): void => {
  it("pairs each chip's words with what they mean and the stored state the export keeps", (): void => {
    const markup = renderToStaticMarkup(<StateGlossary />);
    expect(markup).toContain('>What each state means</h2>');
    expect(markup).toContain('the stored state stays in the export');
    expect(markup).toMatch(
      />Write held for you<\/span><\/dt><dd[^>]*>the exact writes, held until you decide <span[^>]*>\(actions-pending\)<\/span>/,
    );
    expect(markup).toContain('>Rejected by you<');
    expect(markup).toContain('>Stopped<');
    expect(markup.match(/<dt/g)).toHaveLength(12);
    expect(markup).toContain('(claimed, executing)');
  });
});
