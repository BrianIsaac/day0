import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
}));

import { WORK_GEN_SYSTEM } from '../../../src/agent/work-generator';

describe('generated demo work prompt', (): void => {
  it('derives role mismatch from the runtime charter without naming the seeded office', (): void => {
    expect(WORK_GEN_SYSTEM).not.toMatch(/RevOps|revenue operations/i);
    expect(WORK_GEN_SYSTEM).toContain('outside the role described in the charter');
  });
});
