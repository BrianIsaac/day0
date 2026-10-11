import { describe, expect, it } from 'vitest';
import {
  DISMISSED_CHANGES_KEPT,
  changeDigest,
  isNotTheirAddress,
  proposedValues,
  sameValues,
  withDismissedChange,
} from '../../../src/people/proposed-change';

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

describe('isNotTheirAddress', (): void => {
  it("reads a plus-tagged spelling of an address the manager said is someone else's as that address (W14-R54)", (): void => {
    expect(isNotTheirAddress(['mei@kestrel.test'], 'mei+hr@kestrel.test')).toBe(true);
    expect(isNotTheirAddress(['mei+hr@kestrel.test'], 'mei@kestrel.test')).toBe(true);
    expect(isNotTheirAddress(['mei@kestrel.test'], 'mei@kestrel.test')).toBe(true);
    expect(isNotTheirAddress(['mei@kestrel.test'], 'mei.lin@kestrel.test')).toBe(false);
    expect(isNotTheirAddress(['mei@kestrel.test'], 'mei+hr@other.test')).toBe(false);
    expect(isNotTheirAddress(undefined, 'mei@kestrel.test')).toBe(false);
  });

  it('is what a proposed change reads, so the tagged spelling is never proposed', (): void => {
    expect(
      proposedValues(
        { primaryEmail: 'mei.lin@kestrel.test', notTheirAddresses: ['mei@kestrel.test'] },
        { primaryEmail: 'mei+hr@kestrel.test' },
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

describe('changeDigest', (): void => {
  it('is one fixed digest of the normalised title, team and address, the same in every release (W14-R52)', (): void => {
    // Pinned by value (sha256sum of the three lines): a changed input re-proposes every change a
    // manager dismissed, once.
    expect(
      changeDigest({ title: 'Finance lead', team: 'Finance', primaryEmail: 'ana.tan@acme.test' }),
    ).toBe('9cfb47ba72ffe19082892cf268461bcdda0331e8c35ad0cd4012e2ef665ce683');
  });

  it('reads case, width and spacing as one change, and a different value as another', (): void => {
    const digest = changeDigest({ title: 'Finance lead' });
    expect(changeDigest({ title: '  finance   LEAD ' })).toBe(digest);
    expect(changeDigest({ title: '\uff26inance lead' })).toBe(digest);
    expect(changeDigest({ title: 'Finance lead', team: 'Finance' })).not.toBe(digest);
    expect(changeDigest({ team: 'Finance lead' })).not.toBe(digest);
    expect(changeDigest({ title: 'Head of finance' })).not.toBe(digest);
  });
});

describe('withDismissedChange', (): void => {
  it('adds a digest once, newest last, and keeps the newest twenty', (): void => {
    expect(withDismissedChange(undefined, 'a')).toEqual(['a']);
    expect(withDismissedChange(['a', 'b'], 'a')).toEqual(['b', 'a']);
    const held = Array.from({ length: DISMISSED_CHANGES_KEPT }, (_, index) => `d${index}`);
    const kept = withDismissedChange(held, 'new');
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe('d1');
    expect(kept.at(-1)).toBe('new');
  });
});
