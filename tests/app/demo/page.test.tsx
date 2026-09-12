import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import DemoPage from '../../../app/demo/page';

/**
 * Nothing is mocked here on purpose. `/demo` is public, so it must render with
 * no Convex client, no Clerk session and no router: if it ever grew a hook, this
 * file would be the first thing to fail.
 */
describe('the /demo route', (): void => {
  it('renders the recorded walkthrough with nothing mocked', (): void => {
    const html = renderToStaticMarkup(<DemoPage />);
    expect(html).toContain('Recorded walkthrough');
    expect(html).toContain('Append missing pipeline follow-up notes to Q4 tracker');
  });

  it('is built out of the tracked snapshot and nothing live', (): void => {
    const sources = ['app/demo/page.tsx', 'app/demo/DemoWalkthrough.tsx'].map((path) =>
      readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'),
    );
    for (const source of sources) {
      expect(source).not.toContain('use client');
      expect(source).not.toContain('convex/react');
      expect(source).not.toContain('@clerk/nextjs');
      expect(source).not.toContain('fetch(');
      expect(source).not.toContain('useEffect');
    }
  });
});
