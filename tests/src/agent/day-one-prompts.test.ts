import { describe, expect, it } from 'vitest';
import {
  DAY_ONE_TOPIC_SPECS,
  day1Script,
  defaultSoul,
  questionBody,
} from '../../../src/agent/day-one-prompts';

describe('day1Script', (): void => {
  it('promises only what onboarding does after the 1:1, with no good-habits research (N19)', (): void => {
    const script = day1Script();
    expect(script).toContain(
      'After the conversation I synthesise a charter v0.0 with provenance tagging, write IDENTITY.md and TOOLS.md, and surface the work queue.',
    );
    expect(script).not.toMatch(/research/i);
  });
});

describe('the Day-1 questions', (): void => {
  it('carry no em dash, since a turn with no question is handed one as it stands (standard 13.3)', (): void => {
    for (const { question } of DAY_ONE_TOPIC_SPECS) expect(question).not.toContain('\u2014');
    expect(DAY_ONE_TOPIC_SPECS[0].question.split('\n')[0]).toBe('1/7: Why this hire?');
  });

  it("leave the workspace's starting files without an em dash too", (): void => {
    expect(defaultSoul()).not.toContain('\u2014');
    expect(day1Script()).not.toContain('\u2014');
  });
});

describe('questionBody', (): void => {
  it('keeps the words a question asks and leaves out its numbered headline', (): void => {
    for (const { question } of DAY_ONE_TOPIC_SPECS) {
      expect(questionBody(question)).not.toMatch(/\d\/7/);
      expect(question.endsWith(questionBody(question))).toBe(true);
    }
    expect(questionBody('One line only')).toBe('One line only');
  });
});
