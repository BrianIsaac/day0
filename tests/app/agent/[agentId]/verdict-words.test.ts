import { describe, expect, it } from 'vitest';
import { judgedAs, REEVALUATION } from '../../../../app/agent/[agentId]/verdict-words';

describe('what the evaluator judged, in the manager’s words (walk m15)', (): void => {
  it('says each verdict the evaluator gives in words of the job, never the verdict’s own name', (): void => {
    expect(judgedAs('claim')).toBe('part of the job');
    expect(judgedAs('skip')).toBe('not part of the job');
    expect(judgedAs('needs-skill')).toBe('part of the job, needs a skill first');
    for (const decision of ['claim', 'queue', 'skip', 'defer', 'needs-skill']) {
      expect(judgedAs(decision)).not.toMatch(/claim|needs-skill|defer|skip/);
    }
  });

  it('says nothing for a decision no release makes any more, nor for a re-evaluation', (): void => {
    expect(judgedAs('escalate')).toBeUndefined();
    expect(judgedAs(REEVALUATION)).toBeUndefined();
    // An inherited property name is not a verdict.
    expect(judgedAs('toString')).toBeUndefined();
  });
});
