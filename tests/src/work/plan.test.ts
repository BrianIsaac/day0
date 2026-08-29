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
    // OFF must not claim that writes apply; ON must not say anything waits.
    expect(actionModeInstruction(false)).toContain('every other write is held');
    expect(actionModeInstruction(false)).not.toMatch(/lands as emitted/);
    expect(actionModeInstruction(true)).not.toMatch(/is held|waits for/);
    expect(planSystemPrompt(false).split(actionModeInstruction(false))).toHaveLength(2);
  });

  it('states that every mock comparison action waits at the exact-action gate', (): void => {
    const instruction = actionModeInstruction(true, 'mock');
    expect(instruction).toContain('Mock comparison mode');
    expect(instruction).toContain('every emitted action is held');
    expect(instruction).not.toContain('lands as emitted');
    expect(planSystemPrompt(false, 'mock')).toContain(instruction);
  });
});
