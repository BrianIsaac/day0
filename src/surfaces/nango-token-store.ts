import type { Id } from '../../convex/_generated/dataModel';
import type { ActionCtx } from '../../convex/_generated/server';
import { errorMessage } from '../lib/errors';
import { transientFromResponse } from '../lib/transport-error';
import type { TokenStoreBackend } from './token-store';

/*
 * The token store's Nango backend (wave 11, 11-AT; the access plan, section 4.7; B15 and V-A4):
 * Nango's free self-hosted edition, running beside the backend on the compose file's private
 * network, keeps and refreshes the tokens of the API-rung providers Day0 has no native issuer for.
 * The credential row never holds the token: it seals the Nango connection it lives in (a
 * location), and every read asks Nango, which refreshes a token inside its own margin before it
 * answers (measured on the spike: a client-credentials token 5 minutes from expiry was refreshed
 * on the read; six parallel reads made one token request). Day0 never caches the answer, never
 * asks Nango for a refresh token and never repeats Nango's error text, which embeds its own row.
 */

/** How a Nango connection is named in a credential row's sealed value. */
export const NANGO_LOCATION_PREFIX = 'nango:';

/** How long one request to Nango may take. */
export const NANGO_TIMEOUT_MS = 20_000;

/** How much of Nango's answer is read; a connection's JSON is a few kilobytes. */
const NANGO_READ_LIMIT = 64 * 1024;

/** Nango accepts only a version 4 UUID as an environment's secret key (the spike's 401). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A short error code Nango answers with, safe to repeat; anything else is not repeated. */
const NANGO_ERROR_CODE = /^[a-z_]{1,64}$/;

/** A credential type Nango names (`OAUTH2`, `API_KEY`), safe to repeat. */
const NANGO_AUTH_TYPE = /^[A-Z0-9_]{1,32}$/;

/** One connection in Nango: the integration (provider config key) and the connection id. */
export interface NangoConnectionRef {
  readonly providerConfigKey: string;
  readonly connectionId: string;
}

/** Where Day0 reaches its Nango and the environment key it presents. */
export interface NangoConfig {
  readonly baseUrl: URL;
  readonly secretKey: string;
}

/** A token Nango answered with: the access token and, when Nango knows it, its expiry. */
export interface NangoToken {
  readonly accessToken: string;
  readonly expiresAt?: number;
}

/** Why Nango did not answer with a token. */
export const NANGO_REFUSALS = [
  'not-configured',
  'malformed-location',
  'refresh-refused',
  'not-found',
  'key-refused',
  'unavailable',
  'malformed-answer',
  'unexpected-answer',
] as const;

/** One of {@link NANGO_REFUSALS}. */
export type NangoRefusalReason = (typeof NANGO_REFUSALS)[number];

/** Nango, or its configuration, refused a request; the message never carries a token or a key. */
export class NangoRefusal extends Error {
  readonly reason: NangoRefusalReason;

  constructor(reason: NangoRefusalReason, message: string) {
    super(message);
    this.name = 'NangoRefusal';
    this.reason = reason;
  }
}

/** The transport Nango is reached through, so a test can hand it a double. */
export type NangoFetch = (input: URL, init: RequestInit) => Promise<Response>;

/** The sealed value of a credential row whose token Nango keeps. */
export function nangoLocation(ref: NangoConnectionRef): string {
  return `${NANGO_LOCATION_PREFIX}${encodeURIComponent(ref.providerConfigKey)}/${encodeURIComponent(ref.connectionId)}`;
}

/**
 * The Nango connection a credential row's sealed value names.
 *
 * @throws NangoRefusal (`malformed-location`) when the value is not a Nango connection.
 */
export function parseNangoLocation(location: string): NangoConnectionRef {
  const refused = new NangoRefusal(
    'malformed-location',
    'The credential does not name a Nango connection.',
  );
  if (!location.startsWith(NANGO_LOCATION_PREFIX)) throw refused;
  const rest = location.slice(NANGO_LOCATION_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) throw refused;
  try {
    const providerConfigKey = decodeURIComponent(rest.slice(0, slash));
    const connectionId = decodeURIComponent(rest.slice(slash + 1));
    if (!providerConfigKey || !connectionId) throw refused;
    return { providerConfigKey, connectionId };
  } catch {
    // A malformed escape (URIError) is the same refusal as a missing part.
    throw refused;
  }
}

/**
 * The deployment's Nango from its environment: `DAY0_NANGO_URL`, the service on the compose
 * file's private network (an operator's setting, not a page's, so Day0's address rules for
 * provider endpoints do not apply), and `DAY0_NANGO_SECRET_KEY`, the environment key the setup
 * generates and passes to Nango as `NANGO_SECRET_KEY_PROD`.
 *
 * @throws NangoRefusal (`not-configured`) naming what is unset or unusable.
 */
export function nangoConfigFrom(env: Readonly<Record<string, string | undefined>>): NangoConfig {
  const url = env.DAY0_NANGO_URL?.trim() ?? '';
  const secretKey = env.DAY0_NANGO_SECRET_KEY?.trim() ?? '';
  const unset = [
    ...(url ? [] : ['DAY0_NANGO_URL']),
    ...(secretKey ? [] : ['DAY0_NANGO_SECRET_KEY']),
  ];
  const notConfigured = (why: string): NangoRefusal =>
    new NangoRefusal('not-configured', `Nango is not configured on this deployment: ${why}.`);
  if (unset.length > 0) {
    throw notConfigured(`${unset.join(' and ')} ${unset.length === 1 ? 'is' : 'are'} unset`);
  }
  if (!UUID_V4.test(secretKey)) {
    throw notConfigured('DAY0_NANGO_SECRET_KEY is not a version 4 UUID, which Nango requires');
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(url);
  } catch {
    throw notConfigured('DAY0_NANGO_URL is not an address');
  }
  if (
    (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
    baseUrl.username !== '' ||
    baseUrl.password !== ''
  ) {
    throw notConfigured('DAY0_NANGO_URL is not an http or https address without credentials');
  }
  return { baseUrl, secretKey };
}

/** A connection's address under the configured base, with its integration as the one parameter. */
function connectionUrl(config: NangoConfig, ref: NangoConnectionRef): URL {
  const base = config.baseUrl.href.endsWith('/') ? config.baseUrl.href : `${config.baseUrl.href}/`;
  const url = new URL(`connections/${encodeURIComponent(ref.connectionId)}`, base);
  url.searchParams.set('provider_config_key', ref.providerConfigKey);
  return url;
}

/** Send one request to Nango, reading a failure to reach it as `unavailable`. */
async function sendToNango(
  fetch: NangoFetch,
  config: NangoConfig,
  url: URL,
  method: 'GET' | 'DELETE',
): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      headers: { Accept: 'application/json', Authorization: `Bearer ${config.secretKey}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(NANGO_TIMEOUT_MS),
    });
  } catch (error) {
    throw new NangoRefusal('unavailable', `Nango could not be reached: ${errorMessage(error)}`);
  }
}

/** Read at most {@link NANGO_READ_LIMIT} bytes of an answer as text. */
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    read += value.byteLength;
    if (read > NANGO_READ_LIMIT) {
      await reader.cancel();
      throw new NangoRefusal('malformed-answer', 'Nango answered with more than Day0 reads.');
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** A record, as a narrowing guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Nango's error code in an answer, when it is one safe to repeat. */
function errorCodeOf(body: unknown): string | undefined {
  const code = isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
  return typeof code === 'string' && NANGO_ERROR_CODE.test(code) ? code : undefined;
}

/** Parse an answer's JSON, reading a body that is not JSON as none. */
function parsedBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: the status alone answers.
    return undefined;
  }
}

/**
 * Turn an answer that is not a success into its refusal: transient for a busy or failing Nango,
 * typed otherwise. Nango's own message is never repeated.
 */
async function refusalOf(response: Response, ref: NangoConnectionRef): Promise<Error> {
  const transient = transientFromResponse(response, 'Nango');
  if (transient) {
    await response.body?.cancel();
    return transient;
  }
  return refusalFor(response.status, errorCodeOf(parsedBody(await boundedText(response))), ref);
}

/** The refusal an answer's status and safe error code stand for. */
function refusalFor(
  status: number,
  code: string | undefined,
  ref: NangoConnectionRef,
): NangoRefusal {
  if (status === 401 || status === 403) {
    return new NangoRefusal(
      'key-refused',
      "Nango refused Day0's key (DAY0_NANGO_SECRET_KEY does not match the key Nango was started with).",
    );
  }
  if (status === 404) {
    return new NangoRefusal(
      'not-found',
      `Nango holds no connection ${ref.connectionId} for ${ref.providerConfigKey}.`,
    );
  }
  if ((status === 400 || status === 424) && code === 'invalid_credentials') {
    // 424 is Nango backing off for 30 seconds after a refusal: the same refusal, not a new one.
    return new NangoRefusal(
      'refresh-refused',
      'Nango could not refresh the token: the provider refused it. Connect the system again.',
    );
  }
  return new NangoRefusal(
    'unexpected-answer',
    `Nango answered HTTP ${status}${code ? ` (${code})` : ''}.`,
  );
}

/** The access token and its expiry in a connection Nango answered with. */
function tokenFrom(body: unknown): NangoToken {
  const credentials = isRecord(body) ? body.credentials : undefined;
  if (!isRecord(credentials)) {
    throw new NangoRefusal(
      'malformed-answer',
      'Nango answered without the connection credentials.',
    );
  }
  const type = credentials.type;
  let token: unknown;
  if (type === 'OAUTH2_CC') token = credentials.token;
  else if (type === 'OAUTH2') token = credentials.access_token;
  else {
    throw new NangoRefusal(
      'malformed-answer',
      `Nango holds a ${typeof type === 'string' && NANGO_AUTH_TYPE.test(type) ? type : 'different'} credential there, not an OAuth token the token store reads.`,
    );
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new NangoRefusal('malformed-answer', 'Nango answered without an access token.');
  }
  const expiresAt =
    typeof credentials.expires_at === 'string' ? Date.parse(credentials.expires_at) : Number.NaN;
  return Number.isFinite(expiresAt) ? { accessToken: token, expiresAt } : { accessToken: token };
}

/**
 * Ask Nango for a connection's live access token, which it refreshes first when due. Asks for
 * neither the refresh token nor a forced refresh, and keeps only the access token and its expiry
 * from an answer that also carries the client's secret.
 *
 * @throws NangoRefusal for a refused refresh, an unknown connection, a refused key, an unreachable
 *   Nango or an answer without a token; TransientProviderError when Nango is busy or failing.
 */
export async function readNangoToken(
  fetch: NangoFetch,
  config: NangoConfig,
  ref: NangoConnectionRef,
): Promise<NangoToken> {
  const response = await sendToNango(fetch, config, connectionUrl(config, ref), 'GET');
  if (!response.ok) throw await refusalOf(response, ref);
  return tokenFrom(parsedBody(await boundedText(response)));
}

/**
 * Delete a connection from Nango, so it neither keeps nor refreshes the token any longer; one
 * already gone counts as forgotten. Revoking the grant at the vendor is not Nango's (11-AR's
 * revoker makes that call where the vendor has one).
 *
 * @throws NangoRefusal or TransientProviderError when Nango does not delete it.
 */
export async function forgetNangoConnection(
  fetch: NangoFetch,
  config: NangoConfig,
  ref: NangoConnectionRef,
): Promise<void> {
  const response = await sendToNango(fetch, config, connectionUrl(config, ref), 'DELETE');
  if (response.ok || response.status === 404) {
    await response.body?.cancel();
    return;
  }
  if (response.status === 400) {
    const code = errorCodeOf(parsedBody(await boundedText(response)));
    // Nango 0.71.11 answers a delete of a connection it does not hold (a second delete, or one
    // never made) with 400 `unknown_connection`, not 404 (seen on the 11-AT bed).
    if (code === 'unknown_connection') return;
    throw refusalFor(response.status, code, ref);
  }
  throw await refusalOf(response, ref);
}

/** What the Nango backend depends on. */
export interface NangoBackendDeps {
  readonly fetch: NangoFetch;
  /** The deployment's Nango, read when a Nango-held credential is asked for. */
  readonly config: () => NangoConfig;
  /**
   * A Nango-held row's sealed location: `credentials.decrypt`, which refuses a revoked row and
   * records the use.
   */
  readonly location: (ctx: ActionCtx, credentialId: Id<'credentials'>) => Promise<string>;
}

/** The token store's Nango backend: the credential's location opened, its token asked of Nango. */
export function nangoTokenBackend(deps: NangoBackendDeps): TokenStoreBackend {
  return {
    kind: 'nango',
    accessTokenFor: async (ctx, credentialId): Promise<string> => {
      const config = deps.config();
      const ref = parseNangoLocation(await deps.location(ctx, credentialId));
      return (await readNangoToken(deps.fetch, config, ref)).accessToken;
    },
  };
}
