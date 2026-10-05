import { describe, expect, it } from 'vitest';
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
      proposalQuestion({ statement: 'Comment, never email.', correctionIds: ['a', 'b'] }, 'Priya'),
    ).toBe('You have said this twice: “Comment, never email.” Keep it as a working agreement?');
  });

  it('asks of a correction applied to a second item without saying it was said twice', (): void => {
    expect(
      proposalQuestion({ statement: 'Comment, never email.', correctionIds: ['a'] }, 'Priya'),
    ).toBe(
      'Priya applied this correction on a second item: “Comment, never email.” Keep it as a working agreement?',
    );
  });

  it('quotes the clause a refusal names, and offers the amendment only where the charter settles it', (): void => {
    const contradicts = {
      reason: 'contradicts-will-not-do' as const,
      clause: 'email customers directly',
    };
    expect(refusalSentence(contradicts, 'Priya')).toBe(
      'This would go beyond the charter: it contradicts “email customers directly”. Amend the charter instead?',
    );
    expect(refusalOffersAmendment(contradicts)).toBe(true);
    expect(refusalSentence({ reason: 'contradicts-will-not-do' }, 'Priya')).toContain(
      'what Priya will not do',
    );
    expect(refusalOffersAmendment({ reason: 'widens-scope' })).toBe(true);
    expect(refusalOffersAmendment({ reason: 'names-credential' })).toBe(false);
    expect(refusalOffersAmendment({ reason: 'grants-permission' })).toBe(false);
    expect(refusalSentence({ reason: 'names-credential' }, 'Priya')).toBe(
      'This names a credential, which a working agreement never keeps. It was not kept.',
    );
  });

  it('tells a kept agreement waiting on its check from a proposal waiting on the manager', (): void => {
    expect(awaitingCheck({ status: 'proposed', approvedAt: 5 })).toBe(true);
    expect(awaitingManager({ status: 'proposed', approvedAt: 5 })).toBe(false);
    expect(awaitingManager({ status: 'proposed' })).toBe(true);
    expect(awaitingCheck({ status: 'active', approvedAt: 5 })).toBe(false);
    expect(checkingLine('Comment, never email.')).toBe(
      'Kept. Day0 is checking “Comment, never email.” against the charter; it takes effect once the check answers.',
    );
  });

  it('closes a quoted sentence once, whether or not the words end one', (): void => {
    expect(
      proposalQuestion({ statement: 'Comment, never email', correctionIds: ['a', 'b'] }, 'P'),
    ).toBe('You have said this twice: “Comment, never email”. Keep it as a working agreement?');
  });

  it('names whom it binds, where it came from for every source, and what the tick does', (): void => {
    expect(bindingWords({}, 'Priya')).toBe('for every employee');
    expect(bindingWords({ agentId: 'a1' }, 'Priya')).toBe('for Priya');
    for (const source of AGREEMENT_SOURCE_TYPES) expect(sourceWords(source)).not.toBe('');
    expect(keepNoteHint('Priya')).toContain('working agreement for Priya on the Charter tab');
  });
});
