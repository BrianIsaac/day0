/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  page: undefined as unknown,
  /** Every queries object handed to `useQueries`, in render order. */
  subscriptions: [] as unknown[],
}));

vi.mock('convex/react', () => ({
  useQueries: (queries: Record<string, { query: unknown }>) => {
    backend.subscriptions.push(queries);
    return Object.fromEntries(
      Object.entries(queries).map(([key, { query }]) => [
        key,
        getFunctionName(query as never) === 'transferDepartures:employeePage'
          ? backend.page
          : undefined,
      ]),
    );
  },
}));

vi.mock('next/navigation', () => ({
  useParams: (): { agentId: string } => ({ agentId: 'agent-maya' }),
}));

import {
  EmployeeDeparted,
  NotYourEmployee,
} from '../../../../app/agent/[agentId]/EmployeeDeparted';
import { axeViolations } from '../../../fixtures/dom/axe';
import { mount, press, unmountAll } from '../../../fixtures/dom/press';
import { underTarget } from '../../../fixtures/dom/targets';

const DEPARTURE = {
  transferId: 'transfer-1' as never,
  agentName: 'Maya',
  toAddress: 'lead@kestrel.example',
  decidedAt: Date.UTC(2026, 9, 2, 11),
};

describe('EmployeeDeparted (the transfer plan, 7.4)', () => {
  afterEach(() => {
    unmountAll();
    backend.page = undefined;
    backend.subscriptions = [];
    document.title = '';
  });

  it('hands useQueries one queries object across renders, which it subscribes by identity', () => {
    const retry = (): void => undefined;
    const view = mount(<NotYourEmployee retry={retry} />);
    act((): void => view.root.render(<NotYourEmployee retry={retry} />));
    expect(backend.subscriptions.length).toBeGreaterThan(1);
    expect(new Set(backend.subscriptions).size).toBe(1);
  });

  it('says whom the employee reports to since when, focuses its heading and offers the way home', async () => {
    const view = mount(<EmployeeDeparted departure={DEPARTURE} />);
    const heading = view.container.querySelector('h1');
    expect(heading?.textContent).toBe('Maya was handed over');
    expect(document.activeElement).toBe(heading);
    expect(view.container.querySelector('p')?.textContent).toBe(
      'Maya reports to lead@kestrel.example since 2 Oct 2026, 11:00, UTC time. Its record went with it; your record of the handover is on your home.',
    );
    expect(view.container.querySelector('a')?.textContent).toBe('Back to your employees');
    // The tab the page was served with named an employee that is no longer the manager's.
    expect(document.title).toBe('Maya was handed over · Day0');
    expect(await axeViolations(view.container)).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
  });

  it('says an employee retired since was handed over and retired, never whom it reports to (the v0.12.0 walk)', () => {
    const view = mount(<EmployeeDeparted departure={{ ...DEPARTURE, afterwards: 'retired' }} />);
    expect(view.container.querySelector('p')?.textContent).toBe(
      'Maya was handed over to lead@kestrel.example on 2 Oct 2026, 11:00, UTC time, and has since been retired. Your record of the handover is on your home.',
    );
  });

  it('draws the departure, "No such employee" when there is none, and loading while it is read', () => {
    const retry = (): void => undefined;
    expect(mount(<NotYourEmployee retry={retry} />).container.textContent).toContain(
      'loading employee',
    );
    unmountAll();
    backend.page = { page: 'not-yours' };
    expect(
      mount(<NotYourEmployee retry={retry} />).container.querySelector('h1')?.textContent,
    ).toBe('No such employee');
    unmountAll();
    backend.page = { page: 'departed', departure: DEPARTURE };
    expect(
      mount(<NotYourEmployee retry={retry} />).container.querySelector('h1')?.textContent,
    ).toBe('Maya was handed over');
  });

  it('offers the read again when it fails, and logs why, never calling the employee "no such"', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    let retried = 0;
    backend.page = new Error('Server Error');
    const view = mount(
      <NotYourEmployee
        retry={() => {
          retried += 1;
        }}
      />,
    );
    expect(view.container.querySelector('h1')?.textContent).toBe('This page did not load');
    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: 'departure read failed',
        reason: 'Server Error',
      }),
    );
    await press(view.container, 'Try again');
    expect(retried).toBe(1);
    logged.mockRestore();
  });
});
