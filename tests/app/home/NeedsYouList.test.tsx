import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NeedsYouList, waitingFor } from '../../../app/home/NeedsYouList';
import type { NeedsYouInbox } from '../../../app/home/types';

const NOW = Date.UTC(2026, 8, 26, 6, 45);
const minutes = (n: number): number => NOW - n * 60_000;

const base = {
  agentId: 'synthetic-mira',
  employeeName: 'Mira',
  zone: 'Asia/Singapore',
  waitingAtLeast: false,
};

/** The prototype's three entries and the four other kinds, as `work.needsYou` returns them. */
const inbox = {
  entries: [
    {
      ...base,
      kind: 'held',
      key: 'held:1',
      subject: 'Send you a DM in Slack about escalation guidance',
      waitingSince: minutes(6),
      workItemId: 'item-1',
      heldWrites: 1,
    },
    {
      ...base,
      kind: 'plan',
      key: 'plan:2',
      subject: 'Draft response for new tier-two RevOps ask',
      waitingSince: minutes(8),
      workItemId: 'item-2',
      questions: 1,
    },
    {
      ...base,
      kind: 'skill',
      key: 'skill:3',
      subject: 'chat-thread-reply',
      waitingSince: minutes(9),
      skillId: 'skill-3',
      waitingItems: 2,
    },
    {
      ...base,
      kind: 'charter',
      key: 'charter:4',
      employeeName: 'Aiko',
      agentId: 'synthetic-aiko',
      subject: 'charter',
      waitingSince: minutes(90),
    },
    {
      ...base,
      kind: 'parked',
      key: 'parked:5',
      subject: 'Read the tracker',
      waitingSince: minutes(3 * 24 * 60),
      waitingAtLeast: true,
      workItemId: 'item-5',
      reason: 'connection',
    },
    {
      ...base,
      kind: 'stopped',
      key: 'stopped:6',
      subject: 'Close REVOPS-9',
      waitingSince: minutes(30),
      workItemId: 'item-6',
    },
    {
      ...base,
      kind: 'surface',
      key: 'surface:7',
      subject: 'Looker',
      waitingSince: minutes(45),
      surfaceId: 'surface-7',
    },
  ],
  total: 9,
  waitingByEmployee: [],
} as unknown as NeedsYouInbox;

describe('waitingFor', (): void => {
  it('says how long in the coarsest honest unit, and "over" for a floor', (): void => {
    expect(waitingFor(NOW - 20_000, NOW, false)).toBe('waiting under a minute');
    expect(waitingFor(minutes(6), NOW, false)).toBe('waiting 6 min');
    expect(waitingFor(minutes(90), NOW, false)).toBe('waiting 1 h 30 min');
    expect(waitingFor(minutes(3 * 60), NOW, false)).toBe('waiting 3 h');
    expect(waitingFor(minutes(3 * 24 * 60), NOW, true)).toBe('waiting over 3 days');
    expect(waitingFor(minutes(24 * 60), NOW, false)).toBe('waiting 1 day');
  });
});

describe('NeedsYouList', (): void => {
  const html = renderToStaticMarkup(<NeedsYouList inbox={inbox} now={NOW} />);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('heads the card "Needs you", ordered by wait', (): void => {
    expect(html).toContain('>Needs you<');
    expect(text).toContain('ordered by wait');
  });

  it('names the employee and the decision, then what it is about, for each kind', (): void => {
    expect(text).toContain('Mira · a write is held for you');
    expect(text).toContain('Send you a DM in Slack about escalation guidance.');
    expect(text).toContain('Mira · a plan to approve');
    expect(text).toContain('Draft response for new tier-two RevOps ask. One charter question.');
    expect(text).toContain('Mira · a skill to approve');
    expect(text).toContain('chat-thread-reply, which 2 items wait on.');
    expect(text).toContain('Aiko · a charter to review');
    expect(text).toContain('Mira · an item waiting on a connection');
    expect(text).toContain('Mira · an item stopped short of done');
    expect(text).toContain('Mira · a system to approve');
  });

  it('keeps the server’s order, longest wait first, and dates the held write', (): void => {
    const order = ['held for you', 'plan to approve', 'skill to approve', 'charter to review'];
    const positions = order.map((phrase) => text.indexOf(phrase));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text).toContain('waiting 6 min');
    expect(text).toContain('held since 26 Sep 2026, 14:39');
    expect(text).toContain('waiting over 3 days');
  });

  it('links every entry to its employee’s page, with Decide on a held write and Open elsewhere', (): void => {
    expect(html.match(/href="\/agent\/synthetic-mira"/g)).toHaveLength(6);
    expect(html.match(/href="\/agent\/synthetic-aiko"/g)).toHaveLength(1);
    expect(text.match(/ Decide /g)).toHaveLength(1);
    expect(text.match(/ Open /g)).toHaveLength(6);
  });

  it('says how many more wait beyond the ones shown', (): void => {
    expect(text).toContain('2 more on your employees’ pages');
  });

  it('says so when nothing waits on the manager', (): void => {
    const empty = renderToStaticMarkup(
      <NeedsYouList inbox={{ entries: [], total: 0, waitingByEmployee: [] }} now={NOW} />,
    );
    expect(empty).toContain('Nothing is waiting on you.');
  });

  it('sets no type below the 12 px floor', (): void => {
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
  });
});
