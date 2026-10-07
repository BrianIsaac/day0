import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The site header is sticky (`app/layout.tsx`, `min-h-14` with its 1 px rule), so a control the
 * browser scrolls to when it takes focus would sit under it unless the page keeps room for it: the
 * deploy form's name field did at 390 by 844 once its alert sent focus back (14-FX's bed).
 */
describe('the room a focused control keeps under the sticky header', (): void => {
  it('pads the page’s scroll by at least the header’s height', (): void => {
    const css = readFileSync('app/globals.css', 'utf8');
    const padding = /html\s*\{[^}]*scroll-padding-top:\s*([\d.]+)rem/.exec(css)?.[1];
    expect(Number(padding)).toBeGreaterThanOrEqual(3.5 + 0.0625);
  });
});
