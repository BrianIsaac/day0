import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { bringTabIntoView, type TabInStrip } from '../../app/components/strip-scroll';

/**
 * The tab strip in a real Chromium with classic scrollbars, which only a browser lays out: it
 * draws no scrollbar of either kind, its selected tab's underline meets the strip's line, and on
 * a phone it still scrolls sideways. The employee page it heads needs a backend the job does not
 * hold, so the strip is rendered from the component (`tab-strip-markup.ts`) and mounted on a
 * public page, under the build's own stylesheet.
 */

// Chromium's headless default hides scrollbars; the manager's browser draws them.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

/**
 * The strip's markup, rendered from the component with one tab selected.
 *
 * @param selected - The key of the selected tab.
 */
function markup(selected: string): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./tab-strip-markup.ts', import.meta.url)), selected],
    { encoding: 'utf8' },
  );
}

/** The strip with its first tab selected, as the employee page opens. */
const MARKUP = markup('needs-you');

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
 * Mount the strip in a page-width column at the top of a public page.
 *
 * @param page - The loaded page.
 * @param html - The strip's markup; the first tab selected when absent.
 */
async function mountStrip(page: Page, html: string = MARKUP): Promise<StripReading> {
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
  }, html);
}

/** Where the selected tab sits in the strip's visible box, once the strip has brought it in. */
interface InView {
  /** How far the tab reaches past the strip's visible box, on either side; 0 when inside. */
  readonly outside: number;
  /** How far the tab's centre is from the strip's. */
  readonly offCentre: number;
  readonly scrollLeft: number;
}

/**
 * Mount the strip with a tab selected and bring that tab into view with the component's own step
 * (`bringTabIntoView`, which `Tabs` runs as the strip renders), then read where it sits.
 *
 * @param page - The loaded page.
 * @param selected - The key of the selected tab.
 */
async function selectedInView(page: Page, selected: string): Promise<InView> {
  await mountStrip(page, markup(selected));
  const strip = await page.evaluateHandle((): TabInStrip => {
    const list = document.querySelector<HTMLElement>('[role="tablist"]');
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !tab) throw new Error('the strip did not render');
    return { list, tab };
  });
  await page.evaluate(bringTabIntoView, strip);
  return await page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('[role="tablist"]');
    const chosen = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !chosen) throw new Error('the strip did not render');
    const outer = strip.getBoundingClientRect();
    const inner = chosen.getBoundingClientRect();
    return {
      outside: Math.max(0, outer.left - inner.left, inner.right - outer.right),
      offCentre: Math.abs(inner.left + inner.width / 2 - (outer.left + outer.width / 2)),
      scrollLeft: strip.scrollLeft,
    };
  });
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

  test('brings the last tab into view when it is selected on a phone (review m12)', async ({
    page,
  }) => {
    const manage = await selectedInView(page, 'manage');
    // Scrolled to its end: the strip's scroll width is whole pixels and its tabs' widths are not,
    // so the last tab may reach a fraction of a pixel past the edge, never a whole one.
    expect(manage.outside).toBeLessThan(1);
    const narrow = (page.viewportSize()?.width ?? 0) < 768;
    expect(manage.scrollLeft > 0).toBe(narrow);
  });

  test('centres a selected tab from the middle of the strip where the strip scrolls', async ({
    page,
  }) => {
    const skills = await selectedInView(page, 'skills');
    expect(skills.outside).toBe(0);
    if ((page.viewportSize()?.width ?? 0) < 768) expect(skills.offCentre).toBeLessThanOrEqual(1);
    else expect(skills.scrollLeft).toBe(0);
  });
});
