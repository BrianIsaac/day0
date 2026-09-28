import { vi } from 'vitest';

/**
 * The browser seams the landing's motion reads, replaced for jsdom: the reduced-motion query,
 * `IntersectionObserver`, `ResizeObserver` and animation frames. Each test drives them by hand.
 */
export interface BrowserDoubles {
  /** Report the most recently observed element (or `target`) in view or out of it. */
  report(isIntersecting: boolean, target?: Element): void;
  /** Run every queued animation frame at `now`. */
  flushFrames(now: number): void;
  /** Fire every `ResizeObserver` callback, as a first layout would. */
  resize(): void;
  /** How many animation frames are waiting. */
  pendingFrames(): number;
}

/**
 * Install the doubles; `reduce` answers the reduced-motion query and `short` every other one
 * (the landing's short-screen query).
 */
export function installBrowserDoubles(reduce = false, short = false): BrowserDoubles {
  const observed: { callback: IntersectionObserverCallback; target: Element }[] = [];
  const resizers = new Set<() => void>();
  let frames: { id: number; run: FrameRequestCallback }[] = [];
  let nextFrame = 1;
  vi.stubGlobal(
    'matchMedia',
    (query: string): Partial<MediaQueryList> => ({
      matches: query.includes('prefers-reduced-motion') ? reduce : short,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    }),
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private readonly callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element): void {
        observed.push({ callback: this.callback, target });
      }
      unobserve(target: Element): void {
        observed.splice(
          observed.findIndex((entry) => entry.target === target),
          1,
        );
      }
      disconnect(): void {
        for (let index = observed.length - 1; index >= 0; index -= 1) {
          if (observed[index]?.callback === this.callback) observed.splice(index, 1);
        }
      }
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe(): void {
        resizers.add(this.callback);
      }
      disconnect(): void {
        resizers.delete(this.callback);
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
  return {
    report(isIntersecting, target) {
      const entry = target
        ? observed.find((candidate) => candidate.target === target)
        : observed.at(-1);
      if (!entry) throw new Error('nothing is observed');
      entry.callback(
        [{ isIntersecting, target: entry.target } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    },
    flushFrames(now) {
      const due = frames;
      frames = [];
      for (const frame of due) frame.run(now);
    },
    resize() {
      for (const callback of resizers) callback();
    },
    pendingFrames: () => frames.length,
  };
}
