import dns from 'node:dns';
import { afterEach, expect, it, vi } from 'vitest';

/*
 * Run only by the nested run in `tests/setup/fetch-under-fake-clock.test.ts`: the first test must
 * fail although it catches the refusal itself, the way a product module that degrades on a failed
 * call would; the second must pass, and so must the third, whose request reaches the real
 * transport and is refused there.
 *
 * The address is an IP literal, so no request waits on the machine's resolver. Until 11 October
 * 2026 it was the reserved name `double.test`, left to the resolver to refuse. The third test
 * timed out in a full-suite gate that day, and a cold lookup of the name, measured straight
 * after, took five seconds on that workstation: the whole of this run's test timeout.
 * 233.252.0.1 is of MCAST-TEST-NET, the multicast block kept for documentation (RFC 5771), and
 * TCP must refuse to open a connection to a multicast address (RFC 1122, 4.2.3.10): the
 * machine's own stack refuses it at once, with or without a network, and nothing leaves the
 * machine.
 */

/** Where every request of this file goes: an address the machine refuses without a lookup. */
const REFUSED_ORIGIN = 'http://233.252.0.1:8000';

afterEach((): void => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('swallows the refusal of a fetch it made under a faked setTimeout', async (): Promise<void> => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const outcome = await fetch(`${REFUSED_ORIGIN}/v1/spans`, { method: 'POST' }).then(
    (): string => 'answered',
    (): string => 'refused',
  );
  expect(outcome).toBe('refused');
});

it('fetches nothing under a faked setTimeout', (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  expect(vi.getTimerCount()).toBe(0);
});

it('reaches the transport with a real setTimeout, which refuses the address without asking the resolver', async (): Promise<void> => {
  // The resolver's double: it knows no name and says so at once, so a request that did need a
  // lookup fails this test by the name it asked for, on any machine, and never by a timeout.
  const resolver = vi.spyOn(dns, 'lookup').mockImplementation((...asked: unknown[]): void => {
    const answer = asked.at(-1);
    if (typeof answer !== 'function') return;
    process.nextTick(answer, new Error(`this run has no resolver: ${String(asked[0])} is unknown`));
  });
  const failure = await fetch(`${REFUSED_ORIGIN}/healthz`).then(
    (): unknown => undefined,
    (error: unknown): unknown => error,
  );
  expect(failure).toBeInstanceOf(TypeError);
  expect(resolver.mock.calls.map(([name]) => name)).toEqual([]);
});
