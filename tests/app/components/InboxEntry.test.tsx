import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  InboxEntry,
  inboxEntryHref,
  inboxEntryWords,
  waitingFor,
  type InboxItem,
} from '../../../app/components/InboxEntry';

const NOW = Date.UTC(2026, 8, 26, 6, 45);
const minutes = (n: number): number => NOW - n * 60_000;

const base = {
  agentId: 'synthetic-mira',
  employeeName: 'Mira',
  zone: 'Asia/Singapore',
  waitingAtLeast: false,
};

const held = {
  ...base,
  kind: 'held',
  key: 'held:1',
  subject: 'Send you a DM in Slack about escalation guidance',
  waitingSince: minutes(6),
  workItemId: 'item-1',
  heldWrites: 1,
} as unknown as InboxItem;

const plan = {
  ...base,
  kind: 'plan',
  key: 'plan:2',
  subject: 'Draft response for new tier-two RevOps ask',
  waitingSince: minutes(8),
  workItemId: 'item-2',
  questions: 2,
} as unknown as InboxItem;

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

describe('inboxEntryWords and inboxEntryHref', (): void => {
  const entry = (kind: string, extra: Record<string, unknown> = {}): InboxItem =>
    ({
      ...base,
      kind,
      key: kind,
      subject: 'S',
      waitingSince: NOW,
      ...extra,
    }) as unknown as InboxItem;

  it('asks, describes and names one control for every kind, each going to the tab that decides it', (): void => {
    const cases = [
      [entry('one-to-one'), 'a one-to-one to hold', 'Hold the one-to-one', '/agent/synthetic-mira'],
      [
        entry('charter'),
        'a charter to review',
        'Review the charter',
        '/agent/synthetic-mira/charter',
      ],
      [plan, 'a plan to approve', 'Open the plan', '/agent/synthetic-mira/work#item-item-2'],
      [held, 'a write is held for you', 'Decide', '/agent/synthetic-mira/work#item-item-1'],
      [
        entry('skill', { skillId: 's', waitingItems: 1 }),
        'a skill to approve',
        'Open',
        '/agent/synthetic-mira/skills',
      ],
      [
        entry('parked', { workItemId: 'p', reason: 'permission' }),
        'an item waiting on a read grant',
        'Open',
        '/agent/synthetic-mira/work#item-p',
      ],
      [
        entry('stopped', { workItemId: 'x' }),
        'an item stopped short of done',
        'Open',
        '/agent/synthetic-mira/work#item-x',
      ],
      [
        entry('surface', { surfaceId: 'f' }),
        'a system to approve',
        'Open',
        '/agent/synthetic-mira/surfaces',
      ],
    ] as const;
    for (const [item, ask, control, href] of cases) {
      expect(inboxEntryWords(item)).toMatchObject({ ask, control });
      expect(inboxEntryHref(item)).toBe(href);
    }
    expect(inboxEntryWords(plan).about).toBe(
      'Draft response for new tier-two RevOps ask. 2 charter questions.',
    );
  });
});

describe('InboxEntry', (): void => {
  it('opens with the ask as a sentence on the employee page, and after the name on the home', (): void => {
    expect(renderToStaticMarkup(<InboxEntry entry={held} now={NOW} />)).toContain(
      '>A write is held for you</p>',
    );
    expect(renderToStaticMarkup(<InboxEntry entry={held} now={NOW} named />)).toContain(
      '>Mira · a write is held for you</p>',
    );
  });

  it('dates a held write in the employee’s zone and draws it alone in the warn tone', (): void => {
    const heldHtml = renderToStaticMarkup(<InboxEntry entry={held} now={NOW} />);
    expect(heldHtml).toContain('waiting 6 min');
    expect(heldHtml).toContain('held since 26 Sep 2026, 14:39');
    expect(heldHtml).toMatch(/^<li class="[^"]*border-\[var\(--color-warn-line\)\]/);
    const planHtml = renderToStaticMarkup(<InboxEntry entry={plan} now={NOW} />);
    expect(planHtml).not.toContain('held since');
    expect(planHtml).not.toContain('warn');
  });

  it('has one control, a 44 px link described by the entry’s title', (): void => {
    const html = renderToStaticMarkup(<InboxEntry entry={held} now={NOW} />);
    expect(html.match(/<a /g)).toHaveLength(1);
    const title = /<p id="([^"]+)"/.exec(html)?.[1];
    expect(html).toMatch(
      new RegExp(
        `<a class="[^"]*\\bmin-h-11\\b[^"]*" aria-describedby="${title}" href="/agent/synthetic-mira/work#item-item-1">Decide</a>`,
      ),
    );
  });

  it('sets no type below the 12 px floor', (): void => {
    expect(renderToStaticMarkup(<InboxEntry entry={held} now={NOW} named />)).not.toMatch(
      /text-\[(9|10|11)px\]/,
    );
  });
});
