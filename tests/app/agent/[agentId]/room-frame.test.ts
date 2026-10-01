import { describe, expect, it } from 'vitest';
import { ROOM_HEIGHT } from '../../../../app/agent/[agentId]/room-frame';

/** One rem in CSS pixels, at the browser default the product keeps. */
const REM = 16;

/**
 * Where the room starts on its first view at `md` and up, and below `md` where the rail stacks:
 * measured on the 30 September bed at 1440 x 900, 1280 x 720 and 390 x 844.
 */
const ROOM_TOP_PX = { wide: 369, stacked: 595 } as const;

/** The sticky site header's height, which a room scrolled to sits under. */
const HEADER_PX = 57;

/** The room's bottom edge keeps this much window below it, so the composer is not flush. */
const GAP_PX = 8;

/**
 * The room's height in CSS pixels for one of its classes at a window height, evaluating the
 * class's `clamp(min, calc(100dvh - offset), max)`.
 *
 * @param prefix - The breakpoint prefix, `''` for the base class.
 * @param windowHeight - The window's height in CSS pixels.
 */
function heightAt(prefix: '' | 'md:', windowHeight: number): number {
  const pattern = new RegExp(
    `(?:^|\\s)${prefix}h-\\[clamp\\(([\\d.]+)rem,calc\\(100dvh-([\\d.]+)rem\\),([\\d.]+)rem\\)\\]`,
  );
  const match = pattern.exec(ROOM_HEIGHT);
  if (match === null) throw new Error(`no ${prefix || 'base'} viewport height in ${ROOM_HEIGHT}`);
  const [min, offset, max] = match.slice(1).map((value) => Number(value) * REM);
  return Math.min(max, Math.max(min, windowHeight - offset));
}

describe('the one-to-one room frame', (): void => {
  // The room's top was measured at these two sizes; the offset is held against it.
  it.each([
    [1440, 900],
    [1280, 720],
  ])(
    'keeps the whole room, reply box included, in the window on its first view at %i x %i, where its top was measured (walk m9)',
    (_width, windowHeight): void => {
      expect(ROOM_TOP_PX.wide + heightAt('md:', windowHeight) + GAP_PX).toBeLessThanOrEqual(
        windowHeight,
      );
    },
  );

  it('fits in one window under the sticky header on a phone, where the rail stacks above it', (): void => {
    for (const windowHeight of [844, 667]) {
      expect(HEADER_PX + heightAt('', windowHeight) + GAP_PX).toBeLessThanOrEqual(windowHeight);
    }
    // Scrolled to, not on the first view: the stacked rail leaves too little below it.
    expect(ROOM_TOP_PX.stacked + heightAt('', 844)).toBeGreaterThan(844);
  });

  it('grows no taller than 40rem on a tall window and no shorter than 20rem on a short one', (): void => {
    for (const prefix of ['', 'md:'] as const) {
      expect(heightAt(prefix, 2000)).toBe(40 * REM);
      expect(heightAt(prefix, 400)).toBe(20 * REM);
    }
  });
});
