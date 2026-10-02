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

/** The client secret the app presents at the issuer's token endpoint (a confidential client). */
export const CUSTOMER_OIDC_CLIENT_SECRET_VAR = 'DAY0_OIDC_CLIENT_SECRET';

/**
 * The email domains whose people may sign in, comma-separated (decision S2).
 * Checked at the callback and again on the deployment in `getCaller`, against
 * the token's `email` domain and, for Google, its `hd` claim.
 */
export const CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR = 'DAY0_OIDC_ALLOWED_DOMAINS';

/** Seals the browser's session cookie; never leaves the app's server. */
export const CUSTOMER_SESSION_SECRET_VAR = 'DAY0_SESSION_SECRET';

/** The origin people reach the app on, through the customer's proxy. */
export const PUBLIC_URL_VAR = 'DAY0_PUBLIC_URL';

/**
 * The browser bundle's copy of `DAY0_PROFILE`, inlined at `next build`: the
 * browser cannot read a server variable, and it must know before its first
 * render whether it signs people in through the customer's issuer or Clerk.
 */
export const BROWSER_PROFILE_VAR = 'NEXT_PUBLIC_DAY0_PROFILE';

/** Google's issuer, shared by every Google account, which is why its `hd` claim is checked. */
export const GOOGLE_ISSUER = 'https://accounts.google.com';

/** One label of a domain name: letters, digits and inner hyphens. */
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * An issuer URL as two spellings of one issuer compare: trimmed, with no
 * trailing slash. The owner key and the issuer of a caller are compared on
 * this; the discovery check holds `iss` to the configured value byte for byte.
 *
 * @param issuer - The issuer as configured or as a token carries it.
 */
export function issuerKey(issuer: string): string {
  return issuer.trim().replace(/\/+$/, '');
}

/**
 * Whether a token's issuer is Google's, whose accounts all share one issuer.
 *
 * @param issuer - The issuer as a token or the configuration names it.
 */
export function isGoogleIssuer(issuer: string): boolean {
  return issuerKey(issuer) === GOOGLE_ISSUER;
}

/**
 * Read an allowed-domains list: comma- or space-separated domains, trimmed and
 * lower-cased, each a plain DNS name (no `@`, no scheme, no wildcard). A
 * subdomain is its own entry: `acme.com` admits `a@acme.com`, not
 * `a@eu.acme.com`.
 *
 * @param raw - The value as configured.
 * @returns The domains, in order, without repeats; empty when nothing is configured.
 * @throws Error naming the first entry that is not a domain.
 */
export function parseAllowedDomains(raw: string | undefined): readonly string[] {
  const entries = (raw ?? '')
    .split(/[\s,]+/)
    .map((entry: string): string => entry.trim().toLowerCase())
    .filter((entry: string): boolean => entry !== '');
  for (const entry of entries) {
    const labels = entry.split('.');
    if (labels.length < 2 || entry.length > 253 || !labels.every((l) => DOMAIN_LABEL.test(l))) {
      throw new Error(
        `${CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR} holds "${entry}", which is not a domain: list the ` +
          'domains whose people may sign in, such as acme.com,acme.co.uk.',
      );
    }
  }
  return [...new Set(entries)];
}

/**
 * The allowed domains this environment configures.
 *
 * @param read - Reads one environment name.
 * @returns The domains; empty when none are configured.
 * @throws Error when an entry is not a domain.
 */
export function customerOidcAllowedDomains(read: EnvReader): readonly string[] {
  return parseAllowedDomains(readTrimmed(read, CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR));
}

/** The claims the domain rule reads, as a token carries them. */
export interface SignInClaims {
  readonly email?: unknown;
  readonly hd?: unknown;
}

/** Why the domain rule refuses a person. */
export type SignInRefusal = 'no-domains' | 'no-email' | 'foreign-domain' | 'foreign-workspace';

/**
 * Why the address rule refuses a person (the wave 10 review's decision 7 (b)): an issuer the
 * generic preset serves did not verify their address.
 */
export type AddressRefusal = 'unverified-address';

/**
 * Why the deployment refuses a caller the customer's issuer signed (`getCaller`, answered by
 * `config.whoAmI` so the live check can say which): outside the allowed domains, or an address
 * the generic preset requires verified and the issuer did not verify.
 */
export const CALLER_REFUSALS = ['outside-domains', 'unverified-address'] as const;

/** One of {@link CALLER_REFUSALS}. */
export type CallerRefusal = (typeof CALLER_REFUSALS)[number];

/** Every reason the customer sign-in refuses a person the issuer signed in. */
export type CustomerSignInRefusal = SignInRefusal | AddressRefusal;

/** The claims the address rule reads, as a token or a verified identity carries them. */
export interface AddressClaims {
  readonly [claim: string]: unknown;
  readonly email_verified?: unknown;
  /** Convex's spelling of `email_verified` on a verified identity. */
  readonly emailVerified?: unknown;
  /** Entra's "the address's domain owner is verified" (S4). */
  readonly xms_edov?: unknown;
}

/**
 * What a token says of its address's verification, in either spelling: `true` only when every
 * spelling present is `true`, the first other value when one is not (a `false`, a string, a JSON
 * null neither verifies nor reads as absent), undefined when neither is present. An OIDC
 * provider's `email_verified` reaches a Convex function mapped to `emailVerified`; a custom JWT
 * provider's (the local issuer's) arrives raw as `email_verified`, which a self-hosted backend was
 * seen to do on 1 October; two spellings that disagree verify nothing whichever comes first (the
 * wave 9 review's U1-m1).
 *
 * @param claims - The token's claims.
 */
export function emailVerifiedClaim(claims: AddressClaims): unknown {
  const said = [claims.emailVerified, claims.email_verified].filter(
    (claim: unknown) => claim !== undefined,
  );
  if (said.length === 0) return undefined;
  return said.every((claim: unknown) => claim === true)
    ? true
    : said.find((claim: unknown) => claim !== true);
}

/**
 * Whether a customer issuer's token asserts its address verified (D3, S4): its `email_verified`
 * decides when it sends one; else Entra's `xms_edov` when it sends that (a boolean `true`
 * verifies, anything else is the issuer's word against it); only with neither does the
 * deployment's declared trust (`DAY0_OIDC_EMAIL_TRUSTED`) decide. The one rule the sign-in's
 * callback and the deployment's `getCaller` share.
 *
 * @param claims - The token's claims.
 * @param emailTrusted - Whether the deployment declares the issuer authoritative for `email`.
 */
export function customerAddressVerified(claims: AddressClaims, emailTrusted: boolean): boolean {
  const claim = emailVerifiedClaim(claims);
  if (claim !== undefined) return claim === true;
  if (claims.xms_edov !== undefined) return claims.xms_edov === true;
  return emailTrusted;
}

/** What a refused person reads, by reason. Never repeats the address. */
export const SIGN_IN_REFUSAL_WORDS: Readonly<Record<SignInRefusal, string>> = {
  'no-domains':
    'This installation names no domains whose people may sign in, so nobody can. Ask whoever installed Day0 to set them.',
  'no-email':
    'Your sign-in does not carry an email address, and Day0 admits people by the domain of their address. Ask your administrator to send the email claim.',
  'foreign-domain':
    'Your account is not in a domain this installation admits. Sign in with your work account, or ask whoever installed Day0 to add your domain.',
  'foreign-workspace':
    'Your Google account does not belong to a Google Workspace this installation admits. Sign in with your work account.',
};

/** What a refused person reads, by every reason the customer sign-in refuses. Never repeats the address. */
export const CUSTOMER_SIGN_IN_REFUSAL_WORDS: Readonly<Record<CustomerSignInRefusal, string>> = {
  ...SIGN_IN_REFUSAL_WORDS,
  'unverified-address':
    'Your identity provider has not verified your email address, and this installation admits only verified addresses. Ask your administrator to verify it, then sign in again.',
};

/**
 * The domain rule (decision S2): whether a person the issuer signed in may use
 * this installation. The token's `email` must be in an allowed domain; for
 * Google, whose issuer every Google account shares, the `hd` claim (the
 * Workspace the account belongs to) must be one too, since a personal account
 * can carry any address Google has seen. Run at the callback and again in
 * `getCaller`, so a token forced past the first is refused by the second.
 *
 * @param claims - The verified token's claims.
 * @param allowedDomains - The configured domains; empty refuses everyone.
 * @param issuer - The token's issuer.
 * @returns The refusal, or undefined when the person is admitted.
 */
export function signInRefusal(
  claims: SignInClaims,
  allowedDomains: readonly string[],
  issuer: string,
): SignInRefusal | undefined {
  if (allowedDomains.length === 0) return 'no-domains';
  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return 'no-email';
  // ASCII folding only, as addresses are compared everywhere else (`manager-address.ts`).
  const fold = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (!allowedDomains.includes(fold(email.slice(at + 1)))) return 'foreign-domain';
  if (isGoogleIssuer(issuer)) {
    const workspace = typeof claims.hd === 'string' ? fold(claims.hd.trim()) : '';
    if (!allowedDomains.includes(workspace)) return 'foreign-workspace';
  }
  return undefined;
}
