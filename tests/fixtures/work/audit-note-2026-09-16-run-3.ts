import type { AppliedAction } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';

/**
 * The 16 September third run's REVOPS-5 retry: the manager's note, the
 * ledger the retry's phase one landed, and the audit comment the closing
 * phase posted, verbatim from the fix brief
 * (`docs/research/briefs/retry-reentry-and-audit-note-2026-09-16-brief.md`).
 * Check 3's own evidence shows both sibling tickets in Backlog, yet the
 * closing line names only check 2, mirroring the manager's note.
 */

export const RUN_3_RETRY_NOTE = 'Yes, move REVOPS-5 to Done, I accept check 2 unconfirmed.';

export const RUN_3_AUDIT_LINE = 'Last updated by revops at 2026-09-16 07:42:48 UTC';

/** The retry's phase one: the tile read back at 74% and the Q3 close issue list. */
export const LEDGER_2026_09_16_RUN_3: { actions: MockAction[]; applied: AppliedAction[] } = {
  actions: [
    { tool: 'mcp.call', args: { surface: 'looker-pipeline-tile', tool: 'browser_snapshot', toolArgsJson: '{}' } },
    {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'list_issues', toolArgsJson: '{"team":"REVOPS","project":"Q3 close"}' },
    },
  ],
  applied: [
    {
      tool: 'mcp.call',
      idempotencyKey: 'wi_95/run_2/3',
      ok: true,
      effect: `browser_snapshot on looker-pipeline-tile · visible figure 74% · ${RUN_3_AUDIT_LINE}`,
    },
    {
      tool: 'mcp.call',
      idempotencyKey: 'wi_95/run_2/4',
      ok: true,
      effect:
        'list_issues on linear · REVOPS-5 Add the close-summary audit note (In Progress); REVOPS-6 Reconcile Northstar CRM ownership (Backlog); REVOPS-7 Refresh the Looker pipeline tile (Backlog)',
    },
  ],
};

/** The comment the retry posted: check 3 reads as unmet, the closing line names check 2 only. */
export const RUN_3_RETRY_COMMENT = [
  'Q3 close summary — three checks, evidence as read from the system that holds it.',
  `1. Pipeline coverage confirmed. The Looker pipeline tile shows 74%; audit line: ${RUN_3_AUDIT_LINE}.`,
  '2. Friday standup deals reconciled. Deal reconciliation not confirmed — no tracker connected (no approved surface exists for the Q4 pipeline tracker).',
  '3. Close tickets at Done. As Linear reports them: REVOPS-6 (Reconcile Northstar CRM ownership) — Backlog; REVOPS-7 (Refresh the Looker pipeline tile) — Backlog.',
  'Not confirmed: check 2, deal reconciliation — no Q4 pipeline tracker connected. Manager has accepted check 2 unconfirmed and approved moving this ticket to Done.',
].join('\n');

/** The same comment with the closing line derived from the checks' own evidence. */
export const RUN_3_RETRY_COMMENT_CORRECTED = RUN_3_RETRY_COMMENT.replace(
  'Not confirmed: check 2, deal reconciliation — no Q4 pipeline tracker connected.',
  'Not confirmed: checks 2 and 3 — deal reconciliation has no Q4 pipeline tracker connected, and REVOPS-6 and REVOPS-7 are at Backlog, not Done.',
);

export const RUN_3_RETRY_ACTION: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: JSON.stringify({ issueId: 'REVOPS-5', body: RUN_3_RETRY_COMMENT }),
  },
};

export const RUN_3_RETRY_ACTION_CORRECTED: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: JSON.stringify({ issueId: 'REVOPS-5', body: RUN_3_RETRY_COMMENT_CORRECTED }),
  },
};
