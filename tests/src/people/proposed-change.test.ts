import { describe, expect, it } from 'vitest';
import { proposedValues, sameValues } from '../../../src/people/proposed-change';

describe('proposedValues', (): void => {
  it('names only the values that differ from the confirmed ones, trimmed', (): void => {
    expect(
      proposedValues(
        { title: 'Controller', team: 'Finance', primaryEmail: 'ana@acme.test' },
        { title: ' Finance lead ', team: 'Finance', primaryEmail: 'ana@acme.test' },
      ),
    ).toEqual({ title: 'Finance lead' });
  });

  it('names nothing when every value agrees or is empty', (): void => {
    expect(proposedValues({ title: 'Controller' }, { title: 'Controller', team: '  ' })).toBe(
      undefined,
    );
  });

  it("never proposes an address the manager said is someone else's", (): void => {
    expect(
      proposedValues(
        { primaryEmail: 'ana@acme.test', notTheirAddresses: ['ana@other.test'] },
        { primaryEmail: 'ana@other.test' },
      ),
    ).toBe(undefined);
  });
});

describe('sameValues', (): void => {
  it('compares the three values and nothing else', (): void => {
    expect(sameValues({ title: 'A' }, { title: 'A' })).toBe(true);
    expect(sameValues({ title: 'A' }, { title: 'A', team: 'B' })).toBe(false);
  });
});
