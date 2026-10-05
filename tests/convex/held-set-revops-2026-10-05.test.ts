import { describe, expect, it } from 'vitest';
import { closingStopReason, dependentTransitionRefusal } from '../../convex/workActions';
import type { AppliedAction } from '../../src/surfaces/types';
import type { PlanStepOutcome } from '../../src/work/types';
import {
  LINEAR,
  PHASE_ONE_READ,
  REVOPS_2_PLAN,
  REVOPS_3_CLOSING,
  REVOPS_3_CLOSING_WITH_DONE,
  RUN_1_CLOSING,
  RUN_2_CLOSING,
  RUN_2_STOP_PREFIX,
  RUN_3_CLOSING,
  SLACK,
} from '../fixtures/work/revops-2-held-set-2026-10-05';

/*
 * W12V-11's fix tells a supervised closing set how its held writes land; it does not weaken 12-D's
 * rule. The walk's recorded sets through the two checks that stopped REVOPS-2: a set that answers
 * partial while it closes is still refused, a set that holds its promised Done back with a blocked
 * step still stops, the walk's REVOPS-3 still never closes, and the set that answers done for the
 * three writes it emits (run 3) reaches the manager.
 */

const READ_LANDED: AppliedAction = {
  tool: 'mcp.call',
  ok: true,
  effect: 'list_issues on linear',
  idempotencyKey: 'k-read',
};

/** A closing set as the model answered it: its outcomes carry `charterClause: null`. */
interface RecordedSet {
  readonly actions: typeof RUN_2_CLOSING.actions;
  readonly planStepOutcomes: ReadonlyArray<{
    readonly step: number;
    readonly status: PlanStepOutcome['status'];
    readonly evidence: string;
  }>;
  readonly draft: string;
  readonly workDone?: 'done' | 'partial' | 'not-done';
  readonly workDoneWhy?: string;
}

/** The outcomes as the run records them, which the checks read. */
function outcomesOf(set: RecordedSet): PlanStepOutcome[] {
  return set.planStepOutcomes.map(({ step, status, evidence }) => ({ step, status, evidence }));
}

function refusal(set: RecordedSet): string | undefined {
  return dependentTransitionRefusal({
    plan: REVOPS_2_PLAN,
    actions: set.actions,
    planStepOutcomes: outcomesOf(set),
    draft: set.draft,
    ...(set.workDone === undefined
      ? {}
      : { workDone: { workDone: set.workDone, workDoneWhy: set.workDoneWhy ?? '' } }),
  });
}

function stop(set: RecordedSet): string | undefined {
  return closingStopReason({
    plan: REVOPS_2_PLAN,
    outcomes: outcomesOf(set),
    initialActions: [PHASE_ONE_READ],
    initialApplied: [READ_LANDED],
    closingActions: set.actions,
    surfaces: [LINEAR, SLACK],
    asksManager: false,
  });
}

describe('12-D’s rule after W12V-11 (the walk’s REVOPS-2 and REVOPS-3)', (): void => {
  it('still refuses REVOPS-2 run 2’s set: it closes the ticket while answering partial', (): void => {
    expect(refusal(RUN_2_CLOSING)).toMatch(new RegExp(`^${RUN_2_STOP_PREFIX}`));
  });

  it('still stops REVOPS-2 run 1’s set: its promised Done held back with a blocked step', (): void => {
    expect(stop(RUN_1_CLOSING)).toMatch(/^1 approved plan step\(s\) remained blocked: step 4 \(/);
  });

  it('lets REVOPS-2 run 3’s set through: done, for the three writes it emits', (): void => {
    expect(refusal(RUN_3_CLOSING)).toBeUndefined();
    expect(stop(RUN_3_CLOSING)).toBeUndefined();
  });

  it('leaves the walk’s REVOPS-3 open: partial with no close passes, partial with a close is refused', (): void => {
    expect(refusal(REVOPS_3_CLOSING)).toBeUndefined();
    expect(refusal(REVOPS_3_CLOSING_WITH_DONE)).toMatch(
      /^dependent phase sets the ticket to Done while workDone is "partial"/,
    );
  });
});
