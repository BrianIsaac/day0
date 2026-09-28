import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { RECORDED_RUN, elapsedLabel } from '../../src/demo/walkthrough';
import { SPEEDS, atRest, readStop, type ReaderStop } from './pinned-scroll';

/**
 * The walkthrough's pinned device frame, proved the way UX round four proved its prototype
 * (`scroll-assert.mjs`, 288 walkthrough stops): the page scrolled to each of the sixteen steps
 * at three speeds, at 1440 and 390 wide, down and then up. At each reader's stop, after 700 ms at
 * rest, exactly one capture is visible and it is the step's, the tracker's active step is the
 * step, on the way there the active step only moved in the direction of travel, and the frame's
 * clock reads the step's README time (or says it is untimed where the README states none).
 *
 * Runs against a started app at the configured `baseURL`, signed out, in mock mode. Set
 * `WALKTHROUGH_SCROLL_LOG` to a directory to keep the per-stop log as JSON and Markdown.
 */

const WIDTHS = [
  { tag: '1440', width: 1440, height: 900, mobile: false, stops: ['centred', 'beside'] },
  { tag: '390', width: 390, height: 844, mobile: true, stops: ['under'] },
] as const;
const STEPS = RECORDED_RUN.steps.map((step) => step.number);
const UNTIMED = `timed from step ${RECORDED_RUN.steps.find((step) => step.elapsedSeconds !== null)?.number}`;

/** One stop's outcome, as the prototype's log recorded it, with the clock the frame showed. */
interface StopResult {
  readonly width: string;
  readonly speed: string;
  readonly stop: ReaderStop;
  readonly direction: 'down' | 'up';
  readonly step: number;
  readonly scrollY: number;
  readonly visible: number[];
  readonly active: number;
  readonly sequence: number[];
  readonly clock: string;
  readonly pass: boolean;
}

const results: StopResult[] = [];

/** The clock the frame bar shows at rest. */
function clock(page: Page): Promise<string> {
  return page
    .locator('[data-pin-side] [data-clock]')
    .first()
    .innerText()
    .then((text) => text.trim());
}

/** The clock step `step` should show: its README time, or the untimed caption. */
function expectedClock(step: number): string {
  const seconds = RECORDED_RUN.steps[step - 1]?.elapsedSeconds ?? null;
  return seconds === null ? UNTIMED : elapsedLabel(seconds);
}

/** Page errors other than Clerk's, whose frontend API the proof deliberately cannot reach. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    if (!String(error).includes('failed_to_load_clerk_js')) errors.push(String(error));
  });
  return errors;
}

/** Open the walkthrough and let fonts and the first layout settle. */
async function open(page: Page, path = '/walkthrough'): Promise<void> {
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
}

for (const viewport of WIDTHS) {
  test.describe(`the walkthrough's pinned frame at ${viewport.tag}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      isMobile: viewport.mobile,
      hasTouch: viewport.mobile,
      colorScheme: 'dark',
      reducedMotion: 'no-preference',
    });

    for (const speed of SPEEDS) {
      test(`shows the step's own capture and time at every reader's stop, scrolled ${speed.tag}`, async ({
        page,
      }) => {
        test.setTimeout(240_000);
        const errors = collectErrors(page);
        await open(page);

        for (const stop of viewport.stops) {
          await page.evaluate(() => scrollTo(0, 0));
          await page.waitForTimeout(400);
          for (const [direction, order] of [
            ['down', STEPS],
            ['up', [...STEPS].reverse()],
          ] as const) {
            for (const step of order) {
              const seen = await readStop(page, step, stop, speed.px, direction);
              const shown = await clock(page);
              const result: StopResult = {
                width: viewport.tag,
                speed: speed.tag,
                stop,
                direction,
                step,
                scrollY: seen.scrollY,
                visible: seen.visible,
                active: seen.active,
                sequence: seen.sequence,
                clock: shown,
                pass:
                  seen.visible.length === 1 &&
                  seen.visible[0] === step &&
                  seen.active === step &&
                  seen.monotonic &&
                  shown === expectedClock(step),
              };
              results.push(result);
              expect.soft(result, `${stop} ${direction} to step ${step}`).toMatchObject({
                visible: [step],
                active: step,
                clock: expectedClock(step),
              });
              expect
                .soft(
                  seen.monotonic,
                  `the active step moved against the scroll: ${seen.sequence.join(' > ')}`,
                )
                .toBe(true);
            }
          }
        }
        expect(errors).toEqual([]);
      });
    }

    test('lands a link to a step on that step', async ({ page }) => {
      const errors = collectErrors(page);
      for (const step of [2, 8, 15]) {
        await open(page, `/walkthrough#step-${step}`);
        const rest = await atRest(page);
        expect(rest, `#step-${step}`).toMatchObject({ visible: [step], active: step });
      }
      expect(errors).toEqual([]);
    });
  });
}

test.describe('the walkthrough on a phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });

  test('fits the screen, with nothing scrolling sideways', async ({ page }) => {
    await page.goto('/walkthrough');
    const widths = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      screen: innerWidth,
    }));
    expect(widths).toEqual({ page: 390, screen: 390 });
  });
});

test.describe('the walkthrough and the sign-in page as pointer targets', () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`give every control of their own at least 44 px, or keep it inside a sentence, at ${viewport.width}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      for (const path of ['/walkthrough', '/sign-in']) {
        await page.goto(path);
        // The page's own content only: the site header is the layout's.
        const measured = await page.locator('main a[href], main button, main input').count();
        expect(measured, `${path} has controls of its own to measure`).toBeGreaterThan(2);
        const small = await page.evaluate(() =>
          Array.from(
            document.querySelectorAll<HTMLElement>('main a[href], main button, main input'),
            (control) => {
              const box = control.getBoundingClientRect();
              const inline =
                control.tagName === 'A' &&
                getComputedStyle(control).display === 'inline' &&
                (control.parentElement?.textContent ?? '').trim().length >
                  (control.textContent ?? '').trim().length;
              return inline || (box.width >= 44 && box.height >= 44)
                ? null
                : `${control.textContent?.trim()} ${Math.round(box.width)}x${Math.round(box.height)}`;
            },
          ).filter((entry) => entry !== null),
        );
        expect(small, path).toEqual([]);
      }
    });
  }
});

test.describe('the walkthrough under reduced motion', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });

  test('lands the clock at once and swaps the capture by opacity alone', async ({ page }) => {
    await open(page);
    await page.evaluate(() =>
      document.querySelector('[data-step="16"]')?.scrollIntoView({ block: 'center' }),
    );
    await page.waitForTimeout(250);
    expect(await clock(page)).toBe(elapsedLabel(RECORDED_RUN.steps[15]!.elapsedSeconds!));
    const swap = await page.evaluate(() => {
      const frame = document.querySelector('[data-frame]');
      const style = frame ? getComputedStyle(frame) : null;
      return { property: style?.transitionProperty, transform: style?.transform };
    });
    expect(swap).toEqual({ property: 'opacity', transform: 'none' });
  });
});

test.describe('the old address', () => {
  test('redirects /demo to the walkthrough permanently, for a signed-out visitor', async ({
    request,
  }) => {
    const response = await request.get('/demo', { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe('/walkthrough');
  });
});

test.afterAll(() => {
  const directory = process.env.WALKTHROUGH_SCROLL_LOG;
  if (!directory || results.length === 0) return;
  const passed = results.filter((result) => result.pass).length;
  const lines = [
    `# Walkthrough scroll assertions: ${passed} of ${results.length} pass`,
    '',
    '| Width | Speed | Stop | Direction | Step | Visible | Active | Sequence | Clock | Pass |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.width} | ${r.speed} | ${r.stop} | ${r.direction} | ${r.step} | ${r.visible.join(', ') || 'none'} | ${r.active} | ${r.sequence.join(' > ')} | ${r.clock} | ${r.pass ? 'pass' : 'FAIL'} |`,
    ),
    '',
  ];
  // Each worker writes its own share; a single-worker run writes the whole log.
  const name = `walkthrough-scroll-${process.env.TEST_WORKER_INDEX ?? '0'}`;
  writeFileSync(
    join(directory, `${name}.json`),
    JSON.stringify({ passed, total: results.length, results }, null, 1),
  );
  writeFileSync(join(directory, `${name}.md`), lines.join('\n'));
});
