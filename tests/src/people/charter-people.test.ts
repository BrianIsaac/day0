import { describe, expect, it } from 'vitest';
import { charterPeople, charterQuote } from '../../../src/people/charter-people';

describe('charter people', (): void => {
  it('reads one person per named collaborator and per neighbouring role, with what each is for', (): void => {
    const body = {
      namedCollaborators: [
        { name: 'Priya Shah', topic: 'segment and pipeline', introPath: 'self' },
      ],
      adjacentRoles: [
        { who: 'Dana Okafor', staysOutOfTheirLaneBy: 'leaving ledger access to her' },
      ],
    };
    expect(charterPeople(body)).toEqual([
      {
        name: 'Priya Shah',
        edges: [{ type: 'collaborator', scope: 'segment and pipeline' }],
      },
      {
        name: 'Dana Okafor',
        edges: [{ type: 'adjacent-role', scope: 'leaving ledger access to her' }],
      },
    ]);
  });

  it('reads a charter drafted before the lists, or a row missing its name, as naming nobody', (): void => {
    expect(charterPeople(null)).toEqual([]);
    expect(charterPeople({ namedCollaborators: 'Priya' })).toEqual([]);
    expect(
      charterPeople({
        namedCollaborators: [{ topic: 'pipeline' }, { name: '  ' }],
        adjacentRoles: [{}],
      }),
    ).toEqual([]);
  });

  it('names a person once, with both edges, when the charter lists them twice', (): void => {
    const body = {
      namedCollaborators: [{ name: 'Priya', topic: 'pipeline' }],
      adjacentRoles: [{ who: 'priya', staysOutOfTheirLaneBy: 'forecasting' }],
    };
    expect(charterPeople(body)).toEqual([
      {
        name: 'Priya',
        edges: [
          { type: 'collaborator', scope: 'pipeline' },
          { type: 'adjacent-role', scope: 'forecasting' },
        ],
      },
    ]);
  });

  it('reads a neighbouring role written as a collaborator with their role after the name as that collaborator', (): void => {
    // As GLM 5.3 Flash drafted it on the 13-P bed (6 October 2026): every person twice.
    const body = {
      namedCollaborators: [
        { name: 'Lee Tan', topic: 'Linear access and workflow', introPath: 'manager' },
        { name: 'Femi Adeyemi', topic: 'CRM in business systems', introPath: 'manager' },
      ],
      adjacentRoles: [
        {
          who: 'Lee Tan, the Linear admin',
          staysOutOfTheirLaneBy: 'Requesting access through the manager.',
        },
        {
          who: 'Femi Adeyemi in business systems',
          staysOutOfTheirLaneBy: 'Not touching Northstar CRM.',
        },
        {
          who: 'Noor Rahman, the Slack admin',
          staysOutOfTheirLaneBy: 'Going through the manager.',
        },
      ],
    };
    expect(charterPeople(body)).toEqual([
      {
        name: 'Lee Tan',
        edges: [
          { type: 'collaborator', scope: 'Linear access and workflow' },
          { type: 'adjacent-role', scope: 'Requesting access through the manager.' },
        ],
      },
      {
        name: 'Femi Adeyemi',
        edges: [
          { type: 'collaborator', scope: 'CRM in business systems' },
          { type: 'adjacent-role', scope: 'Not touching Northstar CRM.' },
        ],
      },
      {
        name: 'Noor Rahman',
        edges: [{ type: 'adjacent-role', scope: 'Going through the manager.' }],
      },
    ]);
  });

  it('quotes the charter line that names the person, for a proposal with no one-to-one to quote', (): void => {
    expect(
      charterQuote({ name: 'Priya', edges: [{ type: 'collaborator', scope: 'pipeline' }] }),
    ).toBe('Priya: pipeline');
    expect(charterQuote({ name: 'Priya', edges: [{ type: 'collaborator' }] })).toBe('Priya');
  });
});
