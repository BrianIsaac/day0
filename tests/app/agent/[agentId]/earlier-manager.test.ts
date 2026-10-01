import { describe, expect, it } from 'vitest';
import { managerAt, READER_MANAGED } from '../../../../app/agent/[agentId]/earlier-manager';

const EARLIER = [
  { fromAddress: 'first@company.com', decidedAt: 2_000 },
  { fromAddress: 'second@company.com', decidedAt: 5_000 },
];

describe('managerAt', (): void => {
  it('names the manager a later handover took the employee from, the first one after the moment', (): void => {
    expect(managerAt(1_000, EARLIER, 'third@company.com')).toEqual({
      kind: 'earlier',
      address: 'first@company.com',
    });
    expect(managerAt(3_000, EARLIER, 'third@company.com')).toEqual({
      kind: 'earlier',
      address: 'second@company.com',
    });
  });

  it('is the reader after the last handover, with none, and where the handover came from the reader', (): void => {
    expect(managerAt(6_000, EARLIER, 'third@company.com')).toBe(READER_MANAGED);
    expect(managerAt(1_000, [], 'third@company.com')).toBe(READER_MANAGED);
    // A handover back: the reader held the employee before, under the same address.
    expect(managerAt(1_000, EARLIER, 'First@Company.com')).toBe(READER_MANAGED);
  });
});
