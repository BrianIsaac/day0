'use client';

import { usePreviousValue } from './previous-value';

/** How long a count's roll plays (`.roll` in `app/globals.css`). */
export const ROLL_MS = 220;

/**
 * A count that rolls when it changes on the page: the old figure rolls up and out as the new one
 * rolls in (v3 section 5.2). The first figure is simply there, and under reduced motion only the
 * new one shows. Built for the environment's tab badges and reused by every tab strip.
 *
 * @param value - The count as the page shows it now.
 */
export function RollingCount({ value }: { value: number }) {
  const previous = usePreviousValue(value, ROLL_MS);
  if (previous === undefined) return <>{value}</>;
  return (
    <span key={value} className="roll">
      <span aria-hidden="true" className="from">
        {previous}
      </span>
      <span className="to">{value}</span>
    </span>
  );
}
