import { expect, test } from '@playwright/test';
import { axe, smallTargets } from './floor';
import { beyondDebt, debtKeys, unmetDebt, type Debt } from './known-debt';
import { THEMES, chooseTheme, expectDrawnIn } from './theme';

/**
 * The public pages against the accessibility floor (N14, `CONTRIBUTING.md`):
 * no axe violation at the WCAG 2.2 AA tags, no page wider than the window,
 * and every pointer target at least 44 by 44 CSS pixels, at the two widths
 * the projects set and in both themes (16-T), beyond the debt each page is
 * known to carry in files outside this job's unit. They render from the build
 * alone, with no backend.
 */

/** The pages a visitor reaches without signing in. `/demo` answers 308 to `/walkthrough`. */
const PAGES = ['/', '/setup', '/walkthrough', '/sign-in'] as const;

/**
 * What each page is known to fail, node by node (`known-debt.ts`): empty on every page since the
 * wave 5 pre-tag fix met the floor on `/` and `/setup`. A new failure is added here with its reason
 * and whose file it is, and leaves with its fix.
 */
const KNOWN_DEBT: Readonly<Record<(typeof PAGES)[number], readonly Debt[]>> = {
  '/': [],
  '/setup': [],
  '/walkthrough': [],
  '/sign-in': [],
};

/**
 * Check one page's findings against its debt: nothing beyond it, and no debt the page no longer
 * carries. The debts met are noted on the test, so the report still shows them.
 *
 * @param path - The page.
 * @param kind - Which list: axe findings or small targets.
 * @param found - Each finding's key.
 */
function expectOnlyKnownDebt(
  path: (typeof PAGES)[number],
  kind: 'axe' | 'targets',
  found: readonly string[],
): void {
  const known = debtKeys(KNOWN_DEBT[path], test.info().project.name, kind);
  for (const reason of new Set(
    known.filter((debt) => found.includes(debt.key)).map((debt) => debt.reason),
  )) {
    test.info().annotations.push({ type: 'known debt', description: reason });
  }
  expect(beyondDebt(known, found), 'beyond the known debt').toEqual([]);
  expect(unmetDebt(known, found), 'debt the page no longer carries').toEqual([]);
}

for (const theme of THEMES)
  for (const path of PAGES) {
    test.describe(`${path} in ${theme}`, () => {
      test.beforeEach(async ({ page }) => {
        await chooseTheme(page, theme);
        // The build carries a placeholder Clerk key and Convex address; their
        // scripts never load here, and the public pages render without them.
        await page.route(/\.invalid\//, (route) => route.abort());
        await page.goto(path, { waitUntil: 'load' });
        // The page's own content, drawn and hydrated (`/` draws its landing only once the browser
        // knows who it has), and its fonts: a wait on what the checks read, where `networkidle`
        // waited on any request a busy runner happened to hold open (the second review's decision 6).
        await expect(page.locator('main h1').first()).toBeVisible();
        await page.evaluate(async (): Promise<void> => {
          await document.fonts.ready;
        });
        await expectDrawnIn(page, theme);
      });

      test('has no axe violation at the WCAG 2.2 AA tags beyond its known debt', async ({
        page,
      }) => {
        expectOnlyKnownDebt(path, 'axe', await axe(page));
      });

      test('is no wider than the window', async ({ page }) => {
        const widths = await page.evaluate(() => ({
          page: document.documentElement.scrollWidth,
          window: document.documentElement.clientWidth,
        }));
        expect(widths.page).toBeLessThanOrEqual(widths.window);
      });

      test('gives every pointer target beyond its known debt at least 44 by 44 CSS pixels', async ({
        page,
      }) => {
        expectOnlyKnownDebt(path, 'targets', await smallTargets(page));
      });
    });
  }
