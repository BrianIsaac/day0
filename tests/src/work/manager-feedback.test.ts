import { describe, expect, it } from 'vitest';
import { managerFeedbackLabel } from '../../../src/work/manager-feedback';

describe('managerFeedbackLabel', (): void => {
  it("names a cancelled plan's reason by the card's own control, Cancel", (): void => {
    expect(managerFeedbackLabel({ kind: 'plan-rejection' })).toBe('Plan cancel reason');
  });

  it('names a retry note and a rejection reason as the manager gave them', (): void => {
    expect(managerFeedbackLabel({ kind: 'retry-note' })).toBe('Retry note');
    expect(managerFeedbackLabel({ kind: 'rejection' })).toBe('Rejection reason');
  });
});
