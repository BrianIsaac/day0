import { describe, expect, it } from 'vitest';
import {
  clockTime,
  clockTimeWithSeconds,
  relativeTime,
} from '../../../../app/agent/[agentId]/time';

const AT = Date.UTC(2026, 8, 27, 16, 5, 9);

describe('the page clock', (): void => {
  it('stamps an instant with its date and time in the agent’s zone', (): void => {
    expect(clockTime(AT, 'Asia/Singapore')).toBe('28 Sep 2026, 00:05');
    expect(clockTimeWithSeconds(AT, 'Asia/Singapore')).toBe('28 Sep 2026, 00:05:09');
  });

  it('falls back to the viewer’s zone, with the date, when the agent has none', (): void => {
    expect(clockTime(AT)).toBe('27 Sep 2026, 16:05');
    expect(clockTime(AT, undefined)).toBe('27 Sep 2026, 16:05');
  });

  it('says how long ago in the shortest honest form', (): void => {
    expect(relativeTime(AT, AT + 5_000)).toBe('just now');
    expect(relativeTime(AT, AT + 42_000)).toBe('42s ago');
    expect(relativeTime(AT, AT + 5 * 60_000)).toBe('5m ago');
    expect(relativeTime(AT, AT + 3 * 3_600_000)).toBe('3h ago');
    expect(relativeTime(AT, AT + 2 * 86_400_000)).toBe('2d ago');
    expect(relativeTime(AT + 1_000, AT)).toBe('just now');
  });
});
