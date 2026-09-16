import type { AppliedAction } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction, PlanObligations, PlanStepOutcome } from '../../../src/work/types';

/**
 * The 16 September fourth run (fresh clone of main d943084, GLM 5.3 Flash via
 * Featherless, real mode, autonomy on after the REVOPS-7 plan approval), in
 * which the closing gates refused every closing set on a phrasing none of
 * the three earlier rounds covered, and REVOPS-5 stopped with nothing landed.
 *
 * The plans are the bed's own words: every step and summary below is
 * verbatim from the run 4 export quoted in the review brief
 * (`docs/research/briefs/plan-obligations-review-2026-09-16-brief.md`),
 * including the REVOPS-5 stop reason and the deferral it names. The ledger
 * effects follow the run handover (74%, audit line 10:29:13 UTC). The
 * declared obligations are what the judgement returns for each plan; the
 * tests script the judgement with them. The closing sets and the phase-one
 * outputs are reconstructed from the handover's description of what each
 * phase did.
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

/** Run 4 REVOPS-7 step 1, verbatim. */
export const RUN_4_REVOPS_7_STEP_1 =
  "Emit the documented browser sequence on the looker-pipeline-tile surface: navigate to http://looker-tile:8080/, fill Username (revops) and Password ({{secret}}), click Sign in, fill Pipeline coverage with 74%, click Save, then browser_snapshot to read back the visible figure and the audit line 'Last updated by <user> at <time> UTC'. The whole sequence parks for the manager's exact-action approval because a browser login cannot be split across sessions.";
/** Run 4 REVOPS-7 step 2, verbatim: the gate read "Emit ... on linear" as a promised Linear read. */
export const RUN_4_REVOPS_7_STEP_2 =
  'Emit a save_comment on linear issue REVOPS-7 quoting the visible figure and the audit line exactly as read back (no screenshots), with the standard provenance trailer. Held for manager approval.';
/** Run 4 REVOPS-7 step 3, verbatim: the Done after the comment, under the read-back condition. */
export const RUN_4_REVOPS_7_STEP_3 =
  'Emit a save_issue on REVOPS-7 setting state to Done, only after the audit comment, and only if the audit line confirmed the change landed. Held for manager approval.';
/** Run 4 REVOPS-7 step 4, verbatim: the failure branch. */
export const RUN_4_REVOPS_7_STEP_4 =
  'If the page redirects, login fails, an element is absent, or the audit line does not appear, record the observed failure as data, comment the partial result on REVOPS-7, and stop without claiming success.';
/** Run 4 REVOPS-7 summary, verbatim. */
export const RUN_4_REVOPS_7_SUMMARY =
  'Refresh the Looker pipeline coverage tile for REVOPS-7 with the approved figure 74% (from the Friday standup summary per the tile runbook), then leave the audit evidence and status update on the Linear issue. All writes are held for exact manager approval since autonomous actions are off.';

/**
 * The judgement's answer. "Held for manager approval" on steps 2 and 3 and
 * "held for exact manager approval since autonomous actions are off" in the
 * summary describe the gate the plan was drafted under, not a condition the
 * plan puts on the manager's decision; the condition the plan states is the
 * audit line read back in step 1. A judgement that read those words as
 * `conditional-on-manager` would hold the Done for a click under autonomy,
 * never land it on its own.
 */
export const run4RefreshObligations: PlanObligations = {
  steps: [
    { kind: 'write', reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'], reason: 'the documented sequence saves the figure and reads the audit line back' },
    { kind: 'write', reads: [], writes: ['linear'], reason: 'the comment quotes what step 1 read; Linear is only written' },
    { kind: 'conditional-write', reads: [], writes: ['linear'], reason: 'the Done follows the comment only when the audit line confirmed the change landed' },
    { kind: 'conditional-write', reads: [], writes: ['linear'], reason: 'the failure branch comments the partial result and stops; nothing is read' },
  ],
  transition: 'conditional-on-evidence',
  transitionStep: 3,
  basis: 'judgement',
  reason: 'step 3 moves REVOPS-7 to Done only if the audit line confirmed the refresh landed',
};

export const run4RefreshPlan: ExecutionPlan = {
  summary: RUN_4_REVOPS_7_SUMMARY,
  steps: [RUN_4_REVOPS_7_STEP_1, RUN_4_REVOPS_7_STEP_2, RUN_4_REVOPS_7_STEP_3, RUN_4_REVOPS_7_STEP_4],
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
  { step: 3, status: 'satisfied', evidence: 'the audit line was read back, so the Done follows the comment in this response' },
  { step: 4, status: 'satisfied', evidence: 'no redirect, login failure or missing element; the audit line appeared, so the failure branch did not apply' },
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

/** The originating thread as the run's plan names it. */
export const RUN_4_SLACK_CHANNEL = 'C0BSF04TZ19';
export const RUN_4_SLACK_THREAD_TS = '1787746453.202809';

/** Run 4 Slack step 1, verbatim. */
export const RUN_4_SLACK_STEP_1 =
  "Refresh the Looker pipeline tile per the runbook in one browser session: navigate to http://looker-tile:8080/, sign in as revops, enter '74%' in Pipeline coverage, click Save, then browser_snapshot to read back the visible figure and the audit line 'Last updated by <user> at <time> UTC'. If the page redirects, login fails, or the audit line is absent, record the failure and stop.";
/** Run 4 Slack step 2, verbatim: the step names Northstar CRM, an absent surface, in the text of the message it sends. */
export const RUN_4_SLACK_STEP_2 =
  `Reply in the originating #revops-asks thread (channel ${RUN_4_SLACK_CHANNEL}, thread_ts ${RUN_4_SLACK_THREAD_TS}) via chat.postMessage: confirm pipeline coverage is 74% per the Friday standup summary, quote the tile's audit line as evidence, and state that per-deal reconciliation for the three standup deals cannot be confirmed because no approved surface exists for the Q4 pipeline tracker / Northstar CRM.`;
/** Run 4 Slack step 3, verbatim: the escalation. */
export const RUN_4_SLACK_STEP_3 =
  'Escalate the deal-reconciliation gap to the manager DM: Northstar CRM has no connected surface (charter willNotDo), so per-deal confirmation must be routed to Brian or an approved access path obtained before the Q3 close summary goes out.';

export const run4SlackObligations: PlanObligations = {
  steps: [
    { kind: 'write', reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'], reason: 'the refresh sequence and its snapshot' },
    { kind: 'write', reads: [], writes: ['slack'], reason: 'the thread reply quotes the read-back; Northstar CRM has no connection and is only named in the text' },
    { kind: 'write', reads: [], writes: ['slack'], reason: 'the escalation DM to the manager; Northstar CRM is named, not read' },
  ],
  transition: 'none',
  transitionStep: null,
  basis: 'judgement',
  reason: 'a chat ask has no ticket state',
};

export const run4SlackPlan: ExecutionPlan = {
  summary: 'Answer the #revops-asks mention: refresh the Looker pipeline tile to the approved 74%, read the audit line back, reply in the thread with the figure, the audit line and the reconciliation gap, and escalate the gap to the manager.',
  steps: [RUN_4_SLACK_STEP_1, RUN_4_SLACK_STEP_2, RUN_4_SLACK_STEP_3],
  expectedOutputType: 'message', riskNotes: '',
  reversibility: 'The tile can be re-entered by hand; a thread reply can be followed by a correction.',
  estimatedMinutes: 5,
  obligations: run4SlackObligations,
};

export const run4SlackPrerequisites: MockAction[] = run4TileSequence;
export const run4SlackPrerequisiteLedger: AppliedAction[] = tileLedger('run-slack-d');

export const RUN_4_SLACK_REPLY =
  `Pipeline coverage is 74% per the Friday standup summary; the Looker pipeline tile was refreshed and the save was read back: ${RUN_4_AUDIT_LINE}. Per-deal reconciliation for the three standup deals cannot be confirmed: no approved surface exists for the Q4 pipeline tracker / Northstar CRM.`;
export const RUN_4_SLACK_ESCALATION =
  'Escalation: the #revops-asks reply quotes the 74% figure and the audit line; per-deal reconciliation cannot be confirmed because Northstar CRM has no connected surface (charter willNotDo). Per-deal confirmation must be routed to Brian or an approved access path obtained before the Q3 close summary goes out.';
export const run4SlackOutcomes: PlanStepOutcome[] = [
  { step: 1, status: 'satisfied', evidence: `ledger rows 1 to 6 landed on the tile; row 6: ${RUN_4_TILE_READ_BACK}` },
  { step: 2, status: 'satisfied', evidence: 'the threaded reply in this response' },
  { step: 3, status: 'satisfied', evidence: 'the manager DM in this response' },
];
/** The closing set the run authored: the threaded reply, then the manager DM escalation. */
export const run4SlackClosing = {
  draft: 'Replied in the thread with the figure and the audit line; the reconciliation gap is escalated to the manager.',
  notes: '',
  actions: [
    slackPost({ channel: RUN_4_SLACK_CHANNEL, thread_ts: RUN_4_SLACK_THREAD_TS, text: RUN_4_SLACK_REPLY }),
    managerDm(RUN_4_SLACK_ESCALATION),
  ],
  procedureTrails: [],
  planStepOutcomes: run4SlackOutcomes.map((outcome) => ({ ...outcome, basis: 'ledger' as const })),
};

// ---- REVOPS-5 ----

/** Run 4 REVOPS-5 step 1, verbatim: the standalone check 1 the checklist now carries. */
export const RUN_4_REVOPS_5_STEP_1 =
  "Check 1 (pipeline coverage): drive the looker-pipeline-tile surface per the runbook — navigate to http://looker-tile:8080/, sign in as revops, enter the approved 74%, Save, then browser_snapshot and quote the visible figure and the audit line 'Last updated by <user> at <time> UTC'. If the page redirects, login fails, or the audit line does not appear, record the failure and stop.";
/** Run 4 REVOPS-5 step 2, verbatim: the Linear read for check 3. */
export const RUN_4_REVOPS_5_STEP_2 =
  'Check 3 (close tickets at Done): use linear list_issues on team REVOPS, project Q3 close, and record each ticket identifier and its state as Linear reports it, excluding REVOPS-5 itself.';
/** Run 4 REVOPS-5 step 3, verbatim: check 2 reported, no surface. */
export const RUN_4_REVOPS_5_STEP_3 =
  'Check 2 (standup deals reconciled): no connected surface exists for the Q4 pipeline tracker, so the tracker rows cannot be read; name this as the gap and report check 2 as not confirmed in the note.';
/** Run 4 REVOPS-5 step 4, verbatim: the audit comment. */
export const RUN_4_REVOPS_5_STEP_4 =
  'Post the audit note as one save_comment on REVOPS-5: the three checks in order, each with its quoted evidence (tile figure + audit line; Linear ticket states), then one line naming check 2 as not confirmed because no tracker surface is connected.';
/** Run 4 REVOPS-5 step 5, verbatim: the Done on the manager's decision. */
export const RUN_4_REVOPS_5_STEP_5 =
  'Move REVOPS-5 to Done with save_issue only if checks 1 and 3 are confirmed and the manager approves closing with check 2 unconfirmed; otherwise leave the ticket in progress with the comment posted and flag the decision to the manager.';
/** Run 4 REVOPS-5 summary, verbatim. */
export const RUN_4_REVOPS_5_SUMMARY =
  'Complete REVOPS-5 (close-summary audit note): gather evidence for the three Q3 close checks from the connected surfaces (Looker tile, Linear), post the audit note comment on REVOPS-5, then move it to Done. The Q4 pipeline tracker has no connected surface, so check 2 will be reported as not confirmed with the reason.';
/** The deferral phase one declared, as the run's stop reason quoted it. */
export const RUN_4_REVOPS_5_DEFERRED_DESCRIPTION =
  'Move REVOPS-5 to Done via linear save_issue, only if the manager approves closing with check 2 unconfirmed; otherwise leave the ticket in progress.';
export const RUN_4_REVOPS_5_DEFERRED_REASON = "Conditioned on the manager's approval decision";
/** The run 4 stop, verbatim up to the handover's elision: the deferral audit's hard failure with nothing landed. */
export const RUN_4_REVOPS_5_STOP_REASON =
  `executor procedure contract remained invalid after one repair: deferred an action with no result dependency: procedure trail ${RUN_4_REVOPS_5_DEFERRED_DESCRIPTION} is deferred for "${RUN_4_REVOPS_5_DEFERRED_REASON}`;

export const run4AuditNoteObligations: PlanObligations = {
  steps: [
    { kind: 'write', reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'], reason: 'the sign-in, the refresh and the snapshot are on the tile' },
    { kind: 'read', reads: ['linear'], writes: [], reason: 'list_issues on Linear for check 3' },
    { kind: 'report', reads: [], writes: [], reason: 'the tracker has no connected surface; the check is reported, nothing is read' },
    { kind: 'write', reads: [], writes: ['linear'], reason: 'the audit comment on REVOPS-5' },
    { kind: 'conditional-write', reads: [], writes: ['linear'], reason: 'the Done waits on the manager\'s decision to close with check 2 unconfirmed' },
  ],
  transition: 'conditional-on-manager',
  transitionStep: 5,
  basis: 'judgement',
  reason: 'step 5 moves REVOPS-5 to Done only if the manager approves closing with check 2 unconfirmed',
};

export const run4AuditNotePlan: ExecutionPlan = {
  summary: RUN_4_REVOPS_5_SUMMARY,
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
/** REVOPS-5's phase one as the run returned it: the refresh, the read, a prewritten comment, and the Done deferred on the manager's decision in the run's own words. */
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
      description: RUN_4_REVOPS_5_DEFERRED_DESCRIPTION,
      reason: RUN_4_REVOPS_5_DEFERRED_REASON,
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
