/** @vitest-environment jsdom */

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useCountUp,
  useInReadingBand,
  useReducedMotion,
  useSeenOnce,
  type SeenState,
} from '../../app/motion';

/** The media query list every `matchMedia` call answers with, flipped by `setReduce`. */
const media = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    matches: false,
    listeners,
    setReduce(matches: boolean): void {
      this.matches = matches;
      for (const listener of listeners) listener();
    },
  };
});

/** Every `IntersectionObserver` the hooks create, with the element and callback it holds. */
const observers: { callback: IntersectionObserverCallback; target?: Element }[] = [];

/** Animation frames queued by the hooks, run by `flushFrames` at a chosen time. */
let frames: { id: number; run: FrameRequestCallback }[] = [];

function flushFrames(now: number): void {
  const due = frames;
  frames = [];
  for (const frame of due) frame.run(now);
}

let container: HTMLDivElement;
let root: Root;

beforeEach((): void => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  media.matches = false;
  media.listeners.clear();
  observers.length = 0;
  frames = [];
  let nextFrame = 1;
  vi.stubGlobal(
    'matchMedia',
    (): Partial<MediaQueryList> => ({
      get matches(): boolean {
        return media.matches;
      },
      addEventListener: (_: string, listener: () => void): void => {
        media.listeners.add(listener);
      },
      removeEventListener: (_: string, listener: () => void): void => {
        media.listeners.delete(listener);
      },
    }),
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private readonly record: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback };
        observers.push(this.record);
      }
      observe(target: Element): void {
        this.record.target = target;
      }
      disconnect(): void {
        this.record.target = undefined;
      }
    },
  );
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback): number => {
    const id = nextFrame++;
    frames.push({ id, run });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    frames = frames.filter((frame) => frame.id !== id);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach((): void => {
  act((): void => root.unmount());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** Report the observed element as in view or not, as the browser would. */
function report(isIntersecting: boolean): void {
  const observer = observers.at(-1);
  if (!observer?.target) throw new Error('nothing is observed');
  const entry = { isIntersecting, target: observer.target } as IntersectionObserverEntry;
  act((): void => observer.callback([entry], {} as IntersectionObserver));
}

describe('useReducedMotion', (): void => {
  function Probe() {
    return <p>{String(useReducedMotion())}</p>;
  }

  it('answers the reduced-motion query and follows it when it changes', (): void => {
    act((): void => root.render(<Probe />));
    expect(container.textContent).toBe('false');
    act((): void => media.setReduce(true));
    expect(container.textContent).toBe('true');
  });
});

describe('useSeenOnce', (): void => {
  function Probe() {
    const group = useRef<HTMLDivElement>(null);
    const seen: SeenState = useSeenOnce(group);
    return <div ref={group}>{seen}</div>;
  }

  it('hides a group below the fold, then lets it arrive once it is seen', (): void => {
    act((): void => root.render(<Probe />));
    expect(container.textContent).toBe('edge');
    report(false);
    expect(container.textContent).toBe('pending');
    report(true);
    expect(container.textContent).toBe('seen');
    expect(observers.at(-1)?.target).toBeUndefined();
  });

  it('leaves a group already on screen at load settled, so nothing being read moves', (): void => {
    act((): void => root.render(<Probe />));
    report(true);
    expect(container.textContent).toBe('edge');
  });

  it('never hides or animates a group under reduced motion', (): void => {
    media.matches = true;
    act((): void => root.render(<Probe />));
    expect(container.textContent).toBe('edge');
    expect(observers).toHaveLength(0);
  });
});

describe('useCountUp', (): void => {
  function Probe({ run }: { run: boolean }) {
    return <p>{useCountUp(41, run)}</p>;
  }

  it('shows the final figure until it is told to run', (): void => {
    act((): void => root.render(<Probe run={false} />));
    expect(container.textContent).toBe('41');
    expect(frames).toHaveLength(0);
  });

  it('counts from zero to the figure on an ease-out over 900 ms, then stops', (): void => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    act((): void => root.render(<Probe run />));
    act((): void => flushFrames(1000));
    expect(container.textContent).toBe('0');
    act((): void => flushFrames(1450));
    // Half the time, seven eighths of the way: 1 - (1 - 0.5)^3.
    expect(container.textContent).toBe(String(Math.round(41 * 0.875)));
    act((): void => flushFrames(1900));
    expect(container.textContent).toBe('41');
    expect(frames).toHaveLength(0);
  });
});

describe('useInReadingBand', (): void => {
  /** Rects the stub reports for each element, by its data attribute. */
  const rects = new Map<string, DOMRectReadOnly>();
  let resized: (() => void) | undefined;

  function rect(top: number, height: number, left: number, right: number): DOMRectReadOnly {
    return { top, bottom: top + height, height, left, right, width: right - left } as DOMRect;
  }

  /** Lay the sequence out at 1440 by 900 with step `centred` level with the frame's centre. */
  function layOut(centred: number): void {
    const firstTop = 450 - 235 - centred * 470;
    rects.set('root', rect(-400, 2400, 100, 1340));
    rects.set('side', rect(290, 320, 490, 1340));
    rects.set('copy', rect(firstTop, 1880, 100, 440));
    for (const index of [0, 1, 2, 3]) {
      rects.set(`step-${index + 1}`, rect(firstTop + index * 470, 470, 100, 440));
    }
  }

  beforeEach((): void => {
    vi.stubGlobal('innerHeight', 900);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe(): void {}
        disconnect(): void {
          resized = undefined;
        }
      },
    );
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ top: '290px' } as CSSStyleDeclaration);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ): DOMRect {
      const element = this as HTMLElement;
      const key =
        element.dataset.step !== undefined
          ? `step-${element.dataset.step}`
          : 'pinSide' in element.dataset
            ? 'side'
            : 'pinCopy' in element.dataset
              ? 'copy'
              : 'root';
      return rects.get(key) as DOMRect;
    });
  });

  function Sequence() {
    const pin = useRef<HTMLDivElement>(null);
    const active = useInReadingBand(pin);
    return (
      <div ref={pin} data-active={active}>
        <div data-pin-side="" />
        <ol data-pin-copy="">
          {[1, 2, 3, 4].map((step) => (
            <li key={step} data-step={step} />
          ))}
        </ol>
      </div>
    );
  }

  const shown = (): string | undefined =>
    container.querySelector<HTMLElement>('[data-active]')?.dataset.active;

  it('makes the step level with the frame active, in one frame per scroll burst', (): void => {
    layOut(0);
    act((): void => root.render(<Sequence />));
    act((): void => resized?.());
    act((): void => flushFrames(0));
    expect(shown()).toBe('0');

    layOut(2);
    act((): void => {
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('scroll'));
    });
    expect(frames).toHaveLength(1);
    act((): void => flushFrames(16));
    expect(shown()).toBe('2');
  });

  it('writes the frame height the stylesheet centres the frame by', (): void => {
    layOut(0);
    act((): void => root.render(<Sequence />));
    const side = container.querySelector<HTMLElement>('[data-pin-side]');
    Object.defineProperty(side, 'offsetHeight', { value: 320 });
    act((): void => resized?.());
    expect(
      container.querySelector<HTMLElement>('[data-active]')?.style.getPropertyValue('--pin-h'),
    ).toBe('320px');
  });

  it('stops reading the page once the sequence unmounts', (): void => {
    layOut(0);
    act((): void => root.render(<Sequence />));
    act((): void => root.render(<p />));
    act((): void => window.dispatchEvent(new Event('scroll')));
    expect(frames).toHaveLength(0);
    expect(resized).toBeUndefined();
  });
});
