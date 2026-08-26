import { describe, expect, it } from 'vitest';
import { actionModeInstruction, planSystemPrompt } from '../../../src/work/plan';

describe('plan drafter action mode', (): void => {
  it('states the autonomous mode without supervised approval language', (): void => {
    const prompt = planSystemPrompt(true);
    expect(prompt).toContain(
      'Autonomous actions are ON: every allowed write lands as emitted; do not say an action is queued or awaiting approval.',
    );
    expect(prompt).not.toContain('the boss will approve before you act');
    expect(prompt).not.toContain('Prefer drafts over actions');
  });

  it('states exactly what lands and what waits while autonomous actions are off', (): void => {
    expect(planSystemPrompt(false)).toContain(
      "Autonomous actions are OFF: reads and the manager DM land now; every other write is held for the manager's literal approval - say so.",
    );
    expect(actionModeInstruction(false)).not.toContain('once the skill is trusted');
  });
});
