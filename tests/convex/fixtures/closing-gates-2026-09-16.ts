import type { AppliedAction } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction, PlanObligations, PlanStepOutcome } from '../../../src/work/types';

/**
 * The two plans whose closing sets the gates refused in the 16 September
 * second live run (fresh clone of main 7f86cb4, GLM 5.3 Flash, real mode,
 * autonomy on). Every step, summary and reversibility note is the run's own
 * text, read from the bed's backend and recorded in the review brief, and
 * so are REVOPS-5's two phase-one DMs. The ledger effects and the closing
 * sets follow the run-through handover's description of what landed.
 */

const call = (surface: string, tool: string, args: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call', args: { surface, tool, toolArgsJson: JSON.stringify(args) },
});
const managerDm = (text: string): MockAction => ({
  tool: 'http.request',
  args: {
    surface: 'slack', method: 'POST', path: '/chat.postMessage',
    headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
    body: JSON.stringify({ channel: 'D0MANAGER', text }),
  },
});

export const TILE_AUDIT_LINE = 'Last updated by revops at 2026-09-15 19:21:08 UTC';
export const TILE_READ_BACK = `visible figure 74% · ${TILE_AUDIT_LINE}`;

/** REVOPS-7 step 3: a write the gate refused as a missing Linear read. */
export const REVOPS_7_STEP_3 =
  'Add an audit comment on REVOPS-7 via linear save_comment quoting the visible figure and the exact audit line as evidence (comment precedes any status change).';

/** The run 2 REVOPS-7 plan's declared obligations, as the judgement returns them: the sequence writes the tile, the snapshot reads it, the comment and the Done write Linear. */
export const refreshObligations: PlanObligations = {
  steps: [
    { kind: 'write', reads: [], writes: ['looker-pipeline-tile'], reason: 'the documented sequence saves the figure' },
    { kind: 'read', reads: ['looker-pipeline-tile'], writes: [], reason: 'the snapshot reads the figure and the audit line back' },
    { kind: 'write', reads: [], writes: ['linear'], reason: 'the comment quotes the read-back as evidence; Linear is only written' },
    { kind: 'conditional-write', reads: [], writes: ['linear'], reason: 'the Done follows only when the audit line confirmed the change' },
  ],
  transition: 'conditional-on-evidence',
  transitionStep: 4,
  basis: 'judgement',
  reason: 'step 4 moves REVOPS-7 to Done only if the audit line confirmed the change',
};

export const refreshPlan: ExecutionPlan = {
  summary: 'Execute REVOPS-7: refresh the Looker pipeline coverage tile to the approved 74% figure via the documented browser sequence, then record evidence and close the Linear ticket.',
  steps: [
    'On the looker-pipeline-tile surface, run the documented browser sequence: navigate to http://looker-tile:8080/, fill Username (revops) and Password ({{secret}}), click Sign in, fill Pipeline coverage with 74% exactly (per the runbook, do not compute a figure), click Save.',
    "In the same browser session, take a browser_snapshot and read back the audit line 'Last updated by <user> at <time> UTC' plus the visible figure; if the page redirects, login fails, or the audit line is absent, record the observed failure and stop.",
    REVOPS_7_STEP_3,
    'Move REVOPS-7 to Done via linear save_issue only if the audit line confirmed the change landed.',
  ],
  expectedOutputType: 'ticket-update', riskNotes: '', reversibility: 'Re-enter the previous figure.', estimatedMinutes: 5,
  obligations: refreshObligations,
};

const tile = (tool: string, args: Record<string, unknown>): MockAction => call('looker-pipeline-tile', tool, args);
export const refreshPrerequisites: MockAction[] = [
  tile('browser_navigate', { url: 'http://looker-tile:8080/' }),
  tile('browser_fill_form', { fields: [{ name: 'Username', value: 'revops' }, { name: 'Password', value: '{{secret}}' }] }),
  tile('browser_click', { element: 'Sign in' }),
  tile('browser_fill_form', { fields: [{ name: 'Pipeline coverage', value: '74%' }] }),
  tile('browser_click', { element: 'Save' }),
  tile('browser_snapshot', {}),
];
export const refreshPrerequisiteLedger: AppliedAction[] = refreshPrerequisites.map((action, index) => ({
  tool: action.tool, ok: true, authority: 'autonomous', idempotencyKey: `run-7:${index}`,
  effect: index === 5 ? TILE_READ_BACK : index === 0 ? 'Page URL: http://looker-tile:8080/' : 'ok',
}));

export const REVOPS_7_COMMENT =
  `Refreshed the Looker pipeline tile to 74%. Read back: visible figure 74%; ${TILE_AUDIT_LINE}.`;
export const refreshOutcomes: PlanStepOutcome[] = [
  { step: 1, status: 'satisfied', evidence: 'ledger rows 1 to 5 landed on the tile' },
  { step: 2, status: 'satisfied', evidence: `ledger row 6: ${TILE_READ_BACK}` },
  { step: 3, status: 'satisfied', evidence: 'the audit comment in this response quotes the read-back' },
  { step: 4, status: 'satisfied', evidence: 'the audit line confirmed the change, so the Done move is in this response' },
];
export const REVOPS_7_DM = `REVOPS-7: tile at 74%, audit line ${TILE_AUDIT_LINE}; comment and Done held for you.`;
/** The closing set as the model returns it: every outcome carries the basis the reply schema requires. */
export const refreshClosing = {
  draft: 'The tile shows 74% with the audit line; REVOPS-7 is commented, closed and the manager told.',
  notes: '',
  actions: [
    call('linear', 'save_comment', { issueId: 'REVOPS-7', body: REVOPS_7_COMMENT }),
    call('linear', 'save_issue', { id: 'REVOPS-7', state: 'Done' }),
    managerDm(REVOPS_7_DM),
  ],
  procedureTrails: [],
  planStepOutcomes: refreshOutcomes.map((outcome) => ({ ...outcome, basis: 'ledger' as const })),
};

/** REVOPS-5 step 2: a read the gate took for a promise to close. */
export const REVOPS_5_STEP_2 =
  'Read the Q3 close project tickets in Linear team REVOPS via get_issue/list_issues and record each ticket identifier and its state as Linear reports it, as evidence for check 3.';
/** REVOPS-5 step 5: the plan withholding Done in its own words. */
export const REVOPS_5_STEP_5 =
  'Do not move REVOPS-5 to Done: per the checklist the ticket moves to Done only when all three checks are confirmed or the manager says so; flag the Done decision to the manager in the completion note.';

/** The run 2 REVOPS-5 plan's declared obligations: the tile and Linear are read, check 2 is reported, the comment writes Linear, and the Done is withheld in the plan's own words. */
export const auditNoteObligations: PlanObligations = {
  steps: [
    { kind: 'read', reads: ['looker-pipeline-tile'], writes: [], reason: 'the sign-in and snapshot read the tile for check 1' },
    { kind: 'read', reads: ['linear'], writes: [], reason: 'list_issues on the Q3 close project for check 3' },
    { kind: 'report', reads: [], writes: [], reason: 'the tracker has no connected surface; the check is reported, nothing is read' },
    { kind: 'write', reads: [], writes: ['linear'], reason: 'the audit comment on REVOPS-5' },
    { kind: 'report', reads: [], writes: [], reason: 'the plan leaves the state alone and flags the decision to the manager' },
  ],
  transition: 'withheld',
  transitionStep: 5,
  basis: 'judgement',
  reason: 'step 5 says not to move REVOPS-5 to Done',
};

export const auditNotePlan: ExecutionPlan = {
  summary: 'Compose the close-summary audit note on REVOPS-5 per the Q3 close checklist: gather evidence for the three checks from the connected surfaces (Looker tile audit line, Linear ticket states), post the audit comment, and hold the Done transition because the deal-reconciliation check has no connected evidence source.',
  steps: [
    "Read the Looker pipeline tile via the connected looker-pipeline-tile surface (browser sign-in, snapshot) and quote the visible figure and the audit line 'Last updated by <user> at <time> UTC' as evidence for check 1.",
    REVOPS_5_STEP_2,
    "Check 2 (Friday standup deals reconciled in the Q4 pipeline tracker): no Q4 pipeline tracker surface is connected, so record this check as not confirmed in the note with the reason 'no tracker connected'; do not fabricate evidence.",
    'Post one save_comment on REVOPS-5 with the three checks in checklist order, quoting evidence, ending with the not-confirmed line for check 2.',
    REVOPS_5_STEP_5,
  ],
  expectedOutputType: 'ticket-update', riskNotes: '',
  reversibility: 'The audit comment is additive and can be rewritten via save_comment id or superseded by a follow-up comment; no status change is planned, so the ticket state is untouched.',
  estimatedMinutes: 4,
  obligations: auditNoteObligations,
};

/** The two manager DMs REVOPS-5's phase one sent, in order, as the run sent them. */
export const REVOPS_5_DM_1 =
  'REVOPS-5 close-summary audit note: check 2 (Friday standup deals reconciled) is not confirmed — no Q4 pipeline tracker surface is connected. The audit comment will be posted with that check marked not confirmed. Per the Q3 close checklist the ticket moves to Done only when all three checks are confirmed or you say so — should REVOPS-5 move to Done?';
export const REVOPS_5_DM_2 =
  'REVOPS-5 audit comment posted with the three checks in checklist order; check 2 recorded as not confirmed (no tracker connected). Done transition held pending your decision.';
/** The clause of DM 2 the evidence check refuses: the comment did not exist when the DM was sent. */
export const REVOPS_5_DM_2_CLAIM = 'REVOPS-5 audit comment posted with the three checks in checklist order';

export const auditNotePrerequisites: MockAction[] = [
  tile('browser_navigate', { url: 'http://looker-tile:8080/' }),
  tile('browser_fill_form', { fields: [{ name: 'Username', value: 'revops' }, { name: 'Password', value: '{{secret}}' }] }),
  tile('browser_click', { element: 'Sign in' }),
  tile('browser_snapshot', {}),
  call('linear', 'list_issues', { team: 'REVOPS', project: 'Q3 close' }),
  managerDm(REVOPS_5_DM_1),
  managerDm(REVOPS_5_DM_2),
];
export const LIST_ISSUES_EFFECT = 'REVOPS-5 Add the close-summary audit note (Todo); REVOPS-6 Northstar reconciliation (Todo); REVOPS-7 Refresh the Looker pipeline tile (Done)';
export const auditNotePrerequisiteLedger: AppliedAction[] = auditNotePrerequisites.map((action, index) => ({
  tool: action.tool, ok: true, authority: 'autonomous', idempotencyKey: `run-5:${index}`,
  effect: index === 3 ? TILE_READ_BACK : index === 4 ? LIST_ISSUES_EFFECT : index >= 5 ? 'sent 1789000000.000100' : 'ok',
}));

export const REVOPS_5_COMMENT = [
  'Audit note, checklist order.',
  `Check 1: tile read-back shows visible figure 74%; ${TILE_AUDIT_LINE}.`,
  'Check 2: not confirmed; no tracker connected.',
  `Check 3: list_issues returned ${LIST_ISSUES_EFFECT}.`,
].join(' ');
export const auditNoteOutcomes: PlanStepOutcome[] = [
  { step: 1, status: 'satisfied', evidence: `ledger row 4: ${TILE_READ_BACK}` },
  { step: 2, status: 'satisfied', evidence: `ledger row 5: list_issues returned ${LIST_ISSUES_EFFECT}` },
  { step: 3, status: 'satisfied', evidence: 'check 2 recorded as not confirmed in the comment, reason no tracker connected' },
  { step: 4, status: 'satisfied', evidence: 'the audit comment in this response' },
  { step: 5, status: 'satisfied', evidence: 'no status change emitted; the Done decision is flagged to the manager' },
];
export const auditNoteClosing = {
  draft: 'The audit note is recorded on REVOPS-5; the Done decision is flagged to the manager as planned.',
  notes: '',
  actions: [call('linear', 'save_comment', { issueId: 'REVOPS-5', body: REVOPS_5_COMMENT })],
  procedureTrails: [],
  planStepOutcomes: auditNoteOutcomes.map((outcome) => ({ ...outcome, basis: 'ledger' as const })),
};

/**
 * The REVOPS-7 plan from the 16 September third run (fresh clone of main
 * 1465d2a with the closing-gates fix and its review merged, GLM 5.3 Flash,
 * real mode, autonomy on). Every step, the summary and the reversibility
 * note are the run's own text as the review brief records them from the
 * bed, the em dash in step 1 included. Phase one landed the six browser
 * actions and the snapshot read the audit line at 07:42:48 UTC; the closing
 * phase authored the comment and the Done, and the gate refused them as a
 * Linear read step 3 never promised.
 */
export const RUN_3_TILE_AUDIT_LINE = 'Last updated by revops at 2026-09-16 07:42:48 UTC';
export const RUN_3_TILE_READ_BACK = `visible figure 74% · ${RUN_3_TILE_AUDIT_LINE}`;

/** Run 3 REVOPS-7 step 1: the browser sequence and the read-back, on the tile. */
export const RUN_3_REVOPS_7_STEP_1 =
  "On the looker-pipeline-tile surface, run the documented browser sequence in one session: navigate to http://looker-tile:8080/, fill Username (revops) and Password ({{secret}}), click 'Sign in', fill 'Pipeline coverage' with 74% (the approved figure from the Friday standup summary — do not compute a replacement), click 'Save', then browser_snapshot to read back the visible figure and the audit line 'Last updated by <user> at <time> UTC'. If the page redirects, login fails, or the audit line does not appear, record the observed failure and stop.";
/** Run 3 REVOPS-7 step 2: the audit comment, a write on Linear. */
export const RUN_3_REVOPS_7_STEP_2 =
  'On linear, add an audit comment to REVOPS-7 quoting the visible figure and the exact audit line as evidence the refresh landed (or the observed failure if it did not), with the standard provenance trailer.';
/** Run 3 REVOPS-7 step 3: the Done under a condition on the tile read-back, refused as a promised Linear read. */
export const RUN_3_REVOPS_7_STEP_3 =
  "On linear, set REVOPS-7 state to 'Done' only if the refresh landed and the audit line was read back; otherwise leave it in progress with the failure noted in the comment.";

/** The run 3 REVOPS-7 plan's declared obligations: step 1 writes and reads the tile, steps 2 and 3 only write Linear, the Done is conditional on the read-back. */
export const run3RefreshObligations: PlanObligations = {
  steps: [
    { kind: 'write', reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'], reason: 'the documented sequence saves the figure and reads the audit line back' },
    { kind: 'write', reads: [], writes: ['linear'], reason: 'the comment quotes the read-back; Linear is only written' },
    { kind: 'conditional-write', reads: [], writes: ['linear'], reason: 'the Done follows only when the refresh landed and the audit line was read back' },
  ],
  transition: 'conditional-on-evidence',
  transitionStep: 3,
  basis: 'judgement',
  reason: 'step 3 sets REVOPS-7 to Done only if the refresh landed',
};

export const run3RefreshPlan: ExecutionPlan = {
  summary: 'Execute REVOPS-7 per the Looker tile runbook: refresh the pipeline coverage tile to the approved 74% via the connected browser surface, read back the audit line as evidence, then close the loop on Linear with an audit comment and status change.',
  steps: [RUN_3_REVOPS_7_STEP_1, RUN_3_REVOPS_7_STEP_2, RUN_3_REVOPS_7_STEP_3],
  expectedOutputType: 'ticket-update', riskNotes: '',
  reversibility: 'The tile holds a single value and can be re-entered by hand by the operations lead; the Linear comment and status change are individually reversible via Linear.',
  estimatedMinutes: 5,
  obligations: run3RefreshObligations,
};

export const run3RefreshPrerequisites: MockAction[] = refreshPrerequisites;
export const run3RefreshPrerequisiteLedger: AppliedAction[] = run3RefreshPrerequisites.map((action, index) => ({
  tool: action.tool, ok: true, authority: 'autonomous', idempotencyKey: `run-7c:${index}`,
  effect: index === 5 ? RUN_3_TILE_READ_BACK : index === 0 ? 'Page URL: http://looker-tile:8080/' : 'ok',
}));

export const RUN_3_REVOPS_7_COMMENT =
  `Refreshed the Looker pipeline tile to 74%. Read back: visible figure 74%; ${RUN_3_TILE_AUDIT_LINE}. Provenance: day0 agent, REVOPS-7 runbook.`;
export const run3RefreshOutcomes: PlanStepOutcome[] = [
  { step: 1, status: 'satisfied', evidence: `ledger rows 1 to 6 landed on the tile; row 6: ${RUN_3_TILE_READ_BACK}` },
  { step: 2, status: 'satisfied', evidence: 'the audit comment in this response quotes the figure and the audit line' },
  { step: 3, status: 'satisfied', evidence: 'the refresh landed and the audit line was read back, so the Done is in this response' },
];
/** The closing set the run authored: the comment quoting the read-back, then the Done. */
export const run3RefreshClosing = {
  draft: 'The tile shows 74% with the audit line; REVOPS-7 is commented and closed.',
  notes: '',
  actions: [
    call('linear', 'save_comment', { issueId: 'REVOPS-7', body: RUN_3_REVOPS_7_COMMENT }),
    call('linear', 'save_issue', { id: 'REVOPS-7', state: 'Done' }),
  ],
  procedureTrails: [],
  planStepOutcomes: run3RefreshOutcomes.map((outcome) => ({ ...outcome, basis: 'ledger' as const })),
};
