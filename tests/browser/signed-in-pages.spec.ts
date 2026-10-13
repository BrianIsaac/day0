import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
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
  'reorientation-talk',
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
  'reorientation-talk': [],
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

/**
 * Hold a check to the signed-in page as it was mounted: its main the one landmark shown, and its
 * text still the markup's, so nothing drawn since has replaced it.
 */
async function expectSignedInPage(page: Page, html: string): Promise<void> {
  await expect(page.locator('main:visible')).toHaveCount(1);
  const [drawn, mounted] = await page.evaluate((markup: string) => {
    const template = document.createElement('template');
    template.innerHTML = markup;
    return [
      document.querySelector('main[data-signed-in]')?.textContent ?? '',
      template.content.textContent ?? '',
    ];
  }, html);
  expect(drawn.length).toBeGreaterThan(0);
  expect(drawn).toBe(mounted);
}

test('renders every signed-in page from the fixture', () => {
  expect(Object.keys(MARKUP)).toEqual([...PAGES]);
  for (const name of PAGES) expect(MARKUP[name]?.length, name).toBeGreaterThan(5_000);
  // Nothing is left loading, so every card is measured: the rail's figures are the employee's day
  // (16-F's "Today"), and the Surfaces tab waits on the credentials, the organisation's
  // connections and the documentation's first page (the joins).
  for (const name of PAGES) expect(MARKUP[name], name).not.toContain('Loading');
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
        // The page's own main is hidden, not emptied, and the signed-in page goes into a main of
        // its own after it, a node React does not own: a later commit of the page's tree has
        // nothing of the markup to reconcile, and the page keeps one main landmark.
        await page.evaluate((html: string) => {
          const own = document.querySelector('main');
          if (!own) throw new Error('the page has no main');
          const signedIn = document.createElement('main');
          signedIn.className = own.className;
          signedIn.tabIndex = -1;
          signedIn.dataset.signedIn = '';
          signedIn.innerHTML = html;
          own.hidden = true;
          own.removeAttribute('id');
          signedIn.id = 'main';
          own.after(signedIn);
        }, MARKUP[name] ?? '');
        await page.evaluate(async (): Promise<void> => {
          await document.fonts.ready;
        });
        await expectDrawnIn(page, theme);
      });

      test('has no axe violation at the WCAG 2.2 AA tags, colour contrast among them', async ({
        page,
      }) => {
        await expectSignedInPage(page, MARKUP[name] ?? '');
        expectOnlyKnownDebt(name, 'axe', await axe(page));
      });

      test('is no wider than the window', async ({ page }) => {
        await expectSignedInPage(page, MARKUP[name] ?? '');
        const widths = await page.evaluate(() => ({
          page: document.documentElement.scrollWidth,
          window: document.documentElement.clientWidth,
        }));
        expect(widths.page).toBeLessThanOrEqual(widths.window);
      });

      test('gives every pointer target at least 44 by 44 CSS pixels', async ({ page }) => {
        await expectSignedInPage(page, MARKUP[name] ?? '');
        expectOnlyKnownDebt(name, 'targets', await smallTargets(page));
      });
    });
  }
