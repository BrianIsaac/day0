/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PinnedSequence, type PinnedStep } from '../../../app/marketing/PinnedSequence';
import { installBrowserDoubles, type BrowserDoubles } from './browser-doubles';

const STEPS: PinnedStep[] = [1, 2, 3, 4].map((n) => ({
  title: `Step ${n}`,
  body: `Body ${n}`,
  frame: <p>Frame {n}</p>,
}));

/** Lay the section out at 1440 by 900 with step `centred` (0-based) level with the frame. */
function layOut(centred: number): void {
  const firstTop = 450 - 235 - centred * 470;
  const rect = (top: number, height: number, left: number, right: number): DOMRect =>
    ({ top, bottom: top + height, height, left, right, width: right - left }) as DOMRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    const data = (this as HTMLElement).dataset;
    if (data.step !== undefined) {
      return rect(firstTop + (Number(data.step) - 1) * 470, 470, 100, 440);
    }
    if ('pinSide' in data) return rect(290, 320, 490, 1340);
    if ('pinCopy' in data) return rect(firstTop, 1880, 100, 440);
    return rect(-400, 2400, 100, 1340);
  });
}

let doubles: BrowserDoubles;
let container: HTMLDivElement;
let root: Root;

function mount(reduce = false, short = false): void {
  doubles = installBrowserDoubles(reduce, short);
  vi.stubGlobal('innerHeight', 900);
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ top: '290px' } as CSSStyleDeclaration);
  layOut(0);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act((): void => root.render(<PinnedSequence steps={STEPS} />));
  act((): void => doubles.resize());
  act((): void => doubles.flushFrames(0));
}

/** Scroll so step `centred` (0-based) is level with the frame, and let the tracker read it. */
function scrollTo(centred: number): void {
  layOut(centred);
  act((): void => {
    window.dispatchEvent(new Event('scroll'));
  });
  act((): void => doubles.flushFrames(16));
}

const frames = (): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-frame]'));

beforeEach((): void => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach((): void => {
  act((): void => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('the pinned sequence', () => {
  it('shows only the frame of the step level with it, and hides the rest from assistive technology', () => {
    mount();
    scrollTo(2);
    expect(container.querySelector('[data-pin]')?.getAttribute('data-active')).toBe('3');
    expect(frames().map((frame) => frame.hasAttribute('data-on'))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(frames().map((frame) => frame.getAttribute('aria-hidden'))).toEqual([
      'true',
      'true',
      'false',
      'true',
    ]);
  });

  it('plays a frame’s sequence the first time its step is reached, once the section is seen', () => {
    mount();
    const pin = container.querySelector('[data-pin]') as Element;
    act((): void => doubles.report(false, pin));
    expect(frames().map((frame) => frame.dataset.seen)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    act((): void => doubles.report(true, pin));
    expect(frames().map((frame) => frame.dataset.seen)).toEqual([
      'seen',
      'pending',
      'pending',
      'pending',
    ]);
    scrollTo(2);
    scrollTo(0);
    expect(frames().map((frame) => frame.dataset.seen)).toEqual([
      'seen',
      'pending',
      'seen',
      'pending',
    ]);
  });

  it('leaves every frame settled under reduced motion while the frame still follows the step', () => {
    mount(true);
    scrollTo(3);
    expect(frames().map((frame) => frame.dataset.seen)).toEqual(['edge', 'edge', 'edge', 'edge']);
    expect(frames()[3]?.hasAttribute('data-on')).toBe(true);
  });
});

describe('the sequence on a short screen (M8)', () => {
  it('lays each frame inline above its own copy, with nothing pinned', () => {
    mount(false, true);
    expect(container.querySelector('[data-pin-side]')).toBeNull();
    expect(container.querySelector('[data-pin]')?.getAttribute('data-pin')).toBe('inline');
    const steps = Array.from(container.querySelectorAll<HTMLElement>('li[data-step]'));
    expect(steps.map((step) => step.firstElementChild?.getAttribute('data-frame'))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(steps.map((step) => step.querySelector('h3')?.textContent)).toEqual([
      'Step 1',
      'Step 2',
      'Step 3',
      'Step 4',
    ]);
    expect(frames().every((frame) => !frame.hasAttribute('aria-hidden'))).toBe(true);
  });

  it('plays an inline frame’s sequence the first time its step scrolls into view', () => {
    mount(false, true);
    const third = container.querySelector('li[data-step="3"]') as Element;
    act((): void => doubles.report(false, third));
    expect(frames()[2]?.dataset.seen).toBe('pending');
    act((): void => doubles.report(true, third));
    expect(frames()[2]?.dataset.seen).toBe('seen');
  });
});
