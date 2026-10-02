import { vi } from 'vitest';

/*
 * Work that waits on a timer under fake timers (the wave 11 review's M11 a): a refused refresh
 * waits for a concurrent winner's write before it answers (the token store's rotation wait), and a
 * fake timer never fires by itself. The clock is moved on step by step until the work settles, so
 * the test neither sleeps nor hangs.
 */

/** How far the clock moves at each step: one rotation wait. */
const STEP_MS = 200;

/** The most steps before the work is called stuck. */
const STEP_LIMIT = 100;

/**
 * Await work that waits on timers, moving the fake clock on through each wait until it settles.
 *
 * @param work - The work under fake timers.
 * @returns What the work answers.
 * @throws What the work throws, or an Error when it has not settled after every step.
 */
export async function throughTimers<T>(work: Promise<T>): Promise<T> {
  // Observed at once, so a rejection while the clock moves is never an unhandled one.
  let outcome: { readonly value: T } | { readonly error: unknown } | undefined;
  const watched = work.then(
    (value: T): void => {
      outcome = { value };
    },
    (error: unknown): void => {
      outcome = { error };
    },
  );
  for (let step = 0; step < STEP_LIMIT && outcome === undefined; step += 1) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
  }
  await Promise.race([watched, Promise.resolve()]);
  if (outcome === undefined) throw new Error('The work did not settle under the fake clock.');
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}
