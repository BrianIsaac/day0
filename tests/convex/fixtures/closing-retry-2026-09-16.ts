import type { AppliedAction } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction } from '../../../src/work/types';

const call = (surface: string, tool: string, args: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call', args: { surface, tool, toolArgsJson: JSON.stringify(args) },
});

export const auditRetryPlan: ExecutionPlan = {
  summary: 'Read the tile and issue list, then record the audit note and close REVOPS-5.',
  steps: [
    'Sign in and read the Looker pipeline tile with its audit line.',
    'Read the Linear issue list for the audit note.',
    'Add the audit comment to REVOPS-5 in Linear, then move it to Done.',
  ],
  expectedOutputType: 'ticket-update', riskNotes: '', reversibility: 'Reopen the issue.', estimatedMinutes: 2,
};
export const auditPrerequisites = [
  call('looker-pipeline-tile', 'browser_navigate', { url: 'http://looker-tile:8080/' }),
  call('looker-pipeline-tile', 'browser_fill_form', { fields: [{ name: 'Username', value: 'revops' }, { name: 'Password', value: '{{secret}}' }] }),
  call('looker-pipeline-tile', 'browser_click', { element: 'Sign in' }),
  call('looker-pipeline-tile', 'browser_snapshot', {}),
  call('linear', 'list_issues', { project: 'Q3 close' }),
];
export const auditPrerequisiteLedger: AppliedAction[] = auditPrerequisites.map((action, index) => ({
  tool: action.tool, ok: true, idempotencyKey: `previous-run:${index}`,
  effect: index === 3 ? 'visible figure 74%; Last updated by revops at 2026-09-16 00:15:00 UTC'
    : index === 4 ? 'REVOPS-5: audit-note item, Todo' : 'Sign-in step succeeded',
}));
export const auditClosing = {
  draft: 'Record the audit note and close REVOPS-5.', notes: '',
  actions: [
    call('linear', 'save_comment', { issueId: 'REVOPS-5', body: 'Audit note: pipeline coverage is 74%. Last updated by revops at 2026-09-16 00:15:00 UTC. Followed the audit-note runbook.' }),
    call('linear', 'save_issue', { id: 'REVOPS-5', state: 'Done' }),
  ],
  procedureTrails: [],
  planStepOutcomes: [
    { step: 1, status: 'satisfied', basis: 'ledger', evidence: 'Tile read-back: 74% and audit line.' },
    { step: 2, status: 'satisfied', basis: 'ledger', evidence: 'Linear list_issues returned REVOPS-5.' },
    { step: 3, status: 'satisfied', basis: 'ledger', evidence: 'The audit comment and Done move in this closing set.' },
  ],
};
export const closingTransportFailure = 'Failed to connect to MCP server linear';
