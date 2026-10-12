import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * The Documentation tab's main column at a phone's width with six sources linked (W15-R50, the
 * review's bed 3: the company folder and the five readers' sources), in a real Chromium, which
 * only a browser lays out: nothing reaches past the viewport, so the page never scrolls sideways.
 * The tab needs a backend the job does not hold, so its Sources card and two relation cards are
 * rendered from the components (`documentation-markup.tsx`) and mounted on a public page, under
 * the build's own stylesheet, in a column with the page's own side gutter.
 */

/** The column's markup, rendered once from the components. */
const MARKUP = execFileSync(
  process.execPath,
  ['--import', 'tsx', fileURLToPath(new URL('./documentation-markup.tsx', import.meta.url))],
  { encoding: 'utf8' },
);

test.describe('the Documentation tab at 390 with six sources (W15-R50)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('lays every source, its controls and the cards out inside the viewport', async ({
    page,
  }, testInfo) => {
    // The width is the test's own, so the desktop project would only run it a second time.
    test.skip(testInfo.project.name !== 'phone', 'measured once, under the phone project');
    await page.goto('/setup');
    const reading = await page.evaluate((html: string) => {
      document.body.replaceChildren();
      const column = document.createElement('main');
      column.style.cssText = 'padding:24px 16px';
      column.innerHTML = html;
      document.body.append(column);
      const past = [...column.querySelectorAll<HTMLElement>('*')]
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 0.5)
        // The visually hidden copies sit off the layout by design.
        .filter((element) => element.closest('.sr-only') === null)
        .map(
          (element) =>
            `${element.tagName.toLowerCase()} right ${Math.round(element.getBoundingClientRect().right)}: ${(element.textContent ?? '').trim().slice(0, 40)}`,
        );
      return {
        scrollWidth: document.documentElement.scrollWidth,
        rows: column.querySelectorAll('[aria-label="Linked documentation"] tbody').length,
        past: past.slice(0, 8),
      };
    }, MARKUP);
    expect(reading.rows).toBe(6);
    expect(reading.past).toEqual([]);
    expect(reading.scrollWidth).toBeLessThanOrEqual(390);
  });
});
