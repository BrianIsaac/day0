import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from 'playwright/test';

/**
 * The pinned how-it-works frame, proved the way UX round four proved its prototype
 * (`scroll-assert.mjs`, 72 landing stops): the signed-out landing scrolled to each of the four
 * steps at three speeds, at 1440 and 390 wide, down and then up. Every stop is a reader's stop,
 * not the tracker's own rule: at 1440 the step copy centred in the viewport, and the copy beside
 * the pinned frame with their centres level; at 390 the copy just under the pinned frame. At
 * each stop, after 700 ms at rest, exactly one frame is visible and it is the step's, the
 * tracker's active step is the step, and on the way there the active step only moved in the
 * direction of travel.
 *
 * Runs against a started app at the configured `baseURL`, signed out, in mock mode. Set
 * `LANDING_SCROLL_LOG` to a directory to keep the per-stop log as JSON and Markdown.
 */

const WIDTHS = [
  { tag: '1440', width: 1440, height: 900, mobile: false, stops: ['centred', 'beside'] },
  { tag: '390', width: 390, height: 844, mobile: true, stops: ['under'] },
] as const;
const SPEEDS = [
  { tag: 'slow', px: 4 },
  { tag: 'medium', px: 14 },
  { tag: 'fast', px: 48 },
] as const;
const STEPS = [1, 2, 3, 4];

type Stop = (typeof WIDTHS)[number]['stops'][number];

/** One stop's outcome, as the prototype's log recorded it. */
interface StopResult {
  readonly width: string;
  readonly speed: string;
  readonly stop: Stop;
  readonly direction: 'down' | 'up';
  readonly step: number;
  readonly scrollY: number;
  readonly visible: number[];
  readonly active: number;
  readonly sequence: number[];
  readonly pass: boolean;
}

const results: StopResult[] = [];

/** The scroll position at which step `step` sits at a reader's `stop`. */
function target(page: Page, step: number, stop: Stop): Promise<number> {
  return page.evaluate(
    ({ step, stop }) => {
      const root = document.querySelector<HTMLElement>('[data-pin]');
      const side = root?.querySelector<HTMLElement>('[data-pin-side]');
      const copy = root?.querySelector<HTMLElement>(`[data-step="${step}"]`);
      if (!root || !side || !copy) throw new Error('the pinned sequence is not on the page');
      const box = copy.getBoundingClientRect();
      const height = side.offsetHeight;
      // Where the frame rests once the section is pinned: its sticky top, from the stylesheet.
      const top = Number.parseFloat(getComputedStyle(side).top) || 0;
      const pinStart = scrollY + root.getBoundingClientRect().top - top;
      const y =
        stop === 'centred'
          ? scrollY + box.top + box.height / 2 - innerHeight / 2
          : stop === 'beside'
            ? scrollY + box.top + box.height / 2 - (top + height / 2)
            : scrollY + box.top - (top + height) - 16;
      return Math.round(Math.max(pinStart, y));
    },
    { step, stop },
  );
}

/** Scroll to `y` at `px` per animation frame, sampling the active step on every frame. */
function travel(page: Page, y: number, px: number): Promise<[number, number][]> {
  return page.evaluate(
    ({ y, px }) =>
      new Promise<[number, number][]>((resolve) => {
        const root = document.querySelector<HTMLElement>('[data-pin]');
        const samples: [number, number][] = [];
        const sample = (): void => {
          samples.push([Math.round(scrollY), Number(root?.dataset.active)]);
        };
        const frame = (): void => {
          const distance = y - scrollY;
          sample();
          if (Math.abs(distance) <= px) {
            scrollTo(0, y);
            sample();
            resolve(samples);
            return;
          }
          const before = scrollY;
          scrollBy(0, Math.sign(distance) * px);
          // The page ends before the target.
          if (scrollY === before) resolve(samples);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    { y, px },
  );
}

/** What is visible at rest: the frames above half opacity and the tracker's active step. */
function observe(page: Page): Promise<{ visible: number[]; active: number; scrollY: number }> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-pin]');
    const frames = Array.from(root?.querySelectorAll<HTMLElement>('[data-frame]') ?? []);
    return {
      visible: frames
        .filter((frame) => Number(getComputedStyle(frame).opacity) > 0.5)
        .map((frame) => Number(frame.dataset.frame)),
      active: Number(root?.dataset.active),
      scrollY: Math.round(scrollY),
    };
  });
}

for (const viewport of WIDTHS) {
  test.describe(`the pinned how-it-works frame at ${viewport.tag}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      isMobile: viewport.mobile,
      hasTouch: viewport.mobile,
      colorScheme: 'dark',
      reducedMotion: 'no-preference',
    });

    for (const speed of SPEEDS) {
      test(`shows the step's own frame at every reader's stop, scrolled ${speed.tag}`, async ({
        page,
      }) => {
        // The reader scrolls by the frame: the slow pass at 1440 is about 30 s of frames on its
        // own, which the default 30 s budget cut short on every run, the product unchanged.
        test.setTimeout(90_000);
        const errors: string[] = [];
        page.on('pageerror', (error) => {
          // The proof runs with no Clerk frontend API to reach, by design (no live service);
          // the landing is what a visitor sees before, or without, the sign-in script.
          if (!String(error).includes('failed_to_load_clerk_js')) errors.push(String(error));
        });
        await page.goto('/');
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(1500);

        for (const stop of viewport.stops) {
          await page.evaluate(() => scrollTo(0, 0));
          await page.waitForTimeout(400);
          for (const [direction, order] of [
            ['down', STEPS],
            ['up', [...STEPS].reverse()],
          ] as const) {
            for (const step of order) {
              const samples = await travel(page, await target(page, step, stop), speed.px);
              await page.waitForTimeout(700);
              const seen = await observe(page);
              const sequence = samples
                .map(([, active]) => active)
                .filter((active, index, all) => index === 0 || active !== all[index - 1]);
              const monotonic = sequence.every(
                (active, index) =>
                  index === 0 ||
                  (direction === 'down'
                    ? active >= (sequence[index - 1] ?? active)
                    : active <= (sequence[index - 1] ?? active)),
              );
              const result: StopResult = {
                width: viewport.tag,
                speed: speed.tag,
                stop,
                direction,
                step,
                scrollY: seen.scrollY,
                visible: seen.visible,
                active: seen.active,
                sequence,
                pass:
                  seen.visible.length === 1 &&
                  seen.visible[0] === step &&
                  seen.active === step &&
                  monotonic,
              };
              results.push(result);
              expect.soft(result, `${stop} ${direction} to step ${step}`).toMatchObject({
                visible: [step],
                active: step,
              });
              expect
                .soft(
                  monotonic,
                  `the active step moved against the scroll: ${sequence.join(' > ')}`,
                )
                .toBe(true);
            }
          }
        }
        expect(errors).toEqual([]);
      });
    }
  });
}

test.describe('the landing on a phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });

  test('fits the screen, with nothing scrolling sideways', async ({ page }) => {
    await page.goto('/');
    const widths = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      screen: innerWidth,
    }));
    expect(widths).toEqual({ page: 390, screen: 390 });
  });
});

test.describe('the landing under reduced motion', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });

  test('shows every card at once and swaps the frame by opacity alone', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    const cards = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-cards] > *'), (card) => ({
        opacity: getComputedStyle(card).opacity,
        animation: getComputedStyle(card).animationName,
      })),
    );
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(card).toEqual({ opacity: '1', animation: 'none' });
    const swap = await page.evaluate(() => {
      const frame = document.querySelector('[data-frame]');
      const style = frame ? getComputedStyle(frame) : null;
      return { property: style?.transitionProperty, transform: style?.transform };
    });
    expect(swap).toEqual({ property: 'opacity', transform: 'none' });
  });
});

test.afterAll(() => {
  const directory = process.env.LANDING_SCROLL_LOG;
  if (!directory || results.length === 0) return;
  const passed = results.filter((result) => result.pass).length;
  const lines = [
    `# Landing scroll assertions: ${passed} of ${results.length} pass`,
    '',
    '| Width | Speed | Stop | Direction | Step | Visible | Active | Sequence | Pass |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.width} | ${r.speed} | ${r.stop} | ${r.direction} | ${r.step} | ${r.visible.join(', ') || 'none'} | ${r.active} | ${r.sequence.join(' > ')} | ${r.pass ? 'pass' : 'FAIL'} |`,
    ),
    '',
  ];
  // Each worker writes its own share; a single-worker run writes the whole log.
  const name = `landing-scroll-${process.env.TEST_WORKER_INDEX ?? '0'}`;
  writeFileSync(
    join(directory, `${name}.json`),
    JSON.stringify({ passed, total: results.length, results }, null, 1),
  );
  writeFileSync(join(directory, `${name}.md`), lines.join('\n'));
});
