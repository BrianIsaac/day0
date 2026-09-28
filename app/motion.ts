import { useCallback, useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { measurePin, pickReadingStep } from './reading-line';

const REDUCE = '(prefers-reduced-motion: reduce)';

/**
 * Whether a media query matches, re-read when it changes, so the script and the stylesheet read
 * the same answer. `server` is the answer before hydration, when there is no window to ask.
 */
export function useMediaQuery(query: string, server: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  const read = useCallback((): boolean => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, read, () => server);
}

/**
 * Whether reduced motion is asked for, from the query the stylesheet reads, so the script never
 * animates what the stylesheet has settled. `true` on the server: nothing animates before this.
 */
export function useReducedMotion(): boolean {
  return useMediaQuery(REDUCE, true);
}

/** `edge` is visible and never animates; `pending` waits hidden; `seen` arrives now. */
export type SeenState = 'edge' | 'pending' | 'seen';

/** A group's arrival state: `seen` once its leading edge is a tenth of the viewport in. */
export function useSeenOnce(ref: RefObject<Element | null>): SeenState {
  const reduce = useReducedMotion();
  const [state, setState] = useState<SeenState>('edge');
  useEffect(() => {
    const element = ref.current;
    if (reduce || !element || !('IntersectionObserver' in window)) return;
    // The first report of a group already in view leaves it `edge`: it is being read.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return setState('pending');
        observer.disconnect();
        setState((now) => (now === 'edge' ? 'edge' : 'seen'));
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, reduce]);
  return reduce ? 'edge' : state;
}

/** Counts from zero to `target` on a cubic ease-out once `run` turns true; `target` otherwise. */
export function useCountUp(target: number, run: boolean, durationMs = 900): number {
  const [value, setValue] = useState(target);
  useEffect(() => {
    if (!run) return;
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now: number): void {
      const progress = Math.min(1, (now - start) / durationMs);
      setValue(Math.round(target * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [run, target, durationMs]);
  return run ? value : target;
}

/**
 * The index of a pinned sequence's active step (`pickReadingStep`), read in one animation frame
 * per scroll burst or resize. `root` holds one `[data-pin-side]`, one `[data-pin-copy]` and the
 * `[data-step]` copies in order; the frame's height goes to `--pin-h` on `root` for the stylesheet.
 */
export function useInReadingBand(root: RefObject<HTMLElement | null>, hysteresis = 0.1): number {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const element = root.current;
    const side = element?.querySelector<HTMLElement>('[data-pin-side]');
    const copy = element?.querySelector<HTMLElement>('[data-pin-copy]');
    if (!element || !side || !copy) return;
    const steps = Array.from(element.querySelectorAll<HTMLElement>('[data-step]'));
    let frame = 0;
    const read = (): void => {
      frame = 0;
      const geometry = measurePin(element, side, copy, steps);
      setActive((current) => pickReadingStep(geometry, current, hysteresis));
    };
    const ask = (): void => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    const resize = new ResizeObserver(() => {
      element.style.setProperty('--pin-h', `${side.offsetHeight}px`);
      ask();
    });
    resize.observe(side);
    window.addEventListener('scroll', ask, { passive: true });
    window.addEventListener('resize', ask);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener('scroll', ask);
      window.removeEventListener('resize', ask);
    };
  }, [root, hysteresis]);
  return active;
}
