import { describe, expect, it } from 'vitest';
import { closingResume } from '../../../src/work/closing-resume';
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
  it('does not trust a satisfied outcome when the promised surface read is missing', () => {
    expect(closingResume(output, plan, 'connection failed', [
      { slug: 'linear', displayName: 'Linear' }, { slug: 'looker', displayName: 'Looker' },
    ])).toBeUndefined();
  });
});
