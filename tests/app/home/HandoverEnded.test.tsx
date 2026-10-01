/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ ended: undefined as unknown }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown): unknown =>
    getFunctionName(reference as never) === 'managerTransfers:endedForMe'
      ? backend.ended
      : undefined,
}));

import { HandoverEnded } from '../../../app/home/HandoverEnded';
import { axeViolations } from '../../fixtures/dom/axe';
import { mount, unmountAll } from '../../fixtures/dom/press';

describe('HandoverEnded (the acceptor told a handover ended itself, the cockpit’s item)', () => {
  afterEach(() => {
    unmountAll();
    backend.ended = undefined;
  });

  it('says the employee is not coming, who it stays with, and when the handover was accepted', async () => {
    backend.ended = [
      {
        transferId: 'transfer-1',
        agentName: 'Juno',
        fromAddress: 'priya@acme.test',
        acceptedAt: Date.UTC(2026, 9, 1, 21, 30),
      },
    ];
    const view = mount(<HandoverEnded />);
    const card = view.container.querySelector('section');
    expect(card?.querySelector('h2')?.textContent).toBe('A handover that did not finish');
    expect([...(card?.querySelectorAll('li') ?? [])].map((line) => line.textContent)).toEqual([
      'Juno stays with priya@acme.test: the handover you accepted could not finish and was ended (accepted 1 Oct 2026, 21:30, UTC time).',
    ]);
    expect(await axeViolations(view.container)).toEqual([]);
  });

  it('names the card by how many handovers it lists', () => {
    backend.ended = ['one', 'two'].map((id) => ({
      transferId: id,
      agentName: `Employee ${id}`,
      fromAddress: 'priya@acme.test',
      acceptedAt: Date.UTC(2026, 9, 1, 21, 30),
    }));
    const view = mount(<HandoverEnded />);
    expect(view.container.querySelector('h2')?.textContent).toBe('Handovers that did not finish');
  });

  it('draws nothing while the read loads or when no handover ended', () => {
    expect(mount(<HandoverEnded />).container.innerHTML).toBe('');
    backend.ended = [];
    expect(mount(<HandoverEnded />).container.innerHTML).toBe('');
  });
});
