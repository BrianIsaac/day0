/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ departures: undefined as unknown }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown): unknown =>
    getFunctionName(reference as never) === 'managerTransfers:departures'
      ? backend.departures
      : undefined,
}));

import { HandedOver, handedOver } from '../../../app/home/HandedOver';
import type { HandoverDeparture } from '../../../app/handover-words';
import { axeViolations } from '../../fixtures/dom/axe';
import { mount, unmountAll } from '../../fixtures/dom/press';

/** One of the old manager's finished requests. */
function departure(fields: Partial<HandoverDeparture>): HandoverDeparture {
  return {
    transferId: 'transfer-1' as HandoverDeparture['transferId'],
    agentId: 'agent-maya' as HandoverDeparture['agentId'],
    agentName: 'Maya',
    toAddress: 'lead@kestrel.example',
    state: 'accepted',
    decidedAt: Date.UTC(2026, 9, 2, 11),
    ...fields,
  };
}

describe('HandedOver (the transfer plan, 7.4)', () => {
  afterEach(() => {
    unmountAll();
    backend.departures = undefined;
  });

  it('lists each employee another manager took on, since when, in the viewer’s zone named', async () => {
    backend.departures = [
      departure({}),
      departure({
        transferId: 'transfer-2' as HandoverDeparture['transferId'],
        agentName: 'Tomas',
        toAddress: 'ana@kestrel.example',
        decidedAt: Date.UTC(2026, 9, 1, 8),
      }),
    ];
    const view = mount(<HandedOver />);
    const card = view.container.querySelector('section');
    expect(card?.querySelector('h2')?.textContent).toBe('Handed over');
    expect([...(card?.querySelectorAll('li') ?? [])].map((line) => line.textContent)).toEqual([
      'Maya now reports to lead@kestrel.example, since 2 Oct 2026, 11:00, UTC time.',
      'Tomas now reports to ana@kestrel.example, since 1 Oct 2026, 08:00, UTC time.',
    ]);
    expect(await axeViolations(view.container)).toEqual([]);
  });

  it('says nothing of a decline or an expiry, which People says while the employee is still the manager’s', () => {
    expect(
      handedOver([
        departure({ state: 'declined', declineReason: 'Not my team.' }),
        departure({ state: 'expired' }),
      ]),
    ).toEqual([]);
  });

  it('draws nothing while the read loads or when nobody was handed over', () => {
    expect(mount(<HandedOver />).container.innerHTML).toBe('');
    backend.departures = [departure({ state: 'expired' })];
    expect(mount(<HandedOver />).container.innerHTML).toBe('');
  });
});
