import { describe, expect, it } from 'vitest';
import { day1Script } from '../../../src/agent/day-one-prompts';

describe('day1Script', (): void => {
  it('promises only what onboarding does after the 1:1, with no good-habits research (N19)', (): void => {
    const script = day1Script();
    expect(script).toContain(
      'After the conversation I synthesise a charter v0.0 with provenance tagging, write IDENTITY.md and TOOLS.md, and surface the work queue.',
    );
    expect(script).not.toMatch(/research/i);
  });
});
