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
  autonomyTurnedOnAfterDraft,
  autonomyTurnedOnAfterDraftNote,
} from '../../../src/work/autonomy';
import rehearsal from '../../fixtures/work/demo-rehearsal-2-2026-09-19.json';

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

describe('a switch turned on after the plan was drafted', (): void => {
  const priya = rehearsal.workItems.priyaCompleted;
  const flips = rehearsal.autonomyChanges
    .filter((event) => event.agentId === priya.agentId)
    .map((event) => ({ at: event.createdAt, on: event.payload.to }));

  it('finds the rehearsal\'s flip: drafted 03:26:19 UTC, turned on 03:27:38, applied autonomously', (): void => {
    expect(flips).toHaveLength(1);
    expect(autonomyTurnedOnAfterDraft(priya.planPendingAt, true, flips)).toBe(flips[0]!.at);
  });

  it('says nothing without a plan, without an autonomous row, or for a flip before the draft', (): void => {
    expect(autonomyTurnedOnAfterDraft(undefined, true, flips)).toBeUndefined();
    expect(autonomyTurnedOnAfterDraft(priya.planPendingAt, false, flips)).toBeUndefined();
    expect(autonomyTurnedOnAfterDraft(flips[0]!.at, true, flips)).toBeUndefined();
  });

  it('says nothing when the plan was drafted with the switch already on', (): void => {
    const draftedAt = 1_000;
    expect(
      autonomyTurnedOnAfterDraft(draftedAt, true, [
        { at: 3_000, on: true },
        { at: 2_000, on: false },
      ]),
    ).toBeUndefined();
  });

  it('names the first turn-on after the draft, whatever order the flips arrive in', (): void => {
    expect(
      autonomyTurnedOnAfterDraft(1_000, true, [
        { at: 4_000, on: true },
        { at: 3_000, on: false },
        { at: 2_000, on: true },
        { at: 500, on: false },
      ]),
    ).toBe(2_000);
  });

  it('reads as the middle of a sequence', (): void => {
    expect(autonomyTurnedOnAfterDraftNote('11:27', 7, 7)).toBe(
      'Autonomous actions were turned on at 11:27, after this plan was drafted; its actions were applied under it.',
    );
    // Mateo's run: the move to Done was held for the manager, so three of four.
    expect(autonomyTurnedOnAfterDraftNote('11:27', 3, 4)).toBe(
      'Autonomous actions were turned on at 11:27, after this plan was drafted; 3 of its 4 actions were applied under it.',
    );
  });
});
