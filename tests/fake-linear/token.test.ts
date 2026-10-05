import { describe, expect, it } from 'vitest';
import {
  TOKEN_GRANT_NOT_ENABLED,
  TOKEN_INVALID_CLIENT,
  TOKEN_INVALID_GRANT,
} from '../fixtures/linear/linear-oauth-2026-10-02';
import {
  ASSIGNABLE_SCOPE_AS_PRINTED,
  GRAPHQL_NOT_AUTHENTICATED_401,
  LINEAR_JSON_CONTENT_TYPE,
  REFRESH_REPLAY_EXPIRES_IN,
  VIEWER_OF_SHARED_APP_200,
} from '../fixtures/linear/linear-walks-2026-10-03';
import {
  LINEAR_REFRESH_TOKEN_REVOKED_400,
  LINEAR_REVOKE_ALREADY_REVOKED_401,
} from '../fixtures/real-vendor-rewalk-2026-10-03';
import {
  LEO,
  REDIRECT,
  SHARED,
  appActorToken,
  authoriseUrl,
  call,
  clock,
  consent,
  installPair,
  linear,
  pkce,
  refresh,
  revoke,
  viewer,
  type Answer,
} from './double';

const TOKEN = 'https://api.linear.app/oauth/token';

describe('the fake Linear token endpoint', (): void => {
  it('refuses a client it never issued, for either grant, as Linear recorded it', async (): Promise<void> => {
    const fake = linear();
    for (const grant of ['client_credentials', 'authorization_code']) {
      const answer = await call(fake, TOKEN, {
        form: { grant_type: grant, client_id: 'never-issued', client_secret: 'x', scope: 'read' },
      });
      expect(answer.status).toBe(TOKEN_INVALID_CLIENT.status);
      expect(answer.text).toBe(TOKEN_INVALID_CLIENT.body);
    }
  });

  it("refuses client credentials to an app without the grant, in Linear's documented words", async (): Promise<void> => {
    const answer = await call(linear(), TOKEN, {
      form: {
        grant_type: 'client_credentials',
        client_id: LEO.clientId,
        client_secret: LEO.clientSecret,
        scope: 'read,write',
      },
    });
    expect(answer.status).toBe(TOKEN_GRANT_NOT_ENABLED.status);
    expect(answer.text).toBe(TOKEN_GRANT_NOT_ENABLED.body);
  });

  it('issues a 30-day app-actor token with no refresh token and prints the scope sorted, space-separated', async (): Promise<void> => {
    const answer = await call(linear(), TOKEN, {
      form: {
        grant_type: 'client_credentials',
        client_id: SHARED.clientId,
        client_secret: SHARED.clientSecret,
        scope: 'read,write,app:assignable',
      },
    });
    expect(answer.status).toBe(200);
    expect(answer.contentType).toBe(LINEAR_JSON_CONTENT_TYPE);
    expect(answer.body).toEqual({
      access_token: expect.stringMatching(/^lin_oauth_fake_/),
      token_type: 'Bearer',
      expires_in: 2_591_999,
      scope: ASSIGNABLE_SCOPE_AS_PRINTED,
    });
  });

  it('answers viewer with an app-actor token as the app user, app true', async (): Promise<void> => {
    const fake = linear();
    const answer = await viewer(fake, await appActorToken(fake));
    expect(answer.status).toBe(VIEWER_OF_SHARED_APP_200.status);
    expect(answer.body).toEqual(VIEWER_OF_SHARED_APP_200.body);
  });

  it('leaves the app-actor tokens of the same set live (the re-walk, row 11)', async (): Promise<void> => {
    const fake = linear();
    const first = await appActorToken(fake, 'read,write');
    await appActorToken(fake, 'write,read');
    expect((await viewer(fake, first)).status).toBe(200);
  });

  it('revokes every app-actor token of another set when a token is requested (L2, both walks)', async (): Promise<void> => {
    const fake = linear();
    const old = await appActorToken(fake, 'read,write');
    await appActorToken(fake, 'read,write,app:assignable');
    const read = await viewer(fake, old);
    expect(read.status).toBe(GRAPHQL_NOT_AUTHENTICATED_401.status);
    expect(read.body).toEqual(GRAPHQL_NOT_AUTHENTICATED_401.body);
    const again = await revoke(fake, old);
    expect(again.status).toBe(LINEAR_REVOKE_ALREADY_REVOKED_401.status);
    expect(again.body).toEqual(LINEAR_REVOKE_ALREADY_REVOKED_401.body);
  });

  it("exchanges an authorisation code for the employee's own app as its app user", async (): Promise<void> => {
    const fake = linear();
    const { access, refresh: refreshToken, answer } = await installPair(fake);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      access_token: access,
      token_type: 'Bearer',
      expires_in: 86_399,
      scope: ASSIGNABLE_SCOPE_AS_PRINTED,
      refresh_token: refreshToken,
    });
    expect((await viewer(fake, access)).body).toEqual({
      data: { viewer: { id: expect.any(String), name: 'Leo (Day0)', app: true } },
    });
  });

  it('refuses a code exchanged with the wrong verifier, and a code exchanged twice', async (): Promise<void> => {
    const fake = linear();
    const exchange = async (code: string, verifier: string): Promise<Answer> =>
      await call(fake, TOKEN, {
        form: {
          grant_type: 'authorization_code',
          client_id: LEO.clientId,
          client_secret: LEO.clientSecret,
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        },
      });
    const wrong = pkce();
    const { code: first } = await consent(fake, authoriseUrl(LEO, wrong.challenge));
    expect(await exchange(first, 'not-the-verifier')).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant' },
    });
    const right = pkce();
    const { code: second } = await consent(fake, authoriseUrl(LEO, right.challenge));
    expect((await exchange(second, right.verifier)).status).toBe(200);
    expect(await exchange(second, right.verifier)).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant' },
    });
  });

  it('rotates the pair on refresh and leaves the replaced access token working (R41V P7)', async (): Promise<void> => {
    const fake = linear();
    const pair = await installPair(fake);
    const renewed = await refresh(fake, pair.refresh);
    expect(renewed.status).toBe(200);
    const body = renewed.body as { access_token: string; refresh_token: string; scope: string };
    expect(body.access_token).not.toBe(pair.access);
    expect(body.refresh_token).not.toBe(pair.refresh);
    expect(body.scope).toBe(ASSIGNABLE_SCOPE_AS_PRINTED);
    expect((await viewer(fake, pair.access)).status).toBe(200);
    expect((await viewer(fake, body.access_token)).status).toBe(200);
  });

  it('answers a replay inside the 30-minute grace with the same new pair, its remaining life (R41V P7)', async (): Promise<void> => {
    const time = clock();
    const fake = linear(time);
    const pair = await installPair(fake);
    const first = (await refresh(fake, pair.refresh)).body as Record<string, unknown>;
    time.advance(2_000);
    const replay = await refresh(fake, pair.refresh);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first, expires_in: REFRESH_REPLAY_EXPIRES_IN });
  });

  it("refuses a replay past the grace in Linear's documented words", async (): Promise<void> => {
    const time = clock();
    const fake = linear(time);
    const pair = await installPair(fake);
    await refresh(fake, pair.refresh);
    time.advance(30 * 60 * 1000 + 1_000);
    const late = await refresh(fake, pair.refresh);
    expect(late.status).toBe(TOKEN_INVALID_GRANT.status);
    expect(late.text).toBe(TOKEN_INVALID_GRANT.body);
  });

  it('answers the refresh of a grant revoked at Linear 400 invalid_request "Refresh token revoked" (the re-walk, row 3)', async (): Promise<void> => {
    const fake = linear();
    const pair = await installPair(fake);
    await call(fake, `https://api.linear.app/admin/revoke-app?client_id=${LEO.clientId}`, {
      method: 'POST',
    });
    const refused = await refresh(fake, pair.refresh);
    expect(refused.status).toBe(LINEAR_REFRESH_TOKEN_REVOKED_400.status);
    expect(refused.contentType).toBe(LINEAR_JSON_CONTENT_TYPE);
    expect(refused.body).toEqual(LINEAR_REFRESH_TOKEN_REVOKED_400.body);
  });

  it("ends the refresh token when the access token is revoked, a grant's whole end (the re-walk, W-L5)", async (): Promise<void> => {
    const fake = linear();
    const pair = await installPair(fake);
    expect((await revoke(fake, pair.access, 'access_token')).status).toBe(200);
    const refused = await refresh(fake, pair.refresh);
    expect(refused.status).toBe(LINEAR_REFRESH_TOKEN_REVOKED_400.status);
    expect(refused.body).toEqual(LINEAR_REFRESH_TOKEN_REVOKED_400.body);
  });
});
