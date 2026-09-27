import { describe, expect, it } from 'vitest';
import {
  JUDGED_TEXT_CHARS,
  judgeManagerQuestion,
  questionJudgementPrompt,
  type QuestionJudgement,
  type QuestionJudgementCall,
} from '../../../src/work/question-judgement';
import { QUESTION_CHARS } from '../../../src/work/obligations';

/** A model double that answers every message the same way and keeps what it was asked. */
function answering(answer: QuestionJudgement): QuestionJudgementCall & { asked: string[] } {
  const asked: string[] = [];
  const call = async (user: string): Promise<QuestionJudgement> => {
    asked.push(user);
    return answer;
  };
  return Object.assign(call, { asked });
}

describe('judgeManagerQuestion', (): void => {
  it('returns the sentence that asks, as the model copied it', async (): Promise<void> => {
    const call = answering({
      asks: true,
      question: 'Please confirm which template the notice should use.',
    });

    expect(
      await judgeManagerQuestion(
        'The audit comment is drafted. Please confirm which template the notice should use.',
        call,
      ),
    ).toBe('Please confirm which template the notice should use.');
    expect(call.asked[0]).toContain('Please confirm which template the notice should use.');
  });

  it('returns null for a message the model reads as asking nothing', async (): Promise<void> => {
    const call = answering({ asks: false, question: null });

    expect(
      await judgeManagerQuestion('Closed REVOPS-7 and posted the audit note.', call),
    ).toBeNull();
  });

  it('keeps the whole message as the question when the model says it asks but quotes nothing', async (): Promise<void> => {
    const call = answering({ asks: true, question: ' ' });

    expect(await judgeManagerQuestion('请确认通知使用哪个模板。', call)).toBe(
      '请确认通知使用哪个模板。',
    );
  });

  it('reads a message as asking when the judgement cannot be had, so the writes stay held', async (): Promise<void> => {
    const failing: QuestionJudgementCall = async () => {
      throw new Error('model unavailable');
    };

    expect(await judgeManagerQuestion('Which template should the notice use', failing)).toBe(
      'Which template should the notice use',
    );
  });

  it('asks the model nothing about an empty message', async (): Promise<void> => {
    const call = answering({ asks: true, question: 'unused' });

    expect(await judgeManagerQuestion('   ', call)).toBeNull();
    expect(call.asked).toEqual([]);
  });

  it('bounds what the model reads and the question the card shows', async (): Promise<void> => {
    const long = 'Please confirm the template. '.repeat(200);
    const call = answering({ asks: true, question: long });

    const question = await judgeManagerQuestion(long, call);

    expect(question!.length).toBeLessThanOrEqual(QUESTION_CHARS);
    expect(question?.endsWith('…')).toBe(true);
    expect(call.asked[0]!.length).toBeLessThan(JUDGED_TEXT_CHARS + 100);
    expect(questionJudgementPrompt(long)).toContain('--- Message ---');
  });
});
