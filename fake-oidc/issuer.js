/**
 * A test OpenID Connect issuer: discovery, keys, authorisation codes with
 * PKCE, ID tokens and refresh tokens for a fixed set of test people, so a bed
 * and the route tests can sign people in without an external identity
 * provider (decision S3). Never a production issuer: anyone who can reach it
 * may sign in as any of its people.
 *
 * The handler is written on the Fetch API alone (`Request` in, `Response`
 * out), so `server.js` serves it over Node's own listener and a test calls it
 * in process behind a stubbed `fetch`. Its state (codes, refresh tokens, the
 * signing key) lives in memory and is gone at a restart.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';

/**
 * The people a bed signs in by default: two in the allowed domain and one
 * outside it. Every claim a person carries is configurable, so a run can
 * drop `email_verified`, add `xms_edov` or `hd`, or name another domain.
 *
 * @type {ReadonlyArray<import('./issuer').FakePerson>}
 */
export const DEFAULT_PEOPLE = [
  {
    id: 'priya',
    claims: {
      email: 'priya@acme.test',
      email_verified: true,
      name: 'Priya Raman',
      given_name: 'Priya',
    },
  },
  {
    id: 'mateo',
    claims: {
      email: 'mateo@acme.test',
      email_verified: true,
      name: 'Mateo Silva',
      given_name: 'Mateo',
    },
  },
  {
    id: 'eve',
    claims: {
      email: 'eve@rival.test',
      email_verified: true,
      name: 'Eve Outsider',
      given_name: 'Eve',
    },
  },
];

/** How long an ID token lives unless the issuer is told otherwise. */
export const DEFAULT_TOKEN_SECONDS = 300;

/** How long an authorisation code may wait for its exchange. */
const CODE_SECONDS = 120;

/**
 * @param {Uint8Array | string} value
 * @returns {string}
 */
function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/**
 * An OAuth error body, as RFC 6749 section 5.2 shapes it.
 *
 * @param {string} error
 * @param {string} description
 * @param {number} [status]
 * @returns {Response}
 */
function oauthError(error, description, status = 400) {
  return json(status, { error, error_description: description });
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The client credentials a token request presents, from the Basic header or the form.
 *
 * @param {Request} request
 * @param {URLSearchParams} form
 * @returns {{ id: string | null, secret: string | null }}
 */
function clientCredentials(request, form) {
  const header = request.headers.get('authorization') ?? '';
  if (header.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return { id: null, secret: null };
    return {
      id: decodeURIComponent(decoded.slice(0, colon)),
      secret: decodeURIComponent(decoded.slice(colon + 1)),
    };
  }
  return { id: form.get('client_id'), secret: form.get('client_secret') };
}

/**
 * Create the issuer.
 *
 * @param {import('./issuer').FakeIssuerOptions} options
 * @returns {import('./issuer').FakeIssuer}
 */
export function createIssuer(options) {
  const issuer = options.issuer.replace(/\/+$/, '');
  const people = options.people ?? DEFAULT_PEOPLE;
  const clients = options.clients;
  const now = options.now ?? (() => Date.now());
  let tokenSeconds = options.tokenSeconds ?? DEFAULT_TOKEN_SECONDS;
  const endSessionSupported = options.endSession ?? true;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };

  /** @type {Map<string, { personId: string, clientId: string, redirectUri: string, nonce: string | null, challenge: string, expiresAt: number }>} */
  const codes = new Map();
  /** @type {Map<string, { personId: string, clientId: string, sid: string }>} */
  const refreshTokens = new Map();
  /** @type {Set<string>} */
  const revokedPeople = new Set();
  /** @type {string[]} */
  const endedSessions = [];

  /**
   * @param {Record<string, unknown>} claims
   * @returns {string}
   */
  function signJwt(claims) {
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const payload = base64Url(JSON.stringify(claims));
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey);
    return `${header}.${payload}.${base64Url(signature)}`;
  }

  /**
   * @param {string} personId
   * @param {string} clientId
   * @param {{ nonce?: string | null, sid: string }} extra
   * @returns {string}
   */
  function idTokenFor(personId, clientId, extra) {
    const person = people.find((candidate) => candidate.id === personId);
    if (!person) throw new Error(`no test person ${personId}`);
    const issuedAt = Math.floor(now() / 1000);
    return signJwt({
      ...person.claims,
      iss: issuer,
      aud: clientId,
      sub: person.subject ?? `fake-oidc|${person.id}`,
      iat: issuedAt,
      auth_time: issuedAt,
      exp: issuedAt + tokenSeconds,
      sid: extra.sid,
      ...(extra.nonce ? { nonce: extra.nonce } : {}),
    });
  }

  /**
   * @param {string} personId
   * @param {string} clientId
   * @param {string} sid
   * @param {string | null} nonce
   * @returns {Response}
   */
  function tokenResponse(personId, clientId, sid, nonce) {
    const refreshToken = base64Url(randomBytes(32));
    refreshTokens.set(refreshToken, { personId, clientId, sid });
    return json(200, {
      access_token: base64Url(randomBytes(24)),
      token_type: 'Bearer',
      expires_in: tokenSeconds,
      scope: 'openid email profile offline_access',
      id_token: idTokenFor(personId, clientId, { nonce, sid }),
      refresh_token: refreshToken,
    });
  }

  /** @returns {Response} */
  function discovery() {
    return json(200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      ...(endSessionSupported ? { end_session_endpoint: `${issuer}/end-session` } : {}),
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      scopes_supported: ['openid', 'email', 'profile', 'offline_access'],
      claims_supported: [
        'sub',
        'iss',
        'aud',
        'exp',
        'iat',
        'nonce',
        'email',
        'email_verified',
        'name',
        'given_name',
        'hd',
        'xms_edov',
        'sid',
      ],
    });
  }

  /**
   * The authorisation request's problem, or the client it names.
   *
   * @param {URLSearchParams} params
   * @returns {{ refusal: Response } | { client: import('./issuer').FakeClient }}
   */
  function checkAuthorisation(params) {
    const client = clients.find((candidate) => candidate.id === params.get('client_id'));
    if (!client) return { refusal: oauthError('unauthorized_client', 'unknown client_id') };
    const redirect = params.get('redirect_uri') ?? '';
    if (!client.redirectUris.includes(redirect)) {
      return { refusal: oauthError('invalid_request', 'redirect_uri is not registered') };
    }
    if (params.get('response_type') !== 'code') {
      return { refusal: oauthError('unsupported_response_type', 'only code is supported') };
    }
    if (!params.get('code_challenge') || params.get('code_challenge_method') !== 'S256') {
      return { refusal: oauthError('invalid_request', 'PKCE with S256 is required') };
    }
    if (!(params.get('scope') ?? '').split(' ').includes('openid')) {
      return { refusal: oauthError('invalid_scope', 'openid is required') };
    }
    return { client };
  }

  /**
   * @param {URLSearchParams} params
   * @param {string} personId
   * @returns {Response}
   */
  function issueCode(params, personId) {
    if (!people.some((person) => person.id === personId)) {
      return oauthError('access_denied', 'no such test person');
    }
    const code = base64Url(randomBytes(24));
    codes.set(code, {
      personId,
      clientId: params.get('client_id') ?? '',
      redirectUri: params.get('redirect_uri') ?? '',
      nonce: params.get('nonce'),
      challenge: params.get('code_challenge') ?? '',
      expiresAt: now() + CODE_SECONDS * 1000,
    });
    const destination = new URL(params.get('redirect_uri') ?? '');
    destination.searchParams.set('code', code);
    const state = params.get('state');
    if (state !== null) destination.searchParams.set('state', state);
    destination.searchParams.set('iss', issuer);
    return new Response(null, { status: 302, headers: { location: destination.toString() } });
  }

  /**
   * The page a browser picks a test person on; a `login_hint` naming one skips it.
   *
   * @param {URLSearchParams} params
   * @returns {Response}
   */
  function chooser(params) {
    const hidden = [...params.entries()]
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
      )
      .join('');
    const buttons = people
      .map(
        (person) =>
          `<li><button type="submit" name="person" value="${escapeHtml(person.id)}">` +
          `${escapeHtml(String(person.claims.name ?? person.id))} ` +
          `<span>${escapeHtml(String(person.claims.email ?? ''))}</span></button></li>`,
      )
      .join('');
    const html =
      '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Test issuer: choose a person</title>' +
      '<style>body{font:16px system-ui;margin:2rem auto;max-width:28rem;padding:0 1rem}' +
      'ul{list-style:none;padding:0}button{min-height:44px;width:100%;margin:.25rem 0;text-align:left;padding:.5rem .75rem}' +
      'span{color:#555;margin-left:.5rem}</style></head><body>' +
      '<h1>Test issuer</h1><p>Not a real sign-in. Choose who to sign in as.</p>' +
      `<form method="post" action="${escapeHtml(issuer)}/authorize">${hidden}<ul>${buttons}</ul></form>` +
      '</body></html>';
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function authorize(request) {
    const url = new URL(request.url);
    const params =
      request.method === 'POST' ? new URLSearchParams(await request.text()) : url.searchParams;
    const checked = checkAuthorisation(params);
    if ('refusal' in checked) return checked.refusal;
    const chosen = params.get('person');
    if (chosen) return issueCode(params, chosen);
    const hint = params.get('login_hint')?.toLowerCase();
    const hinted = hint
      ? people.find(
          (person) =>
            person.id === hint || String(person.claims.email ?? '').toLowerCase() === hint,
        )
      : undefined;
    if (hinted) return issueCode(params, hinted.id);
    return chooser(params);
  }

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function token(request) {
    const form = new URLSearchParams(await request.text());
    const credentials = clientCredentials(request, form);
    const client = clients.find((candidate) => candidate.id === credentials.id);
    if (!client || client.secret !== credentials.secret) {
      return oauthError('invalid_client', 'client authentication failed', 401);
    }
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const code = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!code || code.expiresAt <= now() || code.clientId !== client.id) {
        return oauthError('invalid_grant', 'the code is unknown, used or expired');
      }
      if (form.get('redirect_uri') !== code.redirectUri) {
        return oauthError('invalid_grant', 'redirect_uri differs from the authorisation request');
      }
      const verifier = form.get('code_verifier') ?? '';
      const challenge = base64Url(createHash('sha256').update(verifier).digest());
      if (!verifier || challenge !== code.challenge) {
        return oauthError('invalid_grant', 'the PKCE verifier does not match');
      }
      revokedPeople.delete(code.personId);
      return tokenResponse(code.personId, client.id, base64Url(randomBytes(12)), code.nonce);
    }
    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      const held = refreshTokens.get(presented);
      if (!held || held.clientId !== client.id || revokedPeople.has(held.personId)) {
        return oauthError('invalid_grant', 'the refresh token is unknown or revoked');
      }
      // Rotated, as Okta and Entra rotate: the presented token is spent.
      refreshTokens.delete(presented);
      return tokenResponse(held.personId, client.id, held.sid, null);
    }
    return oauthError('unsupported_grant_type', 'authorization_code or refresh_token');
  }

  /**
   * Revoke a refresh token (RFC 7009): the client's own, and silently nothing for any other.
   *
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function revoke(request) {
    const form = new URLSearchParams(await request.text());
    const credentials = clientCredentials(request, form);
    const client = clients.find((candidate) => candidate.id === credentials.id);
    if (!client || client.secret !== credentials.secret) {
      return oauthError('invalid_client', 'client authentication failed', 401);
    }
    const presented = form.get('token') ?? '';
    if (refreshTokens.get(presented)?.clientId === client.id) refreshTokens.delete(presented);
    return new Response(null, { status: 200 });
  }

  /**
   * @param {Request} request
   * @returns {Response}
   */
  function endSession(request) {
    const url = new URL(request.url);
    endedSessions.push(url.searchParams.get('id_token_hint') ?? '');
    const back = url.searchParams.get('post_logout_redirect_uri');
    if (!back) return new Response('Signed out of the test issuer.', { status: 200 });
    const destination = new URL(back);
    const state = url.searchParams.get('state');
    if (state !== null) destination.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { location: destination.toString() } });
  }

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function admin(request) {
    const url = new URL(request.url);
    if (url.pathname === '/admin/revoke' && request.method === 'POST') {
      const person = url.searchParams.get('person') ?? '';
      revokedPeople.add(person);
      return json(200, { ok: true, revoked: person });
    }
    if (url.pathname === '/admin/token-seconds' && request.method === 'POST') {
      const seconds = Number(url.searchParams.get('seconds'));
      if (!Number.isInteger(seconds) || seconds < 10) {
        return json(400, { ok: false, error: 'seconds must be an integer of at least 10' });
      }
      tokenSeconds = seconds;
      return json(200, { ok: true, tokenSeconds });
    }
    if (url.pathname === '/admin/state') {
      return json(200, {
        ok: true,
        tokenSeconds,
        liveRefreshTokens: refreshTokens.size,
        revokedPeople: [...revokedPeople],
        endedSessions: endedSessions.length,
      });
    }
    return json(404, { ok: false, error: 'not_found' });
  }

  return {
    issuer,
    jwks: { keys: [publicJwk] },
    mintIdToken: (claims) =>
      signJwt({
        iss: issuer,
        iat: Math.floor(now() / 1000),
        exp: Math.floor(now() / 1000) + tokenSeconds,
        ...claims,
      }),
    async handle(request) {
      const path = new URL(request.url).pathname;
      if (path === '/healthz') return json(200, { ok: true });
      if (path === '/.well-known/openid-configuration') return discovery();
      if (path === '/jwks') return json(200, { keys: [publicJwk] });
      if (path === '/authorize') return authorize(request);
      if (path === '/token' && request.method === 'POST') return token(request);
      if (path === '/revoke' && request.method === 'POST') return revoke(request);
      if (path === '/end-session') return endSession(request);
      if (path.startsWith('/admin/')) return admin(request);
      return json(404, { error: 'not_found' });
    },
  };
}
