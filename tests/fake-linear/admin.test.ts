import { describe, expect, it } from 'vitest';
import { TOKEN_INVALID_GRANT } from '../fixtures/linear/linear-oauth-2026-10-02';
import { LINEAR_REFRESH_TOKEN_REVOKED_400 } from '../fixtures/real-vendor-rewalk-2026-10-03';
import { LEO, SHARED, appActorToken, call, installPair, linear, refresh, viewer } from './double';

const ADMIN = 'https://api.linear.app/admin';

interface State {
  apps: { clientId: string; name: string; appUser: { id: string; name: string } | null }[];
  tokens: {
    value: string;
    kind: string;
    grant: string;
    clientId: string;
    scopes: string[];
    state: string;
  }[];
  log: { path: string; status: number; grant_type?: string; client_id?: string; scope?: string }[];
}

async function state(fake: ReturnType<typeof linear>): Promise<State> {
  return (await call(fake, `${ADMIN}/state`)).body as State;
}

describe('the fake Linear admin controls', (): void => {
  it("lists every token's state and each app's user, and logs requests without a secret", async (): Promise<void> => {
    const fake = linear();
    await appActorToken(fake, 'read,write');
    await appActorToken(fake, 'read,write,app:assignable');
    const listed = await state(fake);
    expect(listed.apps).toEqual([
      {
        clientId: SHARED.clientId,
        name: 'Day0',
        clientCredentials: true,
        appUser: { id: SHARED.appUserId, name: 'Day0' },
      },
      { clientId: LEO.clientId, name: 'Leo (Day0)', clientCredentials: false, appUser: null },
    ]);
    expect(listed.tokens.map((token) => [token.kind, token.scopes.join(' '), token.state])).toEqual(
      [
        ['app-actor', 'read write', 'revoked'],
        ['app-actor', 'app:assignable read write', 'live'],
      ],
    );
    expect(listed.log).toEqual([
      expect.objectContaining({
        path: '/oauth/token',
        status: 200,
        grant_type: 'client_credentials',
        client_id: SHARED.clientId,
        scope: 'read,write',
      }),
      expect.objectContaining({
        path: '/oauth/token',
        status: 200,
        scope: 'read,write,app:assignable',
      }),
    ]);
    expect(JSON.stringify(listed.log)).not.toContain(SHARED.clientSecret);
  });

  it("revokes every token of an app as Linear's Revoke access does (the re-walk, row 3)", async (): Promise<void> => {
    const fake = linear();
    const pair = await installPair(fake);
    const answer = await call(fake, `${ADMIN}/revoke-app?client_id=${LEO.clientId}`, {
      method: 'POST',
    });
    expect(answer.body).toEqual({ ok: true, clientId: LEO.clientId, ended: 2 });
    expect((await viewer(fake, pair.access)).status).toBe(401);
    expect((await refresh(fake, pair.refresh)).body).toEqual(LINEAR_REFRESH_TOKEN_REVOKED_400.body);
  });

  it('expires a token by its value, or every live token of an app by kind', async (): Promise<void> => {
    const fake = linear();
    const pair = await installPair(fake);
    expect(
      (await call(fake, `${ADMIN}/expire?token=${pair.access}`, { method: 'POST' })).body,
    ).toEqual({ ok: true, expired: 1 });
    expect((await viewer(fake, pair.access)).status).toBe(401);
    expect((await refresh(fake, pair.refresh)).status).toBe(200);
    const shared = await appActorToken(fake);
    expect(
      (
        await call(fake, `${ADMIN}/expire?client_id=${SHARED.clientId}&kind=app-actor`, {
          method: 'POST',
        })
      ).body,
    ).toEqual({ ok: true, expired: 1 });
    expect((await viewer(fake, shared)).status).toBe(401);
    expect((await state(fake)).tokens.find((token) => token.value === shared)?.state).toBe(
      'expired',
    );
  });

  it("refuses a refresh token once it has lapsed, in Linear's documented words", async (): Promise<void> => {
    const fake = linear();
    const pair = await installPair(fake);
    await call(fake, `${ADMIN}/expire?token=${pair.refresh}`, { method: 'POST' });
    expect((await refresh(fake, pair.refresh)).body).toEqual(JSON.parse(TOKEN_INVALID_GRANT.body));
  });

  it('refuses an admin change by GET, and an app it does not hold', async (): Promise<void> => {
    const fake = linear();
    expect((await call(fake, `${ADMIN}/revoke-app?client_id=${LEO.clientId}`)).status).toBe(405);
    expect(
      (await call(fake, `${ADMIN}/revoke-app?client_id=nobody`, { method: 'POST' })).status,
    ).toBe(404);
  });
});
