/*
 * Linear's identity issuer (wave 11, 11-AL; the access plan, sections 4.2 and 4.10; the wave
 * file's L1 to L4, read again on 2 October). Two modes, chosen per deployment on the
 * organisation's `linear` connection (D3 with B11):
 *
 * - **shared**: one app-actor token per connection by the `client_credentials` grant, valid 30
 *   days with no refresh token, requested with the connection's fixed scope set and never another
 *   (a request with other scopes revokes every app-actor token of the app, L2);
 * - **per-employee**: the employee's own OAuth app, installed by a Linear administrator with
 *   `actor=app` through the authorisation-code grant with PKCE, its 24-hour access token renewed
 *   by a refresh token that rotates on use (L3).
 *
 * Pure: the requests and the reading of their answers, the app user's identity, and when a held
 * token is due. The deployment's actions (`convex/linearIdentityActions.ts`) send them.
 */

/** The system key Linear's organisation connection and every credential it issues carry. */
export const LINEAR_SYSTEM = 'linear';

/** Where a Linear administrator installs an app with `actor=app` (L1). */
export const LINEAR_AUTHORISE_URL = 'https://linear.app/oauth/authorize';

/** Linear's one token endpoint, for every grant (L2, L3). */
export const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';

/** Linear's GraphQL API, where `viewer` names the identity a token acts as. */
export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

/** The issuer the card's record names for a Linear authorisation. */
export const LINEAR_ISSUER = 'https://linear.app';

/** The route a per-employee app's installation sends the administrator's browser back to. */
export const LINEAR_OAUTH_REDIRECT_PATH = '/api/oauth/linear';

/** How long one request to Linear's OAuth or GraphQL endpoint may take. */
export const LINEAR_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long before its expiry the shared app-actor token is requested again: a 30-day token is used
 * until its last day (the brief), so a card never starts a run on a token that dies inside it.
 */
export const SHARED_TOKEN_RENEWAL_LEAD_MS = 24 * 60 * 60 * 1_000;

/**
 * How long before its expiry a per-employee access token is refreshed by the scheduled refresh, at
 * most: a 24-hour token is refreshed in its last half hour.
 */
export const ACCESS_TOKEN_REFRESH_LEAD_MS = 30 * 60 * 1_000;

/** How close to its expiry a token read for use is renewed first: the call it makes must land. */
export const TOKEN_READ_MARGIN_MS = 2 * 60 * 1_000;

/** The soonest a scheduled renewal runs after it is scheduled, so a short-lived token cannot loop. */
export const MIN_RENEWAL_INTERVAL_MS = 30_000;

/**
 * How long each grant's token lives by Linear's documentation (L2: 30 days; L3: 24 hours), the
 * expiry taken when an answer omits `expires_in`, so a token is never treated as due on every read.
 */
const DOCUMENTED_LIFETIME_MS: { readonly [Grant in LinearTokenGrant['grant']]: number } = {
  client_credentials: 2_591_999_000,
  authorization_code: 86_399_000,
  refresh_token: 86_399_000,
};

/** The PKCE verifier's length in bytes before encoding (RFC 7636: 43 to 128 characters). */
const PKCE_VERIFIER_BYTES = 32;

/** A fetch the issuer's requests go through; a test hands in a fake Linear. */
export type LinearFetch = (url: URL, init: RequestInit) => Promise<Response>;

/** Why Linear did not issue a token or name its identity, as the card and the record read it. */
export const LINEAR_ISSUER_REFUSALS = [
  'client-refused',
  'grant-not-enabled',
  'token-refused',
  'unauthorised',
  'not-an-app',
  'no-scope-set',
  'connection-ended',
  'malformed',
  'unavailable',
] as const;

/** One of {@link LINEAR_ISSUER_REFUSALS}. */
export type LinearIssuerRefusalReason = (typeof LINEAR_ISSUER_REFUSALS)[number];

/** Linear refused, or could not be asked, and why; the message is safe for a card. */
export class LinearIssuerRefusal extends Error {
  readonly reason: LinearIssuerRefusalReason;
  /** The OAuth `error` code Linear answered with, when it answered with one. */
  readonly oauthError?: string;

  constructor(reason: LinearIssuerRefusalReason, message: string, oauthError?: string) {
    super(message);
    this.name = 'LinearIssuerRefusal';
    this.reason = reason;
    if (oauthError !== undefined) this.oauthError = oauthError;
  }
}

/** The OAuth app a request is made as. */
export interface LinearClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * The organisation's shared app, as the `client_credentials` request reads it: its client id and
 * the scope set fixed when IT connected it. The request takes the scopes from here and nowhere else.
 */
export interface SharedLinearApp {
  readonly clientId: string;
  readonly clientCredentialsScopes?: readonly string[];
}

/** One grant at Linear's token endpoint. */
export type LinearTokenGrant =
  | { readonly grant: 'client_credentials'; readonly scopes: readonly string[] }
  | {
      readonly grant: 'authorization_code';
      readonly code: string;
      readonly redirectUrl: string;
      readonly codeVerifier: string;
    }
  | { readonly grant: 'refresh_token'; readonly refreshToken: string };

/** What a token request returned. */
export interface LinearIssuedTokens {
  readonly accessToken: string;
  /** Present for the authorisation-code and refresh grants, never for client credentials (L2). */
  readonly refreshToken?: string;
  /** When the access token stops working, from `expires_in`. */
  readonly expiresAt?: number;
  /** The scopes Linear granted, as it printed them. */
  readonly scopes: readonly string[];
}

/** The identity a token acts as, from `viewer`. */
export interface LinearViewer {
  /** The app user's id in this workspace (L1: "a unique ID for each workspace"). */
  readonly id: string;
  readonly name: string;
  /** Whether the token acts as an app (`actor=app` or client credentials), not as a person. */
  readonly app: boolean;
}

/** A PKCE pair: the verifier kept sealed on the card, the challenge sent to Linear. */
export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/** What the authorise link carries. */
export interface LinearAuthorisationRequest {
  readonly clientId: string;
  readonly redirectUrl: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly codeChallenge: string;
}

/** The words for each refusal the issuer raises itself, before Linear's own text is added. */
const REFUSAL_LEADS: { readonly [Reason in LinearIssuerRefusalReason]: string } = {
  'client-refused': "Linear refused the app's client id or secret",
  'grant-not-enabled': 'The Linear app does not have client credentials turned on',
  'token-refused': 'Linear refused the token or code it was shown',
  unauthorised: 'Linear refused the token',
  'not-an-app': 'The token acts as a person, not as an app',
  'no-scope-set': "The organisation's Linear connection has no client-credentials scope set",
  'connection-ended': "The organisation's Linear connection was ended or holds no app",
  malformed: 'Linear answered with something Day0 cannot read',
  unavailable: 'Linear could not be reached',
};

/** Base64url without padding, as PKCE and the state use. */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh PKCE pair with the S256 challenge (RFC 7636), by the platform's Web Crypto, so the module
 * runs in either Convex runtime.
 */
export async function newPkcePair(): Promise<PkcePair> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(PKCE_VERIFIER_BYTES)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/**
 * The scope set the shared app's token is requested with: the connection's own, fixed when IT
 * connected it (L2), trimmed, in its order.
 *
 * @throws LinearIssuerRefusal `no-scope-set` when the connection holds none, so no other set is
 *   ever sent in its place.
 */
export function sharedTokenScopes(app: SharedLinearApp): readonly string[] {
  const scopes = (app.clientCredentialsScopes ?? [])
    .map((scope: string): string => scope.trim())
    .filter((scope: string): boolean => scope !== '');
  if (scopes.length === 0) {
    throw new LinearIssuerRefusal('no-scope-set', `${REFUSAL_LEADS['no-scope-set']}.`);
  }
  return scopes;
}

/**
 * The form body of a token request: the grant's parameters and the client's id and secret, as
 * Linear's token endpoint takes them (`application/x-www-form-urlencoded`). Scopes are
 * comma-separated, as Linear documents.
 */
export function tokenRequestBody(client: LinearClient, grant: LinearTokenGrant): URLSearchParams {
  const body = new URLSearchParams({
    grant_type: grant.grant,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  switch (grant.grant) {
    case 'client_credentials':
      body.set('scope', grant.scopes.join(','));
      return body;
    case 'authorization_code':
      body.set('code', grant.code);
      body.set('redirect_uri', grant.redirectUrl);
      body.set('code_verifier', grant.codeVerifier);
      return body;
    case 'refresh_token':
      body.set('refresh_token', grant.refreshToken);
      return body;
    default: {
      const unknown: never = grant;
      throw new Error(`unhandled Linear grant ${String(unknown)}`);
    }
  }
}

/** A JSON object's string field, trimmed, or undefined. */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** A parsed JSON body as a record, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The scopes a token answer names: a space- or comma-separated string, or an array for apps
 * created before 1 December 2023 (Linear's note on the token response).
 */
function grantedScopes(value: unknown): readonly string[] {
  const listed = Array.isArray(value)
    ? value.filter((scope): scope is string => typeof scope === 'string')
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  return listed.map((scope) => scope.trim()).filter((scope) => scope !== '');
}

/**
 * Linear's words for a token whose grant was revoked, which it sends without `invalid_grant`
 * ("Refresh token revoked" after an administrator's "Revoke access", the real-vendor walk, 3
 * October 2026, R41V-9).
 */
const GRANT_REVOKED = /\btoken\b.*\brevoked\b/i;

/** The refusal Linear's OAuth error answer names. */
function refusalOf(status: number, error: string | undefined, description: string | undefined) {
  if (status >= 500 || status === 429) return 'unavailable' as const;
  if ([error, description].some((words) => words !== undefined && GRANT_REVOKED.test(words))) {
    return 'token-refused' as const;
  }
  if (
    description !== undefined &&
    /does not support the client_credentials grant/i.test(description)
  ) {
    return 'grant-not-enabled' as const;
  }
  if (error === 'invalid_client' || error === 'unauthorized_client')
    return 'client-refused' as const;
  if (error === 'invalid_grant') return 'token-refused' as const;
  if (status === 401) return 'unauthorised' as const;
  return 'malformed' as const;
}

/**
 * Read a token endpoint's answer: the tokens, or the refusal Linear named. Linear's own
 * `error_description` is kept in the message, since it names the cause for IT ("Client does not
 * support the client_credentials grant type") and carries no secret.
 *
 * @param status - The HTTP status.
 * @param body - The parsed JSON body, or the raw text when it was not JSON.
 * @param now - When the answer arrived, to place `expires_in`.
 * @throws LinearIssuerRefusal for any answer that is not a usable token.
 */
export function readTokenResponse(status: number, body: unknown, now: number): LinearIssuedTokens {
  const record = asRecord(body);
  const accessToken = record === undefined ? undefined : stringField(record, 'access_token');
  if (status >= 200 && status < 300 && record !== undefined && accessToken !== undefined) {
    const refreshToken = stringField(record, 'refresh_token');
    const expiresIn = record.expires_in;
    const expiresAt =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
        ? now + Math.floor(expiresIn) * 1_000
        : undefined;
    return {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      scopes: grantedScopes(record.scope),
    };
  }
  const error = record === undefined ? undefined : stringField(record, 'error');
  const description = record === undefined ? undefined : stringField(record, 'error_description');
  const reason =
    status >= 200 && status < 300 ? ('malformed' as const) : refusalOf(status, error, description);
  const detail = shownDescription(description) ?? error ?? `HTTP ${status}`;
  throw new LinearIssuerRefusal(reason, `${REFUSAL_LEADS[reason]}: ${detail}.`, error);
}

/** The longest description of Linear's that a refusal repeats. */
const DESCRIPTION_MAX = 200;

/**
 * Linear's `error_description` as a refusal may repeat it: one short line of printable text, or
 * nothing, so the manager reads Linear's own words where they are words and the error code where
 * they are not (the wave 11 review's m13).
 *
 * @param description - The description Linear answered, when it answered one.
 */
function shownDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const trimmed = description.trim();
  return trimmed !== '' &&
    trimmed.length <= DESCRIPTION_MAX &&
    !/[\u0000-\u001f\u007f]/.test(trimmed)
    ? trimmed
    : undefined;
}

/** The text of a failed transport, for the refusal's words. */
function transportDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Send one request to Linear with the issuer's timeout; a transport failure is `unavailable`. */
async function send(fetch: LinearFetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(new URL(url), {
      ...init,
      signal: AbortSignal.timeout(LINEAR_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LinearIssuerRefusal(
      'unavailable',
      `${REFUSAL_LEADS.unavailable}: ${transportDetail(error)}.`,
    );
  }
}

/** A response's body as JSON, or its text when it is not JSON. */
async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: a gateway's page; the text alone is handed on, and the status decides.
    return text;
  }
}

/**
 * Ask Linear's token endpoint for tokens by one grant.
 *
 * @throws LinearIssuerRefusal when Linear refuses, answers unreadably, or cannot be reached.
 */
export async function requestLinearTokens(
  fetch: LinearFetch,
  client: LinearClient,
  grant: LinearTokenGrant,
  now: number,
): Promise<LinearIssuedTokens> {
  const response = await send(fetch, LINEAR_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: tokenRequestBody(client, grant).toString(),
  });
  const tokens = readTokenResponse(response.status, await bodyOf(response), now);
  return tokens.expiresAt !== undefined
    ? tokens
    : { ...tokens, expiresAt: now + DOCUMENTED_LIFETIME_MS[grant.grant] };
}

/**
 * Request the shared app's app-actor token by the `client_credentials` grant, with the
 * connection's scope set: the one way the shared token is ever requested, so no request can carry
 * another set and revoke the app's other tokens (L2).
 *
 * @throws LinearIssuerRefusal `no-scope-set` before any request when the connection has none, or
 *   Linear's refusal.
 */
export async function requestAppActorToken(
  fetch: LinearFetch,
  app: SharedLinearApp,
  clientSecret: string,
  now: number,
): Promise<LinearIssuedTokens> {
  const scopes = sharedTokenScopes(app);
  return await requestLinearTokens(
    fetch,
    { clientId: app.clientId, clientSecret },
    { grant: 'client_credentials', scopes },
    now,
  );
}

/**
 * The link a Linear administrator follows to install the employee's own app as an app user
 * (`actor=app`, L1), with the signed state and the PKCE challenge.
 */
export function linearAuthorisationUrl(request: LinearAuthorisationRequest): string {
  const url = new URL(LINEAR_AUTHORISE_URL);
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', request.scopes.join(','));
  url.searchParams.set('state', request.state);
  url.searchParams.set('actor', 'app');
  url.searchParams.set('code_challenge', request.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** The GraphQL query that names the identity a token acts as. */
const VIEWER_QUERY = '{ viewer { id name app } }';

/**
 * Read the identity a token acts as from Linear's `viewer`: the app user's id, which the ticket
 * rule compares assignees and delegates with (D6), and whether it is an app at all.
 *
 * @throws LinearIssuerRefusal `unauthorised` when Linear does not know the token (401),
 *   `token-refused` when it forbids the read (403), `malformed` when the answer names nobody,
 *   `unavailable` when Linear cannot be reached.
 */
export async function readLinearViewer(
  fetch: LinearFetch,
  accessToken: string,
): Promise<LinearViewer> {
  const response = await send(fetch, LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query: VIEWER_QUERY }),
  });
  const body = await bodyOf(response);
  if (response.status === 401) {
    throw new LinearIssuerRefusal('unauthorised', `${REFUSAL_LEADS.unauthorised}: HTTP 401.`);
  }
  // Forbidden is the token known and refused this read: the authority, which a new token does not mend.
  if (response.status === 403) {
    throw new LinearIssuerRefusal('token-refused', `${REFUSAL_LEADS['token-refused']}: HTTP 403.`);
  }
  if (response.status >= 500 || response.status === 429) {
    throw new LinearIssuerRefusal(
      'unavailable',
      `${REFUSAL_LEADS.unavailable}: HTTP ${response.status}.`,
    );
  }
  const viewer = asRecord(asRecord(asRecord(body)?.data)?.viewer);
  const id = viewer === undefined ? undefined : stringField(viewer, 'id');
  if (viewer === undefined || id === undefined) {
    const errors = asRecord(body)?.errors;
    const refused =
      Array.isArray(errors) &&
      errors.some((entry) => /authenticat|unauthori[sz]ed/i.test(JSON.stringify(entry)));
    if (refused) {
      throw new LinearIssuerRefusal('unauthorised', `${REFUSAL_LEADS.unauthorised}.`);
    }
    throw new LinearIssuerRefusal('malformed', `${REFUSAL_LEADS.malformed}: viewer names nobody.`);
  }
  return { id, name: stringField(viewer, 'name') ?? id, app: viewer.app === true };
}

/**
 * The app user a token must act as to land as an app identity: a token whose `viewer` is a person
 * would make the employee act as that person, which D2 rules out.
 *
 * @throws LinearIssuerRefusal `not-an-app` for a person's token.
 */
export function requireAppViewer(viewer: LinearViewer): LinearViewer {
  if (!viewer.app) {
    throw new LinearIssuerRefusal(
      'not-an-app',
      `${REFUSAL_LEADS['not-an-app']}: install it with actor=app (Linear names it ${viewer.name}).`,
    );
  }
  return viewer;
}

/**
 * Whether a held token is due to be requested or refreshed again before use: it has no expiry
 * Day0 knows of (never for these grants), or it ends within `lead` of now.
 *
 * @param expiresAt - The held token's expiry, if known.
 * @param now - The time of the read.
 * @param lead - How long before its expiry it is due.
 */
export function tokenDue(expiresAt: number | undefined, now: number, lead: number): boolean {
  return expiresAt === undefined || expiresAt - now <= lead;
}

/**
 * When a token expiring at `expiresAt` is renewed by the scheduled renewal: `lead` before it, or
 * half its remaining life for a token that lives shorter than twice that, never sooner than
 * {@link MIN_RENEWAL_INTERVAL_MS} from now.
 */
export function renewalDueAt(expiresAt: number, now: number, lead: number): number {
  const remaining = Math.max(0, expiresAt - now);
  const due = expiresAt - Math.min(lead, Math.floor(remaining / 2));
  return Math.max(due, now + MIN_RENEWAL_INTERVAL_MS);
}

/** Linear's revocation endpoint (L3). */
export const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke';

/**
 * Revoke one token Linear issued that Day0 will not keep (`POST /oauth/revoke` with `token` and
 * its `token_type_hint`, L3), so no grant is left live behind a refused landing. Linear's 400
 * ("unable to revoke", the token already revoked) leaves nothing live and is taken as done.
 *
 * @throws LinearIssuerRefusal when Linear cannot be reached or refuses otherwise.
 */
export async function revokeLinearToken(
  fetch: LinearFetch,
  token: string,
  hint: 'access_token' | 'refresh_token',
): Promise<void> {
  const response = await send(fetch, LINEAR_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, token_type_hint: hint }).toString(),
  });
  if (response.status === 200 || response.status === 400) return;
  throw new LinearIssuerRefusal(
    response.status >= 500 || response.status === 429 ? 'unavailable' : 'malformed',
    `Linear did not revoke the token: HTTP ${response.status}.`,
  );
}

/** The refusals that withdraw Day0's authority in Linear, which only IT or the manager restores. */
const AUTHORITY_REFUSALS: ReadonlySet<LinearIssuerRefusalReason> = new Set([
  'client-refused',
  'grant-not-enabled',
  'token-refused',
  'unauthorised',
  'not-an-app',
  'no-scope-set',
  'connection-ended',
]);

/**
 * Whether a failure is Linear, or the organisation's connection, withdrawing the authority a card
 * was approved on: the card ends with the reason and no other route stands in for it. Linear
 * unreachable or answering unreadably is not: that is the system's state, not the authority's.
 */
export function isAuthorityRefusal(error: unknown): error is LinearIssuerRefusal {
  return error instanceof LinearIssuerRefusal && AUTHORITY_REFUSALS.has(error.reason);
}

/** How Linear's MCP server, or its API, says the bearer it was shown is no longer a token. */
const TOKEN_REFUSED = /\bHTTP\s+401\b|\binvalid_token\b|\b401\b.*\bunauthori[sz]ed\b/i;

/**
 * Whether a failure is Linear refusing the bearer itself (HTTP 401, `invalid_token`): the one
 * failure a new token can answer. A 403, a missing scope or a transport failure is not.
 */
export function isTokenRefusal(error: unknown): boolean {
  if (error instanceof LinearIssuerRefusal) return error.reason === 'unauthorised';
  const message = error instanceof Error ? error.message : String(error);
  return TOKEN_REFUSED.test(message);
}
