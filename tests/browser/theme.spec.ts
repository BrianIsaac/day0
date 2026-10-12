import { expect, test } from '@playwright/test';
import { THEME_ATTRIBUTE } from '../../app/theme-preference';
import { chooseTheme, expectDrawnIn } from './theme';

/**
 * The viewer's theme in a real Chromium, from the gate's own build (16-T): the stored choice is on
 * the page before anything is painted, and Follow system follows the system's scheme while the
 * page is open. The Appearance card that stores a choice is on the employee page, which the job
 * cannot reach; its press is the jsdom suite's (`AppearanceControl.test.tsx`).
 */

test.beforeEach(async ({ page }) => {
  // The build carries a placeholder Clerk key and Convex address; their scripts never load here.
  await page.route(/\.invalid\//, (route) => route.abort());
});

/** What the root carried the moment the body was parsed, before the first frame. */
interface FirstParse {
  readonly theme: string | null;
}

test('draws a stored Light before the first paint, so no frame is ever drawn dark first', async ({
  page,
}) => {
  await chooseTheme(page, 'light');
  // The body is parsed before the browser paints a frame of it, and the stylesheet blocks that
  // frame until it has loaded: the attribute the root carries then is the theme the first frame
  // is drawn in.
  await page.addInitScript(
    ([attribute]: readonly [string]) => {
      const observer = new MutationObserver(() => {
        if (!document.body) return;
        observer.disconnect();
        (window as unknown as { firstParse: FirstParse }).firstParse = {
          theme: document.documentElement.getAttribute(attribute),
        };
      });
      observer.observe(document, { childList: true, subtree: true });
    },
    [THEME_ATTRIBUTE] as const,
  );
  await page.goto('/setup', { waitUntil: 'load' });
  const firstParse = await page.evaluate(
    () => (window as unknown as { firstParse?: FirstParse }).firstParse,
  );
  expect(firstParse).toEqual({ theme: 'light' });
  await expectDrawnIn(page, 'light');
});

test('draws dark for a visitor who has never chosen, whatever the system says', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/setup', { waitUntil: 'load' });
  await expectDrawnIn(page, 'dark');
});

test("follows a change of the system's scheme while the page is open, under Follow system", async ({
  page,
}) => {
  await chooseTheme(page, 'system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/setup', { waitUntil: 'load' });
  await expectDrawnIn(page, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectDrawnIn(page, 'light');
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute(
    'content',
    '#fafafa',
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectDrawnIn(page, 'dark');
});

test("colours the browser chrome with the light page through the layout's one theme-color", async ({
  page,
}) => {
  await chooseTheme(page, 'light');
  await page.goto('/setup', { waitUntil: 'load' });
  await expectDrawnIn(page, 'light');
  const chrome = page.locator('meta[name="theme-color"]');
  await expect(chrome).toHaveCount(1);
  await expect(chrome).toHaveAttribute('content', '#fafafa');
  // A client navigation renders the layout's head again; the chrome stays the light page's.
  await page.getByRole('link', { name: 'Walkthrough' }).first().click();
  await page.waitForURL('**/walkthrough');
  await expect(chrome).toHaveCount(1);
  await expect(chrome).toHaveAttribute('content', '#fafafa');
});

test("keeps the pixel office's panel on the dark set in light (RM11 (a))", async ({ page }) => {
  await chooseTheme(page, 'light');
  await page.goto('/setup', { waitUntil: 'load' });
  const inside = await page.evaluate(() => {
    const office = document.createElement('div');
    office.className = 'day0-pixel-office';
    const plate = document.createElement('span');
    plate.style.background = 'var(--color-card)';
    office.append(plate);
    document.body.append(office);
    return {
      plate: getComputedStyle(plate).backgroundColor,
      scheme: getComputedStyle(office).colorScheme,
    };
  });
  expect(inside).toEqual({ plate: 'rgb(24, 24, 27)', scheme: 'dark' });
});
