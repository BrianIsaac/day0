import { describe, expect, it } from 'vitest';
import { charterSchema } from '../../../src/agent/charter';

const base = {
  whyThisHire: 'Own triage.',
  proposedFunction: 'Revenue operations triage',
  evidence: [],
  shortTermGoals: { day30: 'Draft', day60: 'Triage', day90: 'Maintain' },
  proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
  namedCollaborators: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'manager', confidence: 'high' as const },
  openQuestions: [],
};

describe('charter named systems', (): void => {
  it('requires and accepts structured named systems', (): void => {
    expect(charterSchema.safeParse(base).success).toBe(false);
    expect(
      charterSchema.safeParse({
        ...base,
        namedSystems: [
          { name: 'Linear', class: 'kanban', whereMentioned: 'Work lives in Linear.' },
        ],
      }).success,
    ).toBe(true);
  });
});
