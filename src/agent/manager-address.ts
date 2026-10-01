/**
 * The manager's address: the one shape check, the one spelling and the one
 * comparison every reader of an address shares. The account that owns an
 * employee is its manager (the ruling of 30 September), so the address a
 * deploy stores, a handover names and an acceptance proves are all compared
 * here, never ad hoc.
 */

/** The longest address a mailbox can have (RFC 5321's path limit). */
export const MAX_MANAGER_ADDRESS_LENGTH = 254;

/** One `@`, a dotted domain and no spaces: enough to refuse a typo, not a validator. */
const MANAGER_ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The reserved addresses the evaluation harness deploys under: `eval-` and at
 * least one more character, at the product's own `day0.local` domain, which
 * no real mailbox has. Compared on the normalised spelling.
 */
const EVALUATION_ADDRESS_SHAPE = /^eval-[^\s@]+@day0\.local$/;

/**
 * The address the local issuer vouches for when the operator configures none
 * (`NEXT_PUBLIC_DEMO_BOSS_EMAIL`): the browser's label and the token's claim
 * fall back to the same one.
 */
export const DEFAULT_LOCAL_MANAGER_ADDRESS = 'boss@day0.local';

/** The refusal a manager reads for an address that is not shaped like one. */
export const MANAGER_ADDRESS_REFUSAL =
  'The manager must be an email address, such as name@company.com.';

/**
 * Whether a value, trimmed, is shaped like a mailbox address and fits one.
 *
 * @param address - The address as given.
 */
export function isManagerAddressShaped(address: string): boolean {
  const trimmed = address.trim();
  return trimmed.length <= MAX_MANAGER_ADDRESS_LENGTH && MANAGER_ADDRESS_SHAPE.test(trimmed);
}

/**
 * The one spelling of an address: trimmed and lower-cased.
 *
 * @param address - The address as given, or nothing.
 * @returns The normalised address, or undefined when there is none or it is not shaped like one.
 */
export function normaliseManagerAddress(address: string | undefined): string | undefined {
  if (address === undefined || !isManagerAddressShaped(address)) return undefined;
  return address.trim().toLowerCase();
}

/**
 * Whether two values name one mailbox. A value that is not shaped like an
 * address names none, so it matches nothing, itself included.
 */
export function sameManagerAddress(left: string, right: string): boolean {
  const normalised = normaliseManagerAddress(left);
  return normalised !== undefined && normalised === normaliseManagerAddress(right);
}

/**
 * Whether an address is one the evaluation harness reserves. An evaluation
 * employee's address is its evaluation marker, so such an address is never a
 * person's: a handover may not name one, and deploy takes one only from the
 * harness on an evaluation bed.
 *
 * @param address - The address as given.
 */
export function isEvaluationShapedAddress(address: string): boolean {
  const normalised = normaliseManagerAddress(address);
  return normalised !== undefined && EVALUATION_ADDRESS_SHAPE.test(normalised);
}
