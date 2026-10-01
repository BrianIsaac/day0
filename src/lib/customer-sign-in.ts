import { DEV_NO_AUTH } from './dev-auth';

/**
 * Whether this build signs people in through the customer's own issuer (the
 * customer-local profile's browser half), read from the bundle's copy of the
 * profile, `NEXT_PUBLIC_DAY0_PROFILE`, which `next build` inlines. Client-safe:
 * the browser must know before its first render whether to draw Clerk or the
 * customer's sign-in, and it cannot read `DAY0_PROFILE` itself.
 *
 * The literal `process.env` read is what Next inlines into the client.
 */
const requested = process.env.NEXT_PUBLIC_DAY0_PROFILE?.trim() === 'customer-local';

if (requested && DEV_NO_AUTH) {
  throw new Error(
    'NEXT_PUBLIC_DAY0_PROFILE=customer-local and NEXT_PUBLIC_DEV_NO_AUTH=true ask the browser for ' +
      'two sign-ins. A customer install signs people in through its issuer: clear ' +
      'NEXT_PUBLIC_DEV_NO_AUTH, or clear NEXT_PUBLIC_DAY0_PROFILE to develop with the local key.',
  );
}

/** True when this build signs people in through the customer's issuer. */
export const CUSTOMER_SIGN_IN: boolean = requested;

/** The value the browser copy must hold when the server runs the customer-local profile. */
export const CUSTOMER_LOCAL_PROFILE = 'customer-local';

/**
 * Why this server cannot serve the customer sign-in although the build asked
 * for it, or undefined when it can: the server's `DAY0_PROFILE` must say the
 * same as the build's copy, or the browser and the server would sign people
 * in two different ways. The build's copy is fixed at `next build`; the
 * server's is read at each request. The local key under `next dev` stays a
 * way in on a customer-local server (the operator's own), so a build with it
 * on and without the copy is not a mismatch.
 *
 * @param serverProfile - `DAY0_PROFILE` as the server reads it now.
 */
export function profileMismatch(serverProfile: string | undefined): string | undefined {
  const server = serverProfile?.trim() || 'local-dev';
  const serverCustomer = server === CUSTOMER_LOCAL_PROFILE;
  if (CUSTOMER_SIGN_IN === serverCustomer || (serverCustomer && DEV_NO_AUTH)) return undefined;
  return CUSTOMER_SIGN_IN
    ? `This build signs people in through the customer's issuer (NEXT_PUBLIC_DAY0_PROFILE=customer-local), and the server runs DAY0_PROFILE=${server}. Set DAY0_PROFILE=customer-local, or rebuild without the browser copy.`
    : `The server runs DAY0_PROFILE=customer-local, and this build was made without NEXT_PUBLIC_DAY0_PROFILE=customer-local, so the browser would not use the customer's sign-in. Set it in the env file, then run pnpm build again.`;
}
