import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { beyondDebt, debtKeys, unmetDebt, type Debt } from './known-debt';

/**
 * The public pages against the accessibility floor (N14, `CONTRIBUTING.md`):
 * no axe violation at the WCAG 2.2 AA tags, no page wider than the window,
 * and every pointer target at least 44 by 44 CSS pixels, at the two widths
 * the projects set, beyond the debt each page is known to carry in files
 * outside this job's unit. They render from the build alone, with no backend.
 */

const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core/axe.min.js');

/** The tags the floor names, as the jsdom check in the mirrored tests runs them. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

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

/**
 * Run axe in the page at the floor's tags.
 *
 * @param page - The loaded page.
 * @returns Each violating node as `rule selector`, empty when the page passes.
 */
async function axe(page: Page): Promise<string[]> {
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
    return results.violations.flatMap((violation) =>
      violation.nodes.map((node) => `${violation.id} ${node.target.join(' ')}`),
    );
  }, WCAG_TAGS);
}

/**
 * The visible controls smaller than 44 by 44 CSS pixels, except a link inside
 * a run of text, which WCAG's inline exception leaves at the text's size.
 *
 * @param page - The loaded page.
 * @returns Each small control, as `tag "name" at selector`.
 */
async function smallTargets(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    // The node's path from the nearest ancestor with an id, as axe names its own nodes.
    const selectorOf = (element: Element): string => {
      const parts: string[] = [];
      let node: Element | null = element;
      while (node && node !== document.body) {
        if (node.id) {
          parts.unshift(`#${CSS.escape(node.id)}`);
          break;
        }
        const tag = node.tagName.toLowerCase();
        const siblings: Element[] = node.parentElement
          ? [...node.parentElement.children].filter((sibling) => sibling.tagName === node?.tagName)
          : [];
        parts.unshift(
          siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag,
        );
        node = node.parentElement;
      }
      return parts.join(' > ');
    };
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
        small.push(`${control.tagName.toLowerCase()} "${name}" at ${selectorOf(control)}`);
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
      // The page's own content, drawn and hydrated (`/` draws its landing only once the browser
      // knows who it has), and its fonts: a wait on what the checks read, where `networkidle`
      // waited on any request a busy runner happened to hold open (the second review's decision 6).
      await expect(page.locator('main h1').first()).toBeVisible();
      await page.evaluate(async (): Promise<void> => {
        await document.fonts.ready;
      });
    });

    test('has no axe violation at the WCAG 2.2 AA tags beyond its known debt', async ({ page }) => {
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
