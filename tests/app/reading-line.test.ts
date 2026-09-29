import { describe, expect, it } from 'vitest';
import { pickReadingStep, type PinGeometry } from '../../app/reading-line';

/** A box at `top` of `height` spanning `left` to `right`, as `getBoundingClientRect` reports one. */
function box(top: number, height: number, left = 0, right = 100): DOMRectReadOnly {
  return {
    top,
    bottom: top + height,
    height,
    left,
    right,
    width: right - left,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

/**
 * The landing at 1440 by 900: the section has pinned, the 320 px frame rests centred beside the
 * copy (its centre, the reading line, at 450), and four 470 px step copies start at `firstTop`.
 */
function beside(firstTop: number): PinGeometry {
  return {
    viewport: 900,
    stickyTop: 290,
    root: box(-400, 2400, 100, 1340),
    side: box(290, 320, 490, 1340),
    copy: box(firstTop, 1880, 100, 440),
    steps: [0, 1, 2, 3].map((index) => box(firstTop + index * 470, 470, 100, 440)),
  };
}

/**
 * The landing at 390 by 844: the 540 px frame is pinned under the header above the copy, so the
 * reading line is the middle of the band beneath it, at (596 + 844) / 2 = 720.
 */
function above(firstTop: number): PinGeometry {
  return {
    viewport: 844,
    stickyTop: 56,
    root: box(-300, 3000, 0, 390),
    side: box(56, 540, 0, 390),
    copy: box(firstTop, 1600, 0, 390),
    steps: [0, 1, 2, 3].map((index) => box(firstTop + index * 400, 400, 0, 390)),
  };
}

describe('pickReadingStep', () => {
  it('holds the first step until the section has pinned', () => {
    expect(pickReadingStep({ ...beside(0), root: box(400, 2400) }, 2)).toBe(0);
  });

  it('holds the last step once the section has scrolled past the frame', () => {
    expect(pickReadingStep({ ...beside(-2000), root: box(-2000, 600) }, 1)).toBe(3);
  });

  it('shows the step whose copy is level with the frame beside it', () => {
    // Step 3's copy centred on the line at 450, step 2's a whole step above it.
    const geometry = beside(450 - 235 - 2 * 470);
    expect(pickReadingStep(geometry, 1)).toBe(2);
  });

  it('keeps the current step until another is nearer by a tenth of the viewport', () => {
    // The boundary between steps 1 and 2 sits on the line: both are 235 px away.
    const tie = beside(450 - 470);
    expect(pickReadingStep(tie, 0)).toBe(0);
    expect(pickReadingStep(tie, 1)).toBe(1);
    // 100 px past the boundary step 2 is nearer by 200 px, more than the 90 px margin.
    expect(pickReadingStep(beside(450 - 470 - 100), 0)).toBe(1);
    // 40 px past it the margin is not met, so the step shown does not flicker.
    expect(pickReadingStep(beside(450 - 470 - 40), 0)).toBe(0);
  });

  it('reads the band under the frame on a phone, where the frame sits above the copy', () => {
    // Step 3's copy just under the frame: its centre at 612 + 200 = 812, the line at 720.
    expect(pickReadingStep(above(612 - 800), 1)).toBe(2);
  });

  it('keeps the current step when there are no steps to read', () => {
    expect(pickReadingStep({ ...beside(0), steps: [] }, 2)).toBe(2);
  });
});
