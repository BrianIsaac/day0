import { describe, expect, it, vi } from 'vitest';

/**
 * Finding T of the third full internal run (19 September): the promised-read
 * gate read phase one's ledger only, so LOG-1's retry was refused three
 * times for a Linear read the product had made before the plan was drafted
 * and the closing set carried again, and FIN-1 was refused for a Slack read
 * the manager's note had removed. Every row here is the run's own.
 */

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('the gate makes no model call');
  },
}));

import { missingReadReason, unmetDeclaredReads, validatePlanStepOutcomes } from '../../convex/workActions';
import type { GroundingRead } from '../../src/work/evidence-claims';
import {
  FIN_1_RETRY_NOTE,
  LOG_1_REFUSAL,
  LOG_1_RETRY_NOTE,
  fin1Candidate,
  fin1PhaseOne,
  fin1Plan,
  fin1RefusedClosing,
  log1Candidate,
  log1GroundingRead,
  log1Plan,
  log1RefusedClosing,
  log1SecondRefusedClosing,
} from '../fixtures/work/full-run-3-2026-09-19-log-1';

const linear = { slug: 'linear', displayName: 'Linear' };
const slack = { slug: 'slack', displayName: 'Slack' };
const surfaces = [linear, slack];

const log1Gate = (extra: Partial<Parameters<typeof validatePlanStepOutcomes>[0]> = {}): void =>
  validatePlanStepOutcomes({
    plan: log1Plan,
    outcomes: log1RefusedClosing.planStepOutcomes,
    initialActions: [],
    initialLedger: [],
    surfaces,
    managerFeedback: LOG_1_RETRY_NOTE,
    retryNote: LOG_1_RETRY_NOTE,
    ...extra,
  });

const fin1Gate = (extra: Partial<Parameters<typeof validatePlanStepOutcomes>[0]> = {}): void =>
  validatePlanStepOutcomes({
    plan: fin1Plan,
    outcomes: fin1RefusedClosing.planStepOutcomes,
    initialActions: fin1PhaseOne.actions,
    initialLedger: fin1PhaseOne.applied,
    surfaces,
    managerFeedback: FIN_1_RETRY_NOTE,
    retryNote: FIN_1_RETRY_NOTE,
    candidate: fin1Candidate,
    ...extra,
  });

describe('the plan-grounding read of the item is a landed read (LOG-1, 19 September)', () => {
  it('reproduces the run: with no grounding read handed over, the gate refuses with the run\'s sentence', (): void => {
    expect(() => log1Gate()).toThrow(LOG_1_REFUSAL);
    expect(() => log1Gate({ outcomes: log1SecondRefusedClosing.planStepOutcomes })).toThrow(LOG_1_REFUSAL);
  });

  it('accepts both refused closing sets once the item\'s own grounding read is counted', (): void => {
    const grounded = { candidate: log1Candidate, groundingReads: [log1GroundingRead] };
    expect(() => log1Gate(grounded)).not.toThrow();
    expect(() => log1Gate({ ...grounded, outcomes: log1SecondRefusedClosing.planStepOutcomes })).not.toThrow();
  });

  it('never counts a grounding read that did not land, was held, or reads another ticket', (): void => {
    const variant = (change: (read: GroundingRead) => GroundingRead): GroundingRead[] => [
      change(structuredClone(log1GroundingRead)),
    ];
    const failed = variant((read) => ({ ...read, applied: { ...read.applied, ok: false, reason: 'HTTP 401' } }));
    const held = variant((read) => ({ ...read, applied: { ...read.applied, held: true } }));
    const other = variant((read) => ({
      ...read,
      action: { ...read.action, args: { ...read.action.args, toolArgsJson: JSON.stringify({ id: 'LOG-12' }) } },
    }));
    for (const groundingReads of [failed, held, other]) {
      expect(() => log1Gate({ candidate: log1Candidate, groundingReads })).toThrow(LOG_1_REFUSAL);
    }
    expect(() => log1Gate({ groundingReads: [log1GroundingRead] })).toThrow(LOG_1_REFUSAL);
  });

  it('skips a grounding-read row it cannot read instead of failing on it', (): void => {
    const malformed = [
      { action: undefined, applied: { ok: true } },
      { action: {}, applied: { ok: true } },
      { action: log1GroundingRead.action, applied: null },
    ] as unknown as GroundingRead[];
    expect(() => log1Gate({ candidate: log1Candidate, groundingReads: malformed })).toThrow(LOG_1_REFUSAL);
    expect(() => log1Gate({ candidate: log1Candidate, groundingReads: [...malformed, log1GroundingRead] })).not.toThrow();
  });

  it('counts the grounding read for its own surface only: a declared Slack read is still owed', (): void => {
    expect(() => fin1Gate({ retryNote: undefined, groundingReads: [log1GroundingRead], candidate: log1Candidate })).toThrow(
      'approved plan step 4 declares a read of Slack',
    );
  });

  it('still refuses a plan that declares a read of a surface the run never read by any path', (): void => {
    expect(() => log1Gate({ candidate: log1Candidate, groundingReads: [] })).toThrow(LOG_1_REFUSAL);
    const unmet = unmetDeclaredReads({
      plan: log1Plan,
      outcomes: log1RefusedClosing.planStepOutcomes,
      initialActions: [],
      initialLedger: [],
      surfaces,
      candidate: log1Candidate,
      groundingReads: [],
      retryNote: LOG_1_RETRY_NOTE,
    });
    expect(unmet.map(missingReadReason)).toEqual([LOG_1_REFUSAL]);
  });
});

describe('a retry note releases the declared read it removed (FIN-1, 19 September)', () => {
  it('reproduces the run: the gate refuses the Slack read the note removed when it is not told of the note', (): void => {
    expect(() => fin1Gate({ retryNote: undefined })).toThrow(fin1RefusedClosing.reason);
  });

  it('accepts the run\'s closing set: a live retry note, the step resting on it, and the note naming the surface it removes', (): void => {
    expect(() => fin1Gate()).not.toThrow();
  });

  it('releases nothing when the step does not rest on the manager\'s feedback', (): void => {
    const outcomes = fin1RefusedClosing.planStepOutcomes.map((outcome) =>
      outcome.step === 4 ? { step: 4, status: 'satisfied' as const, evidence: outcome.evidence } : outcome,
    );
    expect(() => fin1Gate({ outcomes })).toThrow(fin1RefusedClosing.reason);
  });

  it('releases nothing on a note that does not remove the read', (): void => {
    for (const retryNote of [
      LOG_1_RETRY_NOTE,
      'Do not skip the Slack read: check #finance-close first.',
      'No, read Slack first and then post the note.',
      'Post the note in Linear. The Slack thread can wait for nobody.',
      'Leave out the Notion step.',
    ]) {
      expect(() => fin1Gate({ retryNote, managerFeedback: retryNote }), retryNote).toThrow(fin1RefusedClosing.reason);
    }
  });

  it('releases the read on a note that names the step by number', (): void => {
    const retryNote = 'Skip step 4, the questions were answered on a call.';
    expect(() => fin1Gate({ retryNote, managerFeedback: retryNote })).not.toThrow();
    const wrongStep = 'Skip step 2, the questions were answered on a call.';
    expect(() => fin1Gate({ retryNote: wrongStep, managerFeedback: wrongStep })).toThrow(fin1RefusedClosing.reason);
  });

  it('releases only the read: the step must still carry evidence and the feedback must be live', (): void => {
    expect(() => fin1Gate({ managerFeedback: undefined })).toThrow('step 4 cites manager feedback the run does not carry');
  });

  it('owes nothing for a read the manager\'s note took out of the plan itself: a redrafted plan declares its own reads', (): void => {
    const redrafted = {
      ...fin1Plan,
      steps: fin1Plan.steps.slice(0, 3),
      obligations: { ...fin1Plan.obligations!, steps: fin1Plan.obligations!.steps.slice(0, 3) },
    };
    const outcomes = fin1RefusedClosing.planStepOutcomes.slice(0, 3);
    expect(() => fin1Gate({ plan: redrafted, outcomes, retryNote: undefined })).not.toThrow();
  });
});

