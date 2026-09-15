import { describe, expect, it } from 'vitest';
import {
  DAY_ONE_ANSWERS,
  FOLLOW_UP_ANSWER,
  MAX_FOLLOW_UPS,
  nextAnswer,
  OWNERSHIP_CLAIM,
} from '../../../scripts/rehearsal/answers';

describe("the Day-1 answers, in the tickets' own words", (): void => {
  it('answers the seven topics once each and then only the follow-up line', (): void => {
    expect(DAY_ONE_ANSWERS).toHaveLength(7);
    for (let turn = 0; turn < 7; turn += 1) expect(nextAnswer(turn)).toBe(DAY_ONE_ANSWERS[turn]);
    expect(nextAnswer(7)).toBe(FOLLOW_UP_ANSWER);
    expect(nextAnswer(7 + MAX_FOLLOW_UPS - 1)).toBe(FOLLOW_UP_ANSWER);
    expect(nextAnswer(7 + MAX_FOLLOW_UPS)).toBeUndefined();
  });

  it("uses the tickets' words the runbook card prescribes", (): void => {
    const text = DAY_ONE_ANSWERS.join(' ');
    for (const words of ['Q3 close', 'audit', 'tickets in Linear', 'Looker pipeline tile', '#revops-asks']) {
      expect(text).toContain(words);
    }
  });

  it('never claims the tickets have an owner or are assigned', (): void => {
    for (const answer of DAY_ONE_ANSWERS) expect(answer).not.toMatch(OWNERSHIP_CLAIM);
    expect('the tickets have an owner').toMatch(OWNERSHIP_CLAIM);
    expect('every ticket is assigned').toMatch(OWNERSHIP_CLAIM);
  });

  it('keeps the cold-start rule: only the manager DM, nothing public', (): void => {
    expect(DAY_ONE_ANSWERS.join(' ')).toMatch(/only DM me/i);
  });
});
