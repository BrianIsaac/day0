import type { AppliedAction } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction, PlanStepOutcome } from '../../../src/work/types';

/**
 * The two plans whose closing sets the gates refused in the 16 September
 * second live run (fresh clone of main 7f86cb4, GLM 5.3 Flash, real mode,
 * autonomy on), as recorded in the run-through handover. REVOPS-7 step 3
 * and REVOPS-5 steps 2 and 5 are the run's own words; the handover
 * summarises the other steps, so they are reconstructed here from its
 * description of what each phase did and are marked as such.
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

export const TILE_AUDIT_LINE = 'Last updated by revops at 2026-09-16 19:21:08 UTC';
export const TILE_READ_BACK = `visible figure 74%; ${TILE_AUDIT_LINE}`;

/** REVOPS-7 step 3, verbatim from the run: a write the gate refused as a missing Linear read. */
export const REVOPS_7_STEP_3 =
  'Add an audit comment on REVOPS-7 via linear save_comment quoting the visible figure and the exact audit line as evidence';

export const refreshPlan: ExecutionPlan = {
  summary: 'Refresh the Looker pipeline tile to 74%, read it back, then record the result on REVOPS-7 and close it.',
  steps: [
    // Reconstructed: the handover records six landed browser actions for this step.
    'Sign in to the Looker pipeline tile with the stored login, set Pipeline coverage to 74% and save it.',
    // Reconstructed: the read-back the closing comment quoted.
    'Read back the visible figure and the audit line from the Looker pipeline tile after saving.',
    REVOPS_7_STEP_3,
    // Reconstructed: the Done move and the manager DM the closing phase authored.
    'Move REVOPS-7 to Done via linear save_issue once the audit comment is saved, then DM the manager on Slack with the figure and the audit line.',
  ],
  expectedOutputType: 'ticket-update', riskNotes: '', reversibility: 'Re-enter the previous figure.', estimatedMinutes: 5,
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
  { step: 4, status: 'satisfied', evidence: 'the Done move and the manager DM in this response' },
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

/** REVOPS-5 step 2, verbatim from the run: a read the gate took for a promise to close. */
export const REVOPS_5_STEP_2 =
  'Read the Q3 close project tickets in Linear team REVOPS via get_issue/list_issues';
/** REVOPS-5 step 5 opens with the run's own words; the rest is reconstructed. */
export const REVOPS_5_STEP_5 =
  'Do not move REVOPS-5 to Done; leave the status transition to the manager and DM them on Slack when the comment is saved.';

export const auditNotePlan: ExecutionPlan = {
  summary: 'Run the three audit checks from the checklist page and record the note on REVOPS-5; no status change is planned.',
  steps: [
    // Reconstructed: check 1 via the tile read-back.
    'Sign in to the Looker pipeline tile and read back the visible figure and the audit line for check 1.',
    REVOPS_5_STEP_2,
    // Reconstructed: check 2 reported not confirmed.
    'Report check 2 as not confirmed: no connected surface carries the Northstar figure.',
    // Reconstructed: the note in checklist order, deferred to the closing phase.
    'Add an audit comment on REVOPS-5 via linear save_comment with the three checks in checklist order, quoting the tile read-back and the list_issues result.',
    REVOPS_5_STEP_5,
  ],
  expectedOutputType: 'ticket-update', riskNotes: '', reversibility: 'Delete the comment.', estimatedMinutes: 4,
};

export const auditNotePrerequisites: MockAction[] = [
  tile('browser_navigate', { url: 'http://looker-tile:8080/' }),
  tile('browser_fill_form', { fields: [{ name: 'Username', value: 'revops' }, { name: 'Password', value: '{{secret}}' }] }),
  tile('browser_click', { element: 'Sign in' }),
  tile('browser_snapshot', {}),
  call('linear', 'list_issues', { team: 'REVOPS', project: 'Q3 close' }),
  managerDm('Starting the REVOPS-5 audit note: check 1 read from the tile, check 3 from the Linear issue list.'),
  managerDm('REVOPS-5 audit comment posted with the three checks in checklist order.'),
];
export const LIST_ISSUES_EFFECT = 'REVOPS-5 Audit note (Todo); REVOPS-6 Northstar reconciliation (Todo); REVOPS-7 Refresh the Looker pipeline tile (Done)';
export const auditNotePrerequisiteLedger: AppliedAction[] = auditNotePrerequisites.map((action, index) => ({
  tool: action.tool, ok: true, authority: 'autonomous', idempotencyKey: `run-5:${index}`,
  effect: index === 3 ? TILE_READ_BACK : index === 4 ? LIST_ISSUES_EFFECT : index >= 5 ? 'sent 1789000000.000100' : 'ok',
}));

export const REVOPS_5_COMMENT = [
  'Audit note, checklist order.',
  `Check 1: tile read-back shows visible figure 74%; ${TILE_AUDIT_LINE}.`,
  'Check 2: not confirmed; no connected surface carries the Northstar figure.',
  `Check 3: list_issues returned ${LIST_ISSUES_EFFECT}.`,
].join(' ');
export const auditNoteOutcomes: PlanStepOutcome[] = [
  { step: 1, status: 'satisfied', evidence: `ledger row 4: ${TILE_READ_BACK}` },
  { step: 2, status: 'satisfied', evidence: `ledger row 5: list_issues returned ${LIST_ISSUES_EFFECT}` },
  { step: 3, status: 'satisfied', evidence: 'check 2 reported not confirmed in the comment' },
  { step: 4, status: 'satisfied', evidence: 'the audit comment in this response' },
  { step: 5, status: 'satisfied', evidence: 'no status change emitted, as the plan says' },
];
export const auditNoteClosing = {
  draft: 'The audit note is recorded on REVOPS-5; the status transition is left to the manager as planned.',
  notes: '',
  actions: [call('linear', 'save_comment', { issueId: 'REVOPS-5', body: REVOPS_5_COMMENT })],
  procedureTrails: [],
  planStepOutcomes: auditNoteOutcomes.map((outcome) => ({ ...outcome, basis: 'ledger' as const })),
};
