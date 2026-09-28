import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

/**
 * The public pages against the accessibility floor (N14, `CONTRIBUTING.md`):
 * no axe violation at the WCAG 2.2 AA tags, no page wider than the window,
 * and every pointer target at least 44 by 44 CSS pixels, at the two widths
 * the projects set. They render from the build alone, with no backend.
 */

const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core/axe.min.js');

/** The tags the floor names, as the jsdom check in the mirrored tests runs them. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** The pages a visitor reaches without signing in. */
const PAGES = ['/', '/setup', '/demo'] as const;

/**
 * The checks a public page fails today on files outside the unit that added
 * this job, pinned as expected failures with the reason: each turns red the
 * moment its owner fixes it, and the pin is then removed with the fix.
 * Keyed `project path check`.
 */
const PINNED: ReadonlyMap<string, string> = new Map([
  [
    'phone /setup axe',
    "the page's code blocks scroll sideways with nothing focusable in them (axe scrollable-region-focusable, pass 11 section 3b); app/setup/page.tsx",
  ],
  ...(['desktop', 'phone'] as const).flatMap((project) => [
    [
      `${project} / targets`,
      'the header link and the landing controls are under 44 px (app/layout.tsx, app/page.tsx: the landing pane, wave 5)',
    ] as const,
    [
      `${project} /setup targets`,
      'the header link and the page nav are under 44 px (app/layout.tsx, app/setup/page.tsx)',
    ] as const,
    [
      `${project} /demo targets`,
      'the chapter links and the disclosures are under 44 px (app/demo: the walkthrough pane, wave 5)',
    ] as const,
  ]),
]);

/**
 * Mark the running test as an expected failure when this page's check is pinned.
 *
 * @param project - The project, `desktop` or `phone`.
 * @param path - The page.
 * @param check - Which check: `axe`, `width` or `targets`.
 */
function pinned(project: string, path: string, check: string): void {
  const reason = PINNED.get(`${project} ${path} ${check}`);
  test.fail(reason !== undefined, reason);
}

/** One axe violation, as a failing line reads it. */
interface Violation {
  id: string;
  impact: string | null;
  targets: string[];
}

/**
 * Run axe in the page at the floor's tags.
 *
 * @param page - The loaded page.
 * @returns The violations, empty when the page passes.
 */
async function axe(page: Page): Promise<Violation[]> {
  await page.addScriptTag({ path: AXE });
  return await page.evaluate(async (tags: string[]) => {
    const run = (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: unknown,
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[] }>;
            }>;
          }>;
        };
      }
    ).axe.run;
    const results = await run(document, { runOnly: { type: 'tag', values: tags } });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
  }, WCAG_TAGS);
}

/**
 * The visible controls smaller than 44 by 44 CSS pixels, except a link inside
 * a run of text, which WCAG's inline exception leaves at the text's size.
 *
 * @param page - The loaded page.
 * @returns Each small control's name and size.
 */
async function smallTargets(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const controls = document.querySelectorAll<HTMLElement>(
      'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="switch"]',
    );
    const small: string[] = [];
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (getComputedStyle(control).visibility === 'hidden') continue;
      const inline =
        control.tagName === 'A' &&
        getComputedStyle(control).display === 'inline' &&
        (control.parentElement?.textContent ?? '').trim().length >
          (control.textContent ?? '').trim().length;
      if (inline) continue;
      if (box.width < 44 || box.height < 44) {
        const name = (control.getAttribute('aria-label') ?? control.textContent ?? '')
          .trim()
          .slice(0, 50);
        small.push(
          `${control.tagName.toLowerCase()} "${name}" ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
      }
    }
    return small;
  });
}

for (const path of PAGES) {
  test.describe(`${path}`, () => {
    test.beforeEach(async ({ page }) => {
      // The build carries a placeholder Clerk key and Convex address; their
      // scripts never load here, and the public pages render without them.
      await page.route(/\.invalid\//, (route) => route.abort());
      await page.goto(path, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
    });

    test('has no axe violation at the WCAG 2.2 AA tags', async ({ page }, info) => {
      pinned(info.project.name, path, 'axe');
      expect(await axe(page)).toEqual([]);
    });

    test('is no wider than the window', async ({ page }, info) => {
      pinned(info.project.name, path, 'width');
      const widths = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        window: document.documentElement.clientWidth,
      }));
      expect(widths.page).toBeLessThanOrEqual(widths.window);
    });

    test('gives every pointer target at least 44 by 44 CSS pixels', async ({ page }, info) => {
      pinned(info.project.name, path, 'targets');
      expect(await smallTargets(page)).toEqual([]);
    });
  });
}
