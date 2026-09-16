import { describe, expect, it } from 'vitest';
import { planPromisesClose, promisesClose, promisesResult, withholdsClose } from '../../../src/work/plan-steps';
import {
  auditNotePlan,
  refreshPlan,
  REVOPS_5_STEP_2,
  REVOPS_5_STEP_5,
  REVOPS_7_STEP_3,
} from '../../convex/fixtures/closing-gates-2026-09-16';

describe('what a plan step promises, read from the 16 September plans', (): void => {
  it('does not read a write that quotes something "as evidence" as a promised result', (): void => {
    expect(promisesResult(REVOPS_7_STEP_3)).toBe(false);
    expect(promisesResult(auditNotePlan.steps[3]!)).toBe(false);
    expect(refreshPlan.steps.map(promisesResult)).toEqual([false, true, false, false]);
  });

  it('reads a result a capture verb gathers as a promise, even when the same clause writes', (): void => {
    for (const wording of [
      'Gather evidence from the Looker pipeline tile and post it to Linear.',
      'Collect evidence for the three checks and post the audit comment in one go.',
    ]) {
      expect(promisesResult(wording), wording).toBe(true);
    }
    expect(promisesResult('Record the result of the read-back on REVOPS-7.')).toBe(false);
    expect(promisesResult('Obtain the audit line as evidence and send it to the manager.')).toBe(false);
    expect(promisesResult('Post one save_comment on REVOPS-5 with the three checks in checklist order, quoting evidence.')).toBe(false);
  });

  it('still reads a captured result noun outside a write as a promise', (): void => {
    expect(promisesResult('Capture the Looker pipeline tile read-back evidence')).toBe(true);
    expect(promisesResult('Capture evidence of the figure from the Looker pipeline tile.')).toBe(true);
    expect(promisesResult('Check the three deals with Linear reads')).toBe(true);
  });

  it('does not read a period-named close such as "Q3 close project" as a promise to close', (): void => {
    expect(promisesClose(REVOPS_5_STEP_2)).toBe(false);
    for (const wording of [
      'Read the FY26 close checklist page before the note.',
      'Summarise the month-end close status for the manager.',
      'Read the 2026 close calendar in Notion.',
      'List the tickets in the Q3 close project.',
    ]) {
      expect(promisesClose(wording), wording).toBe(false);
    }
    expect(auditNotePlan.steps.map(promisesClose)).toEqual([false, false, false, false, false]);
  });

  it('reads an imperative close before a noun head as the instruction it is', (): void => {
    for (const wording of [
      'Complete task REVOPS-7.',
      'Close items REVOPS-5 and REVOPS-7 in Linear.',
      'Resolve work item REVOPS-7 once the comment lands.',
      'Then close project REVOPS in Linear.',
    ]) {
      expect(promisesClose(wording), wording).toBe(true);
    }
    expect(withholdsClose('Do not close tasks in this run.')).toBe(true);
    expect(withholdsClose('Never complete items without the audit comment.')).toBe(true);
    for (const wording of ['Review close tasks for the quarter.', 'Read the close status page.', 'Summarise the completed close checks.']) {
      expect(promisesClose(wording), wording).toBe(false);
    }
  });

  it('still reads an instruction to close as a promise', (): void => {
    expect(promisesClose('Close the ticket once the comment lands.')).toBe(true);
    expect(promisesClose('Move REVOPS-7 to Done via linear save_issue once the audit comment is saved.')).toBe(true);
    expect(promisesClose('Close REVOPS-5 in the Q3 close project.')).toBe(true);
    expect(promisesClose(REVOPS_5_STEP_5)).toBe(false);
  });
});

describe('a plan that withholds the transition in its own words', (): void => {
  it('reads a negated close and a "no status change" summary as withholding', (): void => {
    expect(withholdsClose(REVOPS_5_STEP_5)).toBe(true);
    expect(withholdsClose(auditNotePlan.summary)).toBe(true);
    expect(withholdsClose('Hold the Done transition for the manager.')).toBe(true);
    expect(withholdsClose('Leave REVOPS-5 open for the manager to close.')).toBe(true);
    expect(withholdsClose('Move REVOPS-7 to Done once the audit comment is saved.')).toBe(false);
    expect(withholdsClose(REVOPS_5_STEP_2)).toBe(false);
  });

  it('never promised the close, even when another step reads as completing something', (): void => {
    expect(planPromisesClose(refreshPlan)).toBe(true);
    expect(planPromisesClose(auditNotePlan)).toBe(false);
    expect(
      planPromisesClose({
        summary: 'Run the checks and record the note.',
        steps: [
          'Complete the three checks in checklist order and quote the evidence.',
          'Add an audit comment on REVOPS-5 via linear save_comment with the three checks.',
          REVOPS_5_STEP_5,
        ],
      }),
    ).toBe(false);
    expect(
      planPromisesClose({
        summary: 'Run the checks, record the note and close the ticket.',
        steps: ['Complete the three checks in checklist order.', 'Comment on REVOPS-5, then move it to Done.'],
      }),
    ).toBe(true);
  });
});
