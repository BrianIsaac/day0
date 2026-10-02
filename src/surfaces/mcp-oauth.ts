import { createHash, randomBytes } from 'node:crypto';
import {
  checkMcpAddress,
  pinnedFetch,
  resolveHostname,
  type HostResolver,
  type HttpsRequest,
} from './mcp-address';
import type { PrivateHostAllowlist } from '../lib/private-hosts';

/*
 * The OAuth 2.1 client on the MCP rung (wave 11, 11-AM; the access plan, section 4.6), as the MCP
 * authorisation revision 2026-07-28 asks of a client: protected resource metadata (RFC 9728) found
 * from the server's challenge or its well-known URIs, authorisation server metadata (RFC 8414 or
 * OpenID discovery, both tried) validated against the issuer it was fetched for, PKCE with S256 and
 * a refusal where the server does not advertise it, the resource indicator (RFC 8707) on the
 * authorisation request and on every token request, and the RFC 9207 `iss` check on the response
 * before the code is sent anywhere.
 *
 * Nothing here touches Convex or a stored value: every request goes through the fetch the caller
 * hands in, which in a deployment is `addressCheckedFetch` (the MCP rung's address rules and pinned
 * transport, applied to discovery and the token endpoint as to the MCP server itself).
 */

/** The fetch discovery, the token requests and registration go through. */
export type OauthFetch = (url: URL, init: RequestInit) => Promise<Response>;

/** The prefix of an MCP server's system key on its organisation connection. */
export const MCP_SYSTEM_PREFIX = 'mcp:';

/** The MCP protocol revision the discovery request names; the one the tree's client speaks (V-A10). */
const DISCOVERY_PROTOCOL_VERSION = '2025-11-25';

/** The largest metadata or token response read, well above any real one. */
const OAUTH_RESPONSE_LIMIT_CHARS = 64 * 1024;

/** How an OAuth error code may look before it is repeated on a card (RFC 6749 section 5.2's charset). */
const OAUTH_ERROR_CODE = /^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,64}$/;

/** Why the client would not go on; each is a fact the card can name. */
export const MCP_OAUTH_REFUSALS = [
  'no-resource-metadata',
  'resource-mismatch',
  'no-authorisation-server',
  'issuer-mismatch',
  'pkce-unsupported',
  'insecure-endpoint',
  'client-authentication-unsupported',
  'token-refused',
  'token-malformed',
  'registration-refused',
] as const;

/** One of {@link MCP_OAUTH_REFUSALS}. */
export type McpOauthRefusalReason = (typeof MCP_OAUTH_REFUSALS)[number];

/**
 * The client's refusal to go on with an authorisation, a refresh or a registration.
 *
 * The message never repeats anything a server wrote beyond an OAuth error code, which is kept in
 * {@link McpOauthRefusal.oauthError}: a description is free text and could carry anything.
 */
export class McpOauthRefusal extends Error {
  readonly reason: McpOauthRefusalReason;
  readonly oauthError?: string;

  constructor(reason: McpOauthRefusalReason, message: string, oauthError?: string) {
    super(message);
    this.name = 'McpOauthRefusal';
    this.reason = reason;
    if (oauthError !== undefined) this.oauthError = oauthError;
  }
}

/**
 * The system key an MCP server's organisation connection is registered under: `mcp:` and the
 * endpoint's host (with its port when it has one), lower case.
 */
export function mcpSystemKey(endpoint: URL): string {
  return `${MCP_SYSTEM_PREFIX}${endpoint.host.toLowerCase()}`;
}

/**
 * The canonical URI of an MCP server (RFC 8707 section 2, the revision's form): lower-case scheme
 * and host, no fragment, and no trailing slash on a bare origin.
 */
export function canonicalResource(endpoint: URL): string {
  const path = endpoint.pathname === '/' ? '' : endpoint.pathname;
  return `${endpoint.protocol}//${endpoint.host.toLowerCase()}${path}${endpoint.search}`;
}

/** What a `WWW-Authenticate: Bearer` challenge said (RFC 6750, RFC 9728 section 5.1). */
export interface BearerChallenge {
  readonly resourceMetadata?: string;
  readonly scopes?: readonly string[];
  readonly error?: string;
}

/** An RFC 9110 token: a scheme or an auth-param's name. */
const TOKEN = /[A-Za-z0-9!#$%&'*+.^_`|~-]+/y;

/**
 * The auth-params of every challenge in a `WWW-Authenticate` value, by scheme.
 *
 * A value can hold several challenges (`Basic realm="x", Bearer scope="y"`): a token not followed
 * by `=` starts a new challenge, and a quoted value may hold commas and escaped quotes.
 */
function challengesOf(header: string): { scheme: string; params: Map<string, string> }[] {
  const challenges: { scheme: string; params: Map<string, string> }[] = [];
  const skip = (from: number, characters: string): number => {
    let at = from;
    while (at < header.length && characters.includes(header[at])) at += 1;
    return at;
  };
  let at = 0;
  while (at < header.length) {
    at = skip(at, ' \t,');
    TOKEN.lastIndex = at;
    const word = TOKEN.exec(header)?.[0];
    if (word === undefined) break;
    at = skip(TOKEN.lastIndex, ' \t');
    if (header[at] !== '=') {
      challenges.push({ scheme: word.toLowerCase(), params: new Map() });
      continue;
    }
    at = skip(at + 1, ' \t');
    let value = '';
    if (header[at] === '"') {
      at += 1;
      while (at < header.length && header[at] !== '"') {
        if (header[at] === '\\') at += 1;
        value += header[at] ?? '';
        at += 1;
      }
      at += 1;
    } else {
      while (at < header.length && header[at] !== ',' && header[at] !== ' ') {
        value += header[at];
        at += 1;
      }
    }
    challenges.at(-1)?.params.set(word.toLowerCase(), value);
  }
  return challenges;
}

/**
 * Read the Bearer challenge from a `WWW-Authenticate` value.
 *
 * @returns The resource metadata URL, the scopes and the error it names, or undefined when the
 *   value holds no Bearer challenge.
 */
export function parseBearerChallenge(header: string | null): BearerChallenge | undefined {
  if (!header) return undefined;
  const bearer = challengesOf(header).find((challenge) => challenge.scheme === 'bearer');
  if (!bearer) return undefined;
  const scope = bearer.params.get('scope');
  const resourceMetadata = bearer.params.get('resource_metadata');
  const error = bearer.params.get('error');
  return {
    ...(resourceMetadata ? { resourceMetadata } : {}),
    ...(scope ? { scopes: scope.split(' ').filter((entry) => entry !== '') } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Where a server's protected resource metadata may be, in the order the revision tries them: at
 * the endpoint's path, then at the root.
 */
export function protectedResourceMetadataUrls(resource: URL): URL[] {
  const root = new URL('/.well-known/oauth-protected-resource', resource.origin);
  if (resource.pathname === '/' || resource.pathname === '') return [root];
  return [
    new URL(`/.well-known/oauth-protected-resource${resource.pathname}`, resource.origin),
    root,
  ];
}

/**
 * Where an issuer's metadata may be, in the order the revision requires: RFC 8414 then OpenID
 * discovery with the path inserted, then OpenID discovery with the path appended; for an issuer
 * without a path, RFC 8414 then OpenID discovery.
 */
export function authorisationServerMetadataUrls(issuer: string): URL[] {
  const url = new URL(issuer);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  if (path === '') {
    return [
      new URL('/.well-known/oauth-authorization-server', url.origin),
      new URL('/.well-known/openid-configuration', url.origin),
    ];
  }
  return [
    new URL(`/.well-known/oauth-authorization-server${path}`, url.origin),
    new URL(`/.well-known/openid-configuration${path}`, url.origin),
    new URL(`${path}/.well-known/openid-configuration`, url.origin),
  ];
}

/** What a server's protected resource metadata says this client needs. */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorisationServers: readonly string[];
  readonly scopesSupported?: readonly string[];
}

/** An authorisation server's metadata, as far as this client reads it. */
export interface AuthorisationServerMetadata {
  readonly issuer: string;
  readonly authorisationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly registrationEndpoint?: string;
  readonly scopesSupported?: readonly string[];
  /** Whether the server advertised `authorization_response_iss_parameter_supported`. */
  readonly issParameterSupported: boolean;
  /** `token_endpoint_auth_methods_supported`; empty when the server named none. */
  readonly tokenEndpointAuthMethods: readonly string[];
}

/** What an authorisation for one MCP server is made against. */
export interface McpAuthorisationTarget {
  /** The resource indicator every request carries: the metadata's resource, the endpoint's canonical URI. */
  readonly resource: string;
  /** The scopes to ask for: the challenge's, else the resource's advertised ones; may be empty. */
  readonly scopes: readonly string[];
  readonly server: AuthorisationServerMetadata;
}

/** Options for reading metadata. */
export interface MetadataOptions {
  /**
   * Accept `http:` endpoints. Only a test against a local server sets it: a deployment's fetch
   * refuses `http:` anyway, and the authorisation endpoint is the one URL a browser, not the
   * fetch, is sent to.
   */
  readonly allowInsecure?: boolean;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...value]
    : undefined;
}

function recordOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * Validate a protected resource metadata document against the resource it was fetched for
 * (RFC 9728 section 3.3: the `resource` must be identical to it).
 *
 * @throws McpOauthRefusal `resource-mismatch` for another resource, `no-authorisation-server`
 *   when it names none.
 */
export function readProtectedResourceMetadata(
  body: unknown,
  expectedResource: string,
): ProtectedResourceMetadata {
  const document = recordOf(body);
  if (document.resource !== expectedResource) {
    throw new McpOauthRefusal(
      'resource-mismatch',
      `The server's resource metadata names another resource than ${expectedResource}, so Day0 will not use it.`,
    );
  }
  const servers = stringArray(document.authorization_servers) ?? [];
  if (servers.length === 0) {
    throw new McpOauthRefusal(
      'no-authorisation-server',
      'The server names no authorisation server in its resource metadata.',
    );
  }
  const scopes = stringArray(document.scopes_supported);
  return {
    resource: expectedResource,
    authorisationServers: servers,
    ...(scopes ? { scopesSupported: scopes } : {}),
  };
}

function endpointOf(
  document: Record<string, unknown>,
  field: string,
  options: MetadataOptions,
  required: boolean,
): string | undefined {
  const value = document[field];
  if (value === undefined && !required) return undefined;
  let url: URL;
  try {
    url = new URL(typeof value === 'string' ? value : '');
  } catch {
    throw new McpOauthRefusal(
      'insecure-endpoint',
      `The authorisation server's ${field} is missing or is not a URL.`,
    );
  }
  if (url.protocol !== 'https:' && !(options.allowInsecure && url.protocol === 'http:')) {
    throw new McpOauthRefusal(
      'insecure-endpoint',
      `The authorisation server's ${field} is not https, so Day0 will not send a person or a code there.`,
    );
  }
  return url.href;
}

/**
 * Validate an authorisation server's metadata against the issuer it was fetched for.
 *
 * @throws McpOauthRefusal `issuer-mismatch` when the document names another issuer (RFC 8414
 *   section 3.3), `pkce-unsupported` when it does not advertise S256 (the revision: refuse where
 *   methods are not advertised), `insecure-endpoint` for an endpoint that is not https.
 */
export function readAuthorisationServerMetadata(
  body: unknown,
  expectedIssuer: string,
  options: MetadataOptions = {},
): AuthorisationServerMetadata {
  const document = recordOf(body);
  if (document.issuer !== expectedIssuer) {
    throw new McpOauthRefusal(
      'issuer-mismatch',
      `The metadata fetched for ${expectedIssuer} names another issuer, so Day0 will not use it.`,
    );
  }
  if (!(stringArray(document.code_challenge_methods_supported) ?? []).includes('S256')) {
    throw new McpOauthRefusal(
      'pkce-unsupported',
      'The authorisation server does not advertise PKCE with S256, which Day0 requires.',
    );
  }
  const authorisationEndpoint = endpointOf(document, 'authorization_endpoint', options, true);
  const tokenEndpoint = endpointOf(document, 'token_endpoint', options, true);
  const revocationEndpoint = endpointOf(document, 'revocation_endpoint', options, false);
  const registrationEndpoint = endpointOf(document, 'registration_endpoint', options, false);
  const scopes = stringArray(document.scopes_supported);
  return {
    issuer: expectedIssuer,
    authorisationEndpoint: authorisationEndpoint ?? '',
    tokenEndpoint: tokenEndpoint ?? '',
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(scopes ? { scopesSupported: scopes } : {}),
    issParameterSupported: document.authorization_response_iss_parameter_supported === true,
    tokenEndpointAuthMethods: stringArray(document.token_endpoint_auth_methods_supported) ?? [],
  };
}

/** A response's JSON body, read to a bound, or undefined when it is not JSON. */
async function jsonOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > OAUTH_RESPONSE_LIMIT_CHARS) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: the caller treats it as no document at this URL.
    return undefined;
  }
}

/** A GET of a metadata document, or undefined when that URL does not hold one. */
async function metadataAt(fetch: OauthFetch, url: URL): Promise<unknown> {
  const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  return await jsonOf(response);
}

/**
 * Fetch and validate an issuer's metadata, trying the revision's well-known URIs in order.
 *
 * @throws McpOauthRefusal `no-authorisation-server` when none answers with a document, or the
 *   validation's refusal for the first that does.
 */
export async function fetchAuthorisationServerMetadata(
  fetch: OauthFetch,
  issuer: string,
  options: MetadataOptions = {},
): Promise<AuthorisationServerMetadata> {
  for (const url of authorisationServerMetadataUrls(issuer)) {
    const document = await metadataAt(fetch, url);
    if (document !== undefined) return readAuthorisationServerMetadata(document, issuer, options);
  }
  throw new McpOauthRefusal(
    'no-authorisation-server',
    `The authorisation server ${issuer} publishes no metadata Day0 can read.`,
  );
}

/** The challenge an unauthenticated MCP request is answered with, if any. */
async function challengeOf(fetch: OauthFetch, endpoint: URL): Promise<BearerChallenge | undefined> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: DISCOVERY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'day0', version: '1' },
      },
    }),
  });
  await response.body?.cancel();
  return response.status === 401
    ? parseBearerChallenge(response.headers.get('www-authenticate'))
    : undefined;
}

/**
 * Discover how to authorise against one MCP server: its challenge, its protected resource
 * metadata, and its authorisation server's metadata.
 *
 * @param fetch - The fetch every request goes through (`addressCheckedFetch` in a deployment).
 * @param endpoint - The MCP server's endpoint, as the card holds it.
 * @param options.issuer - The issuer the organisation registered its client with; when given,
 *   the resource must list it (a client id is unique to the server that issued it).
 * @throws McpOauthRefusal for every way the server's documents fail the revision's rules.
 */
export async function discoverAuthorisation(
  fetch: OauthFetch,
  endpoint: URL,
  options: MetadataOptions & { readonly issuer?: string } = {},
): Promise<McpAuthorisationTarget> {
  const resource = canonicalResource(endpoint);
  const challenge = await challengeOf(fetch, endpoint);
  const candidates = challenge?.resourceMetadata
    ? [new URL(challenge.resourceMetadata)]
    : protectedResourceMetadataUrls(endpoint);
  let metadata: ProtectedResourceMetadata | undefined;
  for (const url of candidates) {
    const document = await metadataAt(fetch, url);
    if (document !== undefined) {
      metadata = readProtectedResourceMetadata(document, resource);
      break;
    }
  }
  if (!metadata) {
    throw new McpOauthRefusal(
      'no-resource-metadata',
      'The server publishes no protected resource metadata, so Day0 cannot find where to authorise.',
    );
  }
  const issuer = options.issuer ?? metadata.authorisationServers[0];
  if (!metadata.authorisationServers.includes(issuer)) {
    throw new McpOauthRefusal(
      'issuer-mismatch',
      `The server does not name ${issuer}, the authorisation server its client was registered with.`,
    );
  }
  const server = await fetchAuthorisationServerMetadata(fetch, issuer, options);
  return { resource, scopes: challenge?.scopes ?? metadata.scopesSupported ?? [], server };
}

/** A PKCE verifier and its S256 challenge. */
export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/** The S256 challenge of a verifier (RFC 7636 section 4.2). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** A fresh verifier (32 random bytes, 43 characters) and its challenge. */
export function newPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** What an authorisation request is built from. */
export interface AuthorisationRequest {
  readonly server: AuthorisationServerMetadata;
  readonly clientId: string;
  readonly redirectUrl: string;
  /** The signed state; it travels on the URL, the verifier never does. */
  readonly state: string;
  readonly challenge: string;
  readonly resource: string;
  readonly scopes: readonly string[];
}

/** The URL the person's browser is sent to: code flow, PKCE S256, the resource and the scopes. */
export function authorisationUrl(request: AuthorisationRequest): URL {
  const url = new URL(request.server.authorisationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUrl);
  url.searchParams.set('state', request.state);
  url.searchParams.set('code_challenge', request.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', request.resource);
  if (request.scopes.length > 0) url.searchParams.set('scope', request.scopes.join(' '));
  return url;
}

/** The RFC 9207 check's answer. */
export type IssuerCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'iss-missing' | 'iss-mismatch' };

/**
 * Apply the revision's `iss` table to an authorisation response before its code goes anywhere.
 *
 * A present `iss` is compared with the recorded issuer by simple string comparison (no case
 * folding, no trailing-slash or port normalisation), whatever the metadata advertised; an absent
 * one is refused only where the server advertised the parameter.
 *
 * @param check.iss - The response's decoded `iss`, or null when absent.
 * @param check.recordedIssuer - The issuer recorded with the PKCE verifier before the redirect.
 * @param check.issParameterSupported - What that issuer's validated metadata advertised.
 */
export function checkResponseIssuer(check: {
  readonly iss: string | null;
  readonly recordedIssuer: string;
  readonly issParameterSupported: boolean;
}): IssuerCheck {
  if (check.iss === null) {
    return check.issParameterSupported ? { ok: false, reason: 'iss-missing' } : { ok: true };
  }
  return check.iss === check.recordedIssuer ? { ok: true } : { ok: false, reason: 'iss-mismatch' };
}

/** How the client authenticates at the token endpoint. */
export type ClientAuthentication =
  | { readonly method: 'none' }
  | { readonly method: 'client_secret_basic' | 'client_secret_post'; readonly secret: string };

/**
 * The authentication a client uses: none for a public client; for a confidential one, Basic where
 * the server offers it or names no methods (RFC 8414's default), else the form.
 *
 * @throws McpOauthRefusal `client-authentication-unsupported` when the server offers neither.
 */
export function clientAuthentication(
  server: AuthorisationServerMetadata,
  secret: string | undefined,
): ClientAuthentication {
  if (secret === undefined) return { method: 'none' };
  const offered = server.tokenEndpointAuthMethods;
  if (offered.length === 0 || offered.includes('client_secret_basic')) {
    return { method: 'client_secret_basic', secret };
  }
  if (offered.includes('client_secret_post')) return { method: 'client_secret_post', secret };
  throw new McpOauthRefusal(
    'client-authentication-unsupported',
    'The authorisation server takes no client secret in a way Day0 sends one.',
  );
}

/** The two grants this client asks the token endpoint for. */
export type TokenGrant =
  | {
      readonly grant: 'authorization_code';
      readonly code: string;
      readonly redirectUrl: string;
      readonly verifier: string;
    }
  | { readonly grant: 'refresh_token'; readonly refreshToken: string };

/** One token request. */
export interface TokenRequest {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly auth: ClientAuthentication;
  /** The resource indicator; the revision requires it on every token request. */
  readonly resource: string;
  readonly grant: TokenGrant;
}

/** The tokens a token endpoint issued. */
export interface IssuedTokens {
  readonly accessToken: string;
  /** Absent when the server issued none (the revision: never assume one). */
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly scopes?: readonly string[];
}

function grantFields(grant: TokenGrant): Record<string, string> {
  switch (grant.grant) {
    case 'authorization_code':
      return {
        grant_type: 'authorization_code',
        code: grant.code,
        redirect_uri: grant.redirectUrl,
        code_verifier: grant.verifier,
      };
    case 'refresh_token':
      return { grant_type: 'refresh_token', refresh_token: grant.refreshToken };
    default: {
      const unknown: never = grant;
      throw new Error(`unhandled grant ${String(unknown)}`);
    }
  }
}

function tokenRequestInit(request: TokenRequest): RequestInit {
  const form = new URLSearchParams(grantFields(request.grant));
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  const auth = request.auth;
  switch (auth.method) {
    case 'none':
      form.set('client_id', request.clientId);
      break;
    case 'client_secret_post':
      form.set('client_id', request.clientId);
      form.set('client_secret', auth.secret);
      break;
    case 'client_secret_basic': {
      // RFC 6749 section 2.3.1: each part form-encoded before the pair is base64-encoded.
      const pair = `${encodeURIComponent(request.clientId)}:${encodeURIComponent(auth.secret)}`;
      headers.authorization = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
      break;
    }
    default: {
      const unknown: never = auth;
      throw new Error(`unhandled client authentication ${String(unknown)}`);
    }
  }
  form.set('resource', request.resource);
  return { method: 'POST', headers, body: form.toString() };
}

/**
 * Read a token endpoint's answer.
 *
 * @param status - The response's HTTP status.
 * @param body - Its parsed JSON body.
 * @param now - The clock the expiry is counted from, in milliseconds.
 * @throws McpOauthRefusal `token-refused` (with the server's error code, never its description)
 *   for a refusal, `token-malformed` for an answer without a bearer access token.
 */
export function readTokenResponse(status: number, body: unknown, now: number): IssuedTokens {
  const document = recordOf(body);
  if (status < 200 || status > 299) {
    const code =
      typeof document.error === 'string' && OAUTH_ERROR_CODE.test(document.error)
        ? document.error
        : undefined;
    throw new McpOauthRefusal(
      'token-refused',
      `The authorisation server refused the token request${code ? ` (${code})` : ` (HTTP ${status})`}.`,
      code,
    );
  }
  const accessToken = document.access_token;
  if (
    typeof accessToken !== 'string' ||
    accessToken === '' ||
    typeof document.token_type !== 'string' ||
    document.token_type.toLowerCase() !== 'bearer'
  ) {
    throw new McpOauthRefusal(
      'token-malformed',
      'The authorisation server answered without a bearer access token.',
    );
  }
  const expiresIn = document.expires_in;
  const refreshToken = document.refresh_token;
  const scope = document.scope;
  return {
    accessToken,
    ...(typeof refreshToken === 'string' && refreshToken !== '' ? { refreshToken } : {}),
    ...(typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: now + Math.floor(expiresIn * 1000) }
      : {}),
    ...(typeof scope === 'string' && scope.trim() !== ''
      ? { scopes: scope.split(' ').filter((entry) => entry !== '') }
      : {}),
  };
}

/**
 * Ask the token endpoint for tokens: a code exchange with its verifier, or a refresh.
 *
 * @throws McpOauthRefusal as {@link readTokenResponse}.
 */
export async function requestTokens(
  fetch: OauthFetch,
  request: TokenRequest,
  now: number,
): Promise<IssuedTokens> {
  const response = await fetch(new URL(request.tokenEndpoint), tokenRequestInit(request));
  return readTokenResponse(response.status, await jsonOf(response), now);
}

/** A client registered dynamically. */
export interface ClientRegistration {
  readonly clientId: string;
  readonly clientSecret?: string;
}

/**
 * Register a public client with one redirect (RFC 7591). The revision deprecates dynamic
 * registration; the install kit uses it only where the server offers it and the customer allows
 * it (AC7, B12), and lands the result as an `mcp-client` organisation connection.
 *
 * @throws McpOauthRefusal `registration-refused` when the server will not register the client.
 */
export async function registerClient(
  fetch: OauthFetch,
  registrationEndpoint: string,
  client: { readonly clientName: string; readonly redirectUrl: string },
): Promise<ClientRegistration> {
  const response = await fetch(new URL(registrationEndpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: client.clientName,
      redirect_uris: [client.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const document = recordOf(await jsonOf(response));
  if (!response.ok || typeof document.client_id !== 'string' || document.client_id === '') {
    throw new McpOauthRefusal(
      'registration-refused',
      `The authorisation server did not register Day0's client (HTTP ${response.status}).`,
    );
  }
  return {
    clientId: document.client_id,
    ...(typeof document.client_secret === 'string' && document.client_secret !== ''
      ? { clientSecret: document.client_secret }
      : {}),
  };
}

/** What {@link addressCheckedFetch} checks and dials with; a test supplies its own. */
export interface AddressCheckedFetchOptions {
  readonly resolve?: HostResolver;
  readonly request?: HttpsRequest;
  readonly privateHosts?: PrivateHostAllowlist;
}

/**
 * The fetch every OAuth request of the MCP rung goes through: each URL's host is checked by the
 * MCP rung's address rules (https, public or listed in `DAY0_PRIVATE_HOSTS`, every answer checked)
 * and dialled only at the addresses checked, with redirects returned rather than followed.
 *
 * @throws McpAddressRefusal before a socket opens, for an address the rules refuse.
 */
export function addressCheckedFetch(options: AddressCheckedFetchOptions = {}): OauthFetch {
  return async (url: URL, init: RequestInit): Promise<Response> => {
    const checked = await checkMcpAddress(
      url,
      options.resolve ?? resolveHostname,
      ...(options.privateHosts ? [options.privateHosts] : []),
    );
    return await pinnedFetch(checked, options.request)(url, init);
  };
}
