/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ departure: undefined as unknown }));

vi.mock('convex/react', () => ({
  useQueries: (queries: Record<string, { query: unknown }>) =>
    Object.fromEntries(
      Object.entries(queries).map(([key, { query }]) => [
        key,
        getFunctionName(query as never) === 'managerTransfers:departureOf'
          ? backend.departure
          : undefined,
      ]),
    ),
}));

vi.mock('next/navigation', () => ({
  useParams: (): { agentId: string } => ({ agentId: 'agent-maya' }),
}));

import {
  EmployeeDeparted,
  NotYourEmployee,
} from '../../../../app/agent/[agentId]/EmployeeDeparted';
import { axeViolations } from '../../../fixtures/dom/axe';
import { mount, unmountAll } from '../../../fixtures/dom/press';
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
    backend.departure = undefined;
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
    expect(await axeViolations(view.container)).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
  });

  it('draws the departure, "No such employee" when there is none, and loading while it is read', () => {
    expect(mount(<NotYourEmployee />).container.textContent).toContain('loading employee');
    unmountAll();
    backend.departure = null;
    expect(mount(<NotYourEmployee />).container.querySelector('h1')?.textContent).toBe(
      'No such employee',
    );
    unmountAll();
    backend.departure = new Error('ArgumentValidationError');
    expect(mount(<NotYourEmployee />).container.querySelector('h1')?.textContent).toBe(
      'No such employee',
    );
    unmountAll();
    backend.departure = DEPARTURE;
    expect(mount(<NotYourEmployee />).container.querySelector('h1')?.textContent).toBe(
      'Maya was handed over',
    );
  });
});
