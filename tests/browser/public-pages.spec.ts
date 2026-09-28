import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

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

/** The pages a visitor reaches without signing in. */
const PAGES = ['/', '/setup', '/demo'] as const;

/** A failure a public page carries today on files outside the unit that added this job. */
interface Debt {
  /** Why it is not fixed here, and whose file it is. */
  readonly reason: string;
  /** The axe rules the debt covers on this page. */
  readonly axe?: readonly string[];
  /** The controls, as `tag "name"`, under 44 px on this page. */
  readonly targets?: readonly string[];
}

/** The layout's header link, on every page. */
const HEADER: Debt = {
  reason: "the layout's header link (app/layout.tsx: the landing pane, wave 5)",
  targets: ['a "Day0"'],
};

/**
 * What each page is known to fail, named rule by rule and control by
 * control: anything else fails the job, so a new violation on a page that
 * already carries debt is still caught. Each entry leaves with its fix.
 */
const KNOWN_DEBT: Readonly<Record<(typeof PAGES)[number], readonly Debt[]>> = {
  '/': [
    HEADER,
    {
      reason:
        'the landing controls (app/page.tsx: the landing pane, wave 5; the whip cursor goes with N29)',
      targets: ['button "Whip cursorOn"', 'a "Source"', 'a "Watch the recorded walkthrough"'],
    },
  ],
  '/setup': [
    HEADER,
    {
      reason:
        "the page's code blocks scroll sideways at 390 with nothing focusable in them (pass 11 section 3b), and its links are under 44 px (app/setup/page.tsx, no pane in batch 1)",
      axe: ['scrollable-region-focusable'],
      targets: [
        'a "01Before you start"',
        'a "02Three ways to run it"',
        'a "03How it reaches a model"',
        'a "04The commands"',
        'a "05What first success looks like"',
        'a "06How long it takes"',
        'a "07If it stops"',
        'a "08Stopping and starting again"',
        'a "09Where the detail is"',
        'a "Sign in and deploy an agent"',
        'a "Open the walkthrough"',
      ],
    },
  ],
  '/demo': [
    HEADER,
    {
      reason:
        'the chapter links and the disclosures (app/demo: the walkthrough pane, wave 5, which moves the page to /walkthrough)',
      targets: [
        'a "01The charter"',
        'a "02What it may touch"',
        'a "03The work"',
        'a "04The missing skill"',
        'a "05Its workspace"',
        'a "06The office"',
        'a "07The sequence"',
        'summary "The draft the agent wrote before any of it was app"',
        'summary "The skill itself"',
        'summary "The opening of the skill it wrote"',
        'summary "AGENTS.mdGood habits distilled from research into "',
        'summary "SOUL.mdVoice and posture the agent writes in.417b"',
        'summary "IDENTITY.mdRole, why this hire, and the 30/60/90-d"',
        'summary "USER.mdWho the agent reports to.35b"',
        'summary "TOOLS.mdPriority reading and the surfaces it knows"',
        'summary "BOOTSTRAP.mdWhat the agent does on its first day.4"',
        'summary "MEMORY.mdA placeholder written at deployment; noth"',
        'summary "HEARTBEAT.mdWhen the agent was deployed and last r"',
        'summary "How to post to Slack (action guide)how-to-guide"',
        'summary "How to reply to a tweet (action guide)how-to-guide"',
        'summary "How to update a spreadsheet (action guide)how-to-g"',
        'summary "How to update a ticket (action guide)how-to-guide"',
        'summary "Escalation pathsteam-doc"',
        'summary "On-call rotationteam-doc"',
        'summary "Onboarding \u2014 first weekteam-doc"',
        'summary "Team overview \u2014 RevOpsteam-doc"',
      ],
    },
  ],
};

/**
 * Keep the findings the page's known debt does not cover, and note on the
 * test which debts it met, so the report still shows them.
 *
 * @param path - The page.
 * @param kind - Which list the debt names: axe rules or controls.
 * @param found - The findings.
 * @param key - The name a finding is known by.
 * @returns The findings no debt covers.
 */
function beyondDebt<T>(
  path: (typeof PAGES)[number],
  kind: 'axe' | 'targets',
  found: readonly T[],
  key: (finding: T) => string,
): T[] {
  const known = KNOWN_DEBT[path].flatMap((debt) =>
    (debt[kind] ?? []).map((name) => ({ name, reason: debt.reason })),
  );
  const met = known.filter((debt) => found.some((finding) => key(finding) === debt.name));
  for (const reason of new Set(met.map((debt) => debt.reason))) {
    test.info().annotations.push({ type: 'known debt', description: reason });
  }
  return found.filter((finding) => !met.some((debt) => debt.name === key(finding)));
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
 * @returns Each small control, as `tag "name"`.
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
        small.push(`${control.tagName.toLowerCase()} "${name}"`);
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

    test('has no axe violation at the WCAG 2.2 AA tags beyond its known debt', async ({ page }) => {
      expect(beyondDebt(path, 'axe', await axe(page), (violation) => violation.id)).toEqual([]);
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
      expect(beyondDebt(path, 'targets', await smallTargets(page), (target) => target)).toEqual([]);
    });
  });
}
