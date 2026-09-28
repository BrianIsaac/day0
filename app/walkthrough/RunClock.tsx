'use client';

import { useEffect, useRef, useState } from 'react';
import { elapsedLabel } from '@/demo/walkthrough';
import { useReducedMotion } from '../motion';

const TICK_MS = 600;

/**
 * Seconds that run from the last value shown to `target` on a cubic ease-out, so the clock
 * visibly advances (or rewinds) as the reader moves between steps; under reduced motion it
 * lands at once.
 */
function useTicking(target: number): number {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (reduce) {
      from.current = target;
      return;
    }
    const origin = from.current;
    let start: number | undefined;
    let frame = requestAnimationFrame(function tick(now: number): void {
      start ??= now;
      const progress = Math.min(1, (now - start) / TICK_MS);
      const value = Math.round(origin + (target - origin) * (1 - (1 - progress) ** 3));
      from.current = value;
      setShown(value);
      if (progress < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, reduce]);
  return reduce ? target : shown;
}

/** The run's clock in the frame bar: the time from deployment the README states for this step. */
function Ticking({ seconds }: { seconds: number }) {
  return (
    <span className="font-mono text-[13px] tabular-nums text-[var(--color-accent)]">
      {elapsedLabel(useTicking(seconds))}
    </span>
  );
}

/**
 * The frame bar's clock. A step the README gives no time for shows `untimed` instead of an
 * invented offset, and the clock starts from the first stated time. Hidden from assistive
 * technology, which reads each step's time in its copy.
 */
export function RunClock({ seconds, untimed }: { seconds: number | null; untimed: string }) {
  return (
    <span data-clock="" aria-hidden="true" className="shrink-0">
      {seconds === null ? (
        <span className="text-xs text-[var(--color-muted)]">{untimed}</span>
      ) : (
        <Ticking seconds={seconds} />
      )}
    </span>
  );
}
