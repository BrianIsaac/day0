import { describe, expect, it } from 'vitest';
import { inboxOfPages, NEEDS_YOU_LIMIT } from '../../../src/metrics/needs-you-pages';

/** An entry, waiting since a moment. */
const entry = (key: string, waitingSince: number) => ({ key, waitingSince });

describe('the inbox’s pages put together (wave 18, 18-F)', (): void => {
  it('keeps the fifty longest waits of every page, sums the totals and counts each employee once', (): void => {
    const first = {
      // A handover on the first page: counted in its total and on no employee.
      entries: [
        entry('transfer:1', 5),
        ...Array.from({ length: 30 }, (_, i) => entry(`a${i}`, 100 + i)),
      ],
      total: 31,
      waitingByEmployee: [{ agentId: 'a', waiting: 30 }],
    };
    const second = {
      entries: Array.from({ length: 30 }, (_, i) => entry(`b${i}`, 50 + i)),
      total: 30,
      waitingByEmployee: [{ agentId: 'b', waiting: 30 }],
    };
    // The employee a page met again, as a deploy between two reads moves it along.
    const third = {
      entries: [entry('b0', 50)],
      total: 30,
      waitingByEmployee: [{ agentId: 'b', waiting: 30 }],
    };

    const inbox = inboxOfPages([first, second, third]);

    expect(inbox.total).toBe(61);
    expect(inbox.waitingByEmployee).toEqual([
      { agentId: 'a', waiting: 30 },
      { agentId: 'b', waiting: 30 },
    ]);
    expect(inbox.entries).toHaveLength(NEEDS_YOU_LIMIT);
    expect(inbox.entries.slice(0, 2).map((one) => one.key)).toEqual(['transfer:1', 'b0']);
    expect(inbox.entries.at(-1)?.key).toBe('a18');
  });
});

describe('the handovers in the pages put together (the second pass)', (): void => {
  it('keeps every handover, however recent, and fills the rest with the longest waits', (): void => {
    const first = {
      entries: [
        { key: 'transfer:new', waitingSince: 10_000, kind: 'transfer' },
        ...Array.from({ length: 30 }, (_, i) => entry(`a${i}`, 100 + i)),
      ],
      total: 31,
      waitingByEmployee: [{ agentId: 'a', waiting: 30 }],
    };
    const second = {
      entries: Array.from({ length: 30 }, (_, i) => entry(`b${i}`, 50 + i)),
      total: 30,
      waitingByEmployee: [{ agentId: 'b', waiting: 30 }],
    };

    const inbox = inboxOfPages([first, second]);

    expect(inbox.entries).toHaveLength(NEEDS_YOU_LIMIT);
    expect(inbox.entries.map((one) => one.key)).toContain('transfer:new');
    expect(inbox.entries.at(-1)?.key).toBe('transfer:new');
    expect(inbox.entries.at(-2)?.key).toBe('a18');
  });
});
