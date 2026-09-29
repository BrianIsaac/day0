import { useEffect, useState } from 'react';

/** A value a moment can start from: compared by identity, so never an object built per render. */
type Shown = string | number | boolean;

interface Change<T extends Shown> {
  readonly now: T;
  readonly previous?: T;
  /** Counts the changes, so a timer set for one change never clears the next. */
  readonly count: number;
}

/**
 * The value the page showed before the current one, for `forMs` after it changed on the page;
 * `undefined` before the first change and once that time has passed. A count that rolls or a
 * chip that swaps reads it, so the motion starts from what the manager last saw and its markup
 * is gone once it has played: a card React moves later never replays it, and the old value
 * holds no width. It is the render's own state, not an effect's, so the first render of the new
 * value already knows the old one.
 *
 * @param value - The value as the page shows it now.
 * @param forMs - How long the moment that starts from the old value plays.
 */
export function usePreviousValue<T extends Shown>(value: T, forMs: number): T | undefined {
  const [change, setChange] = useState<Change<T>>({ now: value, count: 0 });
  if (!Object.is(change.now, value)) {
    setChange({ now: value, previous: change.now, count: change.count + 1 });
  }
  const playing = change.previous !== undefined;
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(
      () =>
        setChange((current) =>
          current.count === change.count ? { now: current.now, count: current.count } : current,
        ),
      forMs,
    );
    return () => clearTimeout(timer);
  }, [playing, change.count, forMs]);
  return change.previous;
}
