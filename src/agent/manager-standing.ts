import { sameManagerAddress } from './manager-address';

/**
 * Where an employee's address stands against its owner's: the account that
 * owns an employee is its manager (the ruling of 30 September), so an
 * employee whose `bossEmail` is not its owner's verified address is flagged
 * and the owner chooses to hand it over or make the address their own. Nothing
 * is rewritten by itself: its DMs keep going where they went until the owner
 * acts (D17 (a), the transfer plan section 11.2).
 */

/**
 * The standings an employee's address can have. `you`: the owner's own
 * address. `other`: someone else's, which the owner is asked about.
 * `unverified`: the owner's sign-in asserts no verified address, so nothing
 * can be compared. `evaluation`: an evaluation employee, whose reserved
 * address is its run's marker and is never flagged (section 10.6).
 */
export const MANAGER_STANDINGS = ['you', 'other', 'unverified', 'evaluation'] as const;

/** One of {@link MANAGER_STANDINGS}. */
export type ManagerStandingKind = (typeof MANAGER_STANDINGS)[number];

/** The employee reports to the owner's own verified address. */
export interface ManagerStandingYou {
  readonly standing: 'you';
}

/** The employee reports to an address that is not the owner's. */
export interface ManagerStandingOther {
  readonly standing: 'other';
  /** The address the employee reports to, as the row stores it. */
  readonly bossEmail: string;
}

/** The owner's sign-in asserts no verified address to compare with. */
export interface ManagerStandingUnverified {
  readonly standing: 'unverified';
}

/** An evaluation employee, whose address is fixed by its run. */
export interface ManagerStandingEvaluation {
  readonly standing: 'evaluation';
}

/** An employee's standing, by kind. */
export type ManagerStanding =
  | ManagerStandingYou
  | ManagerStandingOther
  | ManagerStandingUnverified
  | ManagerStandingEvaluation;

/** What the standing is decided from. */
export interface ManagerStandingInput {
  /** The employee's `bossEmail`, in whatever spelling an older release stored. */
  readonly bossEmail: string;
  /** The owner's verified address, normalised, or undefined when the sign-in asserts none. */
  readonly callerAddress: string | undefined;
  /** Whether the employee belongs to an evaluation run. */
  readonly evaluation: boolean;
}

/**
 * The standing of one employee's address against its owner's verified one,
 * compared through the one address comparison, so an older row's spelling
 * (`Boss@Day0.local`) is still the owner's.
 */
export function managerStandingOf(input: ManagerStandingInput): ManagerStanding {
  if (input.evaluation) return { standing: 'evaluation' };
  if (input.callerAddress === undefined) return { standing: 'unverified' };
  if (sameManagerAddress(input.bossEmail, input.callerAddress)) return { standing: 'you' };
  return { standing: 'other', bossEmail: input.bossEmail };
}

/**
 * The refusal an owner meets making the address their own while their
 * sign-in asserts no verified address. A `ConvexError`'s data, so the People
 * tab can show it.
 */
export const UNVERIFIED_FOR_ADOPTION =
  'Your sign-in does not carry a verified email address, so it cannot become the address this employee reports to. Verify your address, then sign in again.';

/**
 * The refusal an owner meets making an evaluation employee's address their
 * own: that address is its run's marker.
 */
export const EVALUATION_ADDRESS_FIXED =
  "An evaluation employee's manager address is fixed by its run, so it cannot be made yours.";
