/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIGURES_READ_BY_PAGES } from '../../../../src/metrics/figures-output';

/** What the subscribed read answers, and each read by pages: its arguments and how it ends. */
const backend = vi.hoisted(() => ({
  subscribed: undefined as unknown,
  asked: [] as Array<{ name: string; args: unknown }>,
  byPages: [] as Array<{
    args: unknown;
    resolve: (figures: unknown) => void;
    reject: (error: Error) => void;
  }>,
}));

const readByPages = async (args: unknown): Promise<unknown> =>
  await new Promise((resolve, reject) => {
    backend.byPages.push({ args, resolve, reject });
  });

vi.mock('convex/react', () => ({
  useQueries: (queries: Record<string, { query: unknown; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(queries).map(([key, { query, args }]) => {
        backend.asked.push({ name: getFunctionName(query as never), args });
        return [key, backend.subscribed];
      }),
    ),
  // One function for the reference, as the real hook hands back.
  useAction: () => readByPages,
}));

import {
  EMPLOYEE_FIGURES_REREAD_MS,
  useEmployeeFigures,
} from '../../../../app/agent/[agentId]/use-employee-figures';
import type { Id } from '../../../../convex/_generated/dataModel';
import { mount, type Mounted } from '../../../fixtures/dom/press';

/** Figures with so many decisions approved. */
const figuresOf = (approved: number) => ({ decisions: { approved } });

/** The hook as a page reads it: the approvals, "loading", or the failure. */
function Probe({ day }: { day?: string }) {
  const read = useEmployeeFigures('agent-1' as Id<'agents'>, day);
  return (
    <p>
      {read === undefined
        ? 'loading'
        : read instanceof Error
          ? `failed: ${read.message}`
          : String((read as unknown as ReturnType<typeof figuresOf>).decisions.approved)}
    </p>
  );
}

function drawn(view: Mounted, day?: string): string {
  act((): void => view.root.render(<Probe day={day} />));
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
});

afterEach((): void => {
  backend.subscribed = undefined;
  backend.asked = [];
  backend.byPages = [];
  vi.useRealTimers();
});

describe('an employee’s figures on its page (C1, wave 18, 18-F)', (): void => {
  it('draws the subscribed read and asks for nothing by pages where it holds the records', async (): Promise<void> => {
    backend.subscribed = figuresOf(3);
    const view = mount(<Probe day="2026-10-13" />);
    await elapse(EMPLOYEE_FIGURES_REREAD_MS * 2);
    expect(drawn(view, '2026-10-13')).toBe('3');
    expect(backend.asked[0]).toEqual({
      name: 'metrics:forAgent',
      args: { agentId: 'agent-1', day: '2026-10-13' },
    });
    expect(backend.byPages).toHaveLength(0);
    view.unmount();
  });

  it('draws the figures of an employee whose records pass the read bound, read by pages, and reads them again while the page stays open', async (): Promise<void> => {
    backend.subscribed = new ConvexError(FIGURES_READ_BY_PAGES);
    const view = mount(<Probe day="2026-10-13" />);
    await elapse(0);
    expect(drawn(view, '2026-10-13')).toBe('loading');
    expect(backend.byPages.map((read) => read.args)).toEqual([
      { agentId: 'agent-1', day: '2026-10-13' },
    ]);
    backend.byPages[0]!.resolve(figuresOf(24));
    await elapse(0);
    expect(drawn(view, '2026-10-13')).toBe('24');

    await elapse(EMPLOYEE_FIGURES_REREAD_MS);
    expect(backend.byPages).toHaveLength(2);
    backend.byPages[1]!.resolve(figuresOf(25));
    await elapse(0);
    expect(drawn(view, '2026-10-13')).toBe('25');
    view.unmount();
    await elapse(EMPLOYEE_FIGURES_REREAD_MS * 3);
    expect(backend.byPages).toHaveLength(2);
  });

  it('answers the failure of a read by pages, and of a read that is no bound’s', async (): Promise<void> => {
    backend.subscribed = new ConvexError(FIGURES_READ_BY_PAGES);
    const view = mount(<Probe />);
    await elapse(0);
    backend.byPages[0]!.reject(new Error('the backend is restarting'));
    await elapse(0);
    expect(drawn(view)).toBe('failed: the backend is restarting');

    backend.subscribed = new Error('Server Error');
    expect(drawn(view)).toBe('failed: Server Error');
    view.unmount();
  });
});

describe('an employee’s figures by pages when the day turns (the second pass)', (): void => {
  beforeEach((): void => {
    vi.useFakeTimers();
  });

  it('reads the new day at once, though the old day’s read is still on its way', async (): Promise<void> => {
    backend.subscribed = new ConvexError(FIGURES_READ_BY_PAGES);
    const view = mount(<Probe day="2026-10-13" />);
    await elapse(0);
    expect(backend.byPages).toHaveLength(1);

    expect(drawn(view, '2026-10-14')).toBe('loading');
    await elapse(0);
    expect(backend.byPages.map((read) => read.args)).toEqual([
      { agentId: 'agent-1', day: '2026-10-13' },
      { agentId: 'agent-1', day: '2026-10-14' },
    ]);
    backend.byPages[0]!.resolve(figuresOf(1));
    backend.byPages[1]!.resolve(figuresOf(2));
    await elapse(0);
    expect(drawn(view, '2026-10-14')).toBe('2');
    view.unmount();
  });
});

describe('an employee’s figures by pages when a re-read fails (the second pass)', (): void => {
  beforeEach((): void => {
    vi.useFakeTimers();
  });

  it('keeps the figures it drew when a later read fails', async (): Promise<void> => {
    backend.subscribed = new ConvexError(FIGURES_READ_BY_PAGES);
    const view = mount(<Probe />);
    await elapse(0);
    backend.byPages[0]!.resolve(figuresOf(24));
    await elapse(0);
    expect(drawn(view)).toBe('24');
    await elapse(EMPLOYEE_FIGURES_REREAD_MS);
    backend.byPages[1]!.reject(new Error('the backend is restarting'));
    await elapse(0);
    expect(drawn(view)).toBe('24');
    view.unmount();
  });
});
