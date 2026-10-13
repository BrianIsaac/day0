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

import { useCompanyFigures, WHOLE_COMPANY_REREAD_MS } from '../../../app/home/use-company-figures';
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

  it('reads again a moment after a change, keeping the figures it had meanwhile', async (): Promise<void> => {
    backend.bounded = figuresOf(20, 31);
    const view = mount(<Probe changes="roster-1" />);
    await elapse(0);
    backend.byPages[0]!.resolve(figuresOf(51));
    await elapse(0);

    // Three changes in a second: one read, two seconds after the last of them.
    drawn(view, 'roster-2');
    await elapse(500);
    drawn(view, 'roster-3');
    await elapse(500);
    expect(drawn(view, 'roster-4')).toBe('51 {"kind":"every","employees":51}');
    await elapse(WHOLE_COMPANY_REREAD_MS - 1);
    expect(backend.byPages).toHaveLength(1);
    await elapse(1);
    expect(backend.byPages).toHaveLength(2);

    backend.byPages[1]!.resolve(figuresOf(52));
    await elapse(0);
    expect(drawn(view, 'roster-4')).toBe('52 {"kind":"every","employees":52}');
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

  it('answers nothing while the subscribed read is on its way', (): void => {
    const view = mount(<Probe changes="roster-1" />);
    expect(drawn(view)).toBe('none {"kind":"all"}');
    view.unmount();
  });
});
