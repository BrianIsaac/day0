import { describe, expect, it } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import { identityFromCharter, userFromManager } from '../../../src/agent/charter-workspace';
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

  it('writes the identity file with no em dash, in its headings or its relationships (13.3)', (): void => {
    const identity = identityFromCharter(charter, 'priya@day0.local');
    expect(identity).not.toContain('\u2014');
    expect(identity).toContain('## Boundaries: what I will do');
    expect(identity).toContain('## Boundaries: what I will NOT do');
    expect(identity).toContain('- Priya: pipeline (intro path: manager)');
  });

  it('renders a draft with no manager section until approval names one', (): void => {
    expect(identityFromCharter(charter)).not.toContain('## Manager');
  });
});

describe('userFromManager', (): void => {
  it('names the manager on the Boss line, as the draft and a handover write it', (): void => {
    expect(userFromManager('lead@kestrel.example')).toBe('# USER\n\nBoss: lead@kestrel.example\n');
  });
});
