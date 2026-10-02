import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readSlackAnswer,
  slackAppDeletion,
  slackAppUninstall,
  slackTokenRevocation,
} from '../../../../src/surfaces/revokers/slack';
import {
  SLACK_AUTH_REVOKE_OK,
  SLACK_AUTH_REVOKE_TEST,
  SLACK_INTERNAL_ERROR,
  SLACK_INVALID_APP_ID,
  SLACK_INVALID_AUTH,
  SLACK_INVALID_CLIENT_SECRET,
  SLACK_MANIFEST_DELETE_OK,
  SLACK_NOT_ALLOWED_TOKEN_TYPE,
  SLACK_RATELIMITED,
  SLACK_TOKEN_REVOKED,
  SLACK_UNINSTALL_OK,
} from '../../../fixtures/revokers';
import { restoreSurfaceMode, useSurfaceMode } from '../../../convex/surface-mode-env';

const BOT_TOKEN = 'xoxb-1234567890-abcdefghij';
const CONFIGURATION_TOKEN = 'xoxe.xoxp-1-abcdefghij';

afterEach((): void => {
  restoreSurfaceMode();
});

describe('the Slack revoker: two calls with two meanings (S1, S4)', (): void => {
  it('revokes a bot token with auth.revoke, the token as the bearer and nothing else sent', (): void => {
    const request = slackTokenRevocation(BOT_TOKEN);
    expect(request.url).toBe('https://slack.com/api/auth.revoke');
    expect(request.headers.Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(new URLSearchParams(request.body).toString()).toBe('');
  });

  it('deletes an app with apps.manifest.delete under the configuration token, naming the app', (): void => {
    const request = slackAppDeletion(CONFIGURATION_TOKEN, 'A0W11ARAPP');
    expect(request.url).toBe('https://slack.com/api/apps.manifest.delete');
    expect(request.headers.Authorization).toBe(`Bearer ${CONFIGURATION_TOKEN}`);
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({ app_id: 'A0W11ARAPP' });
  });

  it('uninstalls an installation with apps.uninstall, the client id and secret in the body', (): void => {
    const request = slackAppUninstall({
      token: BOT_TOKEN,
      clientId: '1234.5678',
      clientSecret: 'client-secret-0123',
    });
    expect(request.url).toBe('https://slack.com/api/apps.uninstall');
    expect(request.headers.Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      client_id: '1234.5678',
      client_secret: 'client-secret-0123',
    });
  });

  it('sends every call to the published fake Slack when local real mode names one', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_TEST_SLACK_API_URL', 'http://fake-slack:8090/api/');
    const fresh = await import('../../../../src/surfaces/revokers/slack');
    expect(fresh.slackTokenRevocation(BOT_TOKEN).url).toBe(
      'http://fake-slack:8090/api/auth.revoke',
    );
  });
});

describe("reading Slack's answer", (): void => {
  it('reads a revoked token, a deleted app and an uninstalled installation as done', (): void => {
    expect(readSlackAnswer('auth.revoke', 200, SLACK_AUTH_REVOKE_OK)).toEqual({ kind: 'revoked' });
    expect(readSlackAnswer('apps.manifest.delete', 200, SLACK_MANIFEST_DELETE_OK)).toEqual({
      kind: 'revoked',
    });
    expect(readSlackAnswer('apps.uninstall', 200, SLACK_UNINSTALL_OK)).toEqual({
      kind: 'revoked',
    });
  });

  it('reads a token that no longer authenticates, and an app Slack does not know, as gone', (): void => {
    expect(readSlackAnswer('auth.revoke', 200, SLACK_INVALID_AUTH)).toEqual({ kind: 'gone' });
    expect(readSlackAnswer('auth.revoke', 200, SLACK_TOKEN_REVOKED)).toEqual({ kind: 'gone' });
    expect(readSlackAnswer('apps.manifest.delete', 200, SLACK_INVALID_APP_ID)).toEqual({
      kind: 'gone',
    });
  });

  it("does not read a dead configuration token as a deleted app: it is a refusal in Slack's words", (): void => {
    expect(readSlackAnswer('apps.manifest.delete', 200, SLACK_INVALID_AUTH)).toEqual({
      kind: 'refused',
      words: 'Slack apps.manifest.delete refused: invalid_auth',
    });
    expect(readSlackAnswer('apps.manifest.delete', 200, SLACK_NOT_ALLOWED_TOKEN_TYPE)).toEqual({
      kind: 'refused',
      words: 'Slack apps.manifest.delete refused: not_allowed_token_type',
    });
    expect(readSlackAnswer('apps.uninstall', 200, SLACK_INVALID_CLIENT_SECRET)).toEqual({
      kind: 'refused',
      words: 'Slack apps.uninstall refused: bad_client_secret',
    });
  });

  it('asks for another attempt when Slack is rate limited or failed on its side', (): void => {
    expect(readSlackAnswer('auth.revoke', 429, SLACK_RATELIMITED)).toEqual({
      kind: 'retry',
      words: 'Slack auth.revoke refused: ratelimited',
    });
    expect(readSlackAnswer('auth.revoke', 200, SLACK_INTERNAL_ERROR)).toEqual({
      kind: 'retry',
      words: 'Slack auth.revoke refused: internal_error',
    });
    expect(readSlackAnswer('auth.revoke', 502, 'Bad gateway')).toEqual({
      kind: 'retry',
      words: 'Slack auth.revoke returned HTTP 502.',
    });
  });

  it('refuses an auth.revoke that answers ok without saying the token was revoked', (): void => {
    expect(readSlackAnswer('auth.revoke', 200, SLACK_AUTH_REVOKE_TEST)).toEqual({
      kind: 'refused',
      words: 'Slack auth.revoke did not report the token revoked.',
    });
  });
});
