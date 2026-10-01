import {
  CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR,
  CUSTOMER_OIDC_CLIENT_SECRET_VAR,
  CUSTOMER_OIDC_ISSUER_VAR,
  CUSTOMER_SESSION_SECRET_VAR,
  PUBLIC_URL_VAR,
  customerOidcAllowedDomains,
  customerOidcIssuer,
} from './customer-oidc';
import { SIGN_IN_TRANSACTION_PATH, sessionSecretGap } from './customer-session';
import { errorMessage } from './errors';
import type { EnvReader } from './hosted-markers';

/**
 * The company sign-in's settings as plain values: what is missing, the public
 * origin, and the two addresses the issuer must have registered. No network
 * and no `server-only` marker, so the routes, the setup verb and both checks
 * read them alike.
 */

/** The process's own environment, read at call time so a restart picks up a change. */
export function serverEnv(name: string): string | undefined {
  return process.env[name];
}

/**
 * The public origin, or why it cannot be one: an `http(s)` URL with no path,
 * query or credentials. An `http:` origin is accepted here (a bed on this
 * machine); `check:setup` holds a customer install to https.
 *
 * @param raw - `DAY0_PUBLIC_URL` as configured.
 */
export function publicOrigin(raw: string | undefined): { origin: string } | { gap: string } {
  const value = raw?.trim() ?? '';
  if (value === '') {
    return {
      gap: `${PUBLIC_URL_VAR} is not set: the origin people reach Day0 on, such as https://day0.acme.com.`,
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { gap: `${PUBLIC_URL_VAR} is not a URL.` };
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    return {
      gap: `${PUBLIC_URL_VAR} must be an origin only, such as https://day0.acme.com, with no path, query or credentials.`,
    };
  }
  return { origin: url.origin };
}

/**
 * What is missing or malformed for the sign-in, one line each; empty when it
 * can run. Shared by the routes (which refuse with it) and `check:setup`.
 *
 * @param read - Reads one environment name.
 */
export function customerSignInGaps(read: EnvReader = serverEnv): string[] {
  const gaps: string[] = [];
  try {
    if (!customerOidcIssuer(read)) gaps.push(`${CUSTOMER_OIDC_ISSUER_VAR} is not set.`);
  } catch (err) {
    gaps.push(errorMessage(err));
  }
  if (!read(CUSTOMER_OIDC_CLIENT_SECRET_VAR)?.trim()) {
    gaps.push(`${CUSTOMER_OIDC_CLIENT_SECRET_VAR} is not set.`);
  }
  try {
    if (customerOidcAllowedDomains(read).length === 0) {
      gaps.push(`${CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR} is not set, so nobody may sign in.`);
    }
  } catch (err) {
    gaps.push(errorMessage(err));
  }
  const secretGap = sessionSecretGap(read(CUSTOMER_SESSION_SECRET_VAR));
  if (secretGap) gaps.push(secretGap);
  const origin = publicOrigin(read(PUBLIC_URL_VAR));
  if ('gap' in origin) gaps.push(origin.gap);
  return gaps;
}

/**
 * The redirect URI to register at the issuer, and the one every request names.
 *
 * @param publicUrl - The public origin.
 */
export function redirectUriOf(publicUrl: string): string {
  return `${publicUrl}${SIGN_IN_TRANSACTION_PATH}`;
}

/** The post-sign-out URI to register: the sign-out route's own page. */
export function signedOutUriOf(publicUrl: string): string {
  return `${publicUrl}/api/auth/oidc/logout`;
}
