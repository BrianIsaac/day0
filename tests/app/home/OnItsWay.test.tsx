/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ arriving: undefined as unknown }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown): unknown =>
    getFunctionName(reference as never) === 'managerTransfers:arriving'
      ? backend.arriving
      : undefined,
}));

import { OnItsWay } from '../../../app/home/OnItsWay';
import { axeViolations } from '../../fixtures/dom/axe';
import { mount, unmountAll } from '../../fixtures/dom/press';

describe('OnItsWay (the acceptor’s accepting line, the transfer plan 4.2, M2)', () => {
  afterEach(() => {
    unmountAll();
    backend.arriving = undefined;
  });

  it('says each accepted employee is on its way, with the runs the move waits for and the deadline', async () => {
    backend.arriving = [
      {
        transferId: 'transfer-1',
        agentId: 'agent-maya',
        agentName: 'Maya',
        fromAddress: 'sam@kestrel.example',
        settleBy: Date.UTC(2026, 9, 2, 11, 15),
        runsInFlight: 2,
      },
    ];
    const view = mount(<OnItsWay />);
    const card = view.container.querySelector('section');
    expect(card?.querySelector('h2')?.textContent).toBe('On its way to you');
    expect([...(card?.querySelectorAll('li') ?? [])].map((line) => line.textContent)).toEqual([
      'Maya is finishing 2 runs for sam@kestrel.example and becomes yours when they end, by 2 Oct 2026, 11:15, UTC time at the latest.',
    ]);
    expect(await axeViolations(view.container)).toEqual([]);
  });

  it('draws nothing while the read loads or once every employee has arrived', () => {
    expect(mount(<OnItsWay />).container.innerHTML).toBe('');
    backend.arriving = [];
    expect(mount(<OnItsWay />).container.innerHTML).toBe('');
  });
});
