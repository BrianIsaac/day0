import { SURFACE_MODE } from '../lib/surface-mode';

/** Production Slack origin; local proof overrides never alter surface evidence. */
const SLACK_ORIGIN = 'https://slack.com';
export const SLACK_API_ENDPOINT = `${SLACK_ORIGIN}/api/`;

/**
 * Whether a documented endpoint names the Slack Web API base.
 *
 * The evidence carries the address as the enterprise's documentation wrote it,
 * and a team writes the base with or without its trailing slash. Both are the
 * same base, so both take Slack's probe and Slack's transport. Comparing the
 * parsed URL rather than the string keeps `https://slack.com/api/../elsewhere`
 * and a look-alike host out, and the base forms alone are admitted so that the
 * operation the hold-time gate names is the operation the adapter calls.
 *
 * Args:
 *   endpoint: Evidence-derived surface endpoint.
 *
 * Returns:
 *   Whether Slack's own probe and transport are the right ones for this row.
 */
export function isSlackApiEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    parsed.origin === SLACK_ORIGIN &&
    (parsed.pathname === '/api' || parsed.pathname === '/api/') &&
    parsed.search === '' &&
    parsed.hash === ''
  );
}

function localProofMode(): boolean {
  return SURFACE_MODE === 'real';
}

function localOverride(name: string, expectedPath: string, hosts: readonly string[]): URL | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!localProofMode()) {
    throw new Error(`${name} is restricted to local no-auth real mode.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (
    parsed.protocol !== 'http:' ||
    !hosts.includes(parsed.hostname) ||
    parsed.pathname !== expectedPath ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} is not an approved local fake Slack address.`);
  }
  return parsed;
}

/** Resolve the Slack Web API base to production or the isolated fake. */
export function slackApiBaseUrl(): URL {
  return (
    localOverride('DAY0_TEST_SLACK_API_URL', '/api/', ['fake-slack']) ??
    new URL(SLACK_API_ENDPOINT)
  );
}

/** Resolve one fixed Slack Web API method to production or the isolated fake. */
export function slackApiUrl(method: string): URL {
  if (!/^[a-z][a-z0-9.]*$/i.test(method)) throw new Error('Invalid Slack API method.');
  return new URL(method, slackApiBaseUrl());
}

/** Resolve the administrator install page to production or the host-published fake. */
export function slackAuthorizeUrl(): URL {
  return (
    localOverride('DAY0_TEST_SLACK_AUTHORIZE_URL', '/oauth/v2/authorize', [
      '127.0.0.1',
      'localhost',
    ]) ?? new URL(`${SLACK_ORIGIN}/oauth/v2/authorize`)
  );
}
