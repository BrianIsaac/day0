import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_LABEL,
  AUTONOMY_CHANGE_REASON,
  AUTONOMY_WARNING,
  autonomousActionsOn,
  autonomyLabel,
  HELD_BEFORE_AUTONOMY_NOTE,
  HELD_WHILE_SUPERVISED_NOTE,
  SUPERVISED_LABEL,
} from '../../../src/work/autonomy';

describe('the autonomous-actions switch', (): void => {
  it('reads an absent or false field as off and only an exact true as on', (): void => {
    expect(autonomousActionsOn({})).toBe(false);
    expect(autonomousActionsOn({ autonomousActions: undefined })).toBe(false);
    expect(autonomousActionsOn({ autonomousActions: false })).toBe(false);
    expect(autonomousActionsOn({ autonomousActions: true })).toBe(true);
    // A row the posture ladder wrote carries fields the switch ignores.
    expect(autonomousActionsOn({ posture: 'trusted' } as { autonomousActions?: boolean })).toBe(false);
  });

  it('names the two states and the reason a change records', (): void => {
    expect(autonomyLabel(false)).toBe(SUPERVISED_LABEL);
    expect(autonomyLabel(true)).toBe(AUTONOMOUS_LABEL);
    expect(SUPERVISED_LABEL).toBe('Supervised');
    expect(AUTONOMOUS_LABEL).toBe('Autonomous');
    expect(AUTONOMY_CHANGE_REASON).toBe('set by the manager');
  });

  it('warns in the operator\'s sense before the switch goes on', (): void => {
    expect(AUTONOMY_WARNING).toBe(
      'The agent will act on connected systems without asking - post, comment, change status - within the connections and skills you have approved. Turn this on only after its behaviour has been what you want. Skills and connections still need your approval either way.',
    );
    expect(HELD_WHILE_SUPERVISED_NOTE).toBe('held for your approval - autonomous actions are off');
    expect(HELD_BEFORE_AUTONOMY_NOTE).toContain('held before autonomous actions were turned on');
  });
});
