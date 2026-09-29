import { ConvexError } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { EMPLOYEE_NOT_YOURS, isEmployeeNotYours } from '../../../src/agent/employee-access';

describe('isEmployeeNotYours', (): void => {
  it("knows the backend's refusal of another owner's employee", (): void => {
    expect(isEmployeeNotYours(new ConvexError(EMPLOYEE_NOT_YOURS))).toBe(true);
  });

  it('takes any other failure for a crash, the same words in a plain Error included', (): void => {
    expect(isEmployeeNotYours(new Error(EMPLOYEE_NOT_YOURS))).toBe(false);
    expect(isEmployeeNotYours(new ConvexError('Surface not found.'))).toBe(false);
    expect(isEmployeeNotYours(undefined)).toBe(false);
  });
});
