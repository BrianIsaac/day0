/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import { NeedsYouList } from '../../../app/home/NeedsYouList';
import type { NeedsYouInbox } from '../../../app/home/types';
import { axeViolations } from '../../fixtures/dom/axe';
import { mount, unmountAll } from '../../fixtures/dom/press';
import { underTarget } from '../../fixtures/dom/targets';

const NOW = Date.UTC(2026, 9, 1, 9);

/** A handover named to the manager, the ninth kind, beside a plan, as `work.needsYou` lists them. */
const inbox = {
  entries: [
    {
      kind: 'transfer',
      key: 'transfer:transfer-1',
      agentId: 'agent-maya',
      employeeName: 'Maya',
      zone: 'UTC',
      waitingSince: NOW - 30 * 60_000,
      waitingAtLeast: false,
      transferId: 'transfer-1',
      fromAddress: 'sam@kestrel.example',
      expiresAt: NOW + 14 * 24 * 60 * 60_000,
    },
    {
      kind: 'plan',
      key: 'plan:1',
      agentId: 'agent-mira',
      employeeName: 'Mira',
      zone: 'UTC',
      waitingSince: NOW - 10 * 60_000,
      waitingAtLeast: false,
      workItemId: 'item-1',
      subject: 'Draft the September close checklist',
      questions: 0,
    },
  ],
  total: 2,
  waitingByEmployee: [],
} as unknown as NeedsYouInbox;

describe('NeedsYouList with a handover waiting (the transfer plan, 14.1 item 10)', () => {
  afterEach(() => unmountAll());

  it('passes axe and keeps the entry’s Review at 44 px, opening the acceptance dialog on the home', async () => {
    const view = mount(<NeedsYouList inbox={inbox} now={NOW} />);
    expect(await axeViolations(view.container)).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    const review = [...view.container.querySelectorAll('a')].find(
      (link) => link.textContent === 'Review',
    );
    expect(review?.getAttribute('href')).toBe('/?transfer=transfer-1');
    expect(review?.getAttribute('aria-labelledby')).toMatch(/-control /);
    expect(view.container.textContent).toContain('Maya · an employee to take on');
  });
});
