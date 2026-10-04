import { describe, expect, it } from 'vitest';
import {
  GRAPHQL_NOT_AUTHENTICATED_401,
  LINEAR_JSON_CONTENT_TYPE,
} from '../fixtures/linear/linear-walks-2026-10-03';
import { LINEAR_REVOKE_SUCCESS } from '../fixtures/real-vendor-walk-2026-10-03';
import {
  LINEAR_REVOKE_ALREADY_REVOKED_401,
  LINEAR_REVOKE_TOKEN_NOT_FOUND,
} from '../fixtures/real-vendor-rewalk-2026-10-03';
import { appActorToken, clock, installPair, linear, revoke, viewer } from './double';

describe('the fake Linear revoke endpoint', (): void => {
  it('revokes a live app-actor token with no client authentication: 200 {"success":true}, then 401 (R41V-1, the re-walk, row 4)', async (): Promise<void> => {
    const fake = linear();
    const token = await appActorToken(fake);
    const answer = await revoke(fake, token, 'access_token');
    expect(answer.status).toBe(LINEAR_REVOKE_SUCCESS.status);
    expect(answer.contentType).toBe(LINEAR_JSON_CONTENT_TYPE);
    expect(answer.body).toEqual(LINEAR_REVOKE_SUCCESS.body);
    const after = await viewer(fake, token);
    expect(after.status).toBe(GRAPHQL_NOT_AUTHENTICATED_401.status);
    expect(after.body).toEqual(GRAPHQL_NOT_AUTHENTICATED_401.body);
  });

  it('answers a second revoke of the same token 401 "Token has already been revoked." (the re-walk\'s log)', async (): Promise<void> => {
    const fake = linear();
    const token = await appActorToken(fake);
    await revoke(fake, token);
    const again = await revoke(fake, token, 'access_token');
    expect(again.status).toBe(LINEAR_REVOKE_ALREADY_REVOKED_401.status);
    expect(again.contentType).toBe(LINEAR_JSON_CONTENT_TYPE);
    expect(again.body).toEqual(LINEAR_REVOKE_ALREADY_REVOKED_401.body);
  });

  it('ends a per-employee grant at the first revoke, so the second of the pair is already revoked (row 2)', async (): Promise<void> => {
    const fake = linear();
    const pair = await installPair(fake);
    expect((await revoke(fake, pair.refresh, 'refresh_token')).body).toEqual(
      LINEAR_REVOKE_SUCCESS.body,
    );
    const second = await revoke(fake, pair.access, 'access_token');
    expect(second.status).toBe(LINEAR_REVOKE_ALREADY_REVOKED_401.status);
    expect(second.body).toEqual(LINEAR_REVOKE_ALREADY_REVOKED_401.body);
    expect((await viewer(fake, pair.access)).status).toBe(401);
  });

  it('answers a token it never issued 401 "Token not found", with or without a hint (R41X-1)', async (): Promise<void> => {
    const fake = linear();
    for (const hint of [undefined, 'access_token'] as const) {
      const answer = await revoke(fake, 'lin_oauth_never_issued', hint);
      expect(answer.status).toBe(LINEAR_REVOKE_TOKEN_NOT_FOUND.status);
      expect(answer.contentType).toBe(LINEAR_JSON_CONTENT_TYPE);
      expect(answer.body).toEqual(LINEAR_REVOKE_TOKEN_NOT_FOUND.body);
    }
  });

  it('answers a token past its expiry as one it does not know (not seen: the R41X-1 command decides)', async (): Promise<void> => {
    const time = clock();
    const fake = linear(time);
    const pair = await installPair(fake);
    time.advance(24 * 60 * 60 * 1000);
    expect((await revoke(fake, pair.access, 'access_token')).body).toEqual(
      LINEAR_REVOKE_TOKEN_NOT_FOUND.body,
    );
  });
});
