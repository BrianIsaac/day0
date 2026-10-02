/**
 * A test OpenID Connect issuer: discovery, keys, authorisation codes with
 * PKCE, ID tokens and refresh tokens for a fixed set of test people, so a bed
 * and the route tests can sign people in without an external identity
 * provider (decision S3). Never a production issuer: anyone who can reach it
 * may sign in as any of its people.
 *
 * It is also an OAuth 2.1 authorisation server for one minimal protected MCP
 * resource (wave 11, 11-AM), so a bed and the browser job can walk the MCP
 * rung's authorisation without an external server: authorisation server
 * metadata (RFC 8414), the `iss` parameter on every authorisation response
 * (RFC 9207), resource indicators (RFC 8707), public clients, dynamic client
 * registration (RFC 7591), protected resource metadata (RFC 9728) and an MCP
 * endpoint that answers only a live access token issued for it.
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

/** The protocol revisions the protected MCP resource answers, newest first. */
const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

/** The scopes an OpenID client may ask for beside a resource's own. */
const OPENID_SCOPES = ['openid', 'email', 'profile', 'offline_access'];

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

  const protectedResource = options.protectedResource;
  const resourceUrl = protectedResource ? `${issuer}${protectedResource.path}` : null;
  const resourceMetadataUrl = protectedResource
    ? `${issuer}/.well-known/oauth-protected-resource${protectedResource.path}`
    : null;
  const dynamicRegistration = options.dynamicRegistration ?? false;

  /** @type {import('./issuer').FakeClient[]} */
  const registeredClients = [];
  /** @type {Map<string, { personId: string, clientId: string, redirectUri: string, nonce: string | null, challenge: string, expiresAt: number, resource: string | null, scope: string }>} */
  const codes = new Map();
  /** @type {Map<string, { personId: string, clientId: string, sid: string, resource: string | null, scope: string }>} */
  const refreshTokens = new Map();
  /** @type {Map<string, { personId: string, clientId: string, resource: string | null, expiresAt: number }>} */
  const accessTokens = new Map();
  /** @type {Set<string>} */
  const revokedPeople = new Set();
  /** @type {string[]} */
  const endedSessions = [];
  /** The `iss` an administrator set on authorisation responses, to test a mix-up; null is the issuer's own. */
  /** @type {string | null} */
  let issOverride = null;
  const counts = { codeExchanges: 0, refreshExchanges: 0, mcpRequests: 0 };
  /** @type {string | null} */
  let lastResource = null;

  /**
   * @param {string | null} id
   * @returns {import('./issuer').FakeClient | undefined}
   */
  function clientById(id) {
    return [...clients, ...registeredClients].find((candidate) => candidate.id === id);
  }

  /**
   * The client a token or revocation request authenticates as: a confidential client by its
   * secret, a public client (no secret registered) by its id alone.
   *
   * @param {Request} request
   * @param {URLSearchParams} form
   * @returns {import('./issuer').FakeClient | undefined}
   */
  function authenticatedClient(request, form) {
    const credentials = clientCredentials(request, form);
    const client = clientById(credentials.id);
    if (!client) return undefined;
    if (client.secret === undefined) return credentials.secret ? undefined : client;
    return client.secret === credentials.secret ? client : undefined;
  }

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
   * @param {{ personId: string, clientId: string, sid: string, nonce: string | null, resource: string | null, scope: string }} grant
   * @returns {Response}
   */
  function tokenResponse(grant) {
    const refreshToken = base64Url(randomBytes(32));
    const accessToken = base64Url(randomBytes(24));
    refreshTokens.set(refreshToken, {
      personId: grant.personId,
      clientId: grant.clientId,
      sid: grant.sid,
      resource: grant.resource,
      scope: grant.scope,
    });
    accessTokens.set(accessToken, {
      personId: grant.personId,
      clientId: grant.clientId,
      resource: grant.resource,
      expiresAt: now() + tokenSeconds * 1000,
    });
    lastResource = grant.resource;
    const openid = grant.scope.split(' ').includes('openid');
    return json(200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: tokenSeconds,
      scope: grant.scope,
      ...(openid
        ? {
            id_token: idTokenFor(grant.personId, grant.clientId, {
              nonce: grant.nonce,
              sid: grant.sid,
            }),
          }
        : {}),
      refresh_token: refreshToken,
    });
  }

  /** The authorisation server's own metadata, shared by both discovery documents. */
  function serverMetadata() {
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      revocation_endpoint: `${issuer}/revoke`,
      ...(dynamicRegistration ? { registration_endpoint: `${issuer}/register` } : {}),
      response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [...OPENID_SCOPES, ...(protectedResource?.scopes ?? [])],
    };
  }

  /** @returns {Response} */
  function discovery() {
    return json(200, {
      ...serverMetadata(),
      jwks_uri: `${issuer}/jwks`,
      ...(endSessionSupported ? { end_session_endpoint: `${issuer}/end-session` } : {}),
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
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
   * The protected resource's metadata (RFC 9728), at both well-known URIs.
   *
   * @returns {Response}
   */
  function resourceMetadata() {
    return json(200, {
      resource: resourceUrl,
      authorization_servers: [issuer],
      scopes_supported: [...(protectedResource?.scopes ?? [])],
      bearer_methods_supported: ['header'],
    });
  }

  /**
   * The scope an authorisation request asks for, or why it is refused: an OpenID request must
   * ask for `openid`; a request for the protected resource may ask only for the resource's
   * scopes and the OpenID ones.
   *
   * @param {URLSearchParams} params
   * @returns {{ refusal: Response } | { scope: string }}
   */
  function requestedScope(params) {
    const asked = (params.get('scope') ?? '').split(' ').filter((scope) => scope !== '');
    const resource = params.get('resource');
    if (resource === null) {
      if (!asked.includes('openid')) {
        return { refusal: oauthError('invalid_scope', 'openid is required') };
      }
      return { scope: asked.join(' ') };
    }
    if (!protectedResource || resource !== resourceUrl) {
      return {
        refusal: oauthError('invalid_target', 'the resource is not one this server protects'),
      };
    }
    const allowed = [...OPENID_SCOPES, ...protectedResource.scopes];
    if (asked.some((scope) => !allowed.includes(scope))) {
      return { refusal: oauthError('invalid_scope', 'a scope is not one the resource offers') };
    }
    return { scope: (asked.length > 0 ? asked : protectedResource.scopes).join(' ') };
  }

  /**
   * The authorisation request's problem, or the client it names and the scope it grants.
   *
   * @param {URLSearchParams} params
   * @returns {{ refusal: Response } | { client: import('./issuer').FakeClient, scope: string }}
   */
  function checkAuthorisation(params) {
    const client = clientById(params.get('client_id'));
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
    const scope = requestedScope(params);
    if ('refusal' in scope) return scope;
    return { client, scope: scope.scope };
  }

  /**
   * The redirect back to the client, carrying the state and this server's `iss` (RFC 9207).
   *
   * @param {URLSearchParams} params
   * @param {Record<string, string>} values
   * @returns {Response}
   */
  function redirectBack(params, values) {
    const destination = new URL(params.get('redirect_uri') ?? '');
    for (const [name, value] of Object.entries(values)) destination.searchParams.set(name, value);
    const state = params.get('state');
    if (state !== null) destination.searchParams.set('state', state);
    destination.searchParams.set('iss', issOverride ?? issuer);
    return new Response(null, { status: 302, headers: { location: destination.toString() } });
  }

  /**
   * @param {URLSearchParams} params
   * @param {string} personId
   * @param {string} scope
   * @returns {Response}
   */
  function issueCode(params, personId, scope) {
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
      resource: params.get('resource'),
      scope,
    });
    return redirectBack(params, { code });
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
      `<form method="post" action="${escapeHtml(issuer)}/authorize">${hidden}<ul>${buttons}</ul>` +
      '<p><button type="submit" name="decline" value="1">Decline</button></p></form>' +
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
    if (params.get('decline')) {
      return redirectBack(params, {
        error: 'access_denied',
        error_description: 'The person declined.',
      });
    }
    const chosen = params.get('person');
    if (chosen) return issueCode(params, chosen, checked.scope);
    const hint = params.get('login_hint')?.toLowerCase();
    const hinted = hint
      ? people.find(
          (person) =>
            person.id === hint || String(person.claims.email ?? '').toLowerCase() === hint,
        )
      : undefined;
    if (hinted) return issueCode(params, hinted.id, checked.scope);
    return chooser(params);
  }

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function token(request) {
    const form = new URLSearchParams(await request.text());
    const client = authenticatedClient(request, form);
    if (!client) return oauthError('invalid_client', 'client authentication failed', 401);
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
      // RFC 8707 with the MCP revision's rule: a code issued for a resource is exchanged only
      // with that resource named again.
      if (code.resource !== null && form.get('resource') !== code.resource) {
        return oauthError('invalid_target', 'the resource differs from the authorisation request');
      }
      const verifier = form.get('code_verifier') ?? '';
      const challenge = base64Url(createHash('sha256').update(verifier).digest());
      if (!verifier || challenge !== code.challenge) {
        return oauthError('invalid_grant', 'the PKCE verifier does not match');
      }
      revokedPeople.delete(code.personId);
      counts.codeExchanges += 1;
      return tokenResponse({
        personId: code.personId,
        clientId: client.id,
        sid: base64Url(randomBytes(12)),
        nonce: code.nonce,
        resource: code.resource,
        scope: code.scope,
      });
    }
    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      const held = refreshTokens.get(presented);
      if (!held || held.clientId !== client.id || revokedPeople.has(held.personId)) {
        return oauthError('invalid_grant', 'the refresh token is unknown or revoked');
      }
      const resource = form.get('resource');
      if (resource !== null && resource !== held.resource) {
        return oauthError('invalid_target', 'the resource differs from the grant');
      }
      // Rotated, as Okta and Entra rotate (and as the MCP revision requires for a public
      // client): the presented token is spent.
      refreshTokens.delete(presented);
      counts.refreshExchanges += 1;
      return tokenResponse({ ...held, clientId: client.id, nonce: null });
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
    const client = authenticatedClient(request, form);
    if (!client) return oauthError('invalid_client', 'client authentication failed', 401);
    const presented = form.get('token') ?? '';
    if (refreshTokens.get(presented)?.clientId === client.id) refreshTokens.delete(presented);
    if (accessTokens.get(presented)?.clientId === client.id) accessTokens.delete(presented);
    return new Response(null, { status: 200 });
  }

  /**
   * Register a public client (RFC 7591), offered only when the issuer is told to.
   *
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function register(request) {
    /** @type {{ redirect_uris?: unknown, token_endpoint_auth_method?: unknown, client_name?: unknown }} */
    let metadata;
    try {
      metadata = JSON.parse(await request.text());
    } catch {
      return json(400, { error: 'invalid_client_metadata', error_description: 'not JSON' });
    }
    const redirectUris = Array.isArray(metadata.redirect_uris)
      ? metadata.redirect_uris.filter((uri) => typeof uri === 'string')
      : [];
    if (redirectUris.length === 0) {
      return json(400, {
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris is required',
      });
    }
    if ((metadata.token_endpoint_auth_method ?? 'none') !== 'none') {
      return json(400, {
        error: 'invalid_client_metadata',
        error_description: 'only public clients register here',
      });
    }
    const client = { id: `dynamic-${base64Url(randomBytes(12))}`, redirectUris };
    registeredClients.push(client);
    return json(201, {
      client_id: client.id,
      client_id_issued_at: Math.floor(now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      ...(typeof metadata.client_name === 'string' ? { client_name: metadata.client_name } : {}),
    });
  }

  /**
   * The challenge a request without a live token for the resource is answered with.
   *
   * @param {boolean} presented whether the request carried a token at all
   * @returns {Response}
   */
  function challenge(presented) {
    const scope = (protectedResource?.scopes ?? []).join(' ');
    const value =
      `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scope}"` +
      (presented ? ', error="invalid_token"' : '');
    return json(401, { error: 'unauthorized' }, { 'www-authenticate': value });
  }

  /**
   * The minimal MCP endpoint: JSON-RPC over HTTP, answered as JSON, only for a live access token
   * issued for this resource. One tool, `whoami`, answers the person the token acts for.
   *
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function mcpEndpoint(request) {
    const header = request.headers.get('authorization') ?? '';
    const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const held = presented ? accessTokens.get(presented) : undefined;
    if (!held || held.expiresAt <= now() || held.resource !== resourceUrl) {
      return challenge(presented !== '');
    }
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    counts.mcpRequests += 1;
    /** @type {{ id?: unknown, method?: unknown, params?: { protocolVersion?: unknown, name?: unknown } }} */
    let message;
    try {
      message = JSON.parse(await request.text());
    } catch {
      return json(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }
    if (message.id === undefined) return new Response(null, { status: 202 });
    const reply = (/** @type {unknown} */ result) =>
      json(200, { jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') {
      const asked = message.params?.protocolVersion;
      return reply({
        protocolVersion:
          typeof asked === 'string' && MCP_PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fake-oidc MCP', version: '1.0.0' },
      });
    }
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') {
      return reply({
        tools: [
          {
            name: 'whoami',
            description: 'The address of the person the token acts for.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });
    }
    if (message.method === 'tools/call' && message.params?.name === 'whoami') {
      const person = people.find((candidate) => candidate.id === held.personId);
      return reply({
        content: [{ type: 'text', text: String(person?.claims.email ?? held.personId) }],
      });
    }
    return json(200, {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'Method not found' },
    });
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
    if (url.pathname === '/admin/iss' && request.method === 'POST') {
      const value = url.searchParams.get('value') ?? '';
      issOverride = value === '' ? null : value;
      return json(200, { ok: true, iss: issOverride ?? issuer });
    }
    if (url.pathname === '/admin/state') {
      return json(200, {
        ok: true,
        tokenSeconds,
        liveRefreshTokens: refreshTokens.size,
        liveAccessTokens: [...accessTokens.values()].filter((held) => held.expiresAt > now())
          .length,
        revokedPeople: [...revokedPeople],
        endedSessions: endedSessions.length,
        ...counts,
        lastResource,
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
      if (path === '/.well-known/oauth-authorization-server') return json(200, serverMetadata());
      if (
        protectedResource &&
        (path === '/.well-known/oauth-protected-resource' ||
          path === `/.well-known/oauth-protected-resource${protectedResource.path}`)
      ) {
        return resourceMetadata();
      }
      if (protectedResource && path === protectedResource.path) return mcpEndpoint(request);
      if (path === '/register' && request.method === 'POST' && dynamicRegistration) {
        return register(request);
      }
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
