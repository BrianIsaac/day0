/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerMetrics } from '../../../src/metrics/types';

/** What the bounded read answers, and the read by pages: its calls and how each ends. */
const backend = vi.hoisted(() => ({
  bounded: undefined as unknown,
  asked: [] as string[],
  byPages: [] as Array<{ resolve: (figures: unknown) => void; reject: (error: Error) => void }>,
  readByPages: async (): Promise<unknown> => await Promise.resolve(undefined),
}));

backend.readByPages = async (): Promise<unknown> => {
  backend.asked.push('metrics:forOwnerByPages');
  return await new Promise((resolve, reject) => {
    backend.byPages.push({ resolve, reject });
  });
};

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown): unknown => {
    backend.asked.push(getFunctionName(reference as never));
    return backend.bounded;
  },
  // One function for the reference, as the real hook hands back, so an effect that depends on
  // it does not run again at every render.
  useAction: (): (() => Promise<unknown>) => backend.readByPages,
}));

import {
  useCompanyFigures,
  WHOLE_COMPANY_COOL_DOWN_MS,
  WHOLE_COMPANY_REREAD_MS,
  WHOLE_COMPANY_RETRIES,
  WHOLE_COMPANY_RETRY_MS,
} from '../../../app/home/use-company-figures';
import { coverageLine } from '../../../app/home/company-coverage';
import { mount, type Mounted } from '../../fixtures/dom/press';

/** Figures of so many employees, with so many more left out. */
const figuresOf = (employees: number, omittedEmployees = 0): OwnerMetrics =>
  ({
    employees: [],
    company: { employees },
    excludedAgents: 0,
    omittedEmployees,
  }) as unknown as OwnerMetrics;

/** The hook as a page reads it: the count its figures are of, and the coverage's kind. */
function Probe({ changes }: { changes: unknown }) {
  const { figures, coverage } = useCompanyFigures(changes);
  return (
    <p>
      {figures === undefined ? 'none' : figures.company.employees} {JSON.stringify(coverage)}
    </p>
  );
}

function drawn(view: Mounted, changes: unknown = 'roster-1'): string {
  act((): void => view.root.render(<Probe changes={changes} />));
  return view.container.textContent ?? '';
}

/** Let the timers that are due and the promises behind them run. */
async function elapse(ms: number): Promise<void> {
  await act(async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach((): void => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation((): void => undefined);
});

afterEach((): void => {
  backend.bounded = undefined;
  backend.asked = [];
  backend.byPages = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the company’s figures on the home (wave 17, 17-F; RM33 (a), F-2)', (): void => {
  it('draws the subscribed read and asks for nothing more where it covers the company', async (): Promise<void> => {
    backend.bounded = figuresOf(3);
    const view = mount(<Probe changes="roster-1" />);
    await elapse(10_000);
    expect(drawn(view)).toBe('3 {"kind":"all"}');
    expect(backend.asked).not.toContain('metrics:forOwnerByPages');
    view.unmount();
  });

  it('reads every employee by pages past twenty: the twenty are drawn and said to be so, then the fifty-one', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-1" />);
    await elapse(0);
    expect(drawn(view)).toBe('20 {"kind":"reading","read":20,"of":51}');
    expect(backend.byPages).toHaveLength(1);

    backend.byPages[0]!.resolve(figuresOf(51));
    await elapse(0);
    expect(drawn(view)).toBe('51 {"kind":"every","employees":51}');
    view.unmount();
  });

  it('reads again a moment after a change, a cool-down after the read before it, keeping the figures it had meanwhile', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-1" />);
    await elapse(0);
    backend.byPages[0]!.resolve(figuresOf(51));
    await elapse(0);

    // Three changes in a second: one read, a cool-down after the read before it ended (W17-R28;
    // two seconds after the first change before wave 18).
    drawn(view, 'roster-2');
    await elapse(500);
    drawn(view, 'roster-3');
    await elapse(500);
    expect(drawn(view, 'roster-4')).toBe('51 {"kind":"every","employees":51}');
    await elapse(WHOLE_COMPANY_COOL_DOWN_MS - 1_000 - 1);
    expect(backend.byPages).toHaveLength(1);
    await elapse(1);
    expect(backend.byPages).toHaveLength(2);

    backend.byPages[1]!.resolve(figuresOf(52));
    await elapse(0);
    expect(drawn(view, 'roster-4')).toBe('52 {"kind":"every","employees":52}');
    view.unmount();
  });

  it('keeps the answer of a read that a change overtook, and reads once more after it (the second pass)', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-1" />);
    await elapse(0);
    expect(backend.byPages).toHaveLength(1);

    // A row changes while the first read is still on its way: its answer is still the newest
    // there is, and is drawn; one more read follows it.
    drawn(view, 'roster-2');
    backend.byPages[0]!.resolve(figuresOf(51));
    await elapse(0);
    expect(drawn(view, 'roster-2')).toBe('51 {"kind":"every","employees":51}');
    // A cool-down after it (W17-R28; at once before wave 18).
    await elapse(WHOLE_COMPANY_COOL_DOWN_MS);
    expect(backend.byPages).toHaveLength(2);
    view.unmount();
  });

  it('is not starved by changes that keep arriving: it reads again a cool-down after each read', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-0" />);
    await elapse(0);
    backend.byPages[0]!.resolve(figuresOf(51));
    await elapse(0);

    // A working company: a row changes every half second for thirty seconds.
    for (let tick = 1; tick <= 60; tick += 1) {
      drawn(view, `roster-${tick}`);
      await elapse(500);
      // Each read answers at once, so only the waiting between reads is counted.
      backend.byPages.at(-1)?.resolve(figuresOf(51 + backend.byPages.length));
      await elapse(0);
    }
    // One read at the start and one a cool-down after each (W17-R28; every two seconds before
    // wave 18): never none, never one a change.
    expect(backend.byPages.length).toBeGreaterThanOrEqual(3);
    expect(backend.byPages.length).toBeLessThanOrEqual(4);
    view.unmount();
  });

  it('never has two reads on their way at once', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-0" />);
    await elapse(0);
    // The first read takes ten seconds while rows keep changing.
    for (let tick = 1; tick <= 20; tick += 1) {
      drawn(view, `roster-${tick}`);
      await elapse(500);
    }
    expect(backend.byPages).toHaveLength(1);
    backend.byPages[0]!.resolve(figuresOf(51));
    await elapse(0);
    expect(backend.byPages).toHaveLength(1);
    // The changes it missed are read a cool-down after it is back (W17-R28; at once before).
    await elapse(WHOLE_COMPANY_COOL_DOWN_MS);
    expect(backend.byPages).toHaveLength(2);
    view.unmount();
  });

  it('says its figures are the most recent employees’ when the read by pages fails', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-1" />);
    await elapse(0);
    backend.byPages[0]!.reject(new Error('the backend is restarting'));
    await elapse(0);
    expect(drawn(view)).toBe('20 {"kind":"recent","read":20,"of":51}');
    view.unmount();
  });

  /** A read in flight, a wait that fired during it, and a second change waiting when it returns. */
  async function aSecondReadWithAChangeWaited(): Promise<Mounted> {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-1" />);
    await elapse(0);
    drawn(view, 'roster-2');
    await elapse(WHOLE_COMPANY_REREAD_MS);
    drawn(view, 'roster-3');
    // The first read returns: the second starts a cool-down later (W17-R28; at once before wave
    // 18), after both changes.
    backend.byPages[0]!.resolve(figuresOf(51));
    await elapse(WHOLE_COMPANY_COOL_DOWN_MS);
    expect(backend.byPages).toHaveLength(2);
    backend.byPages[1]!.resolve(figuresOf(52));
    await elapse(0);
    return view;
  }

  it('reads once for the changes a read already followed: the wait set for them is dropped when that read starts (the second pass of the fixes)', async (): Promise<void> => {
    const view = await aSecondReadWithAChangeWaited();
    await elapse(WHOLE_COMPANY_REREAD_MS * 3);
    expect(backend.byPages).toHaveLength(2);
    expect(drawn(view, 'roster-3')).toBe('52 {"kind":"every","employees":52}');
    view.unmount();
  });

  it('asks for nothing once the page is gone, whatever wait was pending', async (): Promise<void> => {
    const view = await aSecondReadWithAChangeWaited();
    view.unmount();
    await elapse(WHOLE_COMPANY_REREAD_MS * 3);
    expect(backend.byPages).toHaveLength(2);
  });

  it('tries a failed read again by itself, waiting twice as long each time, so a quiet company is not left on the twenty', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-1" />);
    await elapse(0);
    backend.byPages[0]!.reject(new Error('the backend is restarting'));
    await elapse(WHOLE_COMPANY_RETRY_MS - 1);
    expect(backend.byPages).toHaveLength(1);
    await elapse(1);
    expect(backend.byPages).toHaveLength(2);

    backend.byPages[1]!.reject(new Error('the backend is restarting'));
    await elapse(WHOLE_COMPANY_RETRY_MS * 2 - 1);
    expect(backend.byPages).toHaveLength(2);
    await elapse(1);
    expect(backend.byPages).toHaveLength(3);

    backend.byPages[2]!.resolve(figuresOf(51));
    await elapse(WHOLE_COMPANY_RETRY_MS * 8);
    expect(drawn(view)).toBe('51 {"kind":"every","employees":51}');
    // Read, and nothing changed since: no further read.
    expect(backend.byPages).toHaveLength(3);
    view.unmount();
  });

  it('reads a change at its own wait while a failed read is waiting to be tried again', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-1" />);
    await elapse(0);
    backend.byPages[0]!.reject(new Error('the backend is restarting'));
    await elapse(0);
    drawn(view, 'roster-2');
    // A cool-down after the failed read ended (W17-R28; the change's own wait before wave 18).
    await elapse(WHOLE_COMPANY_COOL_DOWN_MS);
    expect(backend.byPages).toHaveLength(2);
    // The one read stands for both: the retry that was waiting is not made beside it.
    backend.byPages[1]!.resolve(figuresOf(51));
    await elapse(WHOLE_COMPANY_RETRY_MS * 2);
    expect(backend.byPages).toHaveLength(2);
    view.unmount();
  });

  it('takes a call that throws before it answers as a failed read, and still reads afterwards', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const working = backend.readByPages;
    let thrown = 0;
    backend.readByPages = (): Promise<unknown> => {
      if (thrown === 0) {
        thrown += 1;
        throw new Error('the client is closed');
      }
      return working();
    };
    try {
      const view = mount(<Probe changes="roster-1" />);
      await elapse(0);
      expect(drawn(view)).toBe('20 {"kind":"recent","read":20,"of":51}');
      await elapse(WHOLE_COMPANY_RETRY_MS);
      expect(backend.byPages).toHaveLength(1);
      backend.byPages[0]!.resolve(figuresOf(51));
      await elapse(0);
      expect(drawn(view)).toBe('51 {"kind":"every","employees":51}');
      view.unmount();
    } finally {
      backend.readByPages = working;
    }
  });

  it('answers nothing while the subscribed read is on its way', (): void => {
    const view = mount(<Probe changes="roster-1" />);
    expect(drawn(view)).toBe('none {"kind":"all"}');
    view.unmount();
  });
});

/*
 * The walks' edges (W17-R28's figures half, wave 18, 18-F): a walk after every change under
 * constant change, a failed read retried for ever (and after the company shrank to twenty), and
 * the last whole figures drawn again when the company grows back past twenty.
 */
describe('the company’s figures under change and failure (W17-R28, wave 18)', (): void => {
  it('causes one walk for two changes within the cool-down', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-0" />);
    await elapse(0);
    backend.byPages[0]!.resolve(figuresOf(51));
    await elapse(0);

    // Two changes inside the cool-down after the first walk, each walk answering at once.
    drawn(view, 'roster-1');
    await elapse(WHOLE_COMPANY_COOL_DOWN_MS / 4);
    backend.byPages.at(-1)?.resolve(figuresOf(52));
    await elapse(0);
    drawn(view, 'roster-2');
    await elapse(WHOLE_COMPANY_COOL_DOWN_MS / 2);
    backend.byPages.at(-1)?.resolve(figuresOf(53));
    await elapse(WHOLE_COMPANY_COOL_DOWN_MS * 2);

    expect(backend.byPages).toHaveLength(2);
    view.unmount();
  });

  it('stops a failed read after its retries and says so', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-1" />);
    await elapse(0);
    for (let tries = 1; tries <= WHOLE_COMPANY_RETRIES + 1; tries += 1) {
      expect(backend.byPages).toHaveLength(tries);
      backend.byPages.at(-1)!.reject(new Error('the backend is restarting'));
      await elapse(WHOLE_COMPANY_RETRY_MS * 2 ** tries);
    }
    await elapse(WHOLE_COMPANY_RETRY_MS * 64);

    expect(backend.byPages).toHaveLength(WHOLE_COMPANY_RETRIES + 1);
    expect(drawn(view)).toBe(
      `20 {"kind":"stopped","read":20,"of":51,"tries":${WHOLE_COMPANY_RETRIES + 1}}`,
    );
    expect(
      coverageLine({ kind: 'stopped', read: 20, of: 51, tries: WHOLE_COMPANY_RETRIES + 1 }),
    ).toBe('20 of 51 read: the rest could not be read');
    view.unmount();
  });

  it('tries a failed read no more once the company is back within twenty', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-1" />);
    await elapse(0);
    // The company shrinks to twenty while the read is on its way, and then the read fails.
    backend.bounded = figuresOf(20, 0);
    drawn(view);
    backend.byPages[0]!.reject(new Error('the backend is restarting'));
    await elapse(WHOLE_COMPANY_RETRY_MS * 64);

    expect(backend.byPages).toHaveLength(1);
    expect(drawn(view)).toBe('20 {"kind":"all"}');
    view.unmount();
  });

  it('shows no stale figure of every employee while a company that grows back past twenty is read', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-1" />);
    await elapse(0);
    backend.byPages[0]!.resolve(figuresOf(51));
    await elapse(0);
    expect(drawn(view)).toBe('51 {"kind":"every","employees":51}');

    // Thirty-one retire: the subscribed read covers the twenty left.
    backend.bounded = figuresOf(20, 0);
    expect(drawn(view, 'roster-2')).toBe('20 {"kind":"all"}');
    // Three are hired: twenty-three, read by pages again; the fifty-one are not drawn meanwhile.
    backend.bounded = figuresOf(20, 3);
    expect(drawn(view, 'roster-3')).toBe('20 {"kind":"reading","read":20,"of":23}');
    view.unmount();
  });
});
