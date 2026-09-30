import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * No stylesheet the app ships targets Clerk's classes in a way Clerk reports as structural.
 *
 * A development instance of Clerk walks `document.styleSheets` on every page and warns
 * "Structural CSS detected that may break on updates" for a selector that pins its internal DOM
 * (v0.10.1 shipped one, `[data-headed-clerk] .cl-signIn-start .cl-header`, on every page). The
 * build here carries a placeholder key, so Clerk never loads; the spec runs Clerk's own detector,
 * from the installed `@clerk/ui`, against the built stylesheets instead, so the rule it applies is
 * Clerk's and not a copy.
 */

const require = createRequire(import.meta.url);

/** Clerk's detector module and its one relative import, in the installed `@clerk/ui`. */
const CLERK_UI_UTILS = join(dirname(require.resolve('@clerk/ui/package.json')), 'dist', 'utils');

/** Where the page imports the detector from; the spec serves it from `CLERK_UI_UTILS`. */
const DETECTOR_ROUTE = '/__clerk-ui-utils/';

/** The pages the check loads: every page shares one global stylesheet, and these hold Clerk. */
const PAGES = ['/', '/sign-in'] as const;

for (const path of PAGES) {
  test(`${path} ships no CSS Clerk reports as structural`, async ({ page }) => {
    // The build carries a placeholder Clerk key and Convex address; their scripts never load.
    await page.route(/\.invalid\//, (route) => route.abort());
    await page.route(`**${DETECTOR_ROUTE}*.js`, (route) =>
      route.fulfill({
        path: join(CLERK_UI_UTILS, basename(new URL(route.request().url()).pathname)),
        contentType: 'text/javascript',
      }),
    );
    await page.goto(path, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // A string, so no transpiler rewrites the dynamic import the page runs.
    const hits = (await page.evaluate(`
      import('${DETECTOR_ROUTE}detectClerkStylesheetUsage.js').then((detector) => ({
        sheets: document.styleSheets.length,
        selectors: detector.detectStructuralClerkCss().map((hit) => hit.selector),
      }))
    `)) as { sheets: number; selectors: string[] };

    expect(hits.sheets, 'the page loaded its stylesheets').toBeGreaterThan(0);
    expect(hits.selectors).toEqual([]);
  });
}
