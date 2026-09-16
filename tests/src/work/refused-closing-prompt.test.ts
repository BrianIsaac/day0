import { describe, expect, it } from 'vitest';
import { REFUSED_CLOSING_PROMPT_CHARS, refusedClosingLines } from '../../../src/work/execute-skill';
import type { MockAction } from '../../../src/work/types';
import type { RefusedClosing } from '../../../src/work/types';

/**
 * The refused closing set as the retry's closing prompt shows it: every
 * action visible, each one bounded on its own, and a clip named as a clip
 * so the model corrects the refusal rather than the cut.
 */

const call = (surface: string, tool: string, args: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call', args: { surface, tool, toolArgsJson: JSON.stringify(args) },
});
const dm: MockAction = {
  tool: 'http.request',
  args: { surface: 'slack', method: 'POST', path: '/chat.postMessage', headersJson: '{}', body: JSON.stringify({ channel: 'D0MANAGER', text: 'REVOPS-7: comment and Done held for you.' }) },
};
const refused = (actions: MockAction[]): RefusedClosing => ({
  actions,
  planStepOutcomes: [{ step: 3, status: 'satisfied', evidence: 'the audit comment in this response' }],
  draft: '', notes: '',
  reason: 'dependent phase omitted the approved ticket state transition without a blocked plan step',
  at: 1,
});

describe('the refused closing set in the retry prompt', (): void => {
  it('shows every action on its own line and clips only the long one, saying so', (): void => {
    const long = 'Refreshed the tile. '.repeat(600);
    const lines = refusedClosingLines(refused([call('linear', 'save_comment', { issueId: 'REVOPS-7', body: long }), dm]));
    const text = lines.join('\n');
    expect(text).toContain('REVOPS-7: comment and Done held for you.');
    expect(text).toContain('save_comment');
    expect(text).toMatch(/clipped after \d+ of \d+ characters; the row keeps the whole payload/);
    expect(text).not.toContain('... (truncated)');
    expect(text.length).toBeLessThan(REFUSED_CLOSING_PROMPT_CHARS + 1000);
  });

  it('shows a short set whole', (): void => {
    const lines = refusedClosingLines(refused([call('linear', 'save_comment', { issueId: 'REVOPS-7', body: 'Refreshed the tile to 74%.' }), dm]));
    const text = lines.join('\n');
    expect(text).toContain('Refreshed the tile to 74%.');
    expect(text).not.toContain('clipped');
    expect(text).toContain('Refusal: dependent phase omitted the approved ticket state transition without a blocked plan step');
    expect(text).toContain('3 satisfied (the audit comment in this response)');
  });
});
