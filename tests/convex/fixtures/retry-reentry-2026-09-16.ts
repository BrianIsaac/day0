import type { ExecutionPlan, MockAction, PlanObligations, PlanStepOutcome } from '../../../src/work/types';
import {
  RUN_3_AUDIT_LINE,
  RUN_3_RETRY_COMMENT_CORRECTED,
  RUN_3_RETRY_NOTE,
} from '../../fixtures/work/audit-note-2026-09-16-run-3';

/**
 * The 16 September third run's REVOPS-5 item and its retry (fresh clone of
 * main 1465d2a, GLM 5.3 Flash, real mode, autonomy on). Phase one landed
 * the tile read, `list_issues` and the audit comment itself, applied
 * autonomously; the closing phase recorded step 5 (Done) as blocked on the
 * checklist's own rule and emitted nothing, so the run failed with "1
 * approved plan step(s) remained blocked". The manager reconciled and
 * retried with the note below; the retry re-entered phase one, re-ran the
 * reads, and its closing phase posted a second audit comment with a new
 * body before the Done.
 *
 * The plan is the bed's own text, as the review brief records it
 * (`docs/research/briefs/retry-reentry-review-2026-09-16-brief.md`): the
 * summary, the reversibility note and every step verbatim, em dashes and
 * angle-bracket placeholders included.
 */

const call = (surface: string, tool: string, args: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call', args: { surface, tool, toolArgsJson: JSON.stringify(args) },
});
const tile = (tool: string, args: Record<string, unknown>): MockAction => call('looker-pipeline-tile', tool, args);

export { RUN_3_AUDIT_LINE, RUN_3_RETRY_COMMENT_CORRECTED, RUN_3_RETRY_NOTE };

/** Step 5 as the bed authored it: a close after the comment lands, held for the manager, the alternative branch read out as one branch of that close. */
export const RUN_3_REVOPS_5_STEP_5 =
  'After the comment lands and all confirmable checks are resolved, emit save_issue {id: REVOPS-5, state: Done} \u2014 held for manager approval; if the manager does not confirm, the issue stays in progress with the comment as trace.';

/** The run 3 REVOPS-5 plan's declared obligations: the tile and Linear are read, check 2 is reported, the comment writes Linear, and the Done waits on the manager. */
export const run3AuditNoteObligations: PlanObligations = {
  steps: [
    { kind: 'read', reads: ['looker-pipeline-tile'], writes: [], reason: 'the sign-in and the read-only snapshot for check 1' },
    { kind: 'read', reads: ['linear'], writes: [], reason: 'list_issues on the Q3 close project for check 3' },
    { kind: 'report', reads: [], writes: [], reason: 'the tracker has no connected surface; the note reports the check' },
    { kind: 'write', reads: [], writes: ['linear'], reason: 'the audit comment on REVOPS-5' },
    { kind: 'conditional-write', reads: [], writes: ['linear'], reason: 'the Done is held for the manager\'s approval' },
  ],
  transition: 'conditional-on-manager',
  transitionStep: 5,
  basis: 'judgement',
  reason: 'step 5 moves REVOPS-5 to Done only after the manager approves',
};

export const run3AuditNotePlan: ExecutionPlan = {
  summary: 'REVOPS-5 (Q3 close, REVOPS team): compose the close-summary audit note per the Q3 close checklist, post it as a Linear comment, then move the issue to Done only after manager approval. All writes are held (autonomous actions off); reads and the manager DM land now.',
  steps: [
    "Read evidence for check 1 via the looker-pipeline-tile surface: sign in at http://looker-tile:8080/ and read back the visible figure and the audit line 'Last updated by <user> at <time> UTC' (read-only snapshot; no save needed for this note).",
    "Read evidence for check 3 via linear: list_issues on team REVOPS, project Q3 close, and record each ticket's state as Linear reports it.",
    "Check 2 (Friday standup deals in the Q4 pipeline tracker): no connected surface exists for the tracker, so the note will report 'deal reconciliation not confirmed \u2014 no tracker connected' rather than stopping the run.",
    "Draft the single audit comment (three checks in order, quoted evidence, then the not-confirmed line) and emit it as a save_comment on REVOPS-5 \u2014 held for the manager's literal approval.",
    RUN_3_REVOPS_5_STEP_5,
  ],
  expectedOutputType: 'ticket-update', riskNotes: '',
  reversibility: 'The comment can be rewritten via save_comment with its id; the status change to Done is reversible by setting the prior state. Both are held for exact-action approval before landing.',
  estimatedMinutes: 20,
  obligations: run3AuditNoteObligations,
};

/** The reads both runs' phase one made: tile sign-in and snapshot, then the issue list. */
export const run3Reads: MockAction[] = [
  tile('browser_navigate', { url: 'http://looker-tile:8080/' }),
  tile('browser_fill_form', { fields: [{ name: 'Username', value: 'revops' }, { name: 'Password', value: '{{secret}}' }] }),
  tile('browser_click', { element: 'Sign in' }),
  tile('browser_snapshot', {}),
  call('linear', 'list_issues', { team: 'REVOPS', project: 'Q3 close' }),
];

/** The first run's audit comment: read before REVOPS-7's save, every check not confirmed. */
export const RUN_3_FIRST_COMMENT = [
  'Q3 close summary — three checks, evidence as read from the system that holds it.',
  '1. Pipeline coverage confirmed. The Looker pipeline tile shows 68%; no audit line from this close is visible.',
  '2. Friday standup deals reconciled. Deal reconciliation not confirmed — no tracker connected.',
  '3. Close tickets at Done. As Linear reports them: REVOPS-6 (Reconcile Northstar CRM ownership) — Backlog; REVOPS-7 (Refresh the Looker pipeline tile) — Backlog.',
  'Not confirmed: checks 1, 2 and 3.',
].join('\n');

/** The first run's phase one as the model returned it: the reads and the comment, applied autonomously. */
export const run3FirstPhaseOne = {
  draft: 'Reading the tile and the Q3 close tickets, then posting the audit note on REVOPS-5.',
  notes: '',
  needsDependentPhase: true,
  deferredActions: [],
  procedureTrails: [],
  actions: [...run3Reads, call('linear', 'save_comment', { issueId: 'REVOPS-5', body: RUN_3_FIRST_COMMENT })],
};

/** The first run's closing phase: nothing emitted, the Done blocked on the checklist's rule. */
export const run3FirstClosing = {
  draft: 'The audit note is on REVOPS-5; the Done is blocked by the checklist until the checks are confirmed or the manager says so.',
  notes: '',
  actions: [] as MockAction[],
  procedureTrails: [],
  planStepOutcomes: [
    { step: 1, status: 'satisfied', basis: 'ledger', evidence: 'ledger row 3: the tile snapshot' },
    { step: 2, status: 'satisfied', basis: 'ledger', evidence: 'ledger row 4: list_issues returned the Q3 close tickets' },
    { step: 3, status: 'satisfied', basis: 'ledger', evidence: 'check 2 recorded as not confirmed in the comment, reason no tracker connected' },
    { step: 4, status: 'satisfied', basis: 'ledger', evidence: 'ledger row 5: the audit comment landed on REVOPS-5' },
    { step: 5, status: 'blocked', basis: 'ledger', evidence: 'not all three checks are confirmed and the manager has not said to move it' },
  ],
};

/** The retry's phase one: the same reads, nothing else. */
export const run3RetryPhaseOne = {
  draft: 'Reading the tile and the Q3 close tickets again for the retry.',
  notes: '',
  needsDependentPhase: true,
  deferredActions: [],
  procedureTrails: [],
  actions: run3Reads,
};

export const RUN_3_RETRY_OUTCOMES: PlanStepOutcome[] = [
  { step: 1, status: 'satisfied', evidence: `ledger row 3: visible figure 74%; ${RUN_3_AUDIT_LINE}` },
  { step: 2, status: 'satisfied', evidence: 'ledger row 4: list_issues returned REVOPS-6 and REVOPS-7 at Backlog' },
  { step: 3, status: 'satisfied', evidence: 'check 2 recorded as not confirmed in the comment, reason no tracker connected' },
  { step: 4, status: 'satisfied', evidence: 'the audit comment in this response' },
  { step: 5, status: 'satisfied', basis: 'manager-feedback', evidence: 'the manager said: Yes, move REVOPS-5 to Done, I accept check 2 unconfirmed.' },
];

/** The retry's closing set as the run authored it: a rewritten audit comment, then the Done. */
export const run3RetryClosing = {
  draft: 'The audit note is recorded on REVOPS-5 and the ticket is moved to Done as the manager said.',
  notes: '',
  actions: [
    call('linear', 'save_comment', { issueId: 'REVOPS-5', body: RUN_3_RETRY_COMMENT_CORRECTED }),
    call('linear', 'save_issue', { id: 'REVOPS-5', state: 'Done' }),
  ],
  procedureTrails: [],
  planStepOutcomes: RUN_3_RETRY_OUTCOMES.map((outcome) => ({ basis: 'ledger' as const, ...outcome })),
};

/** The closing set a retry that obeys the landed-writes rule authors: the Done alone, step 4 satisfied from the landed row. */
export const run3ObedientClosing = (commentId: string): typeof run3RetryClosing => ({
  ...run3RetryClosing,
  draft: 'The audit note landed on REVOPS-5 in the earlier run; the ticket is moved to Done as the manager said.',
  actions: [call('linear', 'save_issue', { id: 'REVOPS-5', state: 'Done' })],
  planStepOutcomes: RUN_3_RETRY_OUTCOMES.map((outcome) => ({
    basis: 'ledger' as const,
    ...outcome,
    ...(outcome.step === 4 ? { evidence: `landed comment ${commentId} on REVOPS-5, listed under the writes earlier runs of this item already landed` } : {}),
  })),
});

/** A fixed-payload comment a plan may ask phase one to land before the evidence is read. */
export const RUN_3_STARTING_COMMENT = 'Starting the Q3 close audit note per the checklist; the evidence follows in the audit comment.';

/** A first run whose phase one lands the reads and a starting comment on the same ticket the closing audit comment goes to. */
export const run3TwoCommentPhaseOne = {
  ...run3FirstPhaseOne,
  actions: [...run3Reads, call('linear', 'save_comment', { issueId: 'REVOPS-5', body: RUN_3_STARTING_COMMENT })],
};

/** Its closing phase: the audit comment (a second comment on the ticket, as the plan asked) and the Done, every step on the ledger. */
export const run3TwoCommentClosing = {
  ...run3RetryClosing,
  planStepOutcomes: RUN_3_RETRY_OUTCOMES.map((outcome) => ({
    ...outcome,
    basis: 'ledger' as const,
    ...(outcome.step === 5 ? { evidence: 'every check has its evidence in the comment; the Done is in this response' } : {}),
  })),
};

/** A retry note that asks for the landed comment to be corrected. */
export const RUN_3_CORRECTION_NOTE =
  'Fix the audit comment on REVOPS-5: check 3 must be listed as not confirmed too. Then move REVOPS-5 to Done, I accept checks 2 and 3 unconfirmed.';

/** The closing set for that note: the landed comment rewritten in place, then the Done. */
export const run3CorrectionClosing = (commentId: string): typeof run3RetryClosing => ({
  ...run3RetryClosing,
  actions: [
    call('linear', 'save_comment', { issueId: 'REVOPS-5', id: commentId, body: RUN_3_RETRY_COMMENT_CORRECTED }),
    call('linear', 'save_issue', { id: 'REVOPS-5', state: 'Done' }),
  ],
  planStepOutcomes: RUN_3_RETRY_OUTCOMES.map((outcome) => ({
    basis: 'ledger' as const,
    ...outcome,
    ...(outcome.step === 5 ? { evidence: 'the manager said: Then move REVOPS-5 to Done, I accept checks 2 and 3 unconfirmed.' } : {}),
  })),
});
