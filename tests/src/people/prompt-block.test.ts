import { describe, expect, it } from 'vitest';
import {
  PEOPLE_BLOCK_LEAD,
  PEOPLE_BLOCK_MAX_LINES,
  PEOPLE_HEADING,
  fromLine,
  namesAnyone,
  peopleBlockLines,
  personNamed,
  withoutIdentities,
  type PromptPeople,
} from '../../../src/people/prompt-block';

/**
 * The People block (wave 13, F9; 13-P's "For the People block"): what the planner and both
 * executor phases read of the people graph. Names and roles, grouped by person, at most eight
 * lines; never an identity, an address, a Slack or Linear id, an evidence quote or a person id;
 * nothing at all when the graph has no one for the employee.
 */

const LEE_COLLABORATOR = 'Linear access and workflow';
const LEE_NEIGHBOUR =
  'Raising access and workflow requests through the manager. Never changes a ticket the finance team owns.';

const graph: PromptPeople = {
  people: [
    {
      displayName: 'Dana Okafor',
      title: 'Finance systems owner',
      edges: [{ type: 'dotted-line' }],
    },
    {
      displayName: 'Lee Tan',
      title: 'Work management administrator',
      edges: [
        { type: 'collaborator', scope: LEE_COLLABORATOR },
        { type: 'adjacent-role', scope: LEE_NEIGHBOUR },
      ],
    },
  ],
  escalation: {
    kind: 'person',
    displayName: 'Sara Lindqvist',
    title: 'Support lead',
    scope: 'missing Linear access',
  },
};

describe('the People block', (): void => {
  it('prints each confirmed person once, by name and role, with every edge in the manager words', (): void => {
    expect(peopleBlockLines(graph)).toEqual([
      PEOPLE_BLOCK_LEAD,
      '- Dana Okafor (Finance systems owner): dotted-line contact.',
      '- Lee Tan (Work management administrator): works with you on Linear access and workflow; neighbouring role, raising access and workflow requests through the manager.',
      '- Escalate to: Sara Lindqvist (Support lead), for missing Linear access; anything else, the manager.',
    ]);
  });

  it('prints nothing when the graph has no one for the employee and the manager is the escalation', (): void => {
    expect(peopleBlockLines({ people: [], escalation: { kind: 'manager' } })).toEqual([]);
    expect(peopleBlockLines(undefined)).toEqual([]);
  });

  it('names the manager as the escalation when people are confirmed and no contact is', (): void => {
    expect(peopleBlockLines({ ...graph, escalation: { kind: 'manager' } }).at(-1)).toBe(
      '- Escalate to: the manager.',
    );
  });

  it('prints an escalation contact alone when no one else is confirmed', (): void => {
    expect(
      peopleBlockLines({
        people: [],
        escalation: { kind: 'person', displayName: 'Sara Lindqvist' },
      }),
    ).toEqual([PEOPLE_BLOCK_LEAD, '- Escalate to: Sara Lindqvist.']);
  });

  it('falls back to the team for a person with no title', (): void => {
    expect(
      peopleBlockLines({
        people: [
          { displayName: 'Mo Reyes', team: 'Accounts payable', edges: [{ type: 'collaborator' }] },
        ],
        escalation: { kind: 'manager' },
      })[1],
    ).toBe('- Mo Reyes (Accounts payable): works with you.');
  });

  it('keeps to eight lines, the lead among them, saying how many it left out', (): void => {
    const people = Array.from({ length: 12 }, (_, index) => ({
      displayName: `Person ${String(index + 1).padStart(2, '0')}`,
      edges: [{ type: 'collaborator' as const }],
    }));
    const lines = peopleBlockLines({ people, escalation: { kind: 'manager' } });
    expect(lines).toHaveLength(PEOPLE_BLOCK_MAX_LINES);
    expect(lines.slice(1, 6)).toEqual(
      people.slice(0, 5).map((person) => `- ${person.displayName}: works with you.`),
    );
    expect(lines[6]).toBe('- 7 more people the manager confirmed are not listed here.');
    expect(lines[7]).toBe('- Escalate to: the manager.');
    // Six people fit with the escalation line; a seventh does not.
    expect(
      peopleBlockLines({ people: people.slice(0, 6), escalation: { kind: 'manager' } }),
    ).toHaveLength(PEOPLE_BLOCK_MAX_LINES);
  });

  it('lower-cases a scope that opens on an ordinary word, and leaves a proper noun alone', (): void => {
    const phrase = (scope: string): string =>
      peopleBlockLines({
        people: [{ displayName: 'Lee Tan', edges: [{ type: 'adjacent-role', scope }] }],
        escalation: { kind: 'manager' },
      })[1]!;
    expect(phrase('Raising access requests')).toBe(
      '- Lee Tan: neighbouring role, raising access requests.',
    );
    expect(phrase('Billing tickets in Linear')).toBe(
      '- Lee Tan: neighbouring role, billing tickets in Linear.',
    );
    expect(phrase('The finance close')).toBe('- Lee Tan: neighbouring role, the finance close.');
    expect(phrase('Linear access')).toBe('- Lee Tan: neighbouring role, Linear access.');
    expect(phrase('SOX sign-off')).toBe('- Lee Tan: neighbouring role, SOX sign-off.');
  });

  it('truncates a long scope to one clause', (): void => {
    const long = `${'Reconciling the vendor ledger against the tracker '.repeat(4)}every week`;
    const [, line] = peopleBlockLines({
      people: [{ displayName: 'Lee Tan', edges: [{ type: 'collaborator', scope: long }] }],
      escalation: { kind: 'manager' },
    });
    expect(line!.length).toBeLessThan(160);
    expect(line).toMatch(/[^.]\.\.\.$/);
  });

  it('never prints an address, a Slack or Linear id, a mention or a link, wherever it was written', (): void => {
    const lines = peopleBlockLines({
      people: [
        {
          displayName: 'Lee Tan <lee.tan@kestrel.test>',
          title: 'Admin (U07ABC12345)',
          edges: [
            {
              type: 'collaborator',
              scope:
                'Linear access, ask @lee.tan or 2f1c9a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b via https://linear.app/kestrel/profiles/lee',
            },
          ],
        },
        { displayName: 'dana@kestrel.test', edges: [{ type: 'dotted-line' }] },
      ],
      escalation: {
        kind: 'person',
        displayName: 'Sara Lindqvist',
        scope: 'anything urgent, <@U0SARA1234>',
      },
    });
    const text = lines.join('\n');
    for (const forbidden of [
      '@',
      'kestrel.test',
      'U07ABC12345',
      'U0SARA1234',
      '2f1c9a7e',
      'https://',
      'linear.app',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain('- Lee Tan (Admin): works with you on Linear access, ask or via.');
    expect(text).not.toContain('dotted line');
    expect(text).toContain(
      '- Escalate to: Sara Lindqvist, for anything urgent; anything else, the manager.',
    );
  });

  it('heads the planner section with its own heading', (): void => {
    expect(PEOPLE_HEADING).toBe('--- People ---');
  });
});

describe('withoutIdentities', (): void => {
  it('removes addresses, mentions, Slack and Linear ids and links, and keeps ticket keys', (): void => {
    expect(withoutIdentities('Ask lee@kestrel.test or @lee about LOG-3 (U07ABC12345)')).toBe(
      'Ask or about LOG-3',
    );
  });
});

describe('personNamed', (): void => {
  it('names a confirmed person by name and role, and nothing when the name was only an address', (): void => {
    expect(personNamed({ displayName: 'Lee Tan', title: 'Work management administrator' })).toBe(
      'Lee Tan (Work management administrator)',
    );
    expect(personNamed({ displayName: 'Lee Tan' })).toBe('Lee Tan');
    expect(personNamed({ displayName: 'lee@kestrel.test' })).toBeUndefined();
  });
});

describe('fromLine', (): void => {
  it('names the confirmed requester, else keeps the label, else says unknown', (): void => {
    expect(fromLine('U07LEE12345', { displayName: 'Lee Tan', title: 'Admin' })).toBe(
      'From: Lee Tan (Admin)',
    );
    expect(fromLine('Lee', undefined)).toBe('From: Lee');
    expect(fromLine('Lee', { displayName: 'lee@kestrel.test' })).toBe('From: Lee');
    expect(fromLine(undefined, undefined)).toBe('From: (unknown)');
  });
});

describe('the People block after the second pass (13-J)', (): void => {
  it('strips a handle in brackets, a link with no scheme, an address with no domain and the stop it leaves', (): void => {
    expect(withoutIdentities('Jane (@jane.doe) and [@jane]')).toBe('Jane and');
    expect(withoutIdentities('profile at linear.app/acme/profiles/lee')).toBe('profile at');
    expect(withoutIdentities('write to jane@acme')).toBe('write to');
    expect(withoutIdentities('jane@acme.com.')).toBe('');
    expect(withoutIdentities('id _U01ABCDEF2 here')).toBe('id _ here');
  });

  it('keeps an upper-case word with digits that is not shaped like a Slack id', (): void => {
    for (const word of ['BILLING2024 questions', 'DEPT12345 owner', 'CDB12345', 'WORKSPACE1']) {
      expect(withoutIdentities(word)).toBe(word);
    }
  });

  it('keeps a clause whole across an abbreviation, and cuts at a long dash', (): void => {
    const phrase = (scope: string): string =>
      peopleBlockLines({
        people: [{ displayName: 'Lee Tan', edges: [{ type: 'adjacent-role', scope }] }],
        escalation: { kind: 'manager' },
      })[1]!;
    expect(phrase('Acme Inc. invoices over the limit')).toBe(
      '- Lee Tan: neighbouring role, Acme Inc. invoices over the limit.',
    );
    expect(phrase('Invoices over 5k e.g. travel')).toBe(
      '- Lee Tan: neighbouring role, Invoices over 5k e.g. travel.',
    );
    expect(phrase('Vendor invoices \u2014 never the payroll run')).toBe(
      '- Lee Tan: neighbouring role, Vendor invoices.',
    );
  });

  it('bounds a long name and role at a word', (): void => {
    const [, line] = peopleBlockLines({
      people: [
        {
          displayName: `Lee ${'Tan '.repeat(30)}`.trim(),
          title: `Administrator ${'of everything '.repeat(20)}`.trim(),
          edges: [{ type: 'collaborator' }],
        },
      ],
      escalation: { kind: 'manager' },
    });
    expect(line!.length).toBeLessThan(170);
    expect(line).toMatch(
      /^- Lee Tan( Tan)*\.\.\. \(Administrator( of everything)*( of)?\.\.\.\): works with you\.$/,
    );
  });

  it('prints no escalation line for a contact named only by an address, never the manager in their place', (): void => {
    const contact = { kind: 'person' as const, displayName: 'sara@acme.test' };
    expect(
      peopleBlockLines({
        people: [{ displayName: 'Lee Tan', edges: [{ type: 'collaborator' }] }],
        escalation: contact,
      }),
    ).toEqual([PEOPLE_BLOCK_LEAD, '- Lee Tan: works with you.']);
    expect(peopleBlockLines({ people: [], escalation: contact })).toEqual([]);
  });

  it('says whether the block names anyone the employee works beside', (): void => {
    expect(namesAnyone(graph)).toBe(true);
    expect(namesAnyone({ people: [], escalation: { kind: 'person', displayName: 'Sara' } })).toBe(
      false,
    );
    expect(namesAnyone(undefined)).toBe(false);
  });
});
