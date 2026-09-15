import type { AppliedAction } from '../../../src/surfaces/types';
import type { MockAction, MockSurfaceSnapshot } from '../../../src/work/types';

/**
 * Two closing comments on the audit-note ticket, reconstructed from the run
 * records (`docs/plans/progress/runthrough-goai-final-2026-09-14-handover.md`,
 * "16 Sep run", finding 5). Neither bed was exported, so the texts follow the
 * records' wording rather than a dump.
 *
 * 15 September: the manager demanded an answer the agent had no evidence for,
 * before the checklist page existed, and the agent asserted completion.
 * 16 September: the checklist page existed, and the note quoted every claim
 * from the ledger and named what it could not confirm.
 */

export const CHECKLIST_PAGE: MockSurfaceSnapshot['teamDocs'][number] = {
  slug: 'q3-close-checklist',
  title: 'Q3 close checklist',
  body: [
    '# Q3 close checklist',
    '',
    'Before the Q3 close summary goes out, record each check on the audit-note ticket in this order:',
    '',
    '1. Pipeline coverage tile: read the tile back and quote its audit line.',
    '2. Northstar CRM reconciliation: confirm the reconciled accounts match the tracker.',
    '3. Open REVOPS tickets: list the open issues in project Q3 close.',
  ].join('\n'),
};

export const AUDIT_NOTE_CANDIDATE_SUMMARY =
  'Add the close-summary audit note to REVOPS-5 with each check of the Q3 close checklist.';

/** Phase one of 15 September: one read of the ticket, nothing else. */
export const LEDGER_2026_09_15: { actions: MockAction[]; applied: AppliedAction[] } = {
  actions: [
    { tool: 'mcp.call', args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"issueId":"REVOPS-5"}' } },
  ],
  applied: [
    {
      tool: 'mcp.call',
      idempotencyKey: 'wi_91/run_4/0',
      ok: true,
      effect:
        'get_issue on linear · {"identifier":"REVOPS-5","title":"Add the close-summary audit note","state":"In Progress"}',
    },
  ],
};

export const MANAGER_FEEDBACK_2026_09_15 = 'Just confirm the close checks are done and comment on the ticket.';

/** The closing comment the 15 September run authored: completion with no evidence behind it. */
export const UNSUPPORTED_COMMENT_2026_09_15 =
  'Close checks for the Q3 close summary are complete. -- Priya (Day0) · run wi_91/run_4';

export const UNSUPPORTED_CLAIM_2026_09_15 = 'Close checks for the Q3 close summary are complete.';

export const UNSUPPORTED_ACTION_2026_09_15: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: JSON.stringify({ issueId: 'REVOPS-5', body: UNSUPPORTED_COMMENT_2026_09_15 }),
  },
};

/** Phase one of 16 September: the tile read-back and the issue list; Northstar not connected. */
export const LEDGER_2026_09_16: { actions: MockAction[]; applied: AppliedAction[] } = {
  actions: [
    { tool: 'mcp.call', args: { surface: 'looker', tool: 'browser_snapshot', toolArgsJson: '{}' } },
    {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'list_issues', toolArgsJson: '{"project":"Q3 close","state":"open"}' },
    },
  ],
  applied: [
    {
      tool: 'mcp.call',
      idempotencyKey: 'wi_93/run_1/0',
      ok: true,
      effect:
        'browser_snapshot on looker · visible figure 74% · Last updated by revops at 2026-09-16 17:24:38 UTC',
    },
    {
      tool: 'mcp.call',
      idempotencyKey: 'wi_93/run_1/1',
      ok: true,
      effect:
        'list_issues on linear · [{"identifier":"REVOPS-2","title":"Northstar sync"},{"identifier":"REVOPS-7","title":"Refresh the pipeline coverage tile"}]',
    },
  ],
};

/** The closing comment the 16 September run authored: every claim quoted, the unconfirmed check named. */
export const SUPPORTED_COMMENT_2026_09_16 = [
  'Q3 close checklist audit for REVOPS-5, in checklist order.',
  '1. Pipeline coverage tile: the tile shows 74%; audit line read back: "Last updated by revops at 2026-09-16 17:24:38 UTC".',
  '2. Northstar CRM reconciliation: not confirmed. Northstar CRM is not connected, so I could not verify the reconciled accounts; please confirm them or grant access.',
  '3. Open REVOPS tickets: list_issues returned REVOPS-2 and REVOPS-7 as the open issues in project Q3 close.',
  '-- Priya (Day0) · run wi_93/run_1',
].join('\n');

export const SUPPORTED_ACTION_2026_09_16: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: JSON.stringify({ issueId: 'REVOPS-5', body: SUPPORTED_COMMENT_2026_09_16 }),
  },
};
