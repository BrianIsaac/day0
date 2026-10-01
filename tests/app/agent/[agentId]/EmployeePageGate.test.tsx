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

import { EmployeePageGate } from '../../../../app/agent/[agentId]/EmployeePageGate';
import { mount, unmountAll } from '../../../fixtures/dom/press';

const DEPARTED = {
  page: 'departed',
  departure: {
    transferId: 'transfer-1',
    agentName: 'Maya',
    toAddress: 'lead@kestrel.example',
    decidedAt: Date.UTC(2026, 9, 2, 11),
  },
};

function gate() {
  return (
    <EmployeePageGate agentId="agent-maya">
      <p>the shell</p>
    </EmployeePageGate>
  );
}

describe('EmployeePageGate', () => {
  afterEach(() => {
    unmountAll();
    backend.page = undefined;
    backend.subscriptions = [];
  });

  it('hands useQueries one queries object across renders, which it subscribes by identity', () => {
    const view = mount(gate());
    act((): void => view.root.render(gate()));
    expect(backend.subscriptions.length).toBeGreaterThan(1);
    expect(new Set(backend.subscriptions).size).toBe(1);
  });

  it('draws the shell only once the employee is the reader’s to show, loading until then', () => {
    expect(mount(gate()).container.textContent).toContain('loading');
    unmountAll();
    backend.page = { page: 'employee' };
    expect(mount(gate()).container.textContent).toBe('the shell');
  });

  it('draws where a handed-over employee went, and "No such employee" for another account’s, never the shell', () => {
    backend.page = DEPARTED;
    const departed = mount(gate()).container;
    expect(departed.querySelector('h1')?.textContent).toBe('Maya was handed over');
    expect(departed.textContent).not.toContain('the shell');
    unmountAll();
    backend.page = { page: 'not-yours' };
    const other = mount(gate()).container;
    expect(other.querySelector('h1')?.textContent).toBe('No such employee');
    expect(other.textContent).not.toContain('the shell');
  });

  it('draws the shell when the read fails, and logs why: the shell’s own read still answers', () => {
    const logged = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    backend.page = new Error('Server Error');
    expect(mount(gate()).container.textContent).toBe('the shell');
    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
      expect.objectContaining({ level: 'warn', reason: 'Server Error' }),
    );
    logged.mockRestore();
  });
});
