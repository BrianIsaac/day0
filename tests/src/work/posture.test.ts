import { describe, expect, it } from 'vitest';
import {
  agentPosture,
  decisionsFromEvents,
  DEFAULT_POSTURE,
  holdsEveryRow,
  isAgentPosture,
  nextSupervisedRuns,
  replaySupervisedRuns,
  SKILL_SUPERVISED_RUNS,
  skillTrust,
} from '../../../src/work/posture';

describe('the posture ladder', (): void => {
  it('reads an agent row with the deploy default for rows without a posture', (): void => {
    expect(DEFAULT_POSTURE).toBe('cold-start');
    expect(agentPosture({})).toBe('cold-start');
    expect(agentPosture({ posture: 'trusted' })).toBe('trusted');
    expect(agentPosture({ posture: 'bogus' })).toBe('cold-start');
    expect(isAgentPosture('supervised')).toBe(true);
    expect(isAgentPosture('open')).toBe(false);
  });

  it('counts a skill through its supervised window and labels the card', (): void => {
    expect(SKILL_SUPERVISED_RUNS).toBe(2);
    expect(skillTrust({})).toEqual({ trusted: false, completed: 0, window: 2, label: 'supervised · 0 of 2 approved runs' });
    expect(skillTrust({ supervisedRunsCompleted: 1 }).label).toBe('supervised · 1 of 2 approved runs');
    expect(skillTrust({ supervisedRunsCompleted: 2 })).toEqual({ trusted: true, completed: 2, window: 2, label: 'trusted' });
    expect(skillTrust({ supervisedRunsCompleted: 7 })).toMatchObject({ trusted: true, completed: 2 });
    expect(skillTrust({ supervisedRunsCompleted: -3 })).toMatchObject({ trusted: false, completed: 0 });
  });

  it('holds every row in cold start, per skill when supervised, never when trusted', (): void => {
    expect(holdsEveryRow('cold-start', { supervisedRunsCompleted: 9 })).toBe(true);
    expect(holdsEveryRow('supervised', { supervisedRunsCompleted: 1 })).toBe(true);
    expect(holdsEveryRow('supervised', { supervisedRunsCompleted: 2 })).toBe(false);
    expect(holdsEveryRow('supervised', undefined)).toBe(true);
    expect(holdsEveryRow('trusted', undefined)).toBe(false);
  });

  it('counts approvals with nothing rejected and resets on any rejection', (): void => {
    expect(nextSupervisedRuns(undefined, { kind: 'approved', rejectedAny: false })).toBe(1);
    expect(nextSupervisedRuns(1, { kind: 'approved', rejectedAny: false })).toBe(2);
    expect(nextSupervisedRuns(1, { kind: 'approved', rejectedAny: true })).toBe(0);
    expect(nextSupervisedRuns(2, { kind: 'rejected' })).toBe(0);
    expect(
      replaySupervisedRuns([
        { kind: 'approved', rejectedAny: false },
        { kind: 'rejected' },
        { kind: 'approved', rejectedAny: false },
        { kind: 'approved', rejectedAny: false },
        { kind: 'approved', rejectedAny: true },
        { kind: 'approved', rejectedAny: false },
      ]),
    ).toBe(1);
    expect(replaySupervisedRuns([])).toBe(0);
  });

  it('replays the rule over gate events of either generation', (): void => {
    const wi = 'kx7';
    const events = [
      // Old shape: the hold event's heldIndexes are the gate's refusals and the
      // approval's heldIndexes are every index not applied.
      { type: 'work.actions-pending', payload: { workItemId: wi, runId: 'r1', heldIndexes: [3] }, createdAt: 1 },
      { type: 'work.actions-approved', payload: { workItemId: wi, runId: 'r1', approvedIndexes: [0, 1, 2], heldIndexes: [3] }, createdAt: 2 },
      { type: 'work.actions-pending', payload: { workItemId: wi, runId: 'r2', heldIndexes: [] }, createdAt: 3 },
      { type: 'work.actions-approved', payload: { workItemId: wi, runId: 'r2', approvedIndexes: [0], heldIndexes: [1] }, createdAt: 4 },
      // New shape: the approval names the rows the manager left out.
      { type: 'work.actions-pending', payload: { workItemId: wi, runId: 'r3', refusedIndexes: [1], heldIndexes: [0] }, createdAt: 5 },
      { type: 'work.actions-approved', payload: { workItemId: wi, runId: 'r3', approvedIndexes: [0], rejectedIndexes: [] }, createdAt: 6 },
      { type: 'work.actions-rejected', payload: { workItemId: wi, reason: 'no' }, createdAt: 7 },
      { type: 'work.actions-approved', payload: { workItemId: wi, runId: 'r5', approvedIndexes: [], rejectedIndexes: [0] }, createdAt: 8 },
      { type: 'work.completed', payload: { workItemId: wi }, createdAt: 9 },
    ];
    expect(decisionsFromEvents([...events].reverse())).toEqual([
      { kind: 'approved', rejectedAny: false },
      { kind: 'approved', rejectedAny: true },
      { kind: 'approved', rejectedAny: false },
      { kind: 'rejected' },
      { kind: 'approved', rejectedAny: true },
    ]);
    expect(replaySupervisedRuns(decisionsFromEvents(events.slice(0, 2)))).toBe(1);
    expect(replaySupervisedRuns(decisionsFromEvents(events.slice(0, 6)))).toBe(1);
    expect(replaySupervisedRuns(decisionsFromEvents(events))).toBe(0);
  });
});
