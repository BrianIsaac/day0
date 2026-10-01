import { GOOGLE_ISSUER, isGoogleIssuer } from './customer-oidc';

/**
 * What differs between the identity providers the install kit is set up
 * against: how the issuer URL is formed, the scopes that bring back a refresh
 * token, the extra authorisation parameters, how the client authenticates at
 * the token endpoint, and which claim says the address is verified. Read by
 * the sign-in routes, the setup verb and the checks, so all three agree.
 */

/** The providers the setup verb and the guides know, and any other OpenID Connect issuer. */
export const CUSTOMER_OIDC_PROVIDERS = ['entra', 'okta', 'google', 'oidc'] as const;

/** One of {@link CUSTOMER_OIDC_PROVIDERS}. */
export type CustomerOidcProvider = (typeof CUSTOMER_OIDC_PROVIDERS)[number];

/** How the app authenticates at the issuer's token endpoint. */
export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post';

/** One provider's settings. */
export interface CustomerOidcPreset {
  readonly provider: CustomerOidcProvider;
  /** The provider's name in a sentence. */
  readonly label: string;
  readonly scopes: readonly string[];
  /** Extra parameters on the authorisation request. */
  readonly authorizationParameters: Readonly<Record<string, string>>;
  readonly clientAuth: ClientAuthMethod;
  /** The claim that says the address is verified: `email_verified`, or Entra's `xms_edov`. */
  readonly verifiedAddressClaim: 'email_verified' | 'xms_edov';
}

/** The scopes an issuer that grants refresh tokens through `offline_access` is asked for. */
const OFFLINE_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;

/** Every provider's settings. */
export const CUSTOMER_OIDC_PRESETS: Readonly<Record<CustomerOidcProvider, CustomerOidcPreset>> = {
  entra: {
    provider: 'entra',
    label: 'Microsoft Entra ID',
    scopes: OFFLINE_SCOPES,
    authorizationParameters: {},
    clientAuth: 'client_secret_post',
    verifiedAddressClaim: 'xms_edov',
  },
  okta: {
    provider: 'okta',
    label: 'Okta',
    scopes: OFFLINE_SCOPES,
    authorizationParameters: {},
    clientAuth: 'client_secret_basic',
    verifiedAddressClaim: 'email_verified',
  },
  google: {
    provider: 'google',
    label: 'Google Workspace',
    // Google grants a refresh token through `access_type=offline`, not a scope,
    // and only at the first consent unless `prompt=consent` asks again (O4).
    scopes: ['openid', 'email', 'profile'],
    authorizationParameters: { access_type: 'offline', prompt: 'consent' },
    clientAuth: 'client_secret_post',
    verifiedAddressClaim: 'email_verified',
  },
  oidc: {
    provider: 'oidc',
    label: 'an OpenID Connect issuer',
    scopes: OFFLINE_SCOPES,
    authorizationParameters: {},
    clientAuth: 'client_secret_basic',
    verifiedAddressClaim: 'email_verified',
  },
};

/** Entra's host; an issuer on it is Entra's, whatever tenant it names. */
const ENTRA_HOST = 'login.microsoftonline.com';

/** Entra's multi-tenant aliases, which are never an issuer a token carries. */
const ENTRA_ALIASES = new Set(['common', 'organizations', 'consumers']);

/** A tenant id: Entra's issuer names the tenant by its GUID, never by a domain. */
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The provider an issuer belongs to, read off its URL: Google's one issuer,
 * Entra's host, and everything else an issuer the generic settings fit (Okta's
 * included, whose settings are the generic ones but for client authentication).
 *
 * @param issuer - The issuer URL.
 * @param named - The provider the setup verb was told, which wins for an Okta issuer.
 */
export function providerOfIssuer(
  issuer: string,
  named?: CustomerOidcProvider,
): CustomerOidcProvider {
  if (isGoogleIssuer(issuer)) return 'google';
  let host = '';
  try {
    host = new URL(issuer).hostname.toLowerCase();
  } catch {
    // Not a URL: the issuer reader refuses it with its own words; the generic settings stand meanwhile.
    host = '';
  }
  if (host === ENTRA_HOST) return 'entra';
  if (named === 'okta' || /\.(okta|oktapreview|okta-emea)\.com$/.test(host)) return 'okta';
  return 'oidc';
}

/**
 * Entra's issuer for one tenant (O3): per tenant, never `common`, which no
 * token carries and which would admit every Microsoft account.
 *
 * @param tenantId - The directory (tenant) id, a GUID.
 * @throws Error for an alias or anything that is not a tenant id.
 */
export function entraIssuer(tenantId: string): string {
  const tenant = tenantId.trim().toLowerCase();
  if (ENTRA_ALIASES.has(tenant)) {
    throw new Error(
      `"${tenant}" admits accounts from every Microsoft tenant and is never the issuer a token carries. ` +
        "Give the directory (tenant) id from the app registration's Overview page.",
    );
  }
  if (!TENANT_ID.test(tenant)) {
    throw new Error(
      'The directory (tenant) id is a GUID such as 3f2504e0-4f89-11d3-9a0c-0305e82c3301, from the ' +
        "app registration's Overview page.",
    );
  }
  return `https://${ENTRA_HOST}/${tenant}/v2.0`;
}

/**
 * Okta's issuer (O5): the org authorisation server, `https://{domain}`, or a
 * custom one, `https://{domain}/oauth2/{id}` (`default` is the one Okta makes).
 *
 * @param domain - The Okta domain, such as `acme.okta.com`, with or without `https://`.
 * @param server - The custom authorisation server's id, or `org` (or nothing) for the org server.
 * @throws Error when the domain is not a host name or the server id is not one.
 */
export function oktaIssuer(domain: string, server?: string): string {
  const host = domain
    .trim()
    .replace(/^https:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    throw new Error('The Okta domain is a host name such as acme.okta.com.');
  }
  const id = server?.trim() ?? '';
  if (id === '' || id === 'org') return `https://${host}`;
  if (!/^[A-Za-z0-9]+$/.test(id)) {
    throw new Error(
      'The authorisation server id is letters and digits, such as default or aus1a2b3c4.',
    );
  }
  return `https://${host}/oauth2/${id}`;
}

/** The issuer every Google Workspace account signs in through. */
export function googleIssuer(): string {
  return GOOGLE_ISSUER;
}
