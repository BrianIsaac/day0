import { describe, expect, it } from 'vitest';
import {
  RELATION_MEASURES,
  SHARED_TEXT_DUPLICATE,
  relationWords,
} from '../../../src/docs/relation-words';

describe('the measures\u2019 names and the card\u2019s words for each', (): void => {
  it('names five measures and the share of text from which two pages read as one document', (): void => {
    // `edit-dates` joined in wave 16 (16-FD, RM19 (a)).
    expect(RELATION_MEASURES).toEqual([
      'shared-text',
      'title-version',
      'names-successor',
      'heading-figures',
      'edit-dates',
    ]);
    expect(SHARED_TEXT_DUPLICATE).toBe(60);
  });

  it('says the strongest measure of a proposal: a named successor, then a figure, then a version, then the share', (): void => {
    const all = [
      { measure: 'shared-text', value: 78 },
      { measure: 'title-version', value: 1 },
      { measure: 'heading-figures', value: 2 },
      { measure: 'names-successor', value: 1 },
    ];
    expect(relationWords(all)).toBe('one names the other as the page it replaces');
    expect(relationWords(all.slice(0, 3), 'Thresholds')).toBe(
      'say different figures under "Thresholds"',
    );
    expect(relationWords(all.slice(0, 3))).toBe('say different figures under the same heading');
    expect(relationWords(all.slice(0, 2))).toBe(
      'have the same title but for a version and share 78 percent of their text',
    );
    expect(relationWords([{ measure: 'title-version', value: 1 }])).toBe(
      'have the same title but for a version',
    );
    expect(relationWords([{ measure: 'shared-text', value: 78 }])).toBe(
      'share 78 percent of their text',
    );
    // The dated successor (RM19 (a)): the card names the older page first, the newer second.
    expect(
      relationWords([
        { measure: 'shared-text', value: 96 },
        { measure: 'edit-dates', value: 3 },
      ]),
    ).toBe('share 96 percent of their text, and the second was edited 3 days after the first');
    expect(
      relationWords([
        { measure: 'shared-text', value: 100 },
        { measure: 'edit-dates', value: 1 },
      ]),
    ).toBe('share 100 percent of their text, and the second was edited a day after the first');
    // A named successor or a version in the title says more than the dates do.
    expect(
      relationWords([
        { measure: 'title-version', value: 1 },
        { measure: 'shared-text', value: 78 },
        { measure: 'edit-dates', value: 3 },
      ]),
    ).toBe('have the same title but for a version and share 78 percent of their text');
    // A measure this build does not know says the share it has, never nothing.
    expect(relationWords([{ measure: 'a-later-measure', value: 1 }])).toBe(
      'share 0 percent of their text',
    );
  });
});
