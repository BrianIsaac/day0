import type { EnvReader } from './hosted-markers';

/**
 * The customer's own OpenID Connect issuer, which a customer-local deployment
 * signs people in with (A7). Read by the backend's auth config, the surface
 * mode gate and `check:setup`, so all three agree on what "an issuer is
 * configured" means.
 */

/** The issuer URL, exactly as tokens carry it in `iss`. */
export const CUSTOMER_OIDC_ISSUER_VAR = 'DAY0_OIDC_ISSUER';

/** The client id tokens carry in `aud`; the deployment refuses a token for anyone else. */
export const CUSTOMER_OIDC_AUDIENCE_VAR = 'DAY0_OIDC_AUDIENCE';

/**
 * Declares the customer issuer authoritative for the addresses it puts in
 * `email` when it sends no `email_verified` claim (decision D3). Several
 * enterprise issuers omit the claim; without this flag such an address is
 * not believed, since a self-service issuer would let anyone claim any
 * address and so take any employee handed to it.
 */
export const CUSTOMER_OIDC_EMAIL_TRUSTED_VAR = 'DAY0_OIDC_EMAIL_TRUSTED';

/** A configured customer issuer. */
export interface CustomerOidcIssuer {
  readonly issuer: string;
  readonly audience: string;
}

/** One name's trimmed value, or undefined when it is unset, empty or unreadable. */
function readTrimmed(read: EnvReader, name: string): string | undefined {
  let value: string | undefined;
  try {
    value = read(name);
  } catch {
    // The Convex auth config throws for a name the deployment has no value for.
    return undefined;
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The customer issuer this environment configures, if any.
 *
 * The issuer is where the deployment fetches the keys that decide who anyone
 * is, so it must be a plain `https:` URL: no credentials, no query, no
 * fragment. The refusal never repeats the value, which may carry a password.
 *
 * @param read - Reads one environment name.
 * @returns The issuer and audience, or undefined when no issuer is set.
 * @throws Error when an issuer is set but malformed, or set without an audience.
 */
export function customerOidcIssuer(read: EnvReader): CustomerOidcIssuer | undefined {
  const issuer = readTrimmed(read, CUSTOMER_OIDC_ISSUER_VAR);
  if (!issuer) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(issuer);
  } catch {
    url = undefined;
  }
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      `${CUSTOMER_OIDC_ISSUER_VAR} must be the issuer's https:// URL exactly as its tokens ` +
        'carry it in `iss`, with no credentials, query or fragment.',
    );
  }
  const audience = readTrimmed(read, CUSTOMER_OIDC_AUDIENCE_VAR);
  if (!audience) {
    throw new Error(
      `${CUSTOMER_OIDC_ISSUER_VAR} is set without ${CUSTOMER_OIDC_AUDIENCE_VAR}: set it to the ` +
        "client id the issuer's tokens carry in `aud`, or the deployment could not tell a token " +
        'minted for day0 from one minted for any other application.',
    );
  }
  return { issuer, audience };
}

/**
 * Whether this environment declares the customer issuer's `email` claim
 * verified when the issuer sends no `email_verified` (D3). Only `true` turns
 * it on, so a typo never widens whose address is believed.
 *
 * @param read - Reads one environment name.
 */
export function customerOidcEmailTrusted(read: EnvReader): boolean {
  return readTrimmed(read, CUSTOMER_OIDC_EMAIL_TRUSTED_VAR)?.toLowerCase() === 'true';
}
