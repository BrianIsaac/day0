import { describe, expect, it } from 'vitest';
import { answeredQuestionLines } from '../../../src/work/charter-answers';

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
