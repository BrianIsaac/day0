import type { Page } from 'playwright/test';

/**
 * The reader's-stop harness UX round four proved its pinned frames with (`scroll-assert.mjs`),
 * for any page with one `[data-pin]` sequence driven by `useInReadingBand`. A stop is where a
 * reader rests, never the tracker's own rule: at 1440 the step copy centred in the viewport, or
 * beside the pinned frame with their centres level; at 390 the copy just under the pinned frame.
 */

/** A reader's stop: `centred` and `beside` beside the frame (1440), `under` it (390). */
export type ReaderStop = 'centred' | 'beside' | 'under';

/** What a stop saw at rest and on the way there. */
export interface StopReading {
  readonly scrollY: number;
  /** The frames whose computed opacity is above 0.5. */
  readonly visible: number[];
  /** The tracker's active step, from `data-active`. */
  readonly active: number;
  /** The active step each time it changed on the way, starting where the scroll began. */
  readonly sequence: number[];
  /** Whether `sequence` only moved in the direction of travel. */
  readonly monotonic: boolean;
}

/** The scroll speeds of the round-four harness, in pixels per animation frame. */
export const SPEEDS = [
  { tag: 'slow', px: 4 },
  { tag: 'medium', px: 14 },
  { tag: 'fast', px: 48 },
] as const;

/** The scroll position at which step `step` sits at a reader's `stop`. */
export function stopFor(page: Page, step: number, stop: ReaderStop): Promise<number> {
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
function travel(page: Page, y: number, px: number): Promise<number[]> {
  return page.evaluate(
    ({ y, px }) =>
      new Promise<number[]>((resolve) => {
        const root = document.querySelector<HTMLElement>('[data-pin]');
        const samples: number[] = [];
        const sample = (): void => {
          samples.push(Number(root?.dataset.active));
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
export function atRest(
  page: Page,
): Promise<{ visible: number[]; active: number; scrollY: number }> {
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

/**
 * Scroll to step `step`'s reader's `stop` at `px` per frame, rest 700 ms, and read what shows.
 */
export async function readStop(
  page: Page,
  step: number,
  stop: ReaderStop,
  px: number,
  direction: 'down' | 'up',
): Promise<StopReading> {
  const samples = await travel(page, await stopFor(page, step, stop), px);
  await page.waitForTimeout(700);
  const rest = await atRest(page);
  const sequence = samples.filter((active, index, all) => index === 0 || active !== all[index - 1]);
  const monotonic = sequence.every(
    (active, index) =>
      index === 0 ||
      (direction === 'down'
        ? active >= (sequence[index - 1] ?? active)
        : active <= (sequence[index - 1] ?? active)),
  );
  return { ...rest, sequence, monotonic };
}
