import { describe, expect, it } from 'vitest';
import { noteDirectsState, transitionDirectedByNote } from '../../../src/work/transition-direction';
import type { ExecutionPlan, MockAction, PlanStepOutcome } from '../../../src/work/types';
import { run3AuditNotePlan, RUN_3_RETRY_OUTCOMES, RUN_3_RETRY_NOTE } from '../../convex/fixtures/retry-reentry-2026-09-16';

/**
 * A retry note that directs the ticket state change in so many words lifts
 * the hold a manager-conditioned or withheld transition puts on it; a note
 * that says anything else leaves the hold in place.
 */

const done: MockAction = { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_issue', toolArgsJson: JSON.stringify({ id: 'REVOPS-5', state: 'Done' }) } };
const comment: MockAction = { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_comment', toolArgsJson: JSON.stringify({ issueId: 'REVOPS-5', body: 'Audit note.' }) } };
const retryNote = (reason: string) => ({ reason, at: 1, kind: 'retry-note' as const });
const outcomes: PlanStepOutcome[] = RUN_3_RETRY_OUTCOMES;
const base = { plan: run3AuditNotePlan, planStepOutcomes: outcomes, feedback: retryNote(RUN_3_RETRY_NOTE), actions: [comment, done] };

describe('a note naming the state', (): void => {
  it('counts a sentence that names the state and neither negates nor defers it', (): void => {
    expect(noteDirectsState(RUN_3_RETRY_NOTE, 'Done')).toBe(true);
    expect(noteDirectsState('Move it to done.', 'Done')).toBe(true);
    expect(noteDirectsState('Read REVOPS-7 on Linear with get_issue before you start, then continue.', 'Done')).toBe(false);
    expect(noteDirectsState('Fix the audit comment: name check 3 as well.', 'Done')).toBe(false);
    expect(noteDirectsState("Don't move REVOPS-5 to Done yet.", 'Done')).toBe(false);
    expect(noteDirectsState('Do not move it to Done. Fix the comment first.', 'Done')).toBe(false);
    expect(noteDirectsState('Fix the comment first; hold the Done until I say.', 'Done')).toBe(false);
    // The state is a whole word: "undone" is not "Done".
    expect(noteDirectsState('The work is undone.', 'Done')).toBe(false);
    // One sentence refuses, another directs: the directing sentence stands on its own.
    expect(noteDirectsState('Do not post a second comment. Move REVOPS-5 to Done.', 'Done')).toBe(true);
  });
});

describe('the hold under a retry note', (): void => {
  it('lifts the hold the run 3 REVOPS-5 note asked for: the plan holds the Done for the manager, the step rests on the note, the note names Done', (): void => {
    expect(transitionDirectedByNote(base)).toBe(true);
  });

  it('keeps the hold for a note that says anything else, for a rejection reason, and for an addressed note', (): void => {
    expect(transitionDirectedByNote({ ...base, feedback: retryNote('Read REVOPS-7 on Linear with get_issue before you start, then continue.') })).toBe(false);
    expect(transitionDirectedByNote({ ...base, feedback: retryNote('Fix the audit comment: name check 3 as well.') })).toBe(false);
    expect(transitionDirectedByNote({ ...base, feedback: { reason: RUN_3_RETRY_NOTE, at: 1, kind: 'rejection' } })).toBe(false);
    expect(transitionDirectedByNote({ ...base, feedback: { ...retryNote(RUN_3_RETRY_NOTE), addressedAt: 2 } })).toBe(false);
    expect(transitionDirectedByNote({ ...base, feedback: undefined })).toBe(false);
  });

  it('keeps the hold when the closing phase did not rest the transition step on the note, or recorded it blocked', (): void => {
    const ledgerBasis: PlanStepOutcome[] = outcomes.map((row) => (row.step === 5 ? { step: row.step, status: row.status, evidence: row.evidence } : row));
    expect(transitionDirectedByNote({ ...base, planStepOutcomes: ledgerBasis })).toBe(false);
    const blocked = outcomes.map((row) => (row.step === 5 ? { ...row, status: 'blocked' as const } : row));
    expect(transitionDirectedByNote({ ...base, planStepOutcomes: blocked })).toBe(false);
    expect(transitionDirectedByNote({ ...base, planStepOutcomes: undefined })).toBe(false);
  });

  it('reads only a plan that holds the transition for the manager, with a transition step', (): void => {
    const promised: ExecutionPlan = { ...run3AuditNotePlan, obligations: { ...run3AuditNotePlan.obligations!, transition: 'promised' } };
    expect(transitionDirectedByNote({ ...base, plan: promised })).toBe(false);
    const noStep: ExecutionPlan = { ...run3AuditNotePlan, obligations: { ...run3AuditNotePlan.obligations!, transitionStep: null } };
    expect(transitionDirectedByNote({ ...base, plan: noStep })).toBe(false);
    expect(transitionDirectedByNote({ ...base, plan: { ...run3AuditNotePlan, obligations: undefined } })).toBe(false);
  });

  it('needs every status change in the set to move to a state the note names', (): void => {
    expect(transitionDirectedByNote({ ...base, actions: [comment] })).toBe(false);
    const cancelled: MockAction = { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_issue', toolArgsJson: JSON.stringify({ id: 'REVOPS-6', state: 'Cancelled' }) } };
    expect(transitionDirectedByNote({ ...base, actions: [comment, done, cancelled] })).toBe(false);
  });
});
