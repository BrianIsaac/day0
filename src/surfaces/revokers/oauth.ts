import {
  FORM_CONTENT_TYPE,
  type RevocationAnswer,
  type RevocationRequest,
  type TokenTypeHint,
} from './types';

/*
 * OAuth 2.0 token revocation (RFC 7009) for any authorisation server that advertises a
 * `revocation_endpoint` (the access plan, section 4.4): the MCP rung's servers, and Linear's
 * revoke, which takes the same request.
 */

/** The client a revocation authenticates as: confidential with a secret, or public without. */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret?: string;
}

/** The hosts an http revocation endpoint may name: a local authorisation server under test. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The endpoint, refused unless it is https (or http on the loopback, where a local authorisation
 * server runs), so a token is never sent in the clear.
 *
 * @throws Error when the endpoint is not an absolute https address.
 */
function revocationEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('A revocation endpoint must be an https address.');
  }
  const loopback = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !loopback) {
    throw new Error('A revocation endpoint must be an https address.');
  }
  return parsed;
}

/**
 * Build a token revocation request (RFC 7009, section 2.1): the token and its type hint, form
 * encoded. A confidential client authenticates with HTTP Basic, each part form encoded first
 * (RFC 6749, section 2.3.1); a public client names itself by `client_id` in the body.
 *
 * @param input - The endpoint, the token, which token of the pair it is, and the client.
 * @throws Error when the endpoint is not an https address.
 */
export function oauthTokenRevocation(input: {
  readonly endpoint: string;
  readonly token: string;
  readonly hint: TokenTypeHint;
  readonly client?: OAuthClient;
}): RevocationRequest {
  const url = revocationEndpoint(input.endpoint);
  const form = new URLSearchParams({ token: input.token, token_type_hint: input.hint });
  const headers: Record<string, string> = { 'Content-Type': FORM_CONTENT_TYPE };
  const client = input.client;
  if (client?.clientSecret !== undefined) {
    const encode = (part: string): string => new URLSearchParams({ part }).toString().slice(5);
    const basic = `${encode(client.clientId)}:${encode(client.clientSecret)}`;
    // Both parts are ASCII once form encoded, so `btoa` takes them in every runtime.
    headers.Authorization = `Basic ${btoa(basic)}`;
  } else if (client !== undefined) {
    form.set('client_id', client.clientId);
  }
  return { url: url.toString(), headers, body: form.toString() };
}

/**
 * Read a revocation endpoint's answer (RFC 7009, section 2.2): 200 is revoked, an invalid token
 * included; 503, 429 and any server failure ask for another attempt; an `invalid_token` error,
 * which some servers send where the RFC says 200, is gone; anything else is refused in the
 * server's words.
 *
 * @param vendor - The name the words give the server.
 * @param status - The HTTP status.
 * @param body - The parsed JSON body, or the raw text when it was not JSON.
 */
export function readOAuthRevocationAnswer(
  vendor: string,
  status: number,
  body: unknown,
): RevocationAnswer {
  if (status >= 200 && status < 300) return { kind: 'revoked' };
  if (status === 429 || status >= 500) {
    return { kind: 'retry', words: `${vendor} answered HTTP ${status}.` };
  }
  const payload =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
  const error = typeof payload?.error === 'string' ? payload.error : undefined;
  if (error === undefined) return { kind: 'refused', words: `${vendor} answered HTTP ${status}.` };
  if (error === 'invalid_token') return { kind: 'gone' };
  const description =
    typeof payload?.error_description === 'string' ? ` (${payload.error_description})` : '';
  return { kind: 'refused', words: `${vendor} refused: ${error}${description}` };
}
