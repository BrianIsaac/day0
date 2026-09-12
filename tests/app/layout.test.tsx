import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The header sits on every page, including the two public ones. A prefetched
 * link to a protected route is not free there: Next fetches it on sight, the
 * proxy protects it, and a signed-out visitor's browser is sent to Clerk's
 * hosted sign-in before they have clicked anything. The phase 1 request trace
 * caught ten of those on one pass.
 */
describe('the header on a public page', (): void => {
  const layout = readFileSync(new URL('../../app/layout.tsx', import.meta.url), 'utf8');

  it('does not prefetch the protected documentation route', (): void => {
    const link = /<Link[^>]*href="\/documentation"[\s\S]*?>/.exec(layout)?.[0] ?? '';
    expect(link).not.toBe('');
    expect(link).toContain('prefetch={false}');
  });
});

describe('the focus ring', (): void => {
  const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

  it('covers links and disclosures, not only form controls', (): void => {
    const rule = /:where\(([^)]*)\):focus-visible/.exec(css)?.[1] ?? '';
    for (const selector of ['a', 'summary', 'button']) {
      expect(rule.split(',').map((s) => s.trim())).toContain(selector);
    }
  });
});
