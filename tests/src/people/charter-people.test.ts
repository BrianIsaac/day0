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
      { name: 'Priya Shah', type: 'collaborator', scope: 'segment and pipeline' },
      { name: 'Dana Okafor', type: 'adjacent-role', scope: 'leaving ledger access to her' },
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

  it('names a person once, as a collaborator, when the charter lists them twice', (): void => {
    const body = {
      namedCollaborators: [{ name: 'Priya', topic: 'pipeline' }],
      adjacentRoles: [{ who: 'priya', staysOutOfTheirLaneBy: 'forecasting' }],
    };
    expect(charterPeople(body)).toEqual([
      { name: 'Priya', type: 'collaborator', scope: 'pipeline' },
    ]);
  });

  it('quotes the charter line that names the person, for a proposal with no one-to-one to quote', (): void => {
    expect(charterQuote({ name: 'Priya', type: 'collaborator', scope: 'pipeline' })).toBe(
      'Priya: pipeline',
    );
    expect(charterQuote({ name: 'Priya', type: 'collaborator' })).toBe('Priya');
  });
});
