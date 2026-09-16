import type { ExecutionPlan, MockAction, PlanStepOutcome } from '../../../src/work/types';
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
 * The run handover describes the plan and quotes the retry's comment; the
 * plan's steps here are the second run's verbatim REVOPS-5 steps for the
 * same checklist, with step 5 and the summary carrying the checklist's own
 * rule for the Done ("only when all three checks are confirmed or the
 * manager says so"), which is what the third run's closing phase blocked
 * on. The run 3 plan text itself is not recorded verbatim anywhere.
 */

const call = (surface: string, tool: string, args: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call', args: { surface, tool, toolArgsJson: JSON.stringify(args) },
});
const tile = (tool: string, args: Record<string, unknown>): MockAction => call('looker-pipeline-tile', tool, args);

export { RUN_3_AUDIT_LINE, RUN_3_RETRY_COMMENT_CORRECTED, RUN_3_RETRY_NOTE };

/** Step 5 in the checklist's words: a conditional close, not a withheld one. */
export const RUN_3_REVOPS_5_STEP_5 =
  'Move REVOPS-5 to Done only when all three checks are confirmed or the manager says so; otherwise leave it where it is and record the Done decision as blocked in the completion note.';

export const run3AuditNotePlan: ExecutionPlan = {
  summary: 'Compose the close-summary audit note on REVOPS-5 per the Q3 close checklist: gather evidence for the three checks from the connected surfaces (Looker tile audit line, Linear ticket states), post the audit comment, and move the ticket to Done only when all three checks are confirmed or the manager says so.',
  steps: [
    "Read the Looker pipeline tile via the connected looker-pipeline-tile surface (browser sign-in, snapshot) and quote the visible figure and the audit line 'Last updated by <user> at <time> UTC' as evidence for check 1.",
    'Read the Q3 close project tickets in Linear team REVOPS via get_issue/list_issues and record each ticket identifier and its state as Linear reports it, as evidence for check 3.',
    "Check 2 (Friday standup deals reconciled in the Q4 pipeline tracker): no Q4 pipeline tracker surface is connected, so record this check as not confirmed in the note with the reason 'no tracker connected'; do not fabricate evidence.",
    'Post one save_comment on REVOPS-5 with the three checks in checklist order, quoting evidence, ending with the not-confirmed line.',
    RUN_3_REVOPS_5_STEP_5,
  ],
  expectedOutputType: 'ticket-update', riskNotes: '',
  reversibility: 'The audit comment is additive and can be rewritten via save_comment id or superseded by a follow-up comment; the Done move is reversible in Linear.',
  estimatedMinutes: 4,
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
