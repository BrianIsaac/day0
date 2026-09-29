import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * The tab strip in a real Chromium with classic scrollbars, which only a browser lays out: it
 * draws no scrollbar of either kind, its selected tab's underline meets the strip's line, and on
 * a phone it still scrolls sideways. The employee page it heads needs a backend the job does not
 * hold, so the strip is rendered from the component (`tab-strip-markup.ts`) and mounted on a
 * public page, under the build's own stylesheet.
 */

// Chromium's headless default hides scrollbars; the manager's browser draws them.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

/** The strip's markup, rendered once from the component. */
const MARKUP = execFileSync(
  process.execPath,
  ['--import', 'tsx', fileURLToPath(new URL('./tab-strip-markup.ts', import.meta.url))],
  { encoding: 'utf8' },
);

/** What the strip measures once laid out. */
interface StripReading {
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly offsetHeight: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly offsetWidth: number;
  readonly selectedBottom: number;
  readonly stripBottom: number;
}

/**
 * Mount the strip, the first tab selected, in a page-width column at the top of a public page.
 *
 * @param page - The loaded page.
 */
async function mountStrip(page: Page): Promise<StripReading> {
  return await page.evaluate((html: string) => {
    const column = document.createElement('div');
    column.style.cssText =
      'position:fixed;inset:0 0 auto 0;z-index:2147483647;padding:24px 16px;background:var(--color-bg)';
    column.innerHTML = html;
    document.body.append(column);
    const strip = column.querySelector<HTMLElement>('[role="tablist"]');
    const selected = column.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !selected) throw new Error('the strip did not render');
    return {
      scrollHeight: strip.scrollHeight,
      clientHeight: strip.clientHeight,
      offsetHeight: strip.offsetHeight,
      scrollWidth: strip.scrollWidth,
      clientWidth: strip.clientWidth,
      offsetWidth: strip.offsetWidth,
      selectedBottom: selected.getBoundingClientRect().bottom,
      stripBottom: strip.getBoundingClientRect().bottom,
    };
  }, MARKUP);
}

test.describe('the tab strip', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/\.invalid\//, (route) => route.abort());
    await page.goto('/walkthrough', { waitUntil: 'load' });
  });

  test('draws no scrollbar, so its box holds its tabs with no gutter either way', async ({
    page,
  }) => {
    const strip = await mountStrip(page);
    // A scrollbar takes its width out of the client box; with none the two boxes match.
    expect(strip.scrollHeight).toBe(strip.clientHeight);
    expect(strip.offsetHeight).toBe(strip.clientHeight);
    expect(strip.offsetWidth).toBe(strip.clientWidth);
  });

  test("meets its line with the selected tab's underline", async ({ page }) => {
    const strip = await mountStrip(page);
    expect(strip.selectedBottom).toBe(strip.stripBottom);
  });

  test('scrolls sideways where its tabs are wider than the page, and not otherwise', async ({
    page,
  }) => {
    const strip = await mountStrip(page);
    const narrow = (page.viewportSize()?.width ?? 0) < 768;
    expect(strip.scrollWidth > strip.clientWidth).toBe(narrow);
  });
});
