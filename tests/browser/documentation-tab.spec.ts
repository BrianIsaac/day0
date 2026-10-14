import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { THEMES, chooseTheme, expectDrawnIn } from './theme';

/**
 * The Documentation tab at 1440 once a relation's card was answered, and the field that says
 * where a location is, in a real Chromium and in both themes (wave 17, 17-FD): what 16-s's bed
 * and 16-T's signed-in shots drew and only a browser lays out.
 *
 * 16-s's F5 read a full-page shot taken after an answer: the skip link and the sticky header
 * drawn over the Sources card, and the last page row's controls laid out unlike the rows above
 * it. The first is how a full-page capture draws a fixed and a sticky element (at the scroll
 * offset, over whatever is there) and nothing a viewer sees: the browser centres the card focus
 * goes to (probed in Chromium and Firefox, 381 px below a header that ends at 57), and the skip
 * link stays above the window until a keyboard reaches it. That is held here so it stays so. The
 * second was a page select taking its longest option's width (fixed by 16-FD at 390): held here
 * at 1440. 16-T's F7 was a folder's "Where it is" opening on a lone "." with nothing beside it to
 * say what it stood for.
 *
 * The tab needs a backend the job does not hold, so its column is rendered from the components
 * (`documentation-markup.tsx answered`) and mounted on a public page under the build's own
 * stylesheet, below that page's own header: the header is the layout's, the one every page has.
 */

/** The answered column's markup, rendered once from the components. */
const MARKUP = execFileSync(
  process.execPath,
  [
    '--import',
    'tsx',
    fileURLToPath(new URL('./documentation-markup.tsx', import.meta.url)),
    'answered',
  ],
  { encoding: 'utf8' },
);

/**
 * Mount the answered column under the page's own header, in the tab's main column at 1440: two
 * thirds of the page's 1280 less the gap.
 *
 * @param page - The loaded page.
 */
async function mountColumn(page: Page): Promise<void> {
  await page.evaluate((html: string) => {
    const header = document.querySelector('header');
    if (header === null || header.parentElement === null) throw new Error('the page has no header');
    const column = document.createElement('div');
    column.id = 'documentation-column';
    column.style.cssText = 'margin:0 auto;padding:24px 16px;width:837px';
    column.innerHTML = html;
    // Beside the header in its own parent, so the header stays stuck over the column's length.
    header.parentElement.append(column);
  }, MARKUP);
}

test.describe('the Documentation tab at 1440 after an answer', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of THEMES) {
    test(`shows "Your answer" below the sticky header when it takes focus, the page rows laid out alike, in ${theme}`, async ({
      page,
    }, testInfo) => {
      // The width is the test's own, so the phone project would only run it a second time.
      test.skip(testInfo.project.name !== 'desktop', 'measured once, under the desktop project');
      await chooseTheme(page, theme);
      await page.goto('/setup');
      await expectDrawnIn(page, theme);
      await mountColumn(page);
      const reading = await page.evaluate(() => {
        const column = document.getElementById('documentation-column');
        const answer = [...(column?.querySelectorAll<HTMLElement>('section') ?? [])].find(
          (section) => section.querySelector('h2')?.textContent === 'Your answer',
        );
        const header = document.querySelector('header');
        const skip = document.querySelector<HTMLElement>('a[href="#main"]');
        if (!column || !answer || !header || !skip) throw new Error('the column did not render');
        // The manager pressed an answer on a card far down the tab: the page is scrolled past
        // the place "Your answer" then takes, and focus goes there, as the tab sends it.
        window.scrollTo(0, document.documentElement.scrollHeight);
        const scrolledPast = answer.getBoundingClientRect().bottom < 0;
        answer.focus();
        return {
          scrolledPast,
          focused: document.activeElement === answer,
          answerTop: answer.getBoundingClientRect().top,
          headerBottom: header.getBoundingClientRect().bottom,
          headerPosition: getComputedStyle(header).position,
          answerBottom: answer.getBoundingClientRect().bottom,
          // Held above the window until a keyboard reaches it.
          skipBottom: skip.getBoundingClientRect().bottom,
          // Each page row's successor select, by its width: one layout for every row.
          selects: [
            ...new Set(
              [...column.querySelectorAll<HTMLElement>('select')]
                .filter((select) => select.closest('[aria-label="Linked documentation"]') === null)
                .filter((select) => select.id !== 'source-kind' && select.id !== 'source-trust')
                .map((select) => Math.round(select.getBoundingClientRect().width)),
            ),
          ],
          past: [...column.querySelectorAll<HTMLElement>('*')]
            .filter(
              (element) =>
                element.getBoundingClientRect().right > column.getBoundingClientRect().right + 0.5,
            )
            .filter((element) => element.closest('.sr-only') === null)
            .map((element) => (element.textContent ?? '').trim().slice(0, 40))
            .slice(0, 8),
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      expect(reading.headerPosition).toBe('sticky');
      expect(reading.scrolledPast).toBe(true);
      expect(reading.focused).toBe(true);
      expect(reading.answerTop).toBeGreaterThanOrEqual(reading.headerBottom);
      expect(reading.answerBottom).toBeLessThanOrEqual(900);
      expect(reading.skipBottom).toBeLessThanOrEqual(0);
      expect(reading.selects).toHaveLength(1);
      // And the answered column, its dated cards among it, sits inside its own width.
      expect(reading.past).toEqual([]);
      expect(reading.scrollWidth).toBeLessThanOrEqual(1440);
    });

    test(`says what a folder’s “.” means under the field, drawn and readable, in ${theme}`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'measured once, under the desktop project');
      await chooseTheme(page, theme);
      await page.goto('/setup');
      await expectDrawnIn(page, theme);
      await mountColumn(page);
      const field = page.locator('#documentation-column #source-locator');
      await field.scrollIntoViewIfNeeded();
      await expect(field).toHaveValue('.');
      const hint = page.locator('#documentation-column #source-locator-hint');
      await expect(hint).toBeVisible();
      // The words are the form's own, pinned in its mirror test: here, that the field is
      // described by them and that they name the mark the field opens on.
      const words = (await hint.textContent()) ?? '';
      expect(words).toContain('“.”');
      await expect(field).toHaveAccessibleDescription(words);
      const drawn = await page.evaluate(() => {
        const field = document.querySelector<HTMLElement>('#documentation-column #source-locator');
        const hint = document.querySelector<HTMLElement>(
          '#documentation-column #source-locator-hint',
        );
        if (!field || !hint) throw new Error('the field did not render');
        /** A colour's relative luminance (WCAG 2.2), from `rgb(r, g, b)`. */
        const luminance = (colour: string): number => {
          const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
            const channel = Number(part) / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        // The hint sits on its card: the nearest ancestor that paints a background.
        let card: HTMLElement | null = hint.parentElement;
        while (card !== null && getComputedStyle(card).backgroundColor === 'rgba(0, 0, 0, 0)') {
          card = card.parentElement;
        }
        const [text, ground] = [
          luminance(getComputedStyle(hint).color),
          luminance(getComputedStyle(card ?? document.body).backgroundColor),
        ];
        return {
          below: hint.getBoundingClientRect().top >= field.getBoundingClientRect().bottom,
          within: hint.getBoundingClientRect().right <= field.getBoundingClientRect().right + 0.5,
          contrast: (Math.max(text, ground) + 0.05) / (Math.min(text, ground) + 0.05),
        };
      });
      expect(drawn.below).toBe(true);
      expect(drawn.within).toBe(true);
      expect(drawn.contrast).toBeGreaterThanOrEqual(4.5);
    });
  }
});
