import { describe, expect, it } from 'vitest';
import {
  RELATION_MEASURES,
  SHARED_TEXT_DUPLICATE,
  relationWords,
  differingFigures,
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

describe('differingFigures: what a conflict card says the two pages say (W9a)', (): void => {
  it('says only the figures that differ, not every figure of the line', (): void => {
    // 16-J's walk: "An audit comment on a Q3 close ticket is at most 60 words." against
    // "... 120 words." read "3 60 against 3 120" (the 3 is Q3's).
    expect(differingFigures({ from: '3 60', to: '3 120' })).toEqual({ from: '60', to: '120' });
    expect(differingFigures({ from: '3 5', to: '3 2' })).toEqual({ from: '5', to: '2' });
    expect(differingFigures({ from: '10,000', to: '5,000' })).toEqual({
      from: '10,000',
      to: '5,000',
    });
  });

  it('keeps the lines as they are when their figures do not line up one for one', (): void => {
    expect(differingFigures({ from: '3 60', to: '120' })).toEqual({ from: '3 60', to: '120' });
    expect(differingFigures({ from: '3 60', to: '3 60' })).toEqual({ from: '3 60', to: '3 60' });
  });
});
