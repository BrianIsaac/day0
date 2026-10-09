import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The sticky site header's height (`app/layout.tsx`, `min-h-14` with its 1 px rule), in rem. */
const HEADER_REM = 3.5 + 0.0625;

/** The name field's label above it (`text-sm` with `mb-1.5`), in rem. */
const LABEL_REM = 1.25 + 0.375;

/**
 * The deploy form's name field, focused again by its alert, sat under the sticky header at 390 by
 * 844 (14-FX's bed). The room is kept by the field itself, never by the document: a scroll padding
 * on `html` offset every hash landing too, and the walkthrough's `#step-2` rested on step 1 at
 * 667 by 375.
 */
describe('the room a focused control keeps under the sticky header', (): void => {
  it('keeps the deploy form’s name field and its label clear of the header', (): void => {
    const form = readFileSync('app/home/DeployForm.tsx', 'utf8');
    const field = /<input\s+ref=\{nameInput\}.*?className="([^"]*)"/s.exec(form)?.[1] ?? '';
    const margin = /(?:^|\s)scroll-mt-(\d+)(?:\s|$)/.exec(field)?.[1];
    expect(Number(margin) * 0.25).toBeGreaterThanOrEqual(HEADER_REM + LABEL_REM);
  });

  it('leaves the document’s scroll unpadded, so a hash link lands on its target', (): void => {
    const css = readFileSync('app/globals.css', 'utf8');
    expect(css).not.toMatch(/(?:^|[\s,}])(?:html|:root)\s*\{[^}]*scroll-padding/);
  });
});
