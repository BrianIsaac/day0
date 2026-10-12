import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { axe, smallTargets } from './floor';
import { beyondDebt, debtKeys, unmetDebt, type Debt } from './known-debt';
import { THEMES, chooseTheme, expectDrawnIn } from './theme';

/**
 * The signed-in pages against the accessibility floor in both themes (16-T, wave 16 section 5.5):
 * the company home and every tab of a working employee's page, with colour contrast measured,
 * which jsdom's axe cannot do. The pages need a backend and a signed-in session the job does not
 * hold, so each is rendered from the product's own components over a fixture
 * (`signed-in-markup.ts`) and mounted in a public page's `<main>`, under the build's stylesheet
 * and the theme the viewer chose.
 */

/** Every signed-in page's markup, by name, rendered once for this worker. */
const MARKUP = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      fileURLToPath(new URL('./signed-in/hooks.mjs', import.meta.url)),
      fileURLToPath(new URL('./signed-in-markup.ts', import.meta.url)),
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  ),
) as Record<string, string>;

/** The pages, in the order a manager reaches them. */
const PAGES = [
  'home',
  'needs-you',
  'work',
  'charter',
  'people',
  'documentation',
  'skills',
  'surfaces',
  'record',
  'manage',
  'reorientation',
] as const;

/**
 * What each page is known to fail, node by node (`known-debt.ts`). A new failure is added here
 * with its reason and whose file it is, and leaves with its fix.
 */
const KNOWN_DEBT: Readonly<Record<(typeof PAGES)[number], readonly Debt[]>> = {
  home: [],
  'needs-you': [],
  work: [],
  charter: [],
  people: [],
  documentation: [],
  skills: [],
  surfaces: [],
  record: [],
  manage: [],
  reorientation: [],
};

function expectOnlyKnownDebt(
  name: (typeof PAGES)[number],
  kind: 'axe' | 'targets',
  found: readonly string[],
): void {
  const known = debtKeys(KNOWN_DEBT[name], test.info().project.name, kind);
  for (const reason of new Set(
    known.filter((debt) => found.includes(debt.key)).map((debt) => debt.reason),
  )) {
    test.info().annotations.push({ type: 'known debt', description: reason });
  }
  expect(beyondDebt(known, found), 'beyond the known debt').toEqual([]);
  expect(unmetDebt(known, found), 'debt the page no longer carries').toEqual([]);
}

test('renders every signed-in page from the fixture', () => {
  expect(Object.keys(MARKUP)).toEqual([...PAGES]);
  for (const name of PAGES) expect(MARKUP[name]?.length, name).toBeGreaterThan(5_000);
});

// The pages are checked at rest: their cards arrive with a fade, and a contrast measured part way
// through one is a frame, not the page.
test.use({ reducedMotion: 'reduce' });

for (const theme of THEMES)
  for (const name of PAGES) {
    test.describe(`the signed-in ${name} page in ${theme}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.route(/\.invalid\//, (route) => route.abort());
        await chooseTheme(page, theme);
        await page.goto('/setup', { waitUntil: 'load' });
        await expect(page.locator('main h1').first()).toBeVisible();
        // Hydrated first: markup put into a <main> React has still to hydrate is a mismatch, and
        // React renders the whole root again in its place.
        await page.waitForFunction(() => {
          const main = document.querySelector('main');
          return main !== null && Object.keys(main).some((key) => key.startsWith('__reactFiber'));
        });
        await page.evaluate((html: string) => {
          const main = document.querySelector('main');
          if (!main) throw new Error('the page has no main');
          main.innerHTML = html;
        }, MARKUP[name] ?? '');
        await page.evaluate(async (): Promise<void> => {
          await document.fonts.ready;
        });
        await expectDrawnIn(page, theme);
      });

      test('has no axe violation at the WCAG 2.2 AA tags, colour contrast among them', async ({
        page,
      }) => {
        expectOnlyKnownDebt(name, 'axe', await axe(page));
      });

      test('is no wider than the window', async ({ page }) => {
        const widths = await page.evaluate(() => ({
          page: document.documentElement.scrollWidth,
          window: document.documentElement.clientWidth,
        }));
        expect(widths.page).toBeLessThanOrEqual(widths.window);
      });

      test('gives every pointer target at least 44 by 44 CSS pixels', async ({ page }) => {
        expectOnlyKnownDebt(name, 'targets', await smallTargets(page));
      });
    });
  }
