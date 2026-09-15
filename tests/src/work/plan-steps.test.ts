import { describe, expect, it } from 'vitest';
import { promisesClose, promisesResult } from '../../../src/work/plan-steps';
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

  it('still reads an instruction to close as a promise', (): void => {
    expect(promisesClose('Close the ticket once the comment lands.')).toBe(true);
    expect(promisesClose('Move REVOPS-7 to Done via linear save_issue once the audit comment is saved.')).toBe(true);
    expect(promisesClose('Close REVOPS-5 in the Q3 close project.')).toBe(true);
    expect(promisesClose(REVOPS_5_STEP_5)).toBe(false);
  });
});
