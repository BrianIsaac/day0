/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStory } from '../../../app/walkthrough/RunStory';
import { RECORDED_RUN } from '../../../src/demo/walkthrough';
import { installBrowserDoubles, type BrowserDoubles } from '../marketing/browser-doubles';

const STEP_HEIGHT = 470;
const STICKY_TOP = 149;
const SIDE_HEIGHT = 603;

/** Lay the run out at 1440 by 900 with step `centred` (0-based) level with the frame's centre. */
function layOut(centred: number): void {
  const line = STICKY_TOP + SIDE_HEIGHT / 2;
  const firstTop = line - STEP_HEIGHT / 2 - centred * STEP_HEIGHT;
  const rect = (top: number, height: number, left: number, right: number): DOMRect =>
    ({ top, bottom: top + height, height, left, right, width: right - left }) as DOMRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    const data = (this as HTMLElement).dataset;
    if (data.step !== undefined) {
      return rect(firstTop + (Number(data.step) - 1) * STEP_HEIGHT, STEP_HEIGHT, 796, 1340);
    }
    if ('pinSide' in data) return rect(STICKY_TOP, SIDE_HEIGHT, 100, 740);
    if ('pinCopy' in data) return rect(firstTop, 16 * STEP_HEIGHT, 796, 1340);
    return rect(-4000, 12000, 100, 1340);
  });
}

let doubles: BrowserDoubles;
let container: HTMLDivElement;
let root: Root;

function mount(reduce = false): void {
  doubles = installBrowserDoubles(reduce);
  vi.stubGlobal('innerHeight', 900);
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    top: `${STICKY_TOP}px`,
  } as CSSStyleDeclaration);
  layOut(0);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act((): void => root.render(<RunStory run={RECORDED_RUN} />));
  act((): void => doubles.resize());
  act((): void => doubles.flushFrames(0));
}

/** Scroll so step `centred` (0-based) is level with the frame, and let the tracker read it. */
function scrollTo(centred: number, now = 16): void {
  layOut(centred);
  act((): void => {
    window.dispatchEvent(new Event('scroll'));
  });
  act((): void => doubles.flushFrames(now));
}

const pin = (): HTMLElement => container.querySelector<HTMLElement>('[data-pin]')!;
const shown = (): number[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-frame][data-on]'), (frame) =>
    Number(frame.dataset.frame),
  );
const ledger = (): string[] =>
  Array.from(container.querySelectorAll('ol[aria-label="The record so far"] > li'), (line) =>
    line.textContent!.trim(),
  );
const bar = (): string =>
  container.querySelector('[data-pin-side] > div > div')!.textContent!.trim();

beforeEach((): void => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach((): void => {
  act((): void => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('the recorded run', () => {
  it('shows only the capture of the step level with the frame, with its README alt text', () => {
    mount();
    scrollTo(7);
    expect(pin().dataset.active).toBe('8');
    expect(shown()).toEqual([8]);
    const on = container.querySelector('[data-frame][data-on] img');
    expect(on?.getAttribute('alt')).toBe(RECORDED_RUN.steps[7]!.capture.alt);
    expect(container.querySelectorAll('[data-frame][aria-hidden="true"]')).toHaveLength(15);
  });

  it('grows the ledger by each passed step, newest last, and shrinks it going back up', () => {
    mount();
    expect(ledger()).toEqual([RECORDED_RUN.steps[0]!.caption]);
    scrollTo(4);
    expect(ledger()).toEqual([
      RECORDED_RUN.steps[0]!.caption,
      RECORDED_RUN.steps[1]!.caption,
      RECORDED_RUN.steps[2]!.caption,
      `${RECORDED_RUN.steps[3]!.caption}+07:12`,
      `${RECORDED_RUN.steps[4]!.caption}+09:05`,
    ]);
    scrollTo(1);
    expect(ledger()).toHaveLength(2);
  });

  it('advances the progress line by the share of steps read', () => {
    mount();
    scrollTo(3);
    const line = container.querySelector<HTMLElement>('[data-progress] > div');
    expect(line?.style.transform).toBe(`scaleX(${4 / 16})`);
  });

  it('says where the clock starts instead of inventing a time before the first stated one', () => {
    mount();
    scrollTo(2);
    expect(bar()).toBe('Step 3 of 16timed from step 4');
  });

  it('runs the clock from the last time shown to the step’s own, then rests on it', () => {
    mount();
    scrollTo(3, 16);
    act((): void => doubles.flushFrames(16));
    expect(bar()).toBe('Step 4 of 16+07:12');
    scrollTo(5, 1000);
    act((): void => doubles.flushFrames(1000));
    expect(bar()).toBe('Step 6 of 16+07:12');
    act((): void => doubles.flushFrames(1300));
    const midway = bar().slice(-5);
    expect(midway > '07:12' && midway < '13:25').toBe(true);
    act((): void => doubles.flushFrames(1700));
    expect(bar()).toBe('Step 6 of 16+13:25');
  });

  it('lands the clock at once under reduced motion', () => {
    mount(true);
    scrollTo(3);
    scrollTo(15);
    expect(bar()).toBe('Step 16 of 16+48:45');
    expect(doubles.pendingFrames()).toBe(0);
  });
});
