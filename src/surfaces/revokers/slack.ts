import { slackApiUrl } from '../slack-endpoint';
import { FORM_CONTENT_TYPE, type RevocationAnswer, type RevocationRequest } from './types';

/*
 * Slack's revoker: two calls with two meanings (the wave 11 file, section 8, S1 and S4).
 * `auth.revoke` on a bot token "will not uninstall the bot user or the app. It will, however,
 * deactivate the bot user and remove its channel memberships": the end that keeps the app.
 * `apps.manifest.delete` with the configuration token deletes an app Day0 created ("can only
 * delete apps that were created by that manager app"), and `apps.uninstall` "revokes all tokens
 * associated with a single installation": the ends that leave nothing of the employee.
 */

/** The Slack methods a revocation calls. */
export type SlackRevocationMethod = 'auth.revoke' | 'apps.manifest.delete' | 'apps.uninstall';

/**
 * The errors that say what the call was to end is already gone, per method: a token that no
 * longer authenticates has nothing left to revoke, and an app Slack does not know has nothing
 * left to delete. A dead token is not a gone installation, so `apps.uninstall` has none: the app
 * stays installed after its bot token is revoked.
 */
const GONE_ERRORS: Readonly<Record<SlackRevocationMethod, ReadonlySet<string>>> = {
  'auth.revoke': new Set(['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive']),
  'apps.manifest.delete': new Set(['invalid_app_id']),
  'apps.uninstall': new Set(),
};

/** The errors Slack documents for a failure on its own side or a limit, which a later attempt may pass. */
const RETRY_ERRORS: ReadonlySet<string> = new Set([
  'ratelimited',
  'internal_error',
  'fatal_error',
  'service_unavailable',
  'request_timeout',
]);

/**
 * One form-encoded Slack Web API POST with a bearer.
 *
 * @param method - The Slack method.
 * @param token - The bearer the method authenticates with.
 * @param form - The method's arguments.
 */
function slackRequest(
  method: SlackRevocationMethod,
  token: string,
  form: Readonly<Record<string, string>>,
): RevocationRequest {
  return {
    url: slackApiUrl(method).toString(),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': FORM_CONTENT_TYPE },
    body: new URLSearchParams(form).toString(),
  };
}

/**
 * Revoke a bot token with `auth.revoke`: the bot user is deactivated and loses its channel
 * memberships, and the app stays.
 *
 * @param token - The bot token to revoke, which is also the call's bearer.
 */
export function slackTokenRevocation(token: string): RevocationRequest {
  return slackRequest('auth.revoke', token, {});
}

/**
 * Delete an app Day0 created with `apps.manifest.delete`, under the configuration token of the
 * connection that created it.
 *
 * @param configurationToken - The app configuration token.
 * @param appId - The app's id.
 */
export function slackAppDeletion(configurationToken: string, appId: string): RevocationRequest {
  return slackRequest('apps.manifest.delete', configurationToken, { app_id: appId });
}

/**
 * Uninstall an app's installation with `apps.uninstall`, which revokes every token of it: the
 * fallback where no configuration token can delete the app.
 *
 * @param input - A token of the installation (the bot token) and the app's client id and secret.
 */
export function slackAppUninstall(input: {
  readonly token: string;
  readonly clientId: string;
  readonly clientSecret: string;
}): RevocationRequest {
  return slackRequest('apps.uninstall', input.token, {
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
}

/**
 * Ask Slack whether a token still works (`auth.test`), after `auth.revoke` answered: the walk saw
 * a configuration token still accepted after Day0 recorded its revoke (R41V-10), so the answer is
 * checked rather than trusted.
 *
 * @param token - The token, which is also the call's bearer.
 */
export function slackTokenCheck(token: string): RevocationRequest {
  return {
    url: slackApiUrl('auth.test').toString(),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': FORM_CONTENT_TYPE },
    body: '',
  };
}

/**
 * Read Slack's answer to `auth.test`: the token still works only when Slack says `ok`; any other
 * answer, or none, leaves the revoke's own answer standing.
 *
 * @param status - The HTTP status.
 * @param body - The parsed JSON body, or the raw text when it was not JSON.
 */
export function slackTokenStillWorks(status: number, body: unknown): boolean {
  return (
    status < 400 &&
    typeof body === 'object' &&
    body !== null &&
    (body as { ok?: unknown }).ok === true
  );
}

/** Whether an HTTP status says the failure was the vendor's side or a limit. */
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Read Slack's answer to one revocation call: its in-band `ok` and `error`, then the HTTP status
 * for a body that is not Slack's JSON.
 *
 * @param method - The method called.
 * @param status - The HTTP status.
 * @param body - The parsed JSON body, or the raw text when it was not JSON.
 * @returns What the answer means, with Slack's own error word where it gave one.
 */
export function readSlackAnswer(
  method: SlackRevocationMethod,
  status: number,
  body: unknown,
): RevocationAnswer {
  const payload =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
  const error = typeof payload?.error === 'string' ? payload.error : undefined;
  if (payload?.ok === true && status < 400) {
    if (method === 'auth.revoke' && payload.revoked !== true) {
      return { kind: 'refused', words: 'Slack auth.revoke did not report the token revoked.' };
    }
    return { kind: 'revoked' };
  }
  if (error === undefined) {
    const words = `Slack ${method} returned HTTP ${status}.`;
    return retryableStatus(status) ? { kind: 'retry', words } : { kind: 'refused', words };
  }
  if (GONE_ERRORS[method].has(error)) return { kind: 'gone' };
  const words = `Slack ${method} refused: ${error}`;
  return RETRY_ERRORS.has(error) || retryableStatus(status)
    ? { kind: 'retry', words }
    : { kind: 'refused', words };
}
