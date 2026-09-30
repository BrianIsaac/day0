import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * The home's mini office, measured where only a browser lays it out (the pre-tag pass's minor 11:
 * its tests pinned stylesheet strings, and only a bed ever measured it). The home needs a backend
 * the job does not hold, so the office is rendered from the component (`office-markup.ts`) and
 * mounted on a public page under the build's stylesheet, in a column as wide as the home gives it.
 * The specs set their own viewports, so they run under the desktop project only.
 */

/** The office's markup for a named roster, rendered once from the component. */
function markup(roster: string): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./office-markup.ts', import.meta.url)), roster],
    { encoding: 'utf8' },
  );
}

const TEN_IDLE = markup('ten-idle');
const TEN_MIXED = markup('ten-mixed');

/** One box, in CSS pixels. */
interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** What the mounted office measures once laid out. */
interface OfficeReading {
  /** The office's floor, inside its 8 px frame. */
  readonly floor: Box;
  readonly figures: readonly Box[];
  /** Each count pill's text that does not fit its box, in px; 0 when it fits. */
  readonly pillOverflow: readonly number[];
}

/**
 * Mount an office in a column `width` wide (the home's main column) and measure it.
 *
 * @param page - The loaded page.
 * @param html - The office's markup.
 * @param width - The column's width, a CSS length.
 */
async function mountOffice(page: Page, html: string, width: string): Promise<void> {
  await page.evaluate(
    ({ office, column }: { office: string; column: string }) => {
      const holder = document.createElement('div');
      holder.id = 'office-under-test';
      holder.style.cssText = `width: ${column}; margin: 0 auto; position: relative;`;
      holder.innerHTML = office;
      document.body.prepend(holder);
      window.scrollTo(0, 0);
    },
    { office: html, column: width },
  );
}

/** Measure the mounted office. */
async function readOffice(page: Page): Promise<OfficeReading> {
  return await page.evaluate(() => {
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    const office = document.querySelector('#office-under-test .day0-pixel-office');
    if (!office) throw new Error('the office did not mount');
    const outer = box(office);
    const figures = [...office.querySelectorAll('.day0-office-agent')];
    return {
      floor: {
        left: outer.left + 8,
        top: outer.top + 8,
        right: outer.right - 8,
        bottom: outer.bottom - 8,
      },
      figures: figures.map(box),
      pillOverflow: figures.map((figure) => {
        const pill = figure.querySelector<HTMLElement>('.rounded-full');
        return pill ? Math.max(0, pill.scrollWidth - pill.clientWidth) : 0;
      }),
    };
  });
}

/** Each pair of figures whose boxes overlap, by index, with the overlap's area. */
function overlaps(figures: readonly Box[]): string[] {
  return figures.flatMap((a, i) =>
    figures.slice(i + 1).flatMap((b, offset) => {
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      // Rounding at a subpixel edge is not an overlap.
      return width > 0.5 && height > 0.5 ? [`${i} and ${i + offset + 1}: ${width}x${height}`] : [];
    }),
  );
}

/** Each figure that crosses the floor's edge, by index. */
function outside(floor: Box, figures: readonly Box[]): number[] {
  return figures.flatMap((figure, index) =>
    figure.left < floor.left - 0.5 ||
    figure.top < floor.top - 0.5 ||
    figure.right > floor.right + 0.5 ||
    figure.bottom > floor.bottom + 0.5
      ? [index]
      : [],
  );
}

test.describe('the mini office, laid out', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'sets its own viewports');
    await page.route(/\.invalid\//, (route) => route.abort());
    // At rest: the roaming bob and the walk are motion, not layout.
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('stands ten idle employees apart and inside the office at 1440 (second review x9)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/walkthrough', { waitUntil: 'load' });
    // The home's main column at 1440: 1280 less its padding, the aside and the gap between.
    await mountOffice(page, TEN_IDLE, '886px');
    const office = await readOffice(page);
    expect(office.figures).toHaveLength(10);
    expect(overlaps(office.figures)).toEqual([]);
    expect(outside(office.floor, office.figures)).toEqual([]);
  });

  for (const width of [390, 320]) {
    test(`seats ten employees apart and inside the office at ${width}, the counts uncut (pre-tag minor 10)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/walkthrough', { waitUntil: 'load' });
      // The home's column on a phone: the viewport less its 16 px gutters.
      await mountOffice(page, TEN_MIXED, 'calc(100vw - 32px)');
      const office = await readOffice(page);
      expect(office.figures).toHaveLength(10);
      expect(overlaps(office.figures)).toEqual([]);
      expect(outside(office.floor, office.figures)).toEqual([]);
      expect(office.pillOverflow).toEqual(Array.from({ length: 10 }, () => 0));
      // A fourth row for the tenth: the office is as tall as its rows.
      expect(office.floor.bottom - office.floor.top).toBeCloseTo(750 - 16, 0);
    });
  }

  test('redraws the figures in place when the page crosses sm, rather than walking them across', async ({
    page,
  }) => {
    // Motion allowed here: it is the walk that must not start.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/walkthrough', { waitUntil: 'load' });
    await mountOffice(page, TEN_MIXED, 'calc(100vw - 32px)');
    await page.setViewportSize({ width: 800, height: 844 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const office = await readOffice(page);
    // The seated figures' step animation is not a walk; only a transition would be.
    const walking = await page.evaluate(
      () =>
        [...document.querySelectorAll('#office-under-test .day0-office-agent')].filter((figure) =>
          figure.getAnimations().some((animation) => animation instanceof CSSTransition),
        ).length,
    );
    expect(walking).toBe(0);
    expect(office.figures).toHaveLength(10);
  });
});
