import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * The employee page's whole first week, open, in a real Chromium with classic scrollbars, which
 * only a browser lays out: the week holds everything it draws inside its own box, so it never
 * scrolls and never draws a scrollbar of its own (review M1, 30 September). The employee page
 * needs a backend the job does not hold, so the week is rendered from the component and opened
 * there (`first-week-markup.ts`), then mounted on a public page under the build's stylesheet.
 */

// Chromium's headless default hides scrollbars; the manager's browser draws them.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

/** The open week's markup, rendered once from the component. */
const MARKUP = execFileSync(
  process.execPath,
  ['--import', 'tsx', fileURLToPath(new URL('./first-week-markup.ts', import.meta.url))],
  { encoding: 'utf8' },
);

/** What the open week measures once laid out. */
interface WeekReading {
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly offsetWidth: number;
  readonly clientWidth: number;
  /** How far the Close control's box reaches past the week's, on any side; 0 when inside. */
  readonly closeOutside: number;
}

/**
 * Mount the open week over a public page and measure it.
 *
 * @param page - The loaded page.
 */
async function mountWeek(page: Page): Promise<WeekReading> {
  return await page.evaluate((html: string) => {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const scrim = holder.firstElementChild;
    if (scrim === null) throw new Error('the week did not render');
    document.body.append(scrim);
    const week = scrim.querySelector<HTMLElement>('[role="dialog"]');
    const close = week?.querySelector<HTMLElement>('button');
    if (!week || !close) throw new Error('the week has no Close control');
    const outer = week.getBoundingClientRect();
    const inner = close.getBoundingClientRect();
    return {
      scrollHeight: week.scrollHeight,
      clientHeight: week.clientHeight,
      offsetWidth: week.offsetWidth,
      clientWidth: week.clientWidth,
      closeOutside: Math.max(
        0,
        outer.top - inner.top,
        outer.left - inner.left,
        inner.bottom - outer.bottom,
        inner.right - outer.right,
      ),
    };
  }, MARKUP);
}

test.describe('the whole first week, open', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/\.invalid\//, (route) => route.abort());
    await page.goto('/walkthrough', { waitUntil: 'load' });
  });

  test('holds all it draws inside its box, so it never scrolls or draws a scrollbar', async ({
    page,
  }) => {
    const week = await mountWeek(page);
    expect(week.scrollHeight).toBe(week.clientHeight);
    // A vertical scrollbar takes its width out of the client box; with none the two match.
    expect(week.offsetWidth).toBe(week.clientWidth);
  });

  test('keeps its Close control inside its box while no keyboard has reached it', async ({
    page,
  }) => {
    const week = await mountWeek(page);
    expect(week.closeOutside).toBe(0);
  });
});
