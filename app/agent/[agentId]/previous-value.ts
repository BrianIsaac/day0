import { useState } from 'react';

/**
 * The value the page showed before the current one, once it has changed on the page; `undefined`
 * until then. A count that rolls or a chip that swaps reads it, so the motion starts from what the
 * manager last saw. It is the render's own state, not an effect's, so the first render of the
 * new value already knows the old one.
 *
 * @param value - The value as the page shows it now.
 */
export function usePreviousValue<T>(value: T): T | undefined {
  const [values, setValues] = useState<{ readonly now: T; readonly previous?: T }>({ now: value });
  if (!Object.is(values.now, value)) setValues({ now: value, previous: values.now });
  return values.previous;
}
