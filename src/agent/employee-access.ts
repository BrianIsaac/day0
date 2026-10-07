import { ConvexError } from 'convex/values';

/**
 * The refusal the employee page's read answers for an employee another owner holds. It is a
 * `ConvexError`'s data, so it survives production's error stripping and the page's boundary can
 * tell it from a crash.
 */
export const EMPLOYEE_NOT_YOURS = 'This employee is not yours.';

/**
 * The refusal a per-agent guard answers for an employee that no longer exists (retired or
 * deleted), as a `ConvexError`'s data, so a dialog says it after production's error stripping.
 */
export const EMPLOYEE_GONE = 'This employee no longer exists.';

/*
 * The row guards' refusals (the wave 12 review's W12-R25): one for a row that does not exist and
 * one of an employee the caller does not own, so an id confirms nothing, as 13-K's people and
 * agreement guards answer. Each is a `ConvexError`'s data.
 */

/** The refusal of a work item the caller does not own, the same for one that does not exist. */
export const WORK_ITEM_NOT_YOURS = 'This work item is not yours.';

/** The refusal of a charter the caller does not own, the same for one that does not exist. */
export const CHARTER_NOT_YOURS = 'This charter is not yours.';

/** The refusal of a skill the caller does not own, the same for one that does not exist. */
export const SKILL_NOT_YOURS = 'This skill is not yours.';

/**
 * The refusal of a connection card the caller does not own, the same for one that does not exist
 * (W13-R13, W12-R25's one-refusal shape).
 */
export const SURFACE_NOT_YOURS = 'This connection is not yours.';

/** The refusal of a one-to-one the caller does not own, the same for one that does not exist. */
export const ONE_TO_ONE_NOT_YOURS = 'This one-to-one is not yours.';

/**
 * Whether a thrown value is the backend refusing an employee the caller does not own.
 *
 * @param error - What a query threw.
 */
export function isEmployeeNotYours(error: unknown): boolean {
  return error instanceof ConvexError && error.data === EMPLOYEE_NOT_YOURS;
}
