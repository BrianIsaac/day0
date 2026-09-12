import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SetupPage from '../../../app/setup/page';

/**
 * `/setup` exists so the landing page's second button is never dead. Phase 2b
 * replaces it with the real guide; until then it has one job, which is to hand
 * the visitor the instructions that already exist rather than an apology.
 */
describe('the setup placeholder', (): void => {
  const html = renderToStaticMarkup(<SetupPage />);

  it('says the page itself is not the guide yet', (): void => {
    expect(html).toContain('not here yet');
  });

  it('links the setup section of the README, which is', (): void => {
    expect(html).toContain('https://github.com/BrianIsaac/day0#local-dev');
    expect(html).toContain('https://github.com/BrianIsaac/day0#run-it-with-no-accounts');
    expect(html).toContain('https://github.com/BrianIsaac/day0#run-it-with-an-openai-key');
  });

  it('offers the recorded demo to a visitor who only wanted to look', (): void => {
    expect(html).toContain('href="/demo"');
  });

  it('names no model, as the landing page does not', (): void => {
    for (const model of ['GPT-5.6', 'Terra', 'GLM', 'Gemini']) expect(html).not.toContain(model);
  });
});
