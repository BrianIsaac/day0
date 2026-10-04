import { afterEach, expect, it, vi } from 'vitest';

/*
 * Run only by the nested run in `tests/setup/fetch-under-fake-clock.test.ts`: the first test must
 * fail although it catches the refusal itself, the way a product module that degrades on a failed
 * call would; the second must pass, and so must the third, whose request reaches the real
 * transport (a reserved `.test` name, so it is refused by the resolver with or without a network).
 */

afterEach((): void => {
  vi.useRealTimers();
});

it('swallows the refusal of a fetch it made under a faked setTimeout', async (): Promise<void> => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const outcome = await fetch('http://double.test:8000/v1/spans', { method: 'POST' }).then(
    (): string => 'answered',
    (): string => 'refused',
  );
  expect(outcome).toBe('refused');
});

it('fetches nothing under a faked setTimeout', (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  expect(vi.getTimerCount()).toBe(0);
});

it('reaches the transport with a real setTimeout, which refuses an address that cannot resolve', async (): Promise<void> => {
  const failure = await fetch('http://double.test:8000/healthz').then(
    (): unknown => undefined,
    (error: unknown): unknown => error,
  );
  expect(failure).toBeInstanceOf(TypeError);
});
