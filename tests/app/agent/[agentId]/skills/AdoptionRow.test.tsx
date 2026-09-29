import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdoptionRow } from '../../../../../app/agent/[agentId]/skills/AdoptionRow';

describe('AdoptionRow', (): void => {
  it('says what approving does today and offers nothing to press, as no colleague’s skill can be adopted yet', (): void => {
    const html = renderToStaticMarkup(<AdoptionRow name="Mira" />);
    expect(html).toContain(
      'Skills are not shared between your employees yet: approving writes this one for Mira alone.',
    );
    expect(html).not.toMatch(/<button|<a /);
    expect(html).not.toMatch(/\bagent\b/i);
  });
});
