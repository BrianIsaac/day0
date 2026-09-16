import type { AppliedAction } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction, PlanObligations, PlanStepOutcome } from '../../../src/work/types';

/**
 * The 16 September fourth run (fresh clone of main d943084, GLM 5.3 Flash via
 * Featherless, real mode, autonomy on after the REVOPS-7 plan approval), in
 * which the closing gates refused every closing set on a phrasing none of
 * the three earlier rounds covered, and REVOPS-5 stopped with nothing landed.
 *
 * The run handover (`runthrough-goai-final-2026-09-14-handover.md`, "16 Sep
 * run 4") quotes three fragments verbatim and the bed was torn down, so:
 * REVOPS-7 step 2 opens with the run's own words up to the handover's
 * elision; the Slack step 2 carries the run's own clause "because no
 * approved surface exists for the Q4 pipeline tracker / Northstar CRM";
 * REVOPS-5 step 5 carries the run's own "conditioned on the manager's
 * approval decision". Every other step, summary and note is reconstructed
 * from the handover's description of what each phase did and is commented
 * as such. The ledger effects follow the handover (74%, audit line 10:29:13
 * UTC). The declared obligations are what the judgement returns for each
 * plan; the tests script the judgement with them.
 */

const call = (surface: string, tool: string, args: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call', args: { surface, tool, toolArgsJson: JSON.stringify(args) },
});
const tile = (tool: string, args: Record<string, unknown>): MockAction => call('looker-pipeline-tile', tool, args);
const slackPost = (body: Record<string, unknown>): MockAction => ({
  tool: 'http.request',
  args: {
    surface: 'slack', method: 'POST', path: '/chat.postMessage',
    headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
    body: JSON.stringify(body),
  },
});
const managerDm = (text: string): MockAction => slackPost({ channel: 'D0MANAGER', text });

export const RUN_4_AUDIT_LINE = 'Last updated by revops at 2026-09-16 10:29:13 UTC';
export const RUN_4_TILE_READ_BACK = `visible figure 74% · ${RUN_4_AUDIT_LINE}`;

/** The six-step tile sequence phase one landed in every run 4 item. */
export const run4TileSequence: MockAction[] = [
  tile('browser_navigate', { url: 'http://looker-tile:8080/' }),
  tile('browser_fill_form', { fields: [{ name: 'Username', value: 'revops' }, { name: 'Password', value: '{{secret}}' }] }),
  tile('browser_click', { element: 'Sign in' }),
  tile('browser_fill_form', { fields: [{ name: 'Pipeline coverage', value: '74%' }] }),
  tile('browser_click', { element: 'Save' }),
  tile('browser_snapshot', {}),
];
const tileLedger = (prefix: string): AppliedAction[] => run4TileSequence.map((action, index) => ({
  tool: action.tool, ok: true, authority: 'autonomous', idempotencyKey: `${prefix}:${index}`,
  effect: index === 5 ? RUN_4_TILE_READ_BACK : index === 0 ? 'Page URL: http://looker-tile:8080/' : 'ok',
}));

// ---- REVOPS-7 ----

/** Run 4 REVOPS-7 step 1, reconstructed: the documented sequence ending in the read-back. */
export const RUN_4_REVOPS_7_STEP_1 =
  "On the looker-pipeline-tile surface, run the documented browser sequence in one session: navigate to http://looker-tile:8080/, fill Username (revops) and Password ({{secret}}), click 'Sign in', fill 'Pipeline coverage' with 74% (the approved figure; do not compute a replacement), click 'Save', then browser_snapshot to read back the visible figure and the audit line 'Last updated by <user> at <time> UTC'.";
/** Run 4 REVOPS-7 step 2: the run's own words up to the handover's elision, then reconstructed. The gate read "Emit ... on linear" as a promised Linear read. */
export const RUN_4_REVOPS_7_STEP_2 =
  'Emit a save_comment on linear issue REVOPS-7 quoting the visible figure and the audit line exactly as read back in step 1 (or the observed failure if the refresh did not land), with the standard provenance trailer.';
/** Run 4 REVOPS-7 step 3, reconstructed: the Done under the read-back condition. */
export const RUN_4_REVOPS_7_STEP_3 =
  "Emit save_issue on linear issue REVOPS-7 with state 'Done' only if the audit line was read back in step 1; otherwise leave it in progress with the failure noted in the comment.";

export const run4RefreshObligations: PlanObligations = {
  steps: [
    { kind: 'write', reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'], reason: 'the documented sequence saves the figure and reads the audit line back' },
    { kind: 'write', reads: [], writes: ['linear'], reason: 'the comment quotes what step 1 read; Linear is only written' },
    { kind: 'conditional-write', reads: [], writes: ['linear'], reason: 'the Done follows only when the audit line was read back' },
  ],
  transition: 'conditional-on-evidence',
  transitionStep: 3,
  basis: 'judgement',
  reason: 'step 3 moves REVOPS-7 to Done only if the refresh landed',
};

export const run4RefreshPlan: ExecutionPlan = {
  summary: 'Execute REVOPS-7 per the Looker tile runbook: refresh the pipeline coverage tile to the approved 74% via the connected browser surface, read back the audit line, then comment on Linear and close the ticket when the refresh landed.',
  steps: [RUN_4_REVOPS_7_STEP_1, RUN_4_REVOPS_7_STEP_2, RUN_4_REVOPS_7_STEP_3],
  expectedOutputType: 'ticket-update', riskNotes: '',
  reversibility: 'The tile holds a single value and can be re-entered by hand; the Linear comment and status change are individually reversible.',
  estimatedMinutes: 5,
  obligations: run4RefreshObligations,
};

export const run4RefreshPrerequisites: MockAction[] = run4TileSequence;
export const run4RefreshPrerequisiteLedger: AppliedAction[] = tileLedger('run-7d');

export const RUN_4_REVOPS_7_COMMENT =
  `Refreshed the Looker pipeline tile to 74%. Read back: visible figure 74%; ${RUN_4_AUDIT_LINE}. Provenance: day0 agent, REVOPS-7 runbook.`;
export const run4RefreshOutcomes: PlanStepOutcome[] = [
  { step: 1, status: 'satisfied', evidence: `ledger rows 1 to 6 landed on the tile; row 6: ${RUN_4_TILE_READ_BACK}` },
  { step: 2, status: 'satisfied', evidence: 'the audit comment in this response quotes the figure and the audit line' },
  { step: 3, status: 'satisfied', evidence: 'the audit line was read back, so the Done is in this response' },
];
/** The closing set the run authored: the comment quoting the audit line, then the Done. */
export const run4RefreshClosing = {
  draft: 'The tile shows 74% with the audit line; REVOPS-7 is commented and closed.',
  notes: '',
  actions: [
    call('linear', 'save_comment', { issueId: 'REVOPS-7', body: RUN_4_REVOPS_7_COMMENT }),
    call('linear', 'save_issue', { id: 'REVOPS-7', state: 'Done' }),
  ],
  procedureTrails: [],
  planStepOutcomes: run4RefreshOutcomes.map((outcome) => ({ ...outcome, basis: 'ledger' as const })),
};

// ---- The Slack mention ----

/** Run 4 Slack step 1, reconstructed: the same sequence, parked whole on the tile. */
export const RUN_4_SLACK_STEP_1 =
  "On the looker-pipeline-tile surface, run the documented browser sequence in one session (navigate, sign in with {{secret}}, fill 'Pipeline coverage' with 74%, click 'Save', browser_snapshot) and read back the visible figure and the audit line.";
/** Run 4 Slack step 2: reconstructed around the run's own clause the gate quoted; the step mentions Northstar CRM, an absent surface, in the text of the message it sends. */
export const RUN_4_SLACK_STEP_2 =
  'Reply in the thread via chat.postMessage quoting the visible figure and the audit line exactly as read back, and state that the per-deal reconciliation is not confirmed because no approved surface exists for the Q4 pipeline tracker / Northstar CRM; DM the manager the same escalation.';

export const run4SlackObligations: PlanObligations = {
  steps: [
    { kind: 'write', reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'], reason: 'the refresh sequence and its snapshot' },
    { kind: 'write', reads: [], writes: ['slack'], reason: 'the reply quotes the read-back; Northstar CRM has no connection and is only named in the text' },
  ],
  transition: 'none',
  transitionStep: null,
  basis: 'judgement',
  reason: 'a chat ask has no ticket state',
};

export const run4SlackPlan: ExecutionPlan = {
  summary: 'Answer the #revops-asks mention: refresh the Looker pipeline tile to the approved 74%, read the audit line back, and reply in the thread with the figure, the audit line and the reconciliation gap.',
  steps: [RUN_4_SLACK_STEP_1, RUN_4_SLACK_STEP_2],
  expectedOutputType: 'message', riskNotes: '',
  reversibility: 'The tile can be re-entered by hand; a thread reply can be followed by a correction.',
  estimatedMinutes: 5,
  obligations: run4SlackObligations,
};

export const run4SlackPrerequisites: MockAction[] = run4TileSequence;
export const run4SlackPrerequisiteLedger: AppliedAction[] = tileLedger('run-slack-d');

export const RUN_4_SLACK_REPLY =
  `The Looker pipeline tile was refreshed with the approved figure 74% and the save was read back: ${RUN_4_AUDIT_LINE}. Per-deal reconciliation not confirmed: no approved surface exists for the Q4 pipeline tracker / Northstar CRM.`;
export const RUN_4_SLACK_ESCALATION =
  'Escalation: the #revops-asks reply quotes the 74% figure and the audit line; per-deal reconciliation is not confirmed because no approved surface exists for the Q4 pipeline tracker / Northstar CRM. Do you want a Northstar CRM connection set up?';
export const run4SlackOutcomes: PlanStepOutcome[] = [
  { step: 1, status: 'satisfied', evidence: `ledger rows 1 to 6 landed on the tile; row 6: ${RUN_4_TILE_READ_BACK}` },
  { step: 2, status: 'satisfied', evidence: 'the threaded reply and the manager DM in this response' },
];
/** The closing set the run authored: the threaded reply, then the manager DM escalation. */
export const run4SlackClosing = {
  draft: 'Replied in the thread with the figure and the audit line; the reconciliation gap is escalated to the manager.',
  notes: '',
  actions: [
    slackPost({ channel: 'C0REVOPSASKS', thread_ts: '1789000000.000200', text: RUN_4_SLACK_REPLY }),
    managerDm(RUN_4_SLACK_ESCALATION),
  ],
  procedureTrails: [],
  planStepOutcomes: run4SlackOutcomes.map((outcome) => ({ ...outcome, basis: 'ledger' as const })),
};

// ---- REVOPS-5 ----

/** Run 4 REVOPS-5 step 1, reconstructed: the standalone check 1 the checklist now carries, driving the refresh. */
export const RUN_4_REVOPS_5_STEP_1 =
  "Check 1 via the looker-pipeline-tile surface: sign in at http://looker-tile:8080/; if the tile does not already show the approved 74% with an audit line from this close, refresh it by the documented sequence in the same session (fill 'Pipeline coverage' with 74%, click 'Save'), then browser_snapshot to read back the visible figure and the audit line 'Last updated by <user> at <time> UTC'.";
/** Run 4 REVOPS-5 step 2, the run 3 wording: the Linear read for check 3. */
export const RUN_4_REVOPS_5_STEP_2 =
  "Read evidence for check 3 via linear: list_issues on team REVOPS, project Q3 close, and record each ticket's state as Linear reports it.";
/** Run 4 REVOPS-5 step 3, the run 3 wording: check 2 reported, no surface. */
export const RUN_4_REVOPS_5_STEP_3 =
  "Check 2 (Friday standup deals in the Q4 pipeline tracker): no connected surface exists for the tracker, so the note will report 'deal reconciliation not confirmed — no tracker connected' rather than stopping the run.";
/** Run 4 REVOPS-5 step 4, reconstructed: the audit comment. */
export const RUN_4_REVOPS_5_STEP_4 =
  'Draft the single audit comment (three checks in order, quoted evidence, then the not-confirmed line) and emit it as a save_comment on REVOPS-5.';
/** Run 4 REVOPS-5 step 5: reconstructed around the run's own "conditioned on the manager's approval decision". */
export const RUN_4_REVOPS_5_STEP_5 =
  "After the comment lands, emit save_issue {id: REVOPS-5, state: Done} conditioned on the manager's approval decision; if the manager does not confirm, the issue stays in progress with the comment as trace.";

export const run4AuditNoteObligations: PlanObligations = {
  steps: [
    { kind: 'write', reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'], reason: 'the sign-in, the conditional refresh and the snapshot are on the tile' },
    { kind: 'read', reads: ['linear'], writes: [], reason: 'list_issues on Linear for check 3' },
    { kind: 'report', reads: [], writes: [], reason: 'the tracker has no connected surface; the check is reported, nothing is read' },
    { kind: 'write', reads: [], writes: ['linear'], reason: 'the audit comment on REVOPS-5' },
    { kind: 'conditional-write', reads: [], writes: ['linear'], reason: 'the Done waits on the manager\'s decision' },
  ],
  transition: 'conditional-on-manager',
  transitionStep: 5,
  basis: 'judgement',
  reason: 'step 5 moves REVOPS-5 to Done only on the manager\'s approval',
};

export const run4AuditNotePlan: ExecutionPlan = {
  summary: 'REVOPS-5 (Q3 close, REVOPS team): compose the close-summary audit note per the Q3 close checklist, refreshing the tile first if check 1 needs it, post it as a Linear comment, then move the issue to Done conditioned on the manager\'s approval decision.',
  steps: [RUN_4_REVOPS_5_STEP_1, RUN_4_REVOPS_5_STEP_2, RUN_4_REVOPS_5_STEP_3, RUN_4_REVOPS_5_STEP_4, RUN_4_REVOPS_5_STEP_5],
  expectedOutputType: 'ticket-update', riskNotes: '',
  reversibility: 'The comment can be rewritten via save_comment with its id; the status change to Done is reversible by setting the prior state.',
  estimatedMinutes: 20,
  obligations: run4AuditNoteObligations,
};

export const RUN_4_LIST_ISSUES_EFFECT = 'REVOPS-5 Add the close-summary audit note (In Progress); REVOPS-6 Reconcile Northstar CRM ownership (Backlog); REVOPS-7 Refresh the Looker pipeline tile (Done)';
/** The comment phase one prewrote before the read-back existed: the audit removes it and the closing phase authors the real one. */
export const RUN_4_REVOPS_5_PREWRITTEN_COMMENT =
  'Q3 close summary. 1. Pipeline coverage confirmed: the tile shows 74% with an audit line from this close. 2. Friday standup deals reconciled: not confirmed, no tracker connected. 3. Close tickets at Done: REVOPS-7 Done. Not confirmed: check 2.';
/** REVOPS-5's phase one as the run returned it: the refresh, the read, a prewritten comment, and the Done deferred on the manager's decision. */
export const run4AuditNotePhaseOne = {
  draft: 'Refreshing the tile for check 1, reading the Q3 close tickets, posting the audit note; the Done waits on your decision.',
  notes: '',
  needsDependentPhase: true,
  actions: [
    ...run4TileSequence,
    call('linear', 'list_issues', { team: 'REVOPS', project: 'Q3 close' }),
    call('linear', 'save_comment', { issueId: 'REVOPS-5', body: RUN_4_REVOPS_5_PREWRITTEN_COMMENT }),
  ],
  procedureTrails: [],
  deferredActions: [
    {
      description: 'save_issue {id: REVOPS-5, state: Done}',
      reason: "conditioned on the manager's approval decision",
      dependsOnActionIndex: null,
      dependsOnField: null,
    },
  ],
};

export const RUN_4_REVOPS_5_COMMENT = [
  'Q3 close summary — three checks, evidence as read from the system that holds it.',
  `1. Pipeline coverage confirmed. The Looker pipeline tile shows 74%; ${RUN_4_AUDIT_LINE}.`,
  '2. Friday standup deals reconciled. Deal reconciliation not confirmed — no tracker connected.',
  `3. Close tickets at Done. As Linear reports them: ${RUN_4_LIST_ISSUES_EFFECT}.`,
  'Not confirmed: checks 2 and 3.',
].join('\n');
export const run4AuditNoteOutcomes: PlanStepOutcome[] = [
  { step: 1, status: 'satisfied', evidence: `ledger rows 1 to 6 landed on the tile; row 6: ${RUN_4_TILE_READ_BACK}` },
  { step: 2, status: 'satisfied', evidence: `ledger row 7: list_issues returned ${RUN_4_LIST_ISSUES_EFFECT}` },
  { step: 3, status: 'satisfied', evidence: 'check 2 recorded as not confirmed in the comment, reason no tracker connected' },
  { step: 4, status: 'satisfied', evidence: 'the audit comment in this response' },
  { step: 5, status: 'satisfied', evidence: 'the Done is in this response, held for the manager\'s decision' },
];
/** The closing set: the audit comment, then the Done the plan conditions on the manager. */
export const run4AuditNoteClosing = {
  draft: 'The audit note is on REVOPS-5; the Done is held for your decision.',
  notes: '',
  actions: [
    call('linear', 'save_comment', { issueId: 'REVOPS-5', body: RUN_4_REVOPS_5_COMMENT }),
    call('linear', 'save_issue', { id: 'REVOPS-5', state: 'Done' }),
  ],
  procedureTrails: [],
  planStepOutcomes: run4AuditNoteOutcomes.map((outcome) => ({ ...outcome, basis: 'ledger' as const })),
};
