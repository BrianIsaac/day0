import { describe, expect, it } from 'vitest';
import { closingResume, resumedClosingLedger } from '../../../src/work/closing-resume';
import type { ExecutionPlan } from '../../../src/work/types';

const plan: ExecutionPlan = {
  summary: 'Audit the tile', steps: ['Read the Looker tile.', 'Read the Linear issues.', 'Comment then close.'],
  expectedOutputType: 'ticket-update', riskNotes: '', reversibility: '', estimatedMinutes: 1,
};
const action = (surface: string, tool: string) => ({ tool: 'mcp.call', args: { surface, tool, toolArgsJson: tool === 'save_comment' ? '{"body":"Audit"}' : '{}' } });
const output = {
  draft: '', notes: '',
  actions: [action('linear', 'list_issues'), action('linear', 'save_comment')],
  applied: [{ tool: 'mcp.call', ok: true }, { tool: 'mcp.call', ok: false }],
  planStepOutcomes: [1, 2, 3].map(step => ({ step, status: 'satisfied', evidence: 'read completed' })),
};

describe('closing resume prerequisites', () => {
  it('does not mistake a comment followed by an unfinished read for a legacy closing boundary', () => {
    expect(closingResume({
      ...output,
      actions: [...output.actions, action('linear', 'get_issue')],
      applied: [output.applied[0], { tool: 'mcp.call', ok: true }, { tool: 'mcp.call', ok: false }],
    }, { ...plan, steps: ['Read Linear issues.', 'Read Linear details.', 'Close.'] }, 'read failed', [
      { slug: 'linear', displayName: 'Linear' },
    ])).toBeUndefined();
  });

  it('does not trust a satisfied outcome when the promised surface read is missing', () => {
    expect(closingResume(output, plan, 'connection failed', [
      { slug: 'linear', displayName: 'Linear' }, { slug: 'looker', displayName: 'Looker' },
    ])).toBeUndefined();
  });
});

describe('landed closing payloads on resume', () => {
  const comment = (body: string, issueId = 'REVOPS-5') => ({
    tool: 'mcp.call' as const, args: { surface: 'linear', tool: 'save_comment', toolArgsJson: JSON.stringify({ body, issueId }) },
  });
  const previous = {
    actions: [comment('Audit')], applied: [{ tool: 'mcp.call', ok: true, effect: 'comment-91', idempotencyKey: 'old' }],
  };
  const run = { workItemId: 'work', runId: 'retry', actionIndexOffset: 5 };

  it('matches JSON payloads independently of property order and records the resumed identity', () => {
    const reordered = { ...comment('Audit'), args: { ...comment('Audit').args, toolArgsJson: '{ "issueId": "REVOPS-5", "body": "Audit" }' } };
    expect(resumedClosingLedger([reordered], previous, run)).toEqual([
      expect.objectContaining({ ok: true, effect: 'comment-91', idempotencyKey: 'work:retry:5', reason: expect.stringContaining('already landed') }),
    ]);
  });

  it('does not skip a changed body, a different target, a held row or an uncertain result', () => {
    expect(resumedClosingLedger([comment('Revised'), comment('Audit', 'REVOPS-6')], previous, run)).toEqual([undefined, undefined]);
    for (const entry of [{ ok: false }, { ok: true, held: true }, { ok: true, awaitingApproval: true }]) {
      expect(resumedClosingLedger([comment('Audit')], { ...previous, applied: [{ tool: 'mcp.call', idempotencyKey: 'old', ...entry }] }, run)).toEqual([undefined]);
    }
  });
});

describe('resuming after a closing gate refusal', () => {
  const surfaces = [{ slug: 'linear', displayName: 'Linear' }, { slug: 'looker', displayName: 'Looker' }];
  const refused = {
    actions: [action('linear', 'save_comment')], planStepOutcomes: [{ step: 3, status: 'satisfied', evidence: 'the comment' }],
    draft: '', notes: '', reason: 'approved plan step 3 promised a Linear read, but no landed read or blocking ledger reason was recorded', at: 1,
  };
  const landed = { tool: 'mcp.call', ok: true, idempotencyKey: 'k' };
  const gateRefusal = {
    phase: 'dependent-authoring', draft: '', notes: '', needsDependentPhase: true,
    actions: [action('looker', 'browser_snapshot'), action('linear', 'list_issues')],
    applied: [landed, landed],
    refusedClosing: refused,
  };

  it('resumes at the closing phase with the refused set when every prerequisite landed', () => {
    expect(closingResume(gateRefusal, plan, refused.reason, surfaces)).toEqual({
      draft: '', notes: '', actions: gateRefusal.actions, applied: gateRefusal.applied,
      needsDependentPhase: true, phase: 'dependent-authoring', resumedClosing: true,
      initialFailure: refused.reason, previousClosing: { actions: refused.actions, applied: [] }, refusedClosing: refused,
    });
    expect(closingResume({ ...gateRefusal, refusedClosing: undefined }, plan, 'cap exceeded', surfaces)).toMatchObject({
      resumedClosing: true, previousClosing: { actions: [], applied: [] },
    });
  });

  it('resumes when a promised-result step names no surface, as the 16 September REVOPS-7 plan does', () => {
    // The run's own words: step 2 promises the read-back without naming the tile surface.
    const runPlan: ExecutionPlan = {
      ...plan,
      steps: [
        'On the looker-pipeline-tile surface, run the documented browser sequence: navigate to http://looker-tile:8080/, fill Username (revops) and Password ({{secret}}), click Sign in, fill Pipeline coverage with 74% exactly (per the runbook, do not compute a figure), click Save.',
        "In the same browser session, take a browser_snapshot and read back the audit line 'Last updated by <user> at <time> UTC' plus the visible figure; if the page redirects, login fails, or the audit line is absent, record the observed failure and stop.",
        'Add an audit comment on REVOPS-7 via linear save_comment quoting the visible figure and the exact audit line as evidence (comment precedes any status change).',
        'Move REVOPS-7 to Done via linear save_issue only if the audit line confirmed the change landed.',
      ],
    };
    const tileSurfaces = [...surfaces, { slug: 'looker-pipeline-tile', displayName: 'Looker pipeline tile' }];
    const tile = (tool: string) => ({ tool: 'mcp.call', args: { surface: 'looker-pipeline-tile', tool, toolArgsJson: '{}' } });
    const prerequisites = [tile('browser_navigate'), tile('browser_fill_form'), tile('browser_click'), tile('browser_snapshot')];
    expect(closingResume({
      ...gateRefusal, actions: prerequisites, applied: prerequisites.map(() => landed),
    }, runPlan, refused.reason, tileSurfaces)).toMatchObject({ resumedClosing: true, phase: 'dependent-authoring' });
    // The flattened-ledger path reads the same rule.
    expect(closingResume({
      draft: '', notes: '', prerequisiteCount: 4,
      actions: [...prerequisites, action('linear', 'save_comment')],
      applied: [...prerequisites.map(() => landed), { tool: 'mcp.call', ok: false, reason: 'Failed to connect to MCP server linear' }],
      planStepOutcomes: [1, 2].map(step => ({ step, status: 'satisfied', evidence: 'ledger row 4: visible figure 74%' })),
    }, runPlan, 'Failed to connect to MCP server linear', tileSurfaces)).toMatchObject({ resumedClosing: true });
    // A named surface that was not read still sends the retry back through phase one.
    expect(closingResume({
      ...gateRefusal, actions: prerequisites.slice(0, 3), applied: prerequisites.slice(0, 3).map(() => landed),
    }, { ...runPlan, steps: [runPlan.steps[0]!, 'Read back the figure from the Looker pipeline tile.', ...runPlan.steps.slice(2)] }, refused.reason, tileSurfaces)).toBeUndefined();
  });

  it('goes back through phase one when a prerequisite did not land or a promised surface was not read', () => {
    expect(closingResume({ ...gateRefusal, applied: [landed, { tool: 'mcp.call', ok: false }] }, plan, refused.reason, surfaces)).toBeUndefined();
    expect(closingResume({ ...gateRefusal, applied: [landed, { ...landed, held: true }] }, plan, refused.reason, surfaces)).toBeUndefined();
    expect(closingResume({ ...gateRefusal, actions: [gateRefusal.actions[1]], applied: [landed] }, plan, refused.reason, surfaces)).toBeUndefined();
    expect(closingResume({ ...gateRefusal, actions: [], applied: [] }, plan, refused.reason, surfaces)).toBeUndefined();
  });
});
