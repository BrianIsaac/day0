import { SURFACE_MODE } from '../lib/surface-mode';

/** Production Slack origin; local proof overrides never alter surface evidence. */
const SLACK_ORIGIN = 'https://slack.com';

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

/** Resolve one fixed Slack Web API method to production or the isolated fake. */
export function slackApiUrl(method: string): URL {
  if (!/^[a-z][a-z0-9.]*$/i.test(method)) throw new Error('Invalid Slack API method.');
  const base =
    localOverride('DAY0_TEST_SLACK_API_URL', '/api/', ['fake-slack']) ??
    new URL(`${SLACK_ORIGIN}/api/`);
  return new URL(method, base);
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
