import { describe, expect, it } from 'vitest';
import {
  LINEAR_REVOKE_URL,
  linearTokenRevocation,
  readLinearAnswer,
} from '../../../../src/surfaces/revokers/linear';

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
});
