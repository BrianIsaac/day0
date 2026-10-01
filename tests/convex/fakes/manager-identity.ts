import type { UserIdentity } from 'convex/server';
import { DEV_NO_AUTH_ISSUER, DEV_NO_AUTH_SUBJECT } from '../../../src/lib/dev-auth-issuer';

/**
 * The address a fixture's manager signs in with unless the test names
 * another: the local default, which most fixtures' `agents` rows already
 * carry as `bossEmail`.
 */
export const MANAGER_ADDRESS = 'boss@day0.local';

/** The subject a fixture's owner signs in as unless the test names another. */
export const OWNER_SUBJECT = 'owner';

/**
 * The address a fixture account signs in with by default: {@link MANAGER_ADDRESS}
 * for the owner, and one of its own for every other subject, so two accounts
 * never share an address (a handover names an address, and only its account
 * may answer it).
 */
export function fixtureAddressOf(subject: string): string {
  if (subject === OWNER_SUBJECT) return MANAGER_ADDRESS;
  return `${subject.toLowerCase().replace(/[^a-z0-9.+-]+/g, '-')}@day0.local`;
}

/** The claims a fixture's caller presents, as convex-test's `withIdentity` takes them. */
export interface ManagerIdentity {
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly issuer?: string;
}

/**
 * The identity of a manager signed in with a verified address, for
 * `harness.withIdentity(...)`. The account that owns an employee is its
 * manager, and its address is the one its token proves (the transfer plan,
 * section 3.2), so every fixture that signs a caller in gives it one; convex-
 * test hands `email` and `emailVerified` to `ctx.auth` unchanged (U-5,
 * `tests/convex/ownership.test.ts`). This is the shape an OIDC provider's
 * token arrives in (Clerk, the customer's issuer); the local issuer's arrives
 * otherwise, which {@link localIssuerIdentity} gives.
 *
 * @param subject - The token's subject, which is the owner key for Clerk and the local issuer;
 *   its address is {@link fixtureAddressOf} the subject unless `claims` names another.
 * @param claims - Any claim to set otherwise: another address, an unverified one
 *   (`emailVerified: false`), no address (`email: undefined`), or another issuer.
 * @returns The identity to pass to `withIdentity`.
 */
export function managerIdentity(
  subject = OWNER_SUBJECT,
  claims: Omit<ManagerIdentity, 'subject'> = {},
): ManagerIdentity & Partial<UserIdentity> {
  return { subject, email: fixtureAddressOf(subject), emailVerified: true, ...claims };
}

/**
 * The local operator as a self-hosted backend hands the local token to
 * `ctx.auth`: the local issuer is a custom JWT provider, whose claims arrive
 * raw, so its verification is `email_verified` and not `emailVerified` (seen
 * on the 9-U1 bed, 1 October). convex-test passes the object through, so a
 * fixture that means the real local caller uses this.
 *
 * @param address - The configured manager address the token names.
 */
export function localIssuerIdentity(address = MANAGER_ADDRESS): Partial<UserIdentity> {
  return {
    subject: DEV_NO_AUTH_SUBJECT,
    issuer: DEV_NO_AUTH_ISSUER,
    email: address,
    email_verified: true,
  };
}
