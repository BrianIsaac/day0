import { afterAll, afterEach } from 'vitest';
import { refuseFetchUnderFakeClock, refusedFetchFailure } from './fetch-under-fake-clock';

/**
 * The guard against a real `fetch` under a faked clock, installed for every test file
 * (`tests/setup/fetch-under-fake-clock.ts` says why). It costs every test one `afterEach` that
 * reads an empty array, and every real `fetch` one identity comparison.
 */

const refused: string[] = [];
globalThis.fetch = refuseFetchUnderFakeClock(globalThis.fetch, (address: string): void => {
  refused.push(address);
});

/** Fail the test, or the file's hooks, that made a refused request. */
function failOnRefusedFetch(): void {
  const failure = refusedFetchFailure(refused.splice(0));
  if (failure) throw failure;
}

afterEach(failOnRefusedFetch);
afterAll(failOnRefusedFetch);
