/** The boxes one reading of a pinned sequence needs, all from `getBoundingClientRect`. */
export interface PinGeometry {
  readonly viewport: number;
  readonly stickyTop: number;
  readonly root: DOMRectReadOnly;
  readonly side: DOMRectReadOnly;
  readonly copy: DOMRectReadOnly;
  readonly steps: readonly DOMRectReadOnly[];
}

/**
 * The step whose copy centre is nearest the reading line: the pinned frame's centre when the
 * frame sits beside the copy, the band under it when it sits above. Another step must be
 * nearer by `hysteresis` of the viewport to take over; before the frame pins the first step
 * holds, once the section has scrolled past it the last.
 */
export function pickReadingStep(geometry: PinGeometry, current: number, hysteresis = 0.1): number {
  const { viewport, stickyTop, root, side, copy, steps } = geometry;
  if (steps.length === 0) return current;
  if (root.top >= stickyTop) return 0;
  if (root.bottom <= side.bottom) return steps.length - 1;
  const beside = side.right <= copy.left + 1 || copy.right <= side.left + 1;
  const line = beside ? (side.top + side.bottom) / 2 : (side.bottom + viewport) / 2;
  const distance = (box: DOMRectReadOnly): number => Math.abs(box.top + box.height / 2 - line);
  const distances = steps.map(distance);
  const nearest = distances.indexOf(Math.min(...distances));
  const held = distances[current] ?? Infinity;
  return nearest !== current && distances[nearest]! > held - viewport * hysteresis
    ? current
    : nearest;
}

/** Reads a pinned sequence's boxes: the section, the pinned frame, the copy column and each step. */
export function measurePin(
  root: Element,
  side: Element,
  copy: Element,
  steps: readonly Element[],
): PinGeometry {
  return {
    viewport: window.innerHeight,
    stickyTop: Number.parseFloat(getComputedStyle(side).top) || 0,
    root: root.getBoundingClientRect(),
    side: side.getBoundingClientRect(),
    copy: copy.getBoundingClientRect(),
    steps: steps.map((step) => step.getBoundingClientRect()),
  };
}
