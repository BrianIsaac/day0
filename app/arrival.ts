import { useEffect, useState } from 'react';

/**
 * How long a product page's cards take to arrive: a second tier's 200 ms, eleven 50 ms steps and
 * the 260 ms rise (`[data-cards]` in `app/globals.css`).
 */
export const ARRIVAL_MS = 1_010;

type Arrival = 'waiting' | 'arriving' | 'arrived';

/**
 * Whether a product page's cards are still arriving: from the first render with `ready` until
 * the arrival has played, then never again. A card group carries `data-cards` only while this
 * holds, because React reorders a keyed list by moving its nodes and a moved node starts its
 * animation over: without the window, a work item changing state would replay its arrival.
 *
 * @param ready - Whether the group's content has rendered; the window opens the first time it has.
 */
export function useArrival(ready = true): boolean {
  const [arrival, setArrival] = useState<Arrival>(ready ? 'arriving' : 'waiting');
  // Content that renders late opens the window on that render, not one frame after it.
  if (ready && arrival === 'waiting') setArrival('arriving');
  useEffect(() => {
    if (arrival !== 'arriving') return;
    const timer = setTimeout(() => setArrival('arrived'), ARRIVAL_MS);
    return () => clearTimeout(timer);
  }, [arrival]);
  return arrival === 'arriving';
}
