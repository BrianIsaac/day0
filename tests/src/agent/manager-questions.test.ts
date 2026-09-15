import { describe, expect, it } from 'vitest';
import {
  contentWords,
  questionKey,
  sharedContentWords,
} from '../../../src/agent/manager-questions';

describe('question keys', (): void => {
  it('is the text without case, punctuation or spacing differences', (): void => {
    expect(questionKey('Whether Northstar CRM access will be granted.')).toBe(
      'whether northstar crm access will be granted',
    );
    expect(questionKey('  whether  Northstar   CRM access will be granted?')).toBe(
      questionKey('Whether Northstar CRM access will be granted.'),
    );
    expect(questionKey('...')).toBe('');
  });
});

describe('content words', (): void => {
  it('keeps the words that name things and drops the words every question carries', (): void => {
    expect(contentWords('Whether Northstar CRM access will be granted.')).toEqual(['northstar']);
    expect(contentWords('Who owns the Looker pipeline tile.')).toEqual(['looker', 'pipeline', 'tile']);
  });

  it('says which words a plan or candidate shares with a question', (): void => {
    expect(
      sharedContentWords(
        'Who owns the Looker pipeline tile.',
        'Refresh the Looker pipeline tile from REVOPS-7 and comment on the ticket.',
      ),
    ).toEqual(['looker', 'pipeline', 'tile']);
    expect(
      sharedContentWords('Whether Northstar CRM access will be granted.', 'Read the ticket, draft a reply.'),
    ).toEqual([]);
  });
});
