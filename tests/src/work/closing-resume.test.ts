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

  it('goes back through phase one when a prerequisite did not land or a promised surface was not read', () => {
    expect(closingResume({ ...gateRefusal, applied: [landed, { tool: 'mcp.call', ok: false }] }, plan, refused.reason, surfaces)).toBeUndefined();
    expect(closingResume({ ...gateRefusal, applied: [landed, { ...landed, held: true }] }, plan, refused.reason, surfaces)).toBeUndefined();
    expect(closingResume({ ...gateRefusal, actions: [gateRefusal.actions[1]], applied: [landed] }, plan, refused.reason, surfaces)).toBeUndefined();
    expect(closingResume({ ...gateRefusal, actions: [], applied: [] }, plan, refused.reason, surfaces)).toBeUndefined();
  });
});
