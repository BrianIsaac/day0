import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCESS_TOKEN_REFRESH_LEAD_MS,
  isAuthorityRefusal,
  isTokenRefusal,
  LINEAR_GRAPHQL_URL,
  LINEAR_TOKEN_URL,
  LinearIssuerRefusal,
  linearAuthorisationUrl,
  MIN_RENEWAL_INTERVAL_MS,
  newPkcePair,
  readLinearViewer,
  readTokenResponse,
  revokeLinearToken,
  renewalDueAt,
  requestAppActorToken,
  requestLinearTokens,
  requireAppViewer,
  SHARED_TOKEN_RENEWAL_LEAD_MS,
  sharedTokenScopes,
  tokenDue,
  type LinearFetch,
} from '../../../../src/surfaces/identity-issuers/linear';
import { LINEAR_REFRESH_TOKEN_REVOKED } from '../../../fixtures/real-vendor-walk-2026-10-03';
import {
  ARRAY_SCOPE_TOKEN,
  AUTHORISATION_CODE_TOKEN,
  CLIENT_CREDENTIALS_TOKEN,
  MCP_INVALID_TOKEN_ERROR,
  TOKEN_GRANT_NOT_ENABLED,
  TOKEN_INVALID_CLIENT,
  TOKEN_INVALID_GRANT,
  VIEWER_OF_API_KEY,
  VIEWER_OF_SHARED_APP,
  VIEWER_UNAUTHENTICATED,
  type RecordedAnswer,
} from '../../../fixtures/linear/linear-oauth-2026-10-02';

const NOW = 1_800_000_000_000;

/** A fetch that answers every request with one JSON body, recording what was sent. */
function answering(status: number, body: unknown) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetch: LinearFetch = async (url, init) => {
    sent.push({ url: url.toString(), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetch, sent };
}

/** A fetch that replays one recorded answer. */
function replaying(answer: RecordedAnswer) {
  return answering(answer.status, answer.body);
}

/** The form a token request sent. */
function formOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(init.body)));
}

/** The refusal a promise rejects with. */
async function refusalOf(promise: Promise<unknown>): Promise<LinearIssuerRefusal> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof LinearIssuerRefusal)) throw new Error(`not a refusal: ${String(error)}`);
  return error;
}

describe('the shared app-actor token request', (): void => {
  it('is sent with the connection scope set and nothing else, comma separated', async (): Promise<void> => {
    const { fetch, sent } = answering(200, CLIENT_CREDENTIALS_TOKEN);

    const tokens = await requestAppActorToken(
      fetch,
      { clientId: 'day0-shared', clientCredentialsScopes: ['read', 'write', 'app:assignable'] },
      'shared-secret',
      NOW,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(LINEAR_TOKEN_URL);
    expect(formOf(sent[0]!.init)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'day0-shared',
      client_secret: 'shared-secret',
      scope: 'read,write,app:assignable',
    });
    expect(tokens).toEqual({
      accessToken: 'lin_oauth_shared_1',
      expiresAt: NOW + 2_591_999_000,
      scopes: ['read', 'write'],
    });
  });

  it('is never sent when the connection holds no scope set: no default set takes its place', async (): Promise<void> => {
    const { fetch, sent } = answering(200, CLIENT_CREDENTIALS_TOKEN);

    const refusal = await refusalOf(
      requestAppActorToken(
        fetch,
        { clientId: 'day0-shared', clientCredentialsScopes: [' '] },
        's',
        NOW,
      ),
    );

    expect(refusal.reason).toBe('no-scope-set');
    expect(sent).toHaveLength(0);
    expect(() => sharedTokenScopes({ clientId: 'day0-shared' })).toThrow(LinearIssuerRefusal);
  });

  it('names an app without the grant turned on, and a client Linear does not know', async (): Promise<void> => {
    const app = { clientId: 'day0-shared', clientCredentialsScopes: ['read'] };
    const disabled = await refusalOf(
      requestAppActorToken(replaying(TOKEN_GRANT_NOT_ENABLED).fetch, app, 's', NOW),
    );
    expect(disabled.reason).toBe('grant-not-enabled');
    expect(disabled.message).toContain('Client does not support the client_credentials grant type');

    const unknown = await refusalOf(
      requestAppActorToken(replaying(TOKEN_INVALID_CLIENT).fetch, app, 's', NOW),
    );
    expect(unknown.reason).toBe('client-refused');
    expect(unknown.oauthError).toBe('invalid_client');
    expect(unknown.message).not.toContain('s,');
  });
});

describe('the per-employee grants', (): void => {
  it('exchanges a code with the PKCE verifier and reads the pair, its expiry and its scopes', async (): Promise<void> => {
    const { fetch, sent } = answering(200, AUTHORISATION_CODE_TOKEN);

    const tokens = await requestLinearTokens(
      fetch,
      { clientId: 'day0-leo', clientSecret: 'leo-secret' },
      {
        grant: 'authorization_code',
        code: 'code-1',
        redirectUrl: 'https://day0.acme.test/api/oauth/linear',
        codeVerifier: 'verifier-1',
      },
      NOW,
    );

    expect(formOf(sent[0]!.init)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'day0-leo',
      client_secret: 'leo-secret',
      code: 'code-1',
      redirect_uri: 'https://day0.acme.test/api/oauth/linear',
      code_verifier: 'verifier-1',
    });
    expect(tokens).toEqual({
      accessToken: 'lin_oauth_access_1',
      refreshToken: 'lin_refresh_1',
      expiresAt: NOW + 86_399_000,
      scopes: ['read', 'write'],
    });
  });

  it('refreshes with the refresh token and reads an older app printing its scopes as an array', async (): Promise<void> => {
    const { fetch, sent } = answering(200, ARRAY_SCOPE_TOKEN);

    const tokens = await requestLinearTokens(
      fetch,
      { clientId: 'day0-leo', clientSecret: 'leo-secret' },
      { grant: 'refresh_token', refreshToken: 'lin_refresh_1' },
      NOW,
    );

    expect(formOf(sent[0]!.init)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'lin_refresh_1',
    });
    expect(tokens.scopes).toEqual(['read', 'write']);
    expect(tokens.refreshToken).toBe('lin_refresh_2');
  });

  it('names a refused refresh, a busy Linear and a Linear that cannot be reached', async (): Promise<void> => {
    const client = { clientId: 'day0-leo', clientSecret: 'leo-secret' };
    const refresh = { grant: 'refresh_token', refreshToken: 'lin_refresh_1' } as const;
    expect(
      (
        await refusalOf(
          requestLinearTokens(replaying(TOKEN_INVALID_GRANT).fetch, client, refresh, NOW),
        )
      ).reason,
    ).toBe('token-refused');
    expect(
      (
        await refusalOf(
          requestLinearTokens(answering(503, '<html>busy</html>').fetch, client, refresh, NOW),
        )
      ).reason,
    ).toBe('unavailable');
    const unreachable: LinearFetch = async () => {
      throw new TypeError('fetch failed');
    };
    const refusal = await refusalOf(requestLinearTokens(unreachable, client, refresh, NOW));
    expect(refusal.reason).toBe('unavailable');
    expect(refusal.message).toContain('fetch failed');
  });

  it.each(LINEAR_REFRESH_TOKEN_REVOKED)(
    'reads "Refresh token revoked" as a refused refresh, an authority withdrawn, never an unreadable answer (R41V-9): %j',
    ({ status, body }): void => {
      let thrown: unknown;
      try {
        readTokenResponse(status, body, NOW);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LinearIssuerRefusal);
      expect((thrown as LinearIssuerRefusal).reason).toBe('token-refused');
      expect(isAuthorityRefusal(thrown)).toBe(true);
      expect((thrown as Error).message).toBe(
        'Linear refused the token or code it was shown: Refresh token revoked.',
      );
    },
  );

  it("says Linear's description only when it is one short printable line, else its error code (the review's m13)", (): void => {
    const words = (description: string): string => {
      try {
        readTokenResponse(400, { error: 'invalid_grant', error_description: description }, NOW);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('expected a refusal');
    };
    expect(words('Refresh token is invalid or expired')).toContain(
      'Refresh token is invalid or expired',
    );
    expect(words('line one\nline two')).not.toContain('line two');
    expect(words('x'.repeat(400))).not.toContain('x'.repeat(201));
    expect(words('x'.repeat(400))).toContain('invalid_grant');
  });

  it('refuses a success that carries no token rather than landing nothing', (): void => {
    expect(() => readTokenResponse(200, { token_type: 'Bearer' }, NOW)).toThrow(
      expect.objectContaining({ reason: 'malformed' }) as Error,
    );
  });

  it('builds the administrator install link with actor=app, the state and the S256 challenge only', async (): Promise<void> => {
    const pair = await newPkcePair();

    const url = new URL(
      linearAuthorisationUrl({
        clientId: 'day0-leo',
        redirectUrl: 'https://day0.acme.test/api/oauth/linear',
        scopes: ['read', 'write', 'app:assignable'],
        state: 'signed-state',
        codeChallenge: pair.challenge,
      }),
    );

    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'day0-leo',
      redirect_uri: 'https://day0.acme.test/api/oauth/linear',
      response_type: 'code',
      scope: 'read,write,app:assignable',
      state: 'signed-state',
      actor: 'app',
      code_challenge: pair.challenge,
      code_challenge_method: 'S256',
    });
    expect(url.toString()).not.toContain(pair.verifier);
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
  });
});

describe('the identity a token acts as', (): void => {
  it('reads the app user from viewer, with the token as the bearer', async (): Promise<void> => {
    const { fetch, sent } = answering(200, VIEWER_OF_SHARED_APP);

    await expect(readLinearViewer(fetch, 'lin_oauth_shared_1')).resolves.toEqual({
      id: 'app-user-day0-shared',
      name: 'Day0',
      app: true,
    });
    expect(sent[0]?.url).toBe(LINEAR_GRAPHQL_URL);
    expect(new Headers(sent[0]?.init.headers).get('authorization')).toBe(
      'Bearer lin_oauth_shared_1',
    );
  });

  it("refuses to land a person's token as an app identity", async (): Promise<void> => {
    const person = await readLinearViewer(answering(200, VIEWER_OF_API_KEY).fetch, 'lin_api_key');

    expect(person.app).toBe(false);
    expect(() => requireAppViewer(person)).toThrow(
      expect.objectContaining({ reason: 'not-an-app' }) as Error,
    );
  });

  it('names a token GraphQL refuses as unauthorised', async (): Promise<void> => {
    const refusal = await refusalOf(
      readLinearViewer(replaying(VIEWER_UNAUTHENTICATED).fetch, 'gone'),
    );

    expect(refusal.reason).toBe('unauthorised');
    expect(isTokenRefusal(refusal)).toBe(true);
  });
});

describe('when a held token is due', (): void => {
  it('requests the shared token again only in its last day, and renews a token with no known expiry', (): void => {
    expect(
      tokenDue(NOW + SHARED_TOKEN_RENEWAL_LEAD_MS + 1, NOW, SHARED_TOKEN_RENEWAL_LEAD_MS),
    ).toBe(false);
    expect(tokenDue(NOW + SHARED_TOKEN_RENEWAL_LEAD_MS, NOW, SHARED_TOKEN_RENEWAL_LEAD_MS)).toBe(
      true,
    );
    expect(tokenDue(undefined, NOW, SHARED_TOKEN_RENEWAL_LEAD_MS)).toBe(true);
  });

  it('schedules a renewal its lead before the expiry, or halfway for a short token, never at once', (): void => {
    const day = 24 * 60 * 60 * 1_000;
    expect(renewalDueAt(NOW + day, NOW, ACCESS_TOKEN_REFRESH_LEAD_MS)).toBe(
      NOW + day - ACCESS_TOKEN_REFRESH_LEAD_MS,
    );
    expect(renewalDueAt(NOW + 20 * 60_000, NOW, ACCESS_TOKEN_REFRESH_LEAD_MS)).toBe(
      NOW + 10 * 60_000,
    );
    expect(renewalDueAt(NOW + 1_000, NOW, ACCESS_TOKEN_REFRESH_LEAD_MS)).toBe(
      NOW + MIN_RENEWAL_INTERVAL_MS,
    );
  });
});

describe('a refused bearer', (): void => {
  it("is the MCP server's 401 and invalid_token, and not a 403 or a transport failure", (): void => {
    expect(isTokenRefusal(new Error(MCP_INVALID_TOKEN_ERROR))).toBe(true);
    expect(isTokenRefusal(new Error('HTTP 403 forbidden: missing scope'))).toBe(false);
    expect(isTokenRefusal(new Error('fetch failed: ECONNRESET'))).toBe(false);
    expect(isTokenRefusal(new LinearIssuerRefusal('token-refused', 'refresh refused'))).toBe(false);
  });

  it('is read without a network: the module never reaches out on its own', (): void => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(isTokenRefusal('HTTP 401')).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('revoking a token Day0 will not keep', (): void => {
  it('posts the token with its hint, and takes an already revoked one as done', async (): Promise<void> => {
    const { fetch, sent } = answering(200, {});
    await revokeLinearToken(fetch, 'lin_refresh_1', 'refresh_token');
    expect(sent[0]?.url).toBe('https://api.linear.app/oauth/revoke');
    expect(formOf(sent[0]!.init)).toEqual({
      token: 'lin_refresh_1',
      token_type_hint: 'refresh_token',
    });

    await expect(
      revokeLinearToken(answering(400, { error: 'invalid_token' }).fetch, 'gone', 'access_token'),
    ).resolves.toBeUndefined();
    expect(
      (await refusalOf(revokeLinearToken(answering(503, 'busy').fetch, 't', 'access_token')))
        .reason,
    ).toBe('unavailable');
  });
});

describe('an authority withdrawn', (): void => {
  it('is a refused client, grant, token or connection, never Linear unreachable or unreadable', (): void => {
    for (const reason of [
      'client-refused',
      'grant-not-enabled',
      'token-refused',
      'unauthorised',
      'not-an-app',
      'no-scope-set',
      'connection-ended',
    ] as const) {
      expect(isAuthorityRefusal(new LinearIssuerRefusal(reason, reason))).toBe(true);
    }
    expect(isAuthorityRefusal(new LinearIssuerRefusal('unavailable', 'down'))).toBe(false);
    expect(isAuthorityRefusal(new LinearIssuerRefusal('malformed', 'odd'))).toBe(false);
    expect(isAuthorityRefusal(new Error('HTTP 401'))).toBe(false);
  });
});

describe('an answer without expires_in', (): void => {
  it("takes Linear's documented lifetime for the grant, so a token is never requested on every read", async (): Promise<void> => {
    const shared = await requestAppActorToken(
      answering(200, { access_token: 'lin_oauth_shared_9', token_type: 'Bearer', scope: 'read' })
        .fetch,
      { clientId: 'day0-shared', clientCredentialsScopes: ['read'] },
      's',
      NOW,
    );
    expect(shared.expiresAt).toBe(NOW + 2_591_999_000);

    const own = await requestLinearTokens(
      answering(200, { access_token: 'lin_oauth_access_9', refresh_token: 'lin_refresh_9' }).fetch,
      { clientId: 'day0-leo', clientSecret: 'leo-secret' },
      { grant: 'refresh_token', refreshToken: 'lin_refresh_8' },
      NOW,
    );
    expect(own.expiresAt).toBe(NOW + 86_399_000);
  });
});

describe('a viewer Linear forbids', (): void => {
  it('withdraws the authority without asking for a new token', async (): Promise<void> => {
    const refusal = await refusalOf(readLinearViewer(answering(403, { errors: [] }).fetch, 't'));

    expect(isAuthorityRefusal(refusal)).toBe(true);
    expect(isTokenRefusal(refusal)).toBe(false);
  });
});
