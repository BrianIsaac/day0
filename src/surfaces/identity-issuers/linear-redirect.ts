/*
 * What the Linear app's installation redirect (`app/api/oauth/linear`, 11-AL) reads off Linear's
 * answer and where it sends the administrator's browser afterwards. The route itself keeps to its
 * verb handler (the standard, 1.7).
 */

/** The fragment of the dashboard the card lives on. */
const SURFACES_HASH = '#surfaces';

/** The parameters of Linear's answer the deployment is handed; never `error_description`. */
export interface LinearRedirectQuery {
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
}

/**
 * Read Linear's answer off the redirect's query: the state with a code, or with Linear's error.
 * Linear's free-text `error_description` is never read: the card says what happened in Day0's own
 * words. An answer naming any parameter twice is refused, since which of two to believe is exactly
 * what the state's check settles.
 *
 * @returns The answer, or undefined when it carries no state, neither a code nor an error, or a
 *   repeated parameter.
 */
export function readLinearRedirect(params: URLSearchParams): LinearRedirectQuery | undefined {
  if (['state', 'code', 'error'].some((name) => params.getAll(name).length > 1)) return undefined;
  const state = params.get('state') ?? '';
  const code = params.get('code') ?? '';
  const error = params.get('error') ?? '';
  if (state === '' || (code === '' && error === '')) return undefined;
  return { state, ...(code === '' ? {} : { code }), ...(error === '' ? {} : { error }) };
}

/** What the card is told when the deployment could not be asked at all. */
export const LINEAR_INSTALL_UNAVAILABLE =
  'Day0 could not complete the installation just now. Start it again from the card.';

/** What the deployment answered the redirect, as far as the landing reads it. */
export interface LinearInstallResult {
  readonly ok: boolean;
  readonly agentId?: string;
  readonly surfaceSlug?: string;
  readonly reason?: string;
}

/**
 * Where the browser lands after the redirect: the employee's Surfaces tab when the deployment named
 * the card, else the dashboard, with `install` (`installed`, `failed` or `invalid`, as the Slack
 * install's redirect says it), the card's slug and the deployment's reason for the card to show.
 *
 * @param publicUrl - The origin people reach Day0 on.
 * @param result - The deployment's answer, or `invalid` for an answer refused before it.
 */
export function linearInstallLanding(
  publicUrl: string,
  result: LinearInstallResult | 'invalid',
): URL {
  if (result === 'invalid') {
    const url = new URL('/', publicUrl);
    url.searchParams.set('install', 'invalid');
    url.hash = SURFACES_HASH;
    return url;
  }
  const url = new URL(
    result.agentId ? `/agent/${encodeURIComponent(result.agentId)}` : '/',
    publicUrl,
  );
  url.searchParams.set('install', result.ok ? 'installed' : 'failed');
  if (result.surfaceSlug) url.searchParams.set('surface', result.surfaceSlug);
  if (!result.ok && result.reason) url.searchParams.set('reason', result.reason);
  url.hash = SURFACES_HASH;
  return url;
}
