import { describe, expect, it } from 'vitest';
import {
  LINEAR_REVOKE_URL,
  linearTokenRevocation,
  readLinearAnswer,
} from '../../../../src/surfaces/revokers/linear';
import {
  LINEAR_REVOKE_ALREADY_REVOKED_401,
  LINEAR_REVOKE_TOKEN_NOT_FOUND,
} from '../../../fixtures/real-vendor-rewalk-2026-10-03';
import { LINEAR_REVOKE_ALREADY_REVOKED } from '../../../fixtures/real-vendor-walk-2026-10-03';

const ACCESS_TOKEN = 'lin_oauth_0123456789';

describe('the Linear revoker (L3: POST https://api.linear.app/oauth/revoke)', (): void => {
  it('posts the token with its type hint to the one revoke address', (): void => {
    const request = linearTokenRevocation(ACCESS_TOKEN, 'access_token');
    expect(LINEAR_REVOKE_URL).toBe('https://api.linear.app/oauth/revoke');
    expect(request.url).toBe(LINEAR_REVOKE_URL);
    expect(request.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      token: ACCESS_TOKEN,
      token_type_hint: 'access_token',
    });
  });

  it('names a refresh token as one, since Linear does not say revoking the access token ends it', (): void => {
    const request = linearTokenRevocation('lin_refresh_0123456789', 'refresh_token');
    expect(new URLSearchParams(request.body).get('token_type_hint')).toBe('refresh_token');
  });

  it("reads Linear's answer by the revocation rules, naming Linear in its words", (): void => {
    expect(readLinearAnswer(200, '')).toEqual({ kind: 'revoked' });
    expect(readLinearAnswer(500, '')).toEqual({
      kind: 'retry',
      words: 'Linear answered HTTP 500.',
    });
    expect(readLinearAnswer(400, { error: 'invalid_request' })).toEqual({
      kind: 'refused',
      words: 'Linear refused: invalid_request',
    });
  });

  it('reads "Token has already been revoked." as already gone, since a revoke ends the whole grant (R41V-8)', (): void => {
    const { status, body } = LINEAR_REVOKE_ALREADY_REVOKED;
    expect(readLinearAnswer(status, body)).toEqual({ kind: 'gone' });
  });

  it('reads it as already gone under the 401 the re-walk saw it come with', (): void => {
    const { status, body } = LINEAR_REVOKE_ALREADY_REVOKED_401;
    expect(readLinearAnswer(status, body)).toEqual({ kind: 'gone' });
  });

  it('reads Linear\'s 401 "Token not found" for a token it does not know as already gone, since nothing is left to revoke (R41X-1)', (): void => {
    const { status, body } = LINEAR_REVOKE_TOKEN_NOT_FOUND;
    expect(readLinearAnswer(status, body)).toEqual({ kind: 'gone' });
  });

  it("still reads any other 401 as a refusal in Linear's words", (): void => {
    expect(readLinearAnswer(401, { error: 'invalid_client' })).toEqual({
      kind: 'refused',
      words: 'Linear refused: invalid_client',
    });
    expect(readLinearAnswer(401, { error: 'Client not found' })).toEqual({
      kind: 'refused',
      words: 'Linear refused: Client not found',
    });
  });
});
