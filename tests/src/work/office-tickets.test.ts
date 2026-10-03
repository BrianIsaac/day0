import { describe, expect, it } from 'vitest';
import {
  FALLBACK_TICKET_PREFIX,
  filedOnTicketQueue,
  groundTicketWork,
  isTicketWork,
  type TicketGroundingItem,
} from '../../../src/work/office-tickets';

const SEEDED = ['REVOPS-201', 'REVOPS-202', 'REVOPS-203'];

function item(overrides: Partial<TicketGroundingItem> = {}): TicketGroundingItem {
  return {
    sourceCategory: 'ticket-queue',
    sourceSystem: 'ticket',
    title: 'Routine close-out ticket needs comment and closure this week',
    contentSummary: 'Tomas asked for a comment and a close.',
    contentRefs: [],
    priority: 'P1',
    ...overrides,
  };
}

describe('isTicketWork', (): void => {
  it('counts an item from the ticket queue whatever its source system', (): void => {
    expect(isTicketWork(item({ sourceSystem: 'spreadsheet' }))).toBe(true);
  });

  it('counts an item whose source system is a ticket system', (): void => {
    expect(isTicketWork(item({ sourceCategory: 'inbox', sourceSystem: 'tickets' }))).toBe(true);
  });

  it('does not count a chat or social item', (): void => {
    expect(isTicketWork(item({ sourceCategory: 'inbox', sourceSystem: 'slack' }))).toBe(false);
    expect(isTicketWork(item({ sourceCategory: 'social-mention', sourceSystem: 'social' }))).toBe(
      false,
    );
  });
});

describe('filedOnTicketQueue (D2)', (): void => {
  it('takes only a ticket on the ticket queue, never a Slack ask filed there or a ticket from elsewhere', (): void => {
    expect(filedOnTicketQueue(item())).toBe(true);
    expect(filedOnTicketQueue(item({ sourceSystem: 'slack' }))).toBe(false);
    expect(filedOnTicketQueue(item({ sourceCategory: 'inbox' }))).toBe(false);
  });
});

describe('groundTicketWork', (): void => {
  it('opens the next ticket in the office’s key shape for ticket work that names none', (): void => {
    const grounded = groundTicketWork([item()], SEEDED);
    expect(grounded.items[0].contentRefs).toEqual(['ticket://REVOPS-204']);
    expect(grounded.opened).toEqual([
      {
        slug: 'REVOPS-204',
        title: 'Routine close-out ticket needs comment and closure this week',
        body: 'Tomas asked for a comment and a close.',
        priority: 'P1',
      },
    ]);
  });

  it('replaces an originating ticket the office does not hold and keeps the other references', (): void => {
    const grounded = groundTicketWork(
      [item({ contentRefs: ['ticket://made-up-slug', 'mock-spreadsheet://q4-revenue-tracker'] })],
      SEEDED,
    );
    expect(grounded.items[0].contentRefs).toEqual([
      'ticket://REVOPS-204',
      'mock-spreadsheet://q4-revenue-tracker',
    ]);
  });

  it('leaves ticket work on a held ticket as drafted and opens nothing', (): void => {
    const drafted = item({ contentRefs: ['ticket://REVOPS-203', 'docs-fixture/onboarding'] });
    const grounded = groundTicketWork([drafted], SEEDED);
    expect(grounded.items).toEqual([drafted]);
    expect(grounded.opened).toEqual([]);
  });

  it('reads a held ticket behind a path or anchor on its reference', (): void => {
    const grounded = groundTicketWork(
      [item({ contentRefs: ['ticket://REVOPS-202#comments'] })],
      SEEDED,
    );
    expect(grounded.opened).toEqual([]);
    expect(grounded.items[0].contentRefs).toEqual(['ticket://REVOPS-202#comments']);
  });

  it('drops an unheld ticket reference from work that is not a ticket and opens nothing for it', (): void => {
    const grounded = groundTicketWork(
      [
        item({
          sourceCategory: 'inbox',
          sourceSystem: 'slack',
          contentRefs: ['channel://dm-priya', 'ticket://REVOPS-999'],
        }),
      ],
      SEEDED,
    );
    expect(grounded.items[0].contentRefs).toEqual(['channel://dm-priya']);
    expect(grounded.opened).toEqual([]);
  });

  it('numbers two tickets in one batch apart and keeps the batch in order', (): void => {
    const grounded = groundTicketWork(
      [
        item({ title: 'first' }),
        item({ sourceCategory: 'inbox', sourceSystem: 'docs' }),
        item({ title: 'second' }),
      ],
      SEEDED,
    );
    expect(grounded.opened.map((ticket) => [ticket.slug, ticket.title])).toEqual([
      ['REVOPS-204', 'first'],
      ['REVOPS-205', 'second'],
    ]);
    expect(grounded.items.map((drafted) => drafted.contentRefs)).toEqual([
      ['ticket://REVOPS-204'],
      [],
      ['ticket://REVOPS-205'],
    ]);
  });

  it('numbers from the fallback prefix when the office holds no numbered ticket', (): void => {
    const grounded = groundTicketWork([item()], []);
    expect(grounded.opened.map((ticket) => ticket.slug)).toEqual([`${FALLBACK_TICKET_PREFIX}-1`]);
  });

  it('opens a ticket with no priority when the item has none', (): void => {
    const grounded = groundTicketWork(
      [
        {
          sourceCategory: 'ticket-queue',
          sourceSystem: 'ticket',
          title: 'No priority given',
          contentSummary: 'Asked with no priority.',
          contentRefs: [],
        },
      ],
      SEEDED,
    );
    expect(grounded.opened[0]).not.toHaveProperty('priority');
  });
});
