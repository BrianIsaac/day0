import { describe, expect, it } from 'vitest';
import {
  oauthTokenRevocation,
  readOAuthRevocationAnswer,
} from '../../../../src/surfaces/revokers/oauth';
import { OAUTH_INVALID_CLIENT, OAUTH_UNSUPPORTED_TOKEN_TYPE } from '../../../fixtures/revokers';

const ACCESS_TOKEN = 'mcp-access-0123456789';

describe('the OAuth 2.0 token revocation request (RFC 7009)', (): void => {
  it('posts the token and its type hint, authenticating a confidential client with HTTP Basic', (): void => {
    const request = oauthTokenRevocation({
      endpoint: 'https://auth.example.com/oauth/revoke',
      token: ACCESS_TOKEN,
      hint: 'access_token',
      client: { clientId: 'day0 client', clientSecret: 'secret:0123' },
    });
    expect(request.url).toBe('https://auth.example.com/oauth/revoke');
    expect(request.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    // RFC 6749, 2.3.1: each part form-encoded before the Basic encoding.
    expect(request.headers.Authorization).toBe(
      `Basic ${Buffer.from('day0+client:secret%3A0123').toString('base64')}`,
    );
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      token: ACCESS_TOKEN,
      token_type_hint: 'access_token',
    });
  });

  it('names a public client by its id in the body and sends no Authorization header', (): void => {
    const request = oauthTokenRevocation({
      endpoint: 'https://auth.example.com/oauth/revoke',
      token: ACCESS_TOKEN,
      hint: 'refresh_token',
      client: { clientId: 'day0-public' },
    });
    expect(request.headers.Authorization).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      token: ACCESS_TOKEN,
      token_type_hint: 'refresh_token',
      client_id: 'day0-public',
    });
  });

  it('refuses an endpoint that is not https, so a token never leaves in the clear', (): void => {
    expect(() =>
      oauthTokenRevocation({
        endpoint: 'http://auth.example.com/oauth/revoke',
        token: ACCESS_TOKEN,
        hint: 'access_token',
      }),
    ).toThrow('A revocation endpoint must be an https address.');
  });
});

describe("reading a revocation endpoint's answer", (): void => {
  it('reads 200 as revoked, an invalid token included (RFC 7009, 2.2)', (): void => {
    expect(readOAuthRevocationAnswer('Linear', 200, '')).toEqual({ kind: 'revoked' });
  });

  it('asks for another attempt on 503, 429 and any server failure', (): void => {
    expect(readOAuthRevocationAnswer('Linear', 503, '')).toEqual({
      kind: 'retry',
      words: 'Linear answered HTTP 503.',
    });
    expect(readOAuthRevocationAnswer('Linear', 429, '')).toEqual({
      kind: 'retry',
      words: 'Linear answered HTTP 429.',
    });
  });

  it("refuses in the server's own words what another attempt cannot change", (): void => {
    expect(
      readOAuthRevocationAnswer('auth.example.com', 400, OAUTH_UNSUPPORTED_TOKEN_TYPE),
    ).toEqual({
      kind: 'refused',
      words:
        'auth.example.com refused: unsupported_token_type (Only access and refresh tokens are revoked here.)',
    });
    expect(readOAuthRevocationAnswer('auth.example.com', 401, OAUTH_INVALID_CLIENT)).toEqual({
      kind: 'refused',
      words: 'auth.example.com refused: invalid_client (Client authentication failed.)',
    });
    expect(readOAuthRevocationAnswer('Linear', 404, 'Not found')).toEqual({
      kind: 'refused',
      words: 'Linear answered HTTP 404.',
    });
  });

  it('reads an invalid_token error as gone: there is nothing left to revoke', (): void => {
    expect(readOAuthRevocationAnswer('Linear', 400, { error: 'invalid_token' })).toEqual({
      kind: 'gone',
    });
  });
});
