import { ConvexError } from 'convex/values';

/**
 * The refusal the employee page's read answers for an employee another owner holds. It is a
 * `ConvexError`'s data, so it survives production's error stripping and the page's boundary can
 * tell it from a crash.
 */
export const EMPLOYEE_NOT_YOURS = 'This employee is not yours.';

/**
 * Whether a thrown value is the backend refusing an employee the caller does not own.
 *
 * @param error - What a query threw.
 */
export function isEmployeeNotYours(error: unknown): boolean {
  return error instanceof ConvexError && error.data === EMPLOYEE_NOT_YOURS;
}
