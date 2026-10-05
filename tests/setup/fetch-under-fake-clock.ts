import { setTimeout as nodeSetTimeout } from 'node:timers';

/**
 * No test lets a real `fetch` through while `setTimeout` is faked.
 *
 * Node's own `fetch` is undici, which arms its timers through the global `setTimeout`. From
 * undici 6.28 (Node 22.23, the release `.nvmrc` pins and CI runs) a pooled keep-alive socket is
 * reused only after a zero-delay timer fires, so under a faked clock that nothing advances the
 * request is never written and the test stalls until the server drops the socket or the test
 * times out (12-H's CI run 37225855013, 4 October 2026). On the Node before it the same test
 * passes, so the stall is invisible wherever the gate runs on an older release.
 *
 * This module holds the guard's pieces; `tests/setup/fetch-guard.ts`, a setup file of every
 * project, installs them: the global `fetch` refuses a request while `setTimeout` is not Node's
 * own, before any socket is opened, and the test that made it fails after it ends, even when the
 * code under test caught the refusal. A test that needs a double under a faked clock answers it
 * in-process at a reserved `.test` address (`spanModelFetch` in `tests/fixtures/redaction-double.ts`).
 *
 * Its limits: it sees requests through the global `fetch`, so a module importing the `undici`
 * package directly would pass by it (none in the tests' graph but the Convex CLI), and `node:http`
 * is out of its reach and of this cause (its timers are Node's internal ones). It refuses under
 * any fake of `setTimeout`, `shouldAdvanceTime` included, though such a clock could not stall the
 * request. Under `it.concurrent` a refusal is charged to whichever test ends next.
 */

/** The setup file that installs the guard, as the suite's configuration names it. */
export const FETCH_GUARD_SETUP_FILE = 'tests/setup/fetch-guard.ts';

/** The rejection of a request made under a faked clock, and the failure of the test that made it. */
export class FetchUnderFakeClockError extends Error {
  override readonly name = 'FetchUnderFakeClockError';
}

/** Whether the global `setTimeout` is not Node's own: faked by `vi.useFakeTimers` or stubbed. */
function setTimeoutIsFaked(): boolean {
  return globalThis.setTimeout !== nodeSetTimeout;
}

/**
 * The origin and path a `fetch` was called with, whichever of its three shapes it came in: never
 * its query or credentials, which may carry a secret into the test's output.
 */
function addressOf(input: RequestInfo | URL): string {
  const address = input instanceof Request ? input.url : String(input);
  if (!URL.canParse(address)) return 'an address fetch cannot parse';
  const url = new URL(address);
  return `${url.origin}${url.pathname}`;
}

/**
 * Wrap a `fetch` so that it refuses every request while `setTimeout` is faked.
 *
 * A refused request never reaches `realFetch`; its promise rejects with a
 * `FetchUnderFakeClockError` at once, and `report` is told its address so the test can be failed
 * even if the rejection is caught. With `setTimeout` real, every call goes to `realFetch`
 * unchanged.
 *
 * @param realFetch - The transport to guard: the environment's own `fetch`.
 * @param report - Told the address of each refused request.
 */
export function refuseFetchUnderFakeClock(
  realFetch: typeof fetch,
  report: (address: string) => void,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!setTimeoutIsFaked()) return await realFetch(input, init);
    const address = addressOf(input);
    report(address);
    throw new FetchUnderFakeClockError(
      `fetch to ${address} refused: setTimeout is faked, and undici would hold the request on a timer that never fires`,
    );
  };
}

/**
 * The failure for a test that made requests the guard refused, or nothing when it made none.
 *
 * @param addresses - Every refused request's address, in the order they were made.
 */
export function refusedFetchFailure(
  addresses: readonly string[],
): FetchUnderFakeClockError | undefined {
  if (addresses.length === 0) return undefined;
  const distinct = [...new Set(addresses)].join(', ');
  return new FetchUnderFakeClockError(
    `the test let ${addresses.length} ${addresses.length === 1 ? 'request' : 'requests'} through to fetch while setTimeout was faked (${distinct}); ` +
      'on undici 6.28 (Node 22.23) such a request stalls until the test times out. ' +
      'Answer the double in-process at a reserved .test address, as spanModelFetch in tests/fixtures/redaction-double.ts does.',
  );
}
