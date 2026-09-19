import { describe, expect, it } from 'vitest';
import { blockedPlanReason } from '../../../convex/workActions';
import { heldItemOfBlockedStep, type HeldExternalItem } from '../../../src/work/claim-key';
import { stopDetail } from '../../../src/work/stop';
import type { AppliedAction } from '../../../src/surfaces/types';
import type { ExecutionPlan, PlanStepOutcome } from '../../../src/work/types';
import {
  FIN_1_ITEM,
  FINANCE_CLOSE_ASK,
  FINANCE_CLOSE_ASK_ACTIONS,
} from '../../fixtures/mateo-stopped-rows-2026-09-19';

const plan = FINANCE_CLOSE_ASK.plan as unknown as ExecutionPlan;
const outcomes = FINANCE_CLOSE_ASK.planStepOutcomes as PlanStepOutcome[];
const actions = FINANCE_CLOSE_ASK_ACTIONS;
// As `closingStopReason` counts the closing set before the gate: every action as if it landed.
const asIfLanded: Array<Partial<AppliedAction>> = actions.map(() => ({ ok: true }));

/** FIN-1 as the held-items block listed it to the ask's executor: its own item, claimed, with this employee. */
const fin1: HeldExternalItem = {
  externalId: 'FIN-1',
  externalAlias: '8fe4bfa1-3f35-4aa9-abf3-07cd5700c3b1',
  sourceSystem: 'linear',
  holderName: 'Mateo',
  sameEmployee: true,
  title: FIN_1_ITEM.title,
  state: 'plan-approved',
};

function outcome(step: number, evidence: string, status: PlanStepOutcome['status'] = 'blocked'): PlanStepOutcome {
  return { step, status, evidence };
}

describe('a step the executor left out for a held item (19 Sep third run, finding S)', (): void => {
  it("stops the run as the run's own row recorded it when the held items are not given", (): void => {
    expect(blockedPlanReason(outcomes, { plan, actions, applied: asIfLanded })).toBe(
      stopDetail(FINANCE_CLOSE_ASK.skipReason),
    );
  });

  it("reads the run's two blocked steps as FIN-1's, which its own work item holds", (): void => {
    expect(heldItemOfBlockedStep(outcomes[2]!, plan, [fin1])).toBe(fin1);
    expect(heldItemOfBlockedStep(outcomes[4]!, plan, [fin1])).toBe(fin1);
    expect(heldItemOfBlockedStep(outcomes[0]!, plan, [fin1])).toBeUndefined();
  });

  it('accounts for them as a claim-withheld row is: the run may complete and its reply is sent', (): void => {
    expect(blockedPlanReason(outcomes, { plan, actions, applied: asIfLanded, heldElsewhere: [fin1] })).toBeUndefined();
  });

  it('matches the item by its other name too, and never a longer id that begins the same', (): void => {
    const byAlias = outcome(3, 'The save_comment on 8FE4BFA1-3f35-4aa9-abf3-07cd5700c3b1 belongs to its own work item.');
    expect(heldItemOfBlockedStep(byAlias, plan, [fin1])).toBe(fin1);
    expect(heldItemOfBlockedStep(outcome(3, 'FIN-12 has its own work item.'), plan, [fin1])).toBeUndefined();
    expect(heldItemOfBlockedStep(outcome(3, 'REFIN-1 has its own work item.'), plan, [fin1])).toBeUndefined();
  });

  it('still stops the run for a step blocked for any other reason', (): void => {
    const other = outcomes.map((row) =>
      row.step === 3 ? outcome(3, 'Linear returned an error for save_comment, so the note was not posted.') : row,
    );
    expect(blockedPlanReason(other, { plan, actions, applied: asIfLanded, heldElsewhere: [fin1] })).toContain(
      '2 approved plan step(s) remained blocked: step 3 (Linear returned an error',
    );
  });

  it('still stops the run when nothing is held elsewhere, whatever the evidence says', (): void => {
    expect(blockedPlanReason(outcomes, { plan, actions, applied: asIfLanded, heldElsewhere: [] })).toContain('remained blocked');
    const elsewhere: HeldExternalItem = { ...fin1, externalId: 'FIN-4', externalAlias: undefined };
    expect(blockedPlanReason(outcomes, { plan, actions, applied: asIfLanded, heldElsewhere: [elsewhere] })).toContain('remained blocked');
  });

  it("never reads a step that is not a write to the item's surface as the held item's", (): void => {
    // Step 1 is the plan's read of Linear; step 4 writes Slack, not Linear.
    expect(heldItemOfBlockedStep(outcome(1, 'FIN-1 could not be read.'), plan, [fin1])).toBeUndefined();
    expect(heldItemOfBlockedStep(outcome(4, 'The reply about FIN-1 was not written.'), plan, [fin1])).toBeUndefined();
    const readBlocked = outcomes.map((row) => (row.step === 1 ? outcome(1, 'FIN-1 could not be read.') : row));
    expect(blockedPlanReason(readBlocked, { plan, actions, applied: asIfLanded, heldElsewhere: [fin1] })).toContain('step 1 (FIN-1 could not be read.)');
  });

  it('never lends a held item to a step whose own words name another ticket', (): void => {
    const steps = [...plan.steps];
    steps[2] = 'Post the note as one save_comment on FIN-9.';
    const named = { ...plan, steps } as ExecutionPlan;
    expect(heldItemOfBlockedStep(outcome(3, 'Withheld: FIN-1 has its own work item.'), named, [fin1])).toBeUndefined();
  });

  it('never reads a page field as a held ticket', (): void => {
    const field: HeldExternalItem = { ...fin1, externalId: 'FIN-1', externalAlias: undefined, pageField: true };
    expect(heldItemOfBlockedStep(outcomes[2]!, plan, [field])).toBeUndefined();
  });

  it('still fails a run whose emitted action did not land, held item or not', (): void => {
    const failed = asIfLanded.map((row, index) => (index === 1 ? { ok: false, reason: 'provider said no' } : row));
    expect(blockedPlanReason(outcomes, { plan, actions, applied: failed, heldElsewhere: [fin1] })).toContain('remained blocked');
  });

  it('still fails a run that emitted nothing', (): void => {
    expect(blockedPlanReason(outcomes, { plan, actions: [], applied: [], heldElsewhere: [fin1] })).toContain('remained blocked');
  });

  it('reads a plan with no declared obligations by the words alone', (): void => {
    const bare = { ...plan, obligations: undefined } as ExecutionPlan;
    expect(heldItemOfBlockedStep(outcomes[2]!, bare, [fin1])).toBe(fin1);
  });
});
