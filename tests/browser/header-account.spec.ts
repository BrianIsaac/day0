import { expect, test, type Page } from '@playwright/test';
import { holdClerk } from './clerk-double';

/**
 * The header holds still while Clerk loads (30 September, the hosted v0.10.0 redeploy's K1): the
 * account controls mount well after the page paints, and the nav used to move 90 px when they
 * did. Clerk's script is a double the spec releases (`clerk-double.ts`), so the moment it mounts
 * is the spec's, under the build's placeholder keys.
 */

/** The pages a visitor reaches without signing in. */
const PAGES = ['/', '/setup', '/walkthrough', '/sign-in'] as const;

/** One box, rounded to the CSS pixel. */
interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A `layout-shift` entry, which TypeScript's DOM library does not declare. */
interface LayoutShiftEntry extends PerformanceEntry {
  readonly hadRecentInput: boolean;
  readonly sources: ReadonlyArray<{ readonly node: Node | null }>;
}

/**
 * Record, from navigation on, every layout shift that moved something in the header, as the
 * moved node's tag and text. Runs in the page before any of its scripts.
 */
function recordHeaderShifts(): void {
  const moved: string[] = [];
  (window as unknown as { headerShifts: string[] }).headerShifts = moved;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as LayoutShiftEntry[]) {
      for (const { node } of entry.sources) {
        const element = node instanceof Element ? node : (node?.parentElement ?? null);
        // The site header is the document's first; a page may draw a header of its own.
        if (!element || element.closest('header') !== document.querySelector('header')) continue;
        moved.push(`${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim()}"`);
      }
    }
  }).observe({ type: 'layout-shift', buffered: true });
}

/** Mark this browser as holding a Clerk session, in script only, so the server never sees it. */
function holdSessionCookie(): void {
  document.cookie = '__client_uat=1759100000; path=/';
}

/**
 * The header's parts by name, with their boxes: every link and nav it draws, and the cluster at
 * the row's end that holds the account controls, whose left edge anything placed before it
 * follows.
 *
 * @param page - The page.
 * @returns The boxes of the parts that take up room.
 */
async function headerBoxes(page: Page): Promise<Record<string, Box>> {
  return await page.evaluate(() => {
    const boxes: Record<string, Box> = {};
    // The site header is the document's first; a page may draw a header of its own.
    const header = document.querySelector('header');
    const cluster = header?.querySelector(':scope > div > :last-child');
    const parts = [...(header?.querySelectorAll('a, nav') ?? []), ...(cluster ? [cluster] : [])];
    for (const element of parts) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const name =
        element === cluster
          ? 'account cluster'
          : `${element.tagName.toLowerCase()} ${
              element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().slice(0, 40)
            }`;
      boxes[name] = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }
    return boxes;
  });
}

/** Let the page lay out and paint twice, so a shift from the last change has been observed. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** What the header's layout shifts moved, from navigation to now. */
async function headerShifts(page: Page): Promise<string[]> {
  return await page.evaluate(() => (window as unknown as { headerShifts: string[] }).headerShifts);
}

for (const path of PAGES) {
  test(`${path} keeps the header still when Clerk mounts Sign in and Create account`, async ({
    page,
  }) => {
    await page.addInitScript(recordHeaderShifts);
    const clerk = await holdClerk(page, 'signed-out');
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await clerk.requested;
    // The nav mounts once the page has hydrated and read that this browser holds no session.
    await page.locator('header nav[aria-label="Site"]').waitFor({ state: 'attached' });
    await settle(page);
    const before = await headerBoxes(page);
    expect(before).toHaveProperty(['account cluster']);

    clerk.release();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
    await settle(page);

    const after = await headerBoxes(page);
    for (const [name, box] of Object.entries(before)) expect(after[name], name).toEqual(box);
    expect(await headerShifts(page)).toEqual([]);
  });
}

test('keeps the header still when Clerk mounts the account menu of a signed-in manager', async ({
  page,
}) => {
  await page.addInitScript(recordHeaderShifts);
  await page.addInitScript(holdSessionCookie);
  const clerk = await holdClerk(page, 'signed-in');
  await page.goto('/setup', { waitUntil: 'domcontentloaded' });
  await clerk.requested;
  await settle(page);
  const before = await headerBoxes(page);
  expect(before).toHaveProperty(['account cluster']);

  clerk.release();
  await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible();
  await settle(page);

  expect(await headerBoxes(page)).toEqual(before);
  expect(await headerShifts(page)).toEqual([]);
});
