import { describe, expect, it } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import { identityFromCharter } from '../../../src/agent/charter-workspace';
import { runThroughBody } from '../../fixtures/run-through-charter-2026-09-14';

describe('identityFromCharter', (): void => {
  const charter: Charter = runThroughBody();

  it('names the agent row’s manager as who approves, never the charter’s own approval chain (U9 D3 (b))', (): void => {
    const identity = identityFromCharter(
      { ...charter, approvalChain: { boss: 'the finance lead', confidence: 'low' } },
      'priya@day0.local',
    );
    expect(identity).toContain('## Manager (who approves)\n- priya@day0.local\n');
    expect(identity).not.toContain('the finance lead');
    expect(identity.indexOf('## Manager (who approves)')).toBeLessThan(
      identity.indexOf('## Key relationships'),
    );
  });

  it('renders a draft with no manager section until approval names one', (): void => {
    expect(identityFromCharter(charter)).not.toContain('## Manager');
  });
});
