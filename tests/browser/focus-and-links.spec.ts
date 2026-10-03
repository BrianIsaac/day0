import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The focus ring and the link underline in a real Chromium under the build's own stylesheet
 * (C1, C3). The ring sits in the base layer, so every control shows it and a control's own
 * utility outranks it; a link with no class of its own inside a sentence is underlined, and a
 * link drawn as a control, a nav link or a tab is not. The employee page's controls need a
 * backend the job does not hold, so they are rendered from the components
 * (`focus-and-links-markup.ts`) and mounted on a public page; the public pages are walked whole.
 */

/** The controls and the sentence, rendered once from the components. */
const MARKUP = execFileSync(
  process.execPath,
  ['--import', 'tsx', fileURLToPath(new URL('./focus-and-links-markup.ts', import.meta.url))],
  { encoding: 'utf8' },
);

/** The public pages walked with Tab. `/sign-in` is Clerk's, which draws its own focus. */
const PAGES = ['/', '/setup', '/walkthrough'] as const;

/** At most this many Tab presses per page, well past the stops the landing has. */
const MAX_STOPS = 120;

/** What the ring and the underline look like on one element, as computed. */
interface Look {
  readonly focusVisible: boolean;
  readonly outlineStyle: string;
  readonly outlineWidth: number;
  readonly outlineOffset: string;
  readonly borderRadius: string;
  readonly decorationLine: string;
  readonly decorationColour: string;
  readonly height: number;
  readonly lineHeight: number;
}

/**
 * Read an element's ring and underline.
 *
 * @param target - The element.
 */
async function lookOf(target: Locator): Promise<Look> {
  return await target.evaluate((element: Element): Look => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineOffset: style.outlineOffset,
      borderRadius: style.borderTopLeftRadius,
      decorationLine: style.textDecorationLine,
      decorationColour: style.textDecorationColor,
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(element.parentElement ?? element).lineHeight),
    };
  });
}

/**
 * The link line token as the page computes it, read off a probe element.
 *
 * @param page - The loaded page.
 */
async function linkLine(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.textDecorationColor = 'var(--color-link-line)';
    document.body.append(probe);
    const colour = getComputedStyle(probe).textDecorationColor;
    probe.remove();
    return colour;
  });
}

/**
 * Focus an element as the keyboard does: a key is pressed first, so the browser shows the ring
 * for the focus the script then moves.
 *
 * @param page - The loaded page.
 * @param target - The element to focus.
 */
async function keyboardFocus(page: Page, target: Locator): Promise<Look> {
  await page.keyboard.press('Shift');
  await target.focus();
  return await lookOf(target);
}

/**
 * Mount the probes in a page-width column over a public page.
 *
 * @param page - The page.
 */
async function mountProbes(page: Page): Promise<void> {
  await page.goto('/setup', { waitUntil: 'load' });
  await page.evaluate((html: string) => {
    const column = document.createElement('div');
    column.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;overflow:auto;padding:24px 16px;background:var(--color-bg)';
    column.innerHTML = html;
    document.body.append(column);
  }, MARKUP);
}

test.describe('the focus ring (C1)', () => {
  for (const path of PAGES) {
    test(`shows on every control Tab reaches on ${path}`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'load' });
      // The page's own content, drawn and hydrated, as `public-pages.spec.ts` waits for it: `/`
      // draws its landing only once the browser knows who it has, so a walk begun at `load` on a
      // busy runner met the header's two controls alone and failed (seen once in R-W's gate).
      await expect(page.locator('main h1').first()).toBeVisible();
      const missing: string[] = [];
      let stops = 0;
      for (let press = 0; press < MAX_STOPS; press += 1) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => {
          const element = document.activeElement;
          if (element === null || element === document.body) return null;
          // Marked as it is reached, so the walk ends when Tab comes round to a control again.
          if (element.hasAttribute('data-walked')) return 'again';
          element.setAttribute('data-walked', '');
          const style = getComputedStyle(element);
          const name =
            element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? '';
          return {
            key: `${element.tagName.toLowerCase()} "${name}" ${element.getAttribute('href') ?? ''}`,
            ringed: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2,
          };
        });
        if (focused === 'again') break;
        if (focused === null) continue;
        stops += 1;
        if (!focused.ringed) missing.push(focused.key);
      }
      expect(stops, 'Tab reached too few controls to be the whole page').toBeGreaterThan(3);
      expect(missing).toEqual([]);
    });
  }

  test("draws the walkthrough frame's ring inside it, as its own utility says", async ({
    page,
  }) => {
    await page.goto('/walkthrough', { waitUntil: 'load' });
    const frame = page.locator('a.cursor-zoom-in').first();
    // The frame holding it may not be the one shown yet, and a hidden frame is inert.
    await frame.evaluate((link: Element) => link.closest('[inert]')?.removeAttribute('inert'));
    const look = await keyboardFocus(page, frame);
    expect(look.focusVisible).toBe(true);
    expect(look.outlineWidth).toBe(2);
    expect(look.outlineOffset).toBe('-3px');
  });

  test("rings the employee page's controls and keeps each one's own corners", async ({ page }) => {
    await mountProbes(page);
    const button = await keyboardFocus(page, page.locator('[data-probe="button"] button'));
    expect(button).toMatchObject({ focusVisible: true, outlineStyle: 'solid', outlineWidth: 2 });
    // `rounded-lg`, 8 px: unlayered, the ring's 6 px won.
    expect(button.borderRadius).toBe('8px');
    const card = await keyboardFocus(page, page.locator('[data-probe="card"] button.rail-step'));
    expect(card).toMatchObject({ focusVisible: true, outlineStyle: 'solid', borderRadius: '12px' });
    const tab = await keyboardFocus(page, page.locator('[data-probe="tabs"] [role="tab"]').first());
    expect(tab).toMatchObject({ focusVisible: true, outlineStyle: 'solid', outlineOffset: '-2px' });
    const link = await keyboardFocus(page, page.locator('[data-probe="prose"] a'));
    expect(link).toMatchObject({ focusVisible: true, outlineStyle: 'solid', outlineWidth: 2 });
  });
});

test.describe('the link in running text (C3)', () => {
  test('underlines a bare link in a sentence in the link line, on the line it sits on', async ({
    page,
  }) => {
    await mountProbes(page);
    const link = page.locator('[data-probe="prose"] a');
    const look = await lookOf(link);
    expect(look.decorationLine).toBe('underline');
    // `--color-link-line`, as `ButtonLink variant="text"` draws it.
    const line = await linkLine(page);
    // An undefined token would leave both on the text's own colour and still compare equal.
    expect(line).not.toBe(await page.evaluate(() => getComputedStyle(document.body).color));
    expect(look.decorationColour).toBe(line);
    expect(look.height).toBeLessThanOrEqual(look.lineHeight + 1);
    await link.hover();
    // `--color-accent`, #22d3ee, once the 180 ms colour change has run.
    await expect.poll(async () => (await lookOf(link)).decorationColour).toBe('rgb(34, 211, 238)');
  });

  test('leaves a link drawn as a control, a tab and a nav link as they draw themselves', async ({
    page,
  }) => {
    await mountProbes(page);
    expect((await lookOf(page.locator('[data-probe="button-link"] a'))).decorationLine).toBe(
      'none',
    );
    const text = await lookOf(page.locator('[data-probe="text-link"] a'));
    expect(text).toMatchObject({
      decorationLine: 'underline',
      decorationColour: await linkLine(page),
    });
    for (const tab of await page.locator('[data-probe="tabs"] [role="tab"]').all()) {
      expect((await lookOf(tab)).decorationLine).toBe('none');
    }
    await page.goto('/walkthrough', { waitUntil: 'load' });
    const nav = page.locator('header nav a[href="/#how"]');
    await expect(nav).toBeAttached();
    expect((await lookOf(nav)).decorationLine).toBe('none');
  });
});
