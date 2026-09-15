import { describe, expect, it } from 'vitest';
import {
  contentWords,
  managerOpenQuestions,
  questionKey,
  sharedContentWords,
  synthesisNotes,
} from '../../../src/agent/manager-questions';
import {
  OPEN_QUESTIONS_2026_09_16,
  RECORDED_QUESTIONS_2026_09_16,
  SYNTHESIS_SELF_CHECK_NOTE_2026_09_16,
} from '../../fixtures/charter-synthesis-notes-2026-09-16';

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

describe('what the manager is asked', (): void => {
  it("separates the synthesiser's notes from what the 1:1 left open, on a charter that recorded both as questions", (): void => {
    expect(managerOpenQuestions({ openQuestions: RECORDED_QUESTIONS_2026_09_16 })).toEqual(
      OPEN_QUESTIONS_2026_09_16,
    );
    expect(synthesisNotes({ openQuestions: RECORDED_QUESTIONS_2026_09_16 })).toEqual([
      SYNTHESIS_SELF_CHECK_NOTE_2026_09_16,
    ]);
  });

  it('reads the notes field first and keeps a legacy row after it, once', (): void => {
    const later = 'Evidence check: 2 clauses in this draft quoted my own words back as if they were yours, so I dropped them. Which of this is actually what you told me?';
    expect(
      synthesisNotes({ openQuestions: RECORDED_QUESTIONS_2026_09_16, synthesisNotes: [later] }),
    ).toEqual([later, SYNTHESIS_SELF_CHECK_NOTE_2026_09_16]);
    expect(
      synthesisNotes({
        openQuestions: OPEN_QUESTIONS_2026_09_16,
        synthesisNotes: [SYNTHESIS_SELF_CHECK_NOTE_2026_09_16],
      }),
    ).toEqual([SYNTHESIS_SELF_CHECK_NOTE_2026_09_16]);
    expect(managerOpenQuestions({ openQuestions: OPEN_QUESTIONS_2026_09_16 })).toEqual(
      OPEN_QUESTIONS_2026_09_16,
    );
  });
});
