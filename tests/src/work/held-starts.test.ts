import { describe, expect, it } from 'vitest';
import { heldStartLine, pausedCheckRefusal } from '../../../src/work/held-starts';

describe('the words of a start a pause holds (D-8, wave 13 item 6)', (): void => {
  it('says whose pause holds a skill being written, and when it starts', (): void => {
    expect(heldStartLine({ by: 'employee', employeeName: 'Priya' }, 'authoring')).toBe(
      'held while Priya is paused: writing it starts when you resume Priya',
    );
  });

  it('says the deployment holds an orientation, and when it starts', (): void => {
    expect(heldStartLine({ by: 'deployment' }, 'orientation')).toBe(
      "Orientation held while this deployment's scheduled work is paused: it starts once that work runs again.",
    );
  });

  it('names the employee on an orientation its own pause holds', (): void => {
    expect(heldStartLine({ by: 'employee', employeeName: 'Priya' }, 'orientation')).toBe(
      'Orientation held while Priya is paused: it starts when you resume Priya.',
    );
  });

  it('refuses a check for new work on a paused employee in words that say how to go on', (): void => {
    expect(pausedCheckRefusal('Priya')).toBe(
      'Priya is paused: nothing is checked until you resume Priya on Manage.',
    );
  });
});
