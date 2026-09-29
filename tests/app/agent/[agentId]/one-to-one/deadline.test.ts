import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  START_DEADLINE_MS,
  withDeadline,
} from '../../../../../app/agent/[agentId]/one-to-one/deadline';

afterEach((): void => {
  vi.useRealTimers();
});

describe('a deadline on the work a room waits for', (): void => {
  it('settles with the work when it lands first, and leaves no timer behind', async (): Promise<void> => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.resolve('session-1'), 1_000, 'late')).resolves.toBe(
      'session-1',
    );
    expect(vi.getTimerCount()).toBe(0);
    await expect(withDeadline(Promise.reject(new Error('refused')), 1_000, 'late')).rejects.toThrow(
      'refused',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the sentence given once the deadline passes first', async (): Promise<void> => {
    vi.useFakeTimers();
    const waiting = withDeadline(new Promise<string>(() => undefined), START_DEADLINE_MS, 'late');
    const failed = expect(waiting).rejects.toThrow('late');
    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS);
    await failed;
    expect(START_DEADLINE_MS).toBe(15_000);
  });
});
