import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdoptionRow } from '../../../../../app/agent/[agentId]/skills/AdoptionRow';

describe('AdoptionRow', (): void => {
  it('says what approving does today and offers nothing to press, as no colleague’s skill can be adopted', (): void => {
    const html = renderToStaticMarkup(<AdoptionRow name="Mira" />);
    expect(html).toContain(
      'Each skill here is written and checked for Mira alone; your employees do not share skills.',
    );
    // No promise of a feature the product does not have.
    expect(html).not.toMatch(/\byet\b/);
    expect(html).not.toMatch(/<button|<a /);
    expect(html).not.toMatch(/\bagent\b/i);
  });
});
