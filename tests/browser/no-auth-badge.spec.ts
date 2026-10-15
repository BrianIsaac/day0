import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * The no-auth install's header badge stays on one line at a phone's width (17-J's W5, 18-D's F5:
 * at 390 px "NO-AUTH DEV MODE" broke over two lines beside the mark and the Documentation link).
 * The job's build is not a no-auth one, so the badge is rendered from its component
 * (`no-auth-badge-markup.ts`) and put where a no-auth build draws it: in the header's account
 * cluster, after the Documentation link a real-mode deployment shows there, in place of the
 * account controls. The link is drawn with `DocumentationLink.tsx`'s own classes, read from the
 * file, so it takes the room it takes on a deployment.
 */

/** The badge's markup, rendered from the component. */
const BADGE = execFileSync(
  process.execPath,
  ['--import', 'tsx', fileURLToPath(new URL('./no-auth-badge-markup.ts', import.meta.url))],
  { encoding: 'utf8' },
);

/** The Documentation link's classes, as `app/DocumentationLink.tsx` writes them. */
const LINK_CLASSES = /className="([^"]+)"/.exec(
  readFileSync(fileURLToPath(new URL('../../app/DocumentationLink.tsx', import.meta.url)), 'utf8'),
)?.[1];

/** What the badge and the header measure once laid out. */
interface BadgeReading {
  /** How many lines the badge's words take. */
  readonly lines: number;
  /** How far the badge reaches past the viewport's right edge; 0 or less when inside it. */
  readonly overflowRight: number;
  /** How far the header's row is wider than its box. */
  readonly headerOverflow: number;
  /** How far the page is wider than the viewport. */
  readonly pageOverflow: number;
}

for (const width of [390, 1440]) {
  test(`the no-auth badge stays on one line, inside the header, at ${width} px`, async ({
    page,
  }) => {
    expect(LINK_CLASSES).toBeDefined();
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/setup');
    const reading = await page.evaluate(
      ({ badge, link }: { badge: string; link: string }): BadgeReading => {
        const header = document.querySelector('header');
        const cluster = header?.querySelector(':scope > div > :last-child');
        if (!header || !cluster) throw new Error('the header has no account cluster');
        cluster.innerHTML = `<a href="/documentation" class="${link}">Documentation</a>${badge}`;
        const drawn = cluster.querySelector('span[title]');
        const words = drawn?.firstChild;
        if (!drawn || !words) throw new Error('the badge did not render');
        const range = document.createRange();
        range.selectNodeContents(words);
        const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        const row = header.querySelector(':scope > div');
        return {
          lines: tops.size,
          overflowRight: drawn.getBoundingClientRect().right - window.innerWidth,
          headerOverflow: row ? row.scrollWidth - row.clientWidth : 0,
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      },
      { badge: BADGE, link: LINK_CLASSES ?? '' },
    );
    expect(reading.lines).toBe(1);
    expect(reading.overflowRight).toBeLessThanOrEqual(0);
    expect(reading.headerOverflow).toBeLessThanOrEqual(0);
    expect(reading.pageOverflow).toBeLessThanOrEqual(0);
  });
}
