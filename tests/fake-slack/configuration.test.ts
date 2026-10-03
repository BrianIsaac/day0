import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeSlack, type FakeSlack } from './spawn';

/*
 * The bed's fake Slack answers the organisation's configuration token as real Slack answered the
 * real-vendor walk of 3 October 2026 (R41V-10): `auth.revoke` ends the token alone
 * (`{"ok":true,"revoked":true}`), its refresh token still rotates, a rotation revokes the token it
 * replaces, and a token already revoked answers `token_revoked`.
 */

/** The pair the fake starts with, assembled here so no file carries a token whole. */
const CONFIGURATION_TOKEN = ['xoxe', 'day0', 'fake', 'configuration', 'token'].join('-');
const REFRESH_TOKEN = ['xoxe', 'day0', 'fake', 'configuration', 'refresh'].join('-');

let fake: FakeSlack;

beforeAll(async (): Promise<void> => {
  fake = await startFakeSlack();
}, 20_000);

afterAll((): void => {
  fake?.stop();
});

async function call(
  method: string,
  bearer: string | undefined,
  form: Readonly<Record<string, string>> = {},
): Promise<Record<string, unknown>> {
  return (await (
    await fetch(`${fake.base}/api/${method}`, {
      method: 'POST',
      headers: {
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    })
  ).json()) as Record<string, unknown>;
}

describe('fake Slack’s configuration token, as real Slack answered the walk (R41V-10)', (): void => {
  it('revokes the token alone, keeps its refresh token, and answers token_revoked after', async (): Promise<void> => {
    expect(await call('auth.revoke', CONFIGURATION_TOKEN)).toEqual({ ok: true, revoked: true });
    expect(await call('apps.manifest.validate', CONFIGURATION_TOKEN)).toEqual({
      ok: false,
      error: 'token_revoked',
    });
    expect(await call('auth.revoke', CONFIGURATION_TOKEN)).toEqual({
      ok: false,
      error: 'token_revoked',
    });

    const rotated = await call('tooling.tokens.rotate', undefined, {
      refresh_token: REFRESH_TOKEN,
    });
    expect(rotated).toMatchObject({ ok: true });
    const proof = (await (await fetch(`${fake.base}/proof`)).json()) as Record<string, unknown>;
    expect(proof).toMatchObject({ configurationRevoked: 1 });

    // The rotation revoked nothing new (the old token was revoked already); the new one revokes.
    expect(await call('auth.revoke', String(rotated.token))).toEqual({ ok: true, revoked: true });
  });
});
