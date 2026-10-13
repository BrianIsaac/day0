import { describe, expect, it } from 'vitest';
import { answeredQuestionLines, askedQuestion } from '../../../src/work/charter-answers';

describe('askedQuestion', (): void => {
  it('reads the mark before a closing bracket or quote, and keeps an ellipsis (the second pass)', (): void => {
    expect(askedQuestion('Which carrier (for Asia)')).toBe('Which carrier (for Asia)?');
    expect(askedQuestion('Is it “final?”')).toBe('Is it “final?”');
    expect(askedQuestion('And the rest…')).toBe('And the rest…');
  });
});

describe('a question left on another script’s mark, or on a comma (W16-R31)', (): void => {
  it('takes the Arabic question mark as the question’s close, and adds no second mark', (): void => {
    expect(askedQuestion('من يملك لوحة المبيعات؟')).toBe('من يملك لوحة المبيعات؟');
    expect(askedQuestion('من يملك «لوحة المبيعات؟»')).toBe('من يملك «لوحة المبيعات؟»');
  });

  it('closes a question left on a comma, a semicolon or a dash in place of it, never after it', (): void => {
    expect(askedQuestion('Which carrier handles Asia,')).toBe('Which carrier handles Asia?');
    expect(askedQuestion('Which carrier handles Asia ;')).toBe('Which carrier handles Asia?');
    expect(askedQuestion('Which carrier handles Asia -')).toBe('Which carrier handles Asia?');
    expect(askedQuestion('亚洲由哪家承运商负责，')).toBe('亚洲由哪家承运商负责?');
    expect(askedQuestion('Which carrier handles “Asia”,')).toBe('Which carrier handles “Asia”?');
  });

  it('leaves a question that is only such marks as it was written', (): void => {
    expect(askedQuestion(',')).toBe(',');
    expect(askedQuestion('  ')).toBe('');
  });

  it('prints the answer after the one mark in a prompt’s line', (): void => {
    expect(
      answeredQuestionLines({
        answeredQuestions: [
          {
            question: 'Which carrier handles Asia,',
            answer: 'DHL',
            answeredAt: '2026-10-10T00:00:00.000Z',
          },
        ],
      }),
    ).toEqual([
      'Questions the manager answered in the charter (they hold for this work):',
      '  - Which carrier handles Asia? DHL',
    ]);
  });
});

describe('answeredQuestionLines', (): void => {
  it('closes a question the manager left unpunctuated before its answer (W15-R39)', (): void => {
    expect(
      answeredQuestionLines({
        answeredQuestions: [
          {
            question: 'Which carrier handles Asia',
            answer: 'DHL',
            answeredAt: '2026-10-10T00:00:00.000Z',
          },
        ],
      }),
    ).toEqual([
      'Questions the manager answered in the charter (they hold for this work):',
      '  - Which carrier handles Asia? DHL',
    ]);
  });

  it('renders every answered question with its answer under one heading', (): void => {
    expect(
      answeredQuestionLines({
        answeredQuestions: [
          {
            question: 'Who owns the Looker tile?',
            answer: 'Priya.',
            answeredAt: '2026-09-20T00:00:00.000Z',
          },
          { question: '谁负责周报？', answer: 'Aiko。', answeredAt: '2026-09-21T00:00:00.000Z' },
        ],
      }),
    ).toEqual([
      'Questions the manager answered in the charter (they hold for this work):',
      '  - Who owns the Looker tile? Priya.',
      '  - 谁负责周报？ Aiko。',
    ]);
  });

  it('renders nothing before the first answer', (): void => {
    expect(answeredQuestionLines({})).toEqual([]);
    expect(answeredQuestionLines({ answeredQuestions: [] })).toEqual([]);
  });
});
