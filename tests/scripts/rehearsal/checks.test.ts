import { describe, expect, it } from 'vitest';
import {
  browserSequenceOf,
  checkBrowserBatchHeldWhole,
  checkClosingCommentQuotesReadBack,
  checkCompletion,
  checkPlanWithoutOwnershipGate,
  checkWrongKeyReadRepaired,
  OWNERSHIP_GATE,
  readBackOf,
  type WorkItemView,
} from '../../../scripts/rehearsal/checks';

const TILE = 'looker-pipeline-tile';
const AUDIT = 'Last updated by revops at 2026-09-15 09:12:00 UTC';

function mcp(surface: string, tool: string, args: Record<string, unknown>) {
  return { tool: 'mcp.call', args: { surface, tool, toolArgsJson: JSON.stringify(args) } };
}

const tileActions = [
  mcp(TILE, 'browser_navigate', { url: 'http://looker-tile:8080/' }),
  mcp(TILE, 'browser_fill_form', { fields: [{ name: 'Username', value: 'revops' }] }),
  mcp(TILE, 'browser_click', { element: 'Sign in' }),
  mcp(TILE, 'browser_fill_form', { fields: [{ name: 'Pipeline coverage', value: '74%' }] }),
  mcp(TILE, 'browser_click', { element: 'Save' }),
  mcp(TILE, 'browser_snapshot', {}),
];

const parked: WorkItemView = {
  state: 'actions-pending',
  plan: { steps: ['Sign in to the tile', 'Enter 74% and save', 'Read back the audit line and comment on REVOPS-7'] },
  actionVerdicts: [{ disposition: 'auto' }, ...tileActions.map(() => ({ disposition: 'held' as const }))],
  output: {
    actions: [mcp('linear', 'get_issue', { issueId: 'REVOPS-7' }), ...tileActions],
    applied: [
      {
        tool: 'mcp.call',
        ok: true,
        authority: 'standing',
        effect: '{"identifier":"REVOPS-7"}',
        repair: { reason: 'Tool input validation failed', toolArgsJson: '{"issueId":"REVOPS-7"}' },
      },
      ...tileActions.map(() => ({ tool: 'mcp.call', ok: false, held: true, awaitingApproval: true })),
    ],
  },
};

describe('check 1: the plan has no ownership gate', (): void => {
  it('passes a runbook plan and fails a plan that verifies ownership or priority first', (): void => {
    expect(checkPlanWithoutOwnershipGate(parked)).toMatchObject({ passed: true });
    const gated: WorkItemView = {
      ...parked,
      plan: { steps: ['Open REVOPS-7 in Linear to confirm it is owned and prioritized', 'Refresh the tile'] },
    };
    const result = checkPlanWithoutOwnershipGate(gated);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('step 1');
    expect(OWNERSHIP_GATE.test('Read back the visible 74% and the audit line')).toBe(false);
  });

  it('fails when the audit had to mark a step advisory, and when there is no plan', (): void => {
    expect(
      checkPlanWithoutOwnershipGate({ ...parked, plan: { steps: ['x'], advisorySteps: [1] } }).passed,
    ).toBe(false);
    expect(checkPlanWithoutOwnershipGate({ state: 'claimed' }).passed).toBe(false);
  });
});

describe('check 2: the browser batch is held whole in phase one', (): void => {
  it('passes six held tile rows behind an auto read, in the runbook order', (): void => {
    const result = checkBrowserBatchHeldWhole(parked, TILE);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('6');
    expect(browserSequenceOf(parked, TILE).map((row) => row.tool)).toEqual([
      'browser_navigate',
      'browser_fill_form',
      'browser_click',
      'browser_fill_form',
      'browser_click',
      'browser_snapshot',
    ]);
  });

  it('fails when a tile row is missing, split, or not held', (): void => {
    const oneRead: WorkItemView = {
      ...parked,
      actionVerdicts: [{ disposition: 'auto' }],
      output: { actions: [parked.output!.actions![0]!], applied: [parked.output!.applied![0]!] },
    };
    expect(checkBrowserBatchHeldWhole(oneRead, TILE).passed).toBe(false);
    const applied: WorkItemView = {
      ...parked,
      actionVerdicts: parked.actionVerdicts!.map((v, i) => (i === 1 ? { disposition: 'auto' } : v)),
    };
    expect(checkBrowserBatchHeldWhole(applied, TILE).detail).toContain('not held');
  });
});

describe('check 3: a wrong-key read is repaired once when it occurs', (): void => {
  it('passes with the repair recorded on the landed read', (): void => {
    const result = checkWrongKeyReadRepaired(parked);
    expect(result).toMatchObject({ passed: true });
    expect(result.detail).toContain('repaired once');
  });

  it('passes as not needed when the read landed first time, and fails on a read left failed', (): void => {
    const clean: WorkItemView = {
      ...parked,
      output: { ...parked.output, applied: [{ tool: 'mcp.call', ok: true, authority: 'standing' }] },
    };
    expect(checkWrongKeyReadRepaired(clean)).toMatchObject({ passed: true });
    expect(checkWrongKeyReadRepaired(clean).detail).toContain('not needed');
    const failed: WorkItemView = {
      ...parked,
      output: {
        ...parked.output,
        applied: [{ tool: 'mcp.call', ok: false, reason: 'Tool input validation failed' }],
      },
    };
    expect(checkWrongKeyReadRepaired(failed).passed).toBe(false);
  });
});

describe('check 4: the closing comment quotes the read-back', (): void => {
  const closing: WorkItemView = {
    state: 'actions-pending',
    actionVerdicts: [{ disposition: 'auto' }, { disposition: 'held' }, { disposition: 'held' }],
    output: {
      actions: [
        { tool: 'http.request', args: { surface: 'slack', path: '/chat.postMessage' } },
        mcp('linear', 'save_comment', {
          issueId: 'REVOPS-7',
          body: `Refreshed the tile: visible figure 74%. Audit evidence: ${AUDIT}.`,
        }),
        mcp('linear', 'save_issue', { id: 'REVOPS-7', state: 'Done' }),
      ],
      initial: {
        actions: parked.output!.actions,
        applied: [
          parked.output!.applied![0]!,
          ...tileActions.slice(0, 5).map(() => ({ tool: 'mcp.call', ok: true, authority: 'manager' })),
          {
            tool: 'mcp.call',
            ok: true,
            authority: 'manager',
            effect: `Pipeline coverage: visible figure 74% · ${AUDIT}`,
          },
        ],
      },
    },
  };

  it('finds the figure and the audit line in the snapshot row and in the held comment', (): void => {
    expect(readBackOf(closing)).toEqual({ figure: '74%', auditLine: AUDIT });
    const result = checkClosingCommentQuotesReadBack(closing);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('save_comment');
  });

  it('fails when the comment does not quote the audit line, or is not held', (): void => {
    const thin: WorkItemView = {
      ...closing,
      output: {
        ...closing.output,
        actions: [
          closing.output!.actions![0]!,
          mcp('linear', 'save_comment', { issueId: 'REVOPS-7', body: 'Done, 74%.' }),
          closing.output!.actions![2]!,
        ],
      },
    };
    expect(checkClosingCommentQuotesReadBack(thin).passed).toBe(false);
    const auto: WorkItemView = {
      ...closing,
      actionVerdicts: closing.actionVerdicts!.map(() => ({ disposition: 'auto' as const })),
    };
    expect(checkClosingCommentQuotesReadBack(auto).detail).toContain('held');
  });
});

describe('check 5: completion', (): void => {
  it('passes a completed item whose steps are all accounted for and whose ticket is Done with the comment', (): void => {
    const done: WorkItemView = {
      state: 'completed',
      output: { planStepOutcomes: [{ status: 'satisfied' }, { status: 'not-verifiable' }] },
    };
    const result = checkCompletion(done, {
      stateName: 'Done',
      newComments: [`Refreshed: visible figure 74%. ${AUDIT} -- rehearsal worker (Day0) · run wi_1/run_2`],
    });
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('Done');
  });

  it('fails on a blocked step, a ticket not Done, or no new comment', (): void => {
    const done: WorkItemView = { state: 'completed', output: { planStepOutcomes: [{ status: 'blocked' }] } };
    expect(checkCompletion(done, { stateName: 'Done', newComments: ['x'] }).passed).toBe(false);
    const ok: WorkItemView = { state: 'completed', output: { planStepOutcomes: [{ status: 'satisfied' }] } };
    expect(checkCompletion(ok, { stateName: 'Backlog', newComments: ['x'] }).passed).toBe(false);
    expect(checkCompletion(ok, { stateName: 'Done', newComments: [] }).passed).toBe(false);
    expect(checkCompletion({ state: 'failed' }, { stateName: 'Done', newComments: ['x'] }).passed).toBe(false);
  });
});
