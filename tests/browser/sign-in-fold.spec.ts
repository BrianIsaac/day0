import { expect, test, type Page } from '@playwright/test';
import { HOSTED_DEMO_NOTICE } from '../../src/demo/hosted-notice';

/**
 * Where the sign-in card sits (the v0.11.0 walk): at 390 by 844 it was below the fold, under the
 * heading, the lede, the four steps and the whole notice. On a phone the notice now folds under
 * its own heading before the card, and the lede and steps follow the card; at 1440 the page is
 * as it was, the card beside the heading and the notice open. The runner's Clerk never loads, so
 * the card's place (`#sign-in-card`) is measured, not the card.
 */

/**
 * How far below its place the card's first field ends: the mark above the card and the card down
 * to its email field, measured under real Clerk on the wave 9 bed at 390 (262 px), with room.
 */
const CARD_FIRST_FIELD_PX = 280;

/** Where each part of the page starts and ends, from the top of the page. */
async function layout(page: Page): Promise<{
  card: number;
  noticeHeading: { top: number; bottom: number };
  steps: number;
  noticeBody: boolean;
  screen: number;
}> {
  return page.evaluate((heading: string) => {
    const top = (element: Element | null): number =>
      element ? Math.round(element.getBoundingClientRect().top + window.scrollY) : Number.NaN;
    // Drawn and not inside a closed disclosure, whose content keeps its boxes while hidden.
    const seen = (element: Element): boolean => element.checkVisibility();
    const shown = [...document.querySelectorAll('main *')].find(
      (element) =>
        element.children.length === 0 && element.textContent?.trim() === heading && seen(element),
    );
    const box = shown?.getBoundingClientRect();
    const body = [...document.querySelectorAll('main p')].some(
      (element) =>
        element.textContent?.includes('your sign-in email goes to Clerk') && seen(element),
    );
    return {
      card: top(document.querySelector('#sign-in-card')),
      noticeHeading: {
        top: box ? Math.round(box.top + window.scrollY) : Number.NaN,
        bottom: box ? Math.round(box.bottom + window.scrollY) : Number.NaN,
      },
      steps: top(document.querySelector('main ol')),
      noticeBody: body,
      screen: window.innerHeight,
    };
  }, HOSTED_DEMO_NOTICE.heading);
}

test.beforeEach(async ({ page }) => {
  await page.route(/\.invalid\//, (route) => route.abort());
  await page.goto('/sign-in', { waitUntil: 'load' });
});

test('puts the sign-in card in the first screen on a phone, under the notice’s heading, the steps after it', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'the fold is a phone’s');
  const seen = await layout(page);
  expect(seen.card + CARD_FIRST_FIELD_PX).toBeLessThanOrEqual(seen.screen);
  expect(seen.noticeHeading.bottom).toBeLessThanOrEqual(seen.card);
  expect(seen.steps).toBeGreaterThan(seen.card);
  // Folded, one tap away: the receivers are a summary's tap from the card, never gone.
  expect(seen.noticeBody).toBe(false);
  await page.locator('main summary', { hasText: HOSTED_DEMO_NOTICE.heading }).click();
  expect((await layout(page)).noticeBody).toBe(true);
});

test('keeps the card beside the heading and the notice open on a wide screen', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the two columns are a wide screen’s');
  const seen = await layout(page);
  const heading = await page.getByRole('heading', { level: 1 }).boundingBox();
  expect(Math.abs(seen.card - Math.round(heading?.y ?? Number.NaN))).toBeLessThanOrEqual(8);
  expect(seen.noticeBody).toBe(true);
  expect(seen.steps).toBeLessThan(seen.noticeHeading.top);
});
