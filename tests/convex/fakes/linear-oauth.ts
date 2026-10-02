import { createHash } from 'node:crypto';
import type { LinearFetch } from '../../../src/surfaces/identity-issuers/linear';
import {
  TOKEN_GRANT_NOT_ENABLED,
  TOKEN_INVALID_CLIENT,
  TOKEN_INVALID_GRANT,
  VIEWER_UNAUTHENTICATED,
} from '../../fixtures/linear/linear-oauth-2026-10-02';

/*
 * A fake Linear for the issuer's tests (wave 11, 11-AL): the token endpoint for the three grants,
 * `viewer`, the revocation endpoint and an administrator's `actor=app` consent, keeping the rules
 * Linear documents (read 2 October 2026) so a test can prove Day0 keeps them:
 *
 * - client credentials (L2): an app-actor token per request, valid 30 days, no refresh token, up to
 *   many in parallel with the same scopes, and **a request with other scopes revokes every
 *   app-actor token of the app**;
 * - authorisation code with PKCE (L1, L3): `actor=app` consent by an administrator, a 24-hour
 *   access token and a refresh token that rotates on use, with a 30-minute grace in which the
 *   spent refresh token answers the same new pair;
 * - `viewer` names the app user a token acts as, and refuses a token it does not know.
 *
 * Its answers use the recorded and documented shapes under `tests/fixtures/linear/`.
 */

/** One OAuth app IT created in the fake workspace. */
export interface FakeLinearApp {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Whether client credentials are turned on for it (the create form's toggle). */
  readonly clientCredentials: boolean;
  /** The app user its tokens act as. */
  readonly appUser: { readonly id: string; readonly name: string };
  readonly redirectUris: readonly string[];
}

/** One token the fake issued. */
interface IssuedToken {
  readonly clientId: string;
  readonly kind: 'app-actor' | 'access' | 'refresh';
  readonly scopes: string;
  readonly expiresAt: number;
  revoked: boolean;
}

/** A refresh token spent by a rotation, kept for Linear's 30-minute grace. */
interface SpentRefresh {
  readonly at: number;
  readonly answer: Record<string, unknown>;
}

/** A code an administrator's consent issued. */
interface IssuedCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly scopes: string;
  used: boolean;
}

/** One request the fake answered, without secrets. */
export interface FakeLinearRequest {
  readonly path: string;
  readonly grant?: string;
  readonly scope?: string;
  readonly clientId?: string;
}

const DAY_S = 24 * 60 * 60;
const APP_ACTOR_LIFETIME_S = 30 * DAY_S - 1;
const ACCESS_LIFETIME_S = DAY_S - 1;
const GRACE_MS = 30 * 60 * 1_000;

/** A JSON response. */
function json(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The fake Linear: its transport, its consent, and what it holds, for a test to read. */
export interface FakeLinear {
  readonly fetch: LinearFetch;
  /** Every token request and revocation it answered, in order. */
  readonly requests: FakeLinearRequest[];
  /** Whether a token is live at the fake: issued, unexpired and not revoked. */
  live(token: string): boolean;
  /** The app-actor tokens Linear revoked because a request carried other scopes (L2). */
  revokedByScopeChange(): number;
  /** An administrator consents to the install link; answers the redirect Linear sends back. */
  consent(authoriseUrl: string, options?: { readonly deny?: boolean }): URL;
  /** Revoke every token of an app, as rotating its client secret does to app-actor tokens. */
  revokeAppTokens(clientId: string): void;
  /** Make the next requests fail at the transport. */
  setUnreachable(unreachable: boolean): void;
}

/**
 * Build a fake Linear with the apps IT created.
 *
 * @param apps - The workspace's OAuth apps.
 * @param now - The fake's clock, shared with the deployment under test.
 */
export function fakeLinear(apps: readonly FakeLinearApp[], now: () => number): FakeLinear {
  const tokens = new Map<string, IssuedToken>();
  const codes = new Map<string, IssuedCode>();
  const spent = new Map<string, SpentRefresh>();
  const requests: FakeLinearRequest[] = [];
  let serial = 0;
  let scopeRevocations = 0;
  let unreachable = false;

  const appOf = (clientId: string | null): FakeLinearApp | undefined =>
    apps.find((app) => app.clientId === clientId);
  const mint = (prefix: string, token: Omit<IssuedToken, 'revoked'>): string => {
    serial += 1;
    const value = `${prefix}_${serial}`;
    tokens.set(value, { ...token, revoked: false });
    return value;
  };
  const live = (value: string): boolean => {
    const token = tokens.get(value);
    return token !== undefined && !token.revoked && token.expiresAt > now();
  };

  const tokenEndpoint = (form: URLSearchParams): Response => {
    const grant = form.get('grant_type') ?? '';
    const clientId = form.get('client_id');
    requests.push({
      path: '/oauth/token',
      grant,
      ...(form.has('scope') ? { scope: form.get('scope') ?? '' } : {}),
      ...(clientId === null ? {} : { clientId }),
    });
    const app = appOf(clientId);
    if (!app || form.get('client_secret') !== app.clientSecret) {
      return json(TOKEN_INVALID_CLIENT.status, TOKEN_INVALID_CLIENT.body);
    }
    if (grant === 'client_credentials') {
      if (!app.clientCredentials) {
        return json(TOKEN_GRANT_NOT_ENABLED.status, TOKEN_GRANT_NOT_ENABLED.body);
      }
      const scopes = form.get('scope') ?? '';
      for (const token of tokens.values()) {
        if (token.clientId === app.clientId && token.kind === 'app-actor' && !token.revoked) {
          if (token.scopes !== scopes) {
            token.revoked = true;
            scopeRevocations += 1;
          }
        }
      }
      const value = mint('lin_oauth_shared', {
        clientId: app.clientId,
        kind: 'app-actor',
        scopes,
        expiresAt: now() + APP_ACTOR_LIFETIME_S * 1_000,
      });
      return json(200, {
        access_token: value,
        token_type: 'Bearer',
        expires_in: APP_ACTOR_LIFETIME_S,
        scope: scopes.split(',').join(' '),
      });
    }
    if (grant === 'authorization_code') {
      const code = codes.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        !code ||
        code.used ||
        code.clientId !== app.clientId ||
        code.redirectUri !== form.get('redirect_uri') ||
        code.challenge !== challenge
      ) {
        return json(TOKEN_INVALID_GRANT.status, TOKEN_INVALID_GRANT.body);
      }
      code.used = true;
      return json(200, pair(app.clientId, code.scopes));
    }
    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      const earlier = spent.get(presented);
      if (earlier !== undefined && now() - earlier.at <= GRACE_MS) return json(200, earlier.answer);
      const token = tokens.get(presented);
      if (!token || token.kind !== 'refresh' || token.revoked || token.clientId !== app.clientId) {
        return json(TOKEN_INVALID_GRANT.status, TOKEN_INVALID_GRANT.body);
      }
      token.revoked = true;
      const answer = pair(app.clientId, token.scopes);
      spent.set(presented, { at: now(), answer });
      return json(200, answer);
    }
    return json(400, { error: 'unsupported_grant_type' });
  };

  const pair = (clientId: string, scopes: string): Record<string, unknown> => ({
    access_token: mint('lin_oauth_access', {
      clientId,
      kind: 'access',
      scopes,
      expiresAt: now() + ACCESS_LIFETIME_S * 1_000,
    }),
    token_type: 'Bearer',
    expires_in: ACCESS_LIFETIME_S,
    scope: scopes.split(',').join(' '),
    refresh_token: mint('lin_refresh', {
      clientId,
      kind: 'refresh',
      scopes,
      expiresAt: Number.MAX_SAFE_INTEGER,
    }),
  });

  const fetch: LinearFetch = async (url, init) => {
    if (unreachable) throw new TypeError('fetch failed');
    const body = typeof init.body === 'string' ? init.body : '';
    if (url.href === 'https://api.linear.app/oauth/token') {
      return tokenEndpoint(new URLSearchParams(body));
    }
    if (url.href === 'https://api.linear.app/oauth/revoke') {
      const form = new URLSearchParams(body);
      requests.push({ path: '/oauth/revoke' });
      const token = tokens.get(form.get('token') ?? '');
      if (!token || token.revoked) return json(400, { error: 'invalid_token' });
      token.revoked = true;
      return json(200, {});
    }
    if (url.href === 'https://api.linear.app/graphql') {
      const bearer = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
      const token = tokens.get(bearer);
      if (!token || !live(bearer) || token.kind === 'refresh') {
        return json(VIEWER_UNAUTHENTICATED.status, VIEWER_UNAUTHENTICATED.body);
      }
      const app = appOf(token.clientId);
      return json(200, { data: { viewer: { ...app?.appUser, app: true } } });
    }
    return json(404, { error: 'not_found' });
  };

  return {
    fetch,
    requests,
    live,
    revokedByScopeChange: () => scopeRevocations,
    consent(authoriseUrl, options = {}) {
      const url = new URL(authoriseUrl);
      const app = appOf(url.searchParams.get('client_id'));
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      if (!app || !app.redirectUris.includes(redirectUri)) throw new Error('consent refused');
      if (url.searchParams.get('actor') !== 'app') throw new Error('not an app installation');
      const back = new URL(redirectUri);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      if (options.deny) {
        back.searchParams.set('error', 'access_denied');
        return back;
      }
      serial += 1;
      const code = `code_${serial}`;
      codes.set(code, {
        clientId: app.clientId,
        redirectUri,
        challenge: url.searchParams.get('code_challenge') ?? '',
        scopes: url.searchParams.get('scope') ?? '',
        used: false,
      });
      back.searchParams.set('code', code);
      return back;
    },
    revokeAppTokens(clientId) {
      for (const token of tokens.values()) if (token.clientId === clientId) token.revoked = true;
    },
    setUnreachable(value) {
      unreachable = value;
    },
  };
}
