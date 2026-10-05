import { describe, expect, it } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import {
  awaitingCheck,
  awaitingManager,
  bindingWords,
  checkingLine,
  keepNoteHint,
  proposalQuestion,
  refusalOffersAmendment,
  refusalSentence,
  sourceWords,
} from '../../../src/work/agreement-words';
import { AGREEMENT_SOURCE_TYPES } from '../../../src/work/agreement-vocabulary';

describe('what the cards say of a working agreement', (): void => {
  it('asks of repeated words "You have said this twice", in the wave file\'s words', (): void => {
    expect(
      proposalQuestion(
        {
          statement: 'Comment, never email.',
          correctionIds: ['a' as Id<'corrections'>, 'b' as Id<'corrections'>],
        },
        'Priya',
      ),
    ).toBe('You have said this twice: “Comment, never email.” Keep it as a working agreement?');
  });

  it('asks of a correction applied to a second item without saying it was said twice', (): void => {
    expect(
      proposalQuestion(
        { statement: 'Comment, never email.', correctionIds: ['a' as Id<'corrections'>] },
        'Priya',
      ),
    ).toBe(
      'Priya applied this correction on a second item: “Comment, never email.” Keep it as a working agreement?',
    );
  });

  it('quotes the clause a refusal names, and offers the amendment only where the charter settles it', (): void => {
    const contradicts = {
      reason: 'contradicts-will-not-do' as const,
      clause: 'email customers directly',
    };
    expect(refusalSentence(contradicts, 'Priya', 'work')).toBe(
      'This would go beyond the charter: it contradicts “email customers directly”. Amend the charter instead?',
    );
    expect(refusalSentence(contradicts, 'Priya', 'charter')).toBe(
      'This would go beyond the charter: it contradicts “email customers directly”. To allow it, amend the charter above.',
    );
    expect(refusalOffersAmendment(contradicts)).toBe(true);
    expect(refusalSentence({ reason: 'contradicts-will-not-do' }, 'Priya', 'work')).toContain(
      'what Priya will not do',
    );
    expect(refusalOffersAmendment({ reason: 'widens-scope' })).toBe(true);
    expect(refusalOffersAmendment({ reason: 'names-credential' })).toBe(false);
    expect(refusalOffersAmendment({ reason: 'grants-permission' })).toBe(false);
    expect(refusalSentence({ reason: 'names-credential' }, 'Priya', 'charter')).toBe(
      'This names a credential, which a working agreement never keeps. It was not kept.',
    );
  });

  it('tells a kept agreement waiting on its check from a proposal waiting on the manager', (): void => {
    expect(awaitingCheck({ status: 'proposed', approvedAt: 5 })).toBe(true);
    expect(awaitingManager({ status: 'proposed', approvedAt: 5 })).toBe(false);
    expect(awaitingManager({ status: 'proposed' })).toBe(true);
    expect(awaitingCheck({ status: 'active', approvedAt: 5 })).toBe(false);
    expect(checkingLine('Comment, never email.', 'charter')).toBe(
      'Kept. Day0 is checking “Comment, never email.” against the charter; it takes effect once the check passes.',
    );
    expect(checkingLine('Comment, never email.', 'work')).toBe(
      'Kept. Day0 is checking “Comment, never email.” against the charter; once it passes it is on the Charter tab.',
    );
  });

  it('closes a quoted sentence once, whether or not the words end one', (): void => {
    expect(
      proposalQuestion(
        {
          statement: 'Comment, never email',
          correctionIds: ['a' as Id<'corrections'>, 'b' as Id<'corrections'>],
        },
        'P',
      ),
    ).toBe('You have said this twice: “Comment, never email”. Keep it as a working agreement?');
  });

  it('names whom it binds, where it came from for every source, and what the tick does', (): void => {
    expect(bindingWords({}, 'Priya')).toBe('for every employee');
    expect(bindingWords({ agentId: 'a1' as Id<'agents'> }, 'Priya')).toBe('for Priya');
    for (const source of AGREEMENT_SOURCE_TYPES) expect(sourceWords(source)).not.toBe('');
    expect(keepNoteHint('Priya')).toBe(
      'Your answer above becomes a working agreement for Priya once Day0 checks it against the charter; it is then on the Charter tab, where you can edit or retire it.',
    );
  });
});
