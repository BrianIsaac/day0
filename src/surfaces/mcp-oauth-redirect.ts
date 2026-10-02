/*
 * What the MCP authorisation redirect (`app/api/oauth/mcp`, 11-AM) reads off the authorisation
 * server's response and where it sends the browser afterwards. The route itself keeps to its verb
 * handler (the standard, 1.7).
 */

/** The fragment of the dashboard the card lives on. */
const SURFACES_HASH = '#surfaces';

/** The authorisation response's parameters the deployment is handed; never `error_description`. */
export interface McpRedirectQuery {
  readonly state: string;
  readonly code?: string;
  readonly iss?: string;
  readonly error?: string;
}

/**
 * Read the authorisation response off the redirect's query.
 *
 * An error response is handed on as well as a code: the deployment applies the `iss` check to it
 * (the 2026-07-28 revision) and clears the card's pending authorisation. The server's free-text
 * `error_description` is never read, since the revision forbids showing anything of a response
 * whose issuer has not been checked and the card never needs it.
 *
 * @returns The response, or undefined when it carries no state or neither a code nor an error.
 */
export function readMcpRedirect(params: URLSearchParams): McpRedirectQuery | undefined {
  const state = params.get('state') ?? '';
  const code = params.get('code') ?? '';
  const error = params.get('error') ?? '';
  const iss = params.get('iss');
  if (state === '' || (code === '' && error === '')) return undefined;
  return {
    state,
    ...(code === '' ? {} : { code }),
    ...(error === '' ? {} : { error }),
    ...(iss === null ? {} : { iss }),
  };
}

/** What the deployment answered the redirect, as far as the landing reads it. */
export interface McpAuthorisationResult {
  readonly ok: boolean;
  readonly agentId?: string;
  readonly surfaceSlug?: string;
  readonly reason?: string;
}

/**
 * Where the browser lands after the redirect: the employee's Surfaces tab when the deployment
 * named the card, else the dashboard, with `authorisation` (`authorised`, `failed` or `invalid`),
 * the card's slug and the deployment's reason for the card to show.
 *
 * @param publicUrl - The origin people reach Day0 on.
 * @param result - The deployment's answer, or `invalid` for a response refused before it.
 */
export function mcpAuthorisationLanding(
  publicUrl: string,
  result: McpAuthorisationResult | 'invalid',
): URL {
  if (result === 'invalid') {
    const url = new URL('/', publicUrl);
    url.searchParams.set('authorisation', 'invalid');
    url.hash = SURFACES_HASH;
    return url;
  }
  const url = new URL(
    result.agentId ? `/agent/${encodeURIComponent(result.agentId)}` : '/',
    publicUrl,
  );
  url.searchParams.set('authorisation', result.ok ? 'authorised' : 'failed');
  if (result.surfaceSlug) url.searchParams.set('surface', result.surfaceSlug);
  if (!result.ok && result.reason) url.searchParams.set('reason', result.reason);
  url.hash = SURFACES_HASH;
  return url;
}
