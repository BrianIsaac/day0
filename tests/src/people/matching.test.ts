import { describe, expect, it } from 'vitest';
import {
  matchProposal,
  type HeldIdentity,
  type HeldPerson,
  type PersonProposal,
} from '../../../src/people/matching';

/** A confirmed person of the graph. */
function person(id: string, fields: Partial<HeldPerson<string>> = {}): HeldPerson<string> {
  return {
    id,
    nameKey: 'priya shah',
    status: 'active',
    quotes: [],
    ...fields,
  };
}

/** A proposal naming Priya Shah with one quote. */
function proposal(fields: Partial<PersonProposal> = {}): PersonProposal {
  return {
    name: 'Priya Shah',
    identities: [],
    quotes: ['Priya Shah owns the pipeline'],
    ...fields,
  };
}

const slack = (personId: string, externalId: string, workspaceId = 'T1'): HeldIdentity<string> => ({
  personId,
  provider: 'slack',
  externalId,
  workspaceId,
});

describe('people matching', (): void => {
  it('merges a proposal into the person holding the same identity, in the same workspace, whatever its name', (): void => {
    const held = [person('p1', { nameKey: 'p shah' })];
    const identities = [slack('p1', 'U1')];
    const match = matchProposal(
      proposal({ identities: [{ provider: 'slack', externalId: 'U1', workspaceId: 'T1' }] }),
      held,
      identities,
    );
    expect(match).toEqual({ kind: 'same', personId: 'p1', by: 'identity' });
  });

  it('never merges by an id from another workspace', (): void => {
    const match = matchProposal(
      proposal({
        name: 'Somebody',
        identities: [{ provider: 'slack', externalId: 'U1', workspaceId: 'T2' }],
      }),
      [person('p1')],
      [slack('p1', 'U1', 'T1')],
    );
    expect(match).toEqual({ kind: 'new' });
  });

  it('merges a proposal into the person with the same address, in any case', (): void => {
    const held = [person('p1', { nameKey: 'p shah', primaryEmail: 'priya@kestrel.test' })];
    expect(matchProposal(proposal({ email: ' Priya@Kestrel.TEST ' }), held, [])).toEqual({
      kind: 'same',
      personId: 'p1',
      by: 'address',
    });
  });

  it('merges by an address recorded as an identity of the person', (): void => {
    const identities: HeldIdentity<string>[] = [
      { personId: 'p1', provider: 'email', externalId: 'priya@kestrel.test' },
    ];
    expect(
      matchProposal(proposal({ email: 'priya@kestrel.test' }), [person('p1')], identities),
    ).toEqual({ kind: 'same', personId: 'p1', by: 'address' });
  });

  it('offers a name-only match as possibly the same, preferring a confirmed person, and never merges it', (): void => {
    const held = [person('p0', { status: 'unverified', quotes: ['other words'] }), person('p1')];
    expect(matchProposal(proposal(), held, [])).toEqual({ kind: 'possibly', personId: 'p1' });
  });

  it('answers a repeat for a person already proposed on the very same words, so a second run proposes nobody twice', (): void => {
    const held = [person('p1', { status: 'unverified', quotes: ['Priya Shah owns the pipeline'] })];
    expect(matchProposal(proposal(), held, [])).toEqual({ kind: 'repeat', personId: 'p1' });
  });

  it('keeps a dismissed person dismissed when the same identity, address or words come again', (): void => {
    const dismissed = person('p1', {
      status: 'dismissed',
      primaryEmail: 'priya@kestrel.test',
      quotes: ['Priya Shah owns the pipeline'],
    });
    expect(matchProposal(proposal(), [dismissed], [])).toEqual({
      kind: 'dismissed',
      personId: 'p1',
    });
    expect(
      matchProposal(proposal({ name: 'P', email: 'priya@kestrel.test' }), [dismissed], []),
    ).toEqual({ kind: 'dismissed', personId: 'p1' });
  });

  it('proposes afresh a name a dismissed person carried on other words, since the manager turned down those', (): void => {
    const dismissed = person('p1', { status: 'dismissed', quotes: ['old words'] });
    expect(matchProposal(proposal(), [dismissed], [])).toEqual({ kind: 'new' });
  });

  it('proposes a new person when nothing matches, and a name with no letters matches nobody', (): void => {
    expect(matchProposal(proposal({ name: 'Mateo' }), [person('p1')], [])).toEqual({
      kind: 'new',
    });
    expect(matchProposal(proposal({ name: '--' }), [person('p1', { nameKey: '' })], [])).toEqual({
      kind: 'new',
    });
  });
});
