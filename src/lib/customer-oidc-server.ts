import 'server-only';
import * as oidc from 'openid-client';
import {
  CUSTOMER_OIDC_CLIENT_SECRET_VAR,
  CUSTOMER_SESSION_SECRET_VAR,
  PUBLIC_URL_VAR,
  customerOidcAllowedDomains,
  customerOidcIssuer,
  signInRefusal,
  type SignInRefusal,
} from './customer-oidc';
import {
  CUSTOMER_OIDC_PRESETS,
  providerOfIssuer,
  type CustomerOidcPreset,
} from './customer-oidc-presets';
import {
  CUSTOMER_SESSION_MAX_SECONDS,
  SIGN_IN_TRANSACTION_SECONDS,
  type CustomerSession,
  type SignInTransaction,
} from './customer-session';
import {
  customerSignInGaps,
  publicOrigin,
  redirectUriOf,
  serverEnv,
  signedOutUriOf,
} from './customer-sign-in-settings';
import type { EnvReader } from './hosted-markers';
import { errorMessage } from './errors';
import { log } from './logger';

/**
 * The customer-local sign-in's protocol half (decision S1): OpenID Connect
 * authorisation code with PKCE, state and nonce, as a confidential client on
 * the app's server, through `openid-client` (the certified relying-party
 * library). The route handlers under `app/api/auth/oidc/` are thin wrappers
 * over this module and `customer-oidc-routes.ts`.
 */

/** Everything the sign-in needs, read and checked from the server's environment. */
export interface CustomerSignInSettings {
  readonly issuer: string;
  /** The client id: also the audience Convex checks (`DAY0_OIDC_AUDIENCE`). */
  readonly clientId: string;
  readonly clientSecret: string;
  readonly allowedDomains: readonly string[];
  /** The origin people reach the app on, without a trailing slash. */
  readonly publicUrl: string;
  readonly sessionSecret: string;
  readonly preset: CustomerOidcPreset;
}

/** The sign-in could not be set up from this environment; the message lists what is missing. */
export class CustomerSignInUnavailable extends Error {
  /** One line per missing or malformed value. */
  readonly gaps: readonly string[];

  /**
   * @param gaps - One line per missing or malformed value.
   */
  constructor(gaps: readonly string[]) {
    super(`The company sign-in is not set up: ${gaps.join(' ')}`);
    this.gaps = gaps;
  }
}

/**
 * The sign-in's settings.
 *
 * @param read - Reads one environment name.
 * @throws CustomerSignInUnavailable listing every gap.
 */
export function customerSignInSettings(read: EnvReader = serverEnv): CustomerSignInSettings {
  const gaps = customerSignInGaps(read);
  const issuer = gaps.length === 0 ? customerOidcIssuer(read) : undefined;
  const origin = publicOrigin(read(PUBLIC_URL_VAR));
  if (!issuer || 'gap' in origin) throw new CustomerSignInUnavailable(gaps);
  return {
    issuer: issuer.issuer,
    clientId: issuer.audience,
    clientSecret: read(CUSTOMER_OIDC_CLIENT_SECRET_VAR)?.trim() ?? '',
    allowedDomains: customerOidcAllowedDomains(read),
    publicUrl: origin.origin,
    sessionSecret: read(CUSTOMER_SESSION_SECRET_VAR)?.trim() ?? '',
    preset: CUSTOMER_OIDC_PRESETS[providerOfIssuer(issuer.issuer)],
  };
}

/** How long a discovered configuration is reused before the issuer is asked again. */
const DISCOVERY_REUSE_MS = 60 * 60 * 1000;

/** The seconds every request to the issuer may take. */
const ISSUER_TIMEOUT_SECONDS = 10;

interface DiscoveredConfiguration {
  readonly key: string;
  readonly at: number;
  readonly configuration: Promise<oidc.Configuration>;
}

interface SharedRefresh {
  readonly at: number;
  readonly outcome: Promise<RefreshOutcome>;
}

/**
 * How long one refresh is shared: every request that arrives for the same
 * refresh token while it runs, and for a minute after, gets its outcome. Two
 * tabs refreshing at once must not spend a rotating refresh token twice, which
 * the issuer answers by refusing the second and ending the session.
 */
const REFRESH_SHARED_MS = 60_000;

/**
 * The issuer as this server process talks to it: the discovered configuration,
 * held for an hour so a refresh does not fetch the discovery document every
 * time, and the refreshes in flight, shared per refresh token. One
 * `next start` process serves an install, so one instance is the whole cache;
 * a failed discovery is dropped at once so the next request asks again.
 */
class IssuerConnection {
  #discovered: DiscoveredConfiguration | undefined;
  readonly #refreshes = new Map<string, SharedRefresh>();

  /**
   * The issuer's configuration for this client.
   *
   * @param settings - The sign-in's settings.
   * @param now - The current time in milliseconds.
   * @throws Error when the issuer cannot be reached or its metadata names another issuer.
   */
  async configuration(settings: CustomerSignInSettings, now: number): Promise<oidc.Configuration> {
    const key = `${settings.issuer}\n${settings.clientId}\n${settings.clientSecret}`;
    const held = this.#discovered;
    if (held && held.key === key && now - held.at < DISCOVERY_REUSE_MS) return held.configuration;
    const clientAuth =
      settings.preset.clientAuth === 'client_secret_post'
        ? oidc.ClientSecretPost(settings.clientSecret)
        : oidc.ClientSecretBasic(settings.clientSecret);
    const configuration = oidc.discovery(
      new URL(settings.issuer),
      settings.clientId,
      { client_secret: settings.clientSecret },
      clientAuth,
      { timeout: ISSUER_TIMEOUT_SECONDS },
    );
    const entry: DiscoveredConfiguration = { key, at: now, configuration };
    this.#discovered = entry;
    try {
      return await configuration;
    } catch (err) {
      if (this.#discovered === entry) this.#discovered = undefined;
      throw err;
    }
  }

  /**
   * The outcome of refreshing with one refresh token, shared while it is fresh.
   *
   * @param refreshToken - The token presented.
   * @param now - The current time in milliseconds.
   * @param perform - Asks the issuer; called only when no shared outcome is held.
   */
  shareRefresh(
    refreshToken: string,
    now: number,
    perform: () => Promise<RefreshOutcome>,
  ): Promise<RefreshOutcome> {
    for (const [token, shared] of this.#refreshes) {
      if (now - shared.at >= REFRESH_SHARED_MS) this.#refreshes.delete(token);
    }
    const held = this.#refreshes.get(refreshToken);
    if (held) return held.outcome;
    const outcome = perform();
    this.#refreshes.set(refreshToken, { at: now, outcome });
    return outcome;
  }
}

/** This process's connection to the issuer; replaced only by the test seam below. */
let connection = new IssuerConnection();

/** Start from a fresh connection: a test's fresh issuer needs fresh metadata. */
export function __resetIssuerConnectionForTest(): void {
  connection = new IssuerConnection();
}

/**
 * The issuer's configuration for this client.
 *
 * @param settings - The sign-in's settings.
 * @param now - The current time in milliseconds.
 * @throws Error when the issuer cannot be reached or its metadata names another issuer.
 */
export async function issuerConfiguration(
  settings: CustomerSignInSettings,
  now: number = Date.now(),
): Promise<oidc.Configuration> {
  return connection.configuration(settings, now);
}

/**
 * A same-origin path to land on after sign-in, or `/`. Anything that could
 * leave the origin (`//host`, `/\host`, a scheme) or loop back into the
 * sign-in routes is replaced.
 *
 * @param raw - The path the visitor asked for.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  const value = raw ?? '';
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.startsWith('/\\') ||
    value.length > 2_048 ||
    /[\u0000-\u001f]/.test(value) ||
    value.startsWith('/api/auth/oidc/')
  ) {
    return '/';
  }
  return value;
}

/** A started sign-in: where to send the browser, and the transaction to seal for the callback. */
export interface StartedSignIn {
  readonly location: string;
  readonly transaction: SignInTransaction;
}

/**
 * Start a sign-in: state, nonce and a PKCE verifier, and the issuer's
 * authorisation URL that names them.
 *
 * @param settings - The sign-in's settings.
 * @param input - Where to land afterwards, and the live check's id when the check started it.
 * @param now - The current time in milliseconds.
 */
export async function startSignIn(
  settings: CustomerSignInSettings,
  input: { readonly returnTo: string; readonly checkId?: string },
  now: number = Date.now(),
): Promise<StartedSignIn> {
  const configuration = await issuerConfiguration(settings, now);
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const location = oidc.buildAuthorizationUrl(configuration, {
    ...settings.preset.authorizationParameters,
    redirect_uri: redirectUriOf(settings.publicUrl),
    scope: settings.preset.scopes.join(' '),
    response_type: 'code',
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return {
    location: location.href,
    transaction: {
      version: 1,
      state,
      nonce,
      codeVerifier,
      returnTo: input.returnTo,
      ...(input.checkId ? { checkId: input.checkId } : {}),
      expiresAt: now + SIGN_IN_TRANSACTION_SECONDS * 1000,
    },
  };
}

/** The verified claims of an ID token, as the callback and the token route read them. */
export type IdTokenClaims = Readonly<Record<string, unknown>> & {
  readonly iss: string;
  readonly sub: string;
  readonly exp: number;
};

/** How a callback ended. */
export type FinishedSignIn =
  | {
      readonly kind: 'signed-in';
      readonly session: CustomerSession;
      readonly claims: IdTokenClaims;
    }
  | { readonly kind: 'refused'; readonly reason: SignInRefusal; readonly claims: IdTokenClaims }
  | { readonly kind: 'failed'; readonly detail: string };

/**
 * Finish a sign-in at the callback: check the state, exchange the code with
 * the PKCE verifier, check the ID token (signature, issuer, audience, expiry
 * and nonce, by `openid-client`), then the domain rule.
 *
 * @param settings - The sign-in's settings.
 * @param transaction - The transaction the login route sealed.
 * @param search - The callback's query string, as the issuer sent it.
 * @param now - The current time in milliseconds.
 */
export async function finishSignIn(
  settings: CustomerSignInSettings,
  transaction: SignInTransaction,
  search: string,
  now: number = Date.now(),
): Promise<FinishedSignIn> {
  // Built from the public origin, never from the request the proxy forwarded: the redirect URI
  // the code is exchanged with must be the registered one byte for byte.
  const callbackUrl = new URL(`${redirectUriOf(settings.publicUrl)}${search}`);
  let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
  try {
    const configuration = await issuerConfiguration(settings, now);
    tokens = await oidc.authorizationCodeGrant(configuration, callbackUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    });
  } catch (err) {
    return { kind: 'failed', detail: errorMessage(err) };
  }
  const claims = tokens.claims() as IdTokenClaims | undefined;
  if (!claims || !tokens.id_token) return { kind: 'failed', detail: 'the issuer sent no ID token' };
  const refusal = signInRefusal(
    { email: claims.email, hd: claims.hd },
    settings.allowedDomains,
    settings.issuer,
  );
  if (refusal) return { kind: 'refused', reason: refusal, claims };
  return {
    kind: 'signed-in',
    claims,
    session: {
      version: 1,
      idToken: tokens.id_token,
      idTokenExpiresAt: claims.exp * 1000,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      startedAt: now,
      expiresAt: now + CUSTOMER_SESSION_MAX_SECONDS * 1000,
    },
  };
}

/** The most a token is refreshed ahead of its expiry. */
export const REFRESH_AHEAD_MS = 5 * 60 * 1000;

/**
 * Whether an ID token is in its last minutes: within five minutes of expiry,
 * or past half its life for a token issued for less than ten minutes (a
 * two-minute token is refreshed at its first minute, not at once).
 *
 * @param session - The session holding the token.
 * @param issuedAt - The token's `iat`, in milliseconds.
 * @param now - The current time in milliseconds.
 */
export function needsRefresh(session: CustomerSession, issuedAt: number, now: number): boolean {
  const lifetime = Math.max(0, session.idTokenExpiresAt - issuedAt);
  const ahead = Math.min(REFRESH_AHEAD_MS, lifetime / 2);
  return session.idTokenExpiresAt - now <= ahead;
}

/** How a refresh ended. */
export type RefreshOutcome =
  | {
      readonly kind: 'refreshed';
      readonly session: CustomerSession;
      readonly claims: IdTokenClaims;
    }
  /** The issuer refused the refresh token, or the refreshed person is refused: the session ends. */
  | { readonly kind: 'refused'; readonly detail: string }
  /** The issuer could not be reached or failed: the session stands and the browser tries again. */
  | { readonly kind: 'unavailable'; readonly detail: string };

/**
 * Refresh a session's ID token with its refresh token.
 *
 * @param settings - The sign-in's settings.
 * @param session - The session to refresh.
 * @param now - The current time in milliseconds.
 */
export async function refreshSession(
  settings: CustomerSignInSettings,
  session: CustomerSession,
  now: number = Date.now(),
): Promise<RefreshOutcome> {
  const refreshToken = session.refreshToken;
  if (!refreshToken) {
    return { kind: 'refused', detail: 'the issuer granted no refresh token' };
  }
  return connection.shareRefresh(refreshToken, now, () =>
    performRefresh(settings, session, refreshToken, now),
  );
}

async function performRefresh(
  settings: CustomerSignInSettings,
  session: CustomerSession,
  refreshToken: string,
  now: number,
): Promise<RefreshOutcome> {
  let tokens: Awaited<ReturnType<typeof oidc.refreshTokenGrant>>;
  try {
    const configuration = await issuerConfiguration(settings, now);
    tokens = await oidc.refreshTokenGrant(configuration, refreshToken);
  } catch (err) {
    if (err instanceof oidc.ResponseBodyError && err.status >= 400 && err.status < 500) {
      log.info('customer sign-in refresh refused', { error: err.error });
      return { kind: 'refused', detail: err.error };
    }
    log.warn('customer sign-in refresh failed', { reason: errorMessage(err) });
    return { kind: 'unavailable', detail: errorMessage(err) };
  }
  const claims = tokens.claims() as IdTokenClaims | undefined;
  if (!claims || !tokens.id_token) {
    return { kind: 'refused', detail: 'the issuer sent no ID token with the refresh' };
  }
  const refusal = signInRefusal(
    { email: claims.email, hd: claims.hd },
    settings.allowedDomains,
    settings.issuer,
  );
  if (refusal) return { kind: 'refused', detail: refusal };
  return {
    kind: 'refreshed',
    claims,
    session: {
      ...session,
      idToken: tokens.id_token,
      idTokenExpiresAt: claims.exp * 1000,
      // Rotating issuers send a new one; the others keep the one they granted.
      refreshToken: tokens.refresh_token ?? refreshToken,
    },
  };
}

/**
 * Where to send the browser to end the issuer's session as well as the app's:
 * the issuer's `end_session_endpoint` when its metadata names one, else
 * undefined (the app's own session is ended either way).
 *
 * @param settings - The sign-in's settings.
 * @param idToken - The ID token the session held, as the hint.
 */
export async function issuerSignOutUrl(
  settings: CustomerSignInSettings,
  idToken: string | undefined,
): Promise<string | undefined> {
  let configuration: oidc.Configuration;
  try {
    configuration = await issuerConfiguration(settings);
  } catch (err) {
    log.warn('customer sign-out without the issuer', { reason: errorMessage(err) });
    return undefined;
  }
  if (!configuration.serverMetadata().end_session_endpoint) return undefined;
  return oidc.buildEndSessionUrl(configuration, {
    post_logout_redirect_uri: signedOutUriOf(settings.publicUrl),
    ...(idToken ? { id_token_hint: idToken } : {}),
  }).href;
}

/**
 * The claims of a token this server sealed itself, read without checking the
 * signature again: it was checked when the issuer handed it over.
 *
 * @param idToken - A compact JWT.
 * @returns The payload, or undefined when it is not one.
 */
export function sealedTokenClaims(idToken: string): Readonly<Record<string, unknown>> | undefined {
  const payload = idToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    // Not a JWT this server sealed; the caller treats it as no session.
    return undefined;
  }
}
