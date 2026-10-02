import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createIssuer } from '../../../fake-oidc/issuer.js';
import type { FakeIssuer } from '../../../fake-oidc/issuer';
import { McpAddressRefusal, type HttpsRequest } from '../../../src/surfaces/mcp-address';
import { privateHostAllowlist } from '../../../src/lib/private-hosts';
import {
  addressCheckedFetch,
  authorisationServerMetadataUrls,
  authorisationUrl,
  canonicalResource,
  checkResponseIssuer,
  clientAuthentication,
  discoverAuthorisation,
  fetchAuthorisationServerMetadata,
  McpOauthRefusal,
  mcpSystemKey,
  newPkcePair,
  parseBearerChallenge,
  protectedResourceMetadataUrls,
  readAuthorisationServerMetadata,
  readTokenResponse,
  registerClient,
  requestTokens,
  type AuthorisationServerMetadata,
  type OauthFetch,
} from '../../../src/surfaces/mcp-oauth';

const ISSUER = 'https://auth.acme.test';
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = 'https://day0.acme.test/api/oauth/mcp';
const CLIENT = 'day0-mcp';

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function issuer(): FakeIssuer {
  return createIssuer({
    issuer: ISSUER,
    clients: [{ id: CLIENT, redirectUris: [REDIRECT] }],
    protectedResource: { path: '/mcp', scopes: ['read', 'write'] },
    dynamicRegistration: true,
  });
}

/** A fetch that hands every request to the in-process issuer, recording what was sent. */
function fetchTo(server: FakeIssuer, sent: Sent[] = []): OauthFetch {
  return async (url: URL, init: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    sent.push({
      url: url.href,
      method: request.method,
      headers: request.headers,
      body: init.body === undefined || init.body === null ? '' : String(init.body),
    });
    return await server.handle(request);
  };
}

/** The HTTPS transport the pinned fetch dials, answering from the in-process issuer. */
function issuerTransport(
  server: FakeIssuer,
  dialled: { url: URL; resolvedTo: unknown }[],
): HttpsRequest {
  return (url, options, callback) => {
    let fail: (error: Error) => void = (): void => undefined;
    return {
      on: (_event: 'error', listener: (error: Error) => void): void => {
        fail = listener;
      },
      end: (body?: string | Uint8Array): void => {
        const entry = { url, resolvedTo: undefined as unknown };
        dialled.push(entry);
        const lookup = options.lookup as unknown as (
          host: string,
          opts: { all: boolean },
          cb: (error: Error | null, addresses: unknown) => void,
        ) => void;
        lookup(url.hostname, { all: true }, (_error, addresses): void => {
          entry.resolvedTo = addresses;
        });
        const headers = new Headers();
        for (const [name, value] of Object.entries(options.headers ?? {})) {
          headers.set(name, String(value));
        }
        const text = typeof body === 'string' ? body : body && Buffer.from(body).toString('utf8');
        // The answer reaches the pinned fetch through the callback, and a failure through the
        // request's error listener, as Node's own transport delivers them.
        void server
          .handle(
            new Request(url, {
              method: options.method,
              headers,
              ...(text === undefined ? {} : { body: text }),
            }),
          )
          .then(async (answer): Promise<void> => {
            const response = Object.assign(new PassThrough(), {
              statusCode: answer.status,
              statusMessage: '',
              headers: Object.fromEntries(answer.headers),
            });
            callback(response as unknown as IncomingMessage);
            response.end(Buffer.from(await answer.arrayBuffer()));
          })
          .catch((error: unknown): void => {
            fail(error instanceof Error ? error : new Error(String(error)));
          });
      },
    };
  };
}

/** The refusal a pending call rejected with; anything else fails the test. */
async function refusalOf(pending: Promise<unknown>): Promise<McpOauthRefusal> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof McpOauthRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** The reason a synchronous call refused with; anything else fails the test. */
function reasonOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    if (error instanceof McpOauthRefusal) return error.reason;
    throw error;
  }
  throw new Error('expected a refusal');
}

const METADATA: AuthorisationServerMetadata = {
  issuer: ISSUER,
  authorisationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  issParameterSupported: true,
  tokenEndpointAuthMethods: ['none'],
};

describe('naming a server', (): void => {
  it('keys an MCP server by its host and its resource by the canonical URI', (): void => {
    expect(mcpSystemKey(new URL('https://MCP.Example.com:8443/mcp'))).toBe(
      'mcp:mcp.example.com:8443',
    );
    expect(canonicalResource(new URL('HTTPS://MCP.Example.com/mcp#frag'))).toBe(
      'https://mcp.example.com/mcp',
    );
    expect(canonicalResource(new URL('https://mcp.example.com/'))).toBe('https://mcp.example.com');
  });
});

describe('the challenge and the well-known URIs', (): void => {
  it('reads the resource metadata URL and the scopes from a Bearer challenge among others', (): void => {
    expect(
      parseBearerChallenge(
        'Basic realm="x", Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", scope="read write", error="invalid_token"',
      ),
    ).toEqual({
      resourceMetadata: 'https://mcp.linear.app/.well-known/oauth-protected-resource/mcp',
      scopes: ['read', 'write'],
      error: 'invalid_token',
    });
    expect(parseBearerChallenge('Basic realm="x"')).toBeUndefined();
    expect(parseBearerChallenge(null)).toBeUndefined();
  });

  it('tries the path-inserted protected resource metadata before the root', (): void => {
    expect(
      protectedResourceMetadataUrls(new URL('https://example.com/public/mcp')).map(String),
    ).toEqual([
      'https://example.com/.well-known/oauth-protected-resource/public/mcp',
      'https://example.com/.well-known/oauth-protected-resource',
    ]);
    expect(protectedResourceMetadataUrls(new URL('https://example.com/')).map(String)).toEqual([
      'https://example.com/.well-known/oauth-protected-resource',
    ]);
  });

  it('tries the authorisation server metadata in the revision’s order, with and without a path', (): void => {
    expect(authorisationServerMetadataUrls('https://auth.example.com/tenant1').map(String)).toEqual(
      [
        'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
        'https://auth.example.com/.well-known/openid-configuration/tenant1',
        'https://auth.example.com/tenant1/.well-known/openid-configuration',
      ],
    );
    expect(authorisationServerMetadataUrls('https://auth.example.com').map(String)).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ]);
  });
});

describe('discovery', (): void => {
  it('follows the challenge to the resource metadata and on to the authorisation server', async (): Promise<void> => {
    const sent: Sent[] = [];
    const target = await discoverAuthorisation(fetchTo(issuer(), sent), new URL(RESOURCE));
    expect(target.resource).toBe(RESOURCE);
    expect(target.scopes).toEqual(['read', 'write']);
    expect(target.server).toMatchObject({
      issuer: ISSUER,
      authorisationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      revocationEndpoint: `${ISSUER}/revoke`,
      registrationEndpoint: `${ISSUER}/register`,
      issParameterSupported: true,
    });
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      `POST ${RESOURCE}`,
      `GET ${ISSUER}/.well-known/oauth-protected-resource/mcp`,
      `GET ${ISSUER}/.well-known/oauth-authorization-server`,
    ]);
    expect(sent[0].headers.get('authorization')).toBeNull();
  });

  it('falls back to the well-known URIs when the server sends no challenge', async (): Promise<void> => {
    const server = issuer();
    const sent: Sent[] = [];
    const quiet: OauthFetch = async (url, init) =>
      url.pathname === '/mcp' && init.method === 'POST'
        ? new Response(null, { status: 401 })
        : await fetchTo(server, sent)(url, init);
    const target = await discoverAuthorisation(quiet, new URL(RESOURCE));
    expect(target.server.issuer).toBe(ISSUER);
    expect(sent[0].url).toBe(`${ISSUER}/.well-known/oauth-protected-resource/mcp`);
  });

  it('refuses resource metadata that names another resource', async (): Promise<void> => {
    const server = issuer();
    const lying: OauthFetch = async (url, init) =>
      url.pathname.startsWith('/.well-known/oauth-protected-resource')
        ? Response.json({
            resource: 'https://other.acme.test/mcp',
            authorization_servers: [ISSUER],
          })
        : await fetchTo(server)(url, init);
    expect((await refusalOf(discoverAuthorisation(lying, new URL(RESOURCE)))).reason).toBe(
      'resource-mismatch',
    );
  });

  it('refuses authorisation server metadata whose issuer is not the one it was fetched for', async (): Promise<void> => {
    const server = issuer();
    const mixedUp: OauthFetch = async (url, init) => {
      const answer = await fetchTo(server)(url, init);
      if (!url.pathname.includes('authorization-server') && !url.pathname.includes('openid')) {
        return answer;
      }
      return Response.json({ ...(await answer.json()), issuer: 'https://honest.acme.test' });
    };
    expect((await refusalOf(discoverAuthorisation(mixedUp, new URL(RESOURCE)))).reason).toBe(
      'issuer-mismatch',
    );
  });

  it('refuses a server that does not advertise S256', (): void => {
    const body = {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
    };
    expect(reasonOf(() => readAuthorisationServerMetadata(body, ISSUER))).toBe('pkce-unsupported');
    expect(
      reasonOf(() =>
        readAuthorisationServerMetadata(
          { ...body, code_challenge_methods_supported: ['plain'] },
          ISSUER,
        ),
      ),
    ).toBe('pkce-unsupported');
  });

  it('refuses an authorisation endpoint that is not https', (): void => {
    expect(() =>
      readAuthorisationServerMetadata(
        {
          issuer: ISSUER,
          authorization_endpoint: 'http://auth.acme.test/authorize',
          token_endpoint: `${ISSUER}/token`,
          code_challenge_methods_supported: ['S256'],
        },
        ISSUER,
      ),
    ).toThrow('https');
  });

  it('takes the issuer the organisation registered when the resource lists several', async (): Promise<void> => {
    const server = issuer();
    const several: OauthFetch = async (url, init) =>
      url.pathname === '/.well-known/oauth-protected-resource/mcp'
        ? Response.json({
            resource: RESOURCE,
            authorization_servers: ['https://first.acme.test', ISSUER],
          })
        : await fetchTo(server)(url, init);
    const target = await discoverAuthorisation(several, new URL(RESOURCE), { issuer: ISSUER });
    expect(target.server.issuer).toBe(ISSUER);
    expect(
      (
        await refusalOf(
          discoverAuthorisation(several, new URL(RESOURCE), { issuer: 'https://third.acme.test' }),
        )
      ).reason,
    ).toBe('issuer-mismatch');
  });

  it('falls through to the next well-known URI when one cannot be reached or does not validate', async (): Promise<void> => {
    const server = issuer();
    const flaky: OauthFetch = async (url, init) => {
      if (url.pathname === '/mcp') throw new Error('socket hang up');
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        throw new Error('connect ECONNRESET');
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize` });
      }
      return await fetchTo(server)(url, init);
    };
    const target = await discoverAuthorisation(flaky, new URL(RESOURCE));
    expect(target.server.issuer).toBe(ISSUER);
    expect(target.server.tokenEndpoint).toBe(`${ISSUER}/token`);
  });

  it('falls back to the well-known URIs when the challenge names a malformed metadata URL', async (): Promise<void> => {
    const server = issuer();
    const malformed: OauthFetch = async (url, init) =>
      url.pathname === '/mcp' && init.method === 'POST'
        ? new Response(null, {
            status: 401,
            headers: { 'www-authenticate': 'Bearer resource_metadata="not a url"' },
          })
        : await fetchTo(server)(url, init);
    expect((await discoverAuthorisation(malformed, new URL(RESOURCE))).server.issuer).toBe(ISSUER);
  });

  it('refuses to choose between several authorisation servers when none was registered', async (): Promise<void> => {
    const server = issuer();
    const several: OauthFetch = async (url, init) =>
      url.pathname === '/.well-known/oauth-protected-resource/mcp'
        ? Response.json({
            resource: RESOURCE,
            authorization_servers: [ISSUER, 'https://second.acme.test'],
          })
        : await fetchTo(server)(url, init);
    expect((await refusalOf(discoverAuthorisation(several, new URL(RESOURCE)))).reason).toBe(
      'issuer-ambiguous',
    );
  });

  it('gives every request a timeout when the caller set none', async (): Promise<void> => {
    const server = issuer();
    const signals: (AbortSignal | undefined)[] = [];
    const fetch = addressCheckedFetch({
      resolve: async (): Promise<string[]> => ['93.184.216.34'],
      request: (url, options, callback) => {
        signals.push(options.signal ?? undefined);
        return issuerTransport(server, [])(url, options, callback);
      },
      privateHosts: privateHostAllowlist(''),
    });
    await fetchAuthorisationServerMetadata(fetch, ISSUER);
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('honours the address rules and the pinned fetch for every discovery request', async (): Promise<void> => {
    const server = issuer();
    const dialled: { url: URL; resolvedTo: unknown }[] = [];
    const resolve = async (host: string): Promise<string[]> =>
      host === 'auth.acme.test' ? ['93.184.216.34'] : ['10.0.0.8'];
    const fetch = addressCheckedFetch({
      resolve,
      request: issuerTransport(server, dialled),
      privateHosts: privateHostAllowlist(''),
    });
    const target = await discoverAuthorisation(fetch, new URL(RESOURCE));
    expect(target.server.issuer).toBe(ISSUER);
    expect(dialled.map((entry) => entry.url.pathname)).toEqual([
      '/mcp',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
    ]);
    for (const entry of dialled) {
      expect(entry.resolvedTo).toEqual([{ address: '93.184.216.34', family: 4 }]);
    }

    // A resource whose metadata points discovery at a private address is refused before a socket opens.
    const before = dialled.length;
    const rogue = addressCheckedFetch({
      resolve,
      request: issuerTransport(server, dialled),
      privateHosts: privateHostAllowlist(''),
    });
    await expect(rogue(new URL('https://internal.acme.test/.well-known/x'), {})).rejects.toThrow(
      McpAddressRefusal,
    );
    await expect(rogue(new URL('http://auth.acme.test/mcp'), {})).rejects.toThrow(
      McpAddressRefusal,
    );
    expect(dialled).toHaveLength(before);
  });
});

describe('the authorisation request', (): void => {
  it('carries PKCE S256, the resource, the state and the scopes', (): void => {
    const pair = newPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
    const url = authorisationUrl({
      server: METADATA,
      clientId: CLIENT,
      redirectUrl: REDIRECT,
      state: 'signed-state',
      challenge: pair.challenge,
      resource: RESOURCE,
      scopes: ['read', 'write'],
    });
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      state: 'signed-state',
      code_challenge: pair.challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
      scope: 'read write',
    });
    expect(url.searchParams.has('code_verifier')).toBe(false);
  });
});

describe('the authorisation response’s issuer (RFC 9207, the 2026-07-28 table)', (): void => {
  it('compares a present iss by simple string comparison, whatever the metadata says', (): void => {
    for (const issParameterSupported of [true, false]) {
      expect(
        checkResponseIssuer({ iss: ISSUER, recordedIssuer: ISSUER, issParameterSupported }),
      ).toEqual({ ok: true });
      expect(
        checkResponseIssuer({ iss: `${ISSUER}/`, recordedIssuer: ISSUER, issParameterSupported }),
      ).toEqual({ ok: false, reason: 'iss-mismatch' });
      expect(
        checkResponseIssuer({
          iss: 'HTTPS://auth.acme.test',
          recordedIssuer: ISSUER,
          issParameterSupported,
        }),
      ).toEqual({ ok: false, reason: 'iss-mismatch' });
    }
  });

  it('refuses an absent iss only where the server advertised it', (): void => {
    expect(
      checkResponseIssuer({ iss: null, recordedIssuer: ISSUER, issParameterSupported: true }),
    ).toEqual({ ok: false, reason: 'iss-missing' });
    expect(
      checkResponseIssuer({ iss: null, recordedIssuer: ISSUER, issParameterSupported: false }),
    ).toEqual({ ok: true });
  });
});

describe('the token requests', (): void => {
  async function authorisedCode(server: FakeIssuer, challenge: string): Promise<string> {
    const url = authorisationUrl({
      server: METADATA,
      clientId: CLIENT,
      redirectUrl: REDIRECT,
      state: 's',
      challenge,
      resource: RESOURCE,
      scopes: ['read'],
    });
    url.searchParams.set('login_hint', 'priya');
    const back = new URL((await server.handle(new Request(url))).headers.get('location') ?? '');
    return back.searchParams.get('code') ?? '';
  }

  it('sends the verifier and the resource with the code, and the resource with every refresh', async (): Promise<void> => {
    const server = issuer();
    const sent: Sent[] = [];
    const pair = newPkcePair();
    const code = await authorisedCode(server, pair.challenge);
    const issued = await requestTokens(
      fetchTo(server, sent),
      {
        tokenEndpoint: METADATA.tokenEndpoint,
        clientId: CLIENT,
        auth: { method: 'none' },
        resource: RESOURCE,
        grant: {
          grant: 'authorization_code',
          code,
          redirectUrl: REDIRECT,
          verifier: pair.verifier,
        },
      },
      1_000,
    );
    expect(issued.accessToken).toEqual(expect.any(String));
    expect(issued.refreshToken).toEqual(expect.any(String));
    expect(issued.expiresAt).toBe(1_000 + 300_000);
    expect(issued.scopes).toEqual(['read']);
    const exchange = new URLSearchParams(sent[0].body);
    expect(Object.fromEntries(exchange)).toEqual({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: pair.verifier,
      client_id: CLIENT,
      resource: RESOURCE,
    });

    const rotated = await requestTokens(
      fetchTo(server, sent),
      {
        tokenEndpoint: METADATA.tokenEndpoint,
        clientId: CLIENT,
        auth: { method: 'none' },
        resource: RESOURCE,
        grant: { grant: 'refresh_token', refreshToken: issued.refreshToken ?? '' },
      },
      2_000,
    );
    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    expect(new URLSearchParams(sent[1].body).get('resource')).toBe(RESOURCE);
    expect(new URLSearchParams(sent[1].body).get('grant_type')).toBe('refresh_token');
  });

  it('authenticates a confidential client with Basic where the server offers it, else in the form', (): void => {
    expect(clientAuthentication(METADATA, undefined)).toEqual({ method: 'none' });
    expect(
      clientAuthentication(
        { ...METADATA, tokenEndpointAuthMethods: ['client_secret_post', 'client_secret_basic'] },
        'secret',
      ),
    ).toEqual({ method: 'client_secret_basic', secret: 'secret' });
    expect(
      clientAuthentication(
        { ...METADATA, tokenEndpointAuthMethods: ['client_secret_post'] },
        'secret',
      ),
    ).toEqual({ method: 'client_secret_post', secret: 'secret' });
    expect(clientAuthentication({ ...METADATA, tokenEndpointAuthMethods: [] }, 'secret')).toEqual({
      method: 'client_secret_basic',
      secret: 'secret',
    });
    expect(() =>
      clientAuthentication(
        { ...METADATA, tokenEndpointAuthMethods: ['private_key_jwt'] },
        'secret',
      ),
    ).toThrow(McpOauthRefusal);
  });

  it('reads a busy or failing token endpoint as unavailable, not as a refusal', (): void => {
    for (const status of [429, 500, 503]) {
      expect(
        reasonOf(() => readTokenResponse(status, { error: 'temporarily_unavailable' }, 0)),
      ).toBe('token-unavailable');
    }
    expect(reasonOf(() => readTokenResponse(400, { error: 'invalid_grant' }, 0))).toBe(
      'token-refused',
    );
  });

  it('keeps an error code only when it is a code, never free text', (): void => {
    let refusal: McpOauthRefusal | undefined;
    try {
      readTokenResponse(400, { error: 'the grant was revoked by an administrator' }, 0);
    } catch (error) {
      refusal = error as McpOauthRefusal;
    }
    expect(refusal?.oauthError).toBeUndefined();
    expect(refusal?.message).toContain('HTTP 400');
  });

  it('takes a lifetime the server sent as a numeric string', (): void => {
    expect(
      readTokenResponse(
        200,
        { access_token: 'x', token_type: 'Bearer', expires_in: '3600' },
        1_000,
      ),
    ).toEqual({ accessToken: 'x', expiresAt: 1_000 + 3_600_000 });
  });

  it('form-encodes the client id and secret before the Basic pair (RFC 6749 section 2.3.1)', async (): Promise<void> => {
    const sent: Sent[] = [];
    const capture: OauthFetch = async (url, init) => {
      sent.push({
        url: url.href,
        method: init.method ?? 'GET',
        headers: new Headers(init.headers),
        body: String(init.body),
      });
      return Response.json({ access_token: 'a', token_type: 'Bearer' });
    };
    await requestTokens(
      capture,
      {
        tokenEndpoint: `${ISSUER}/token`,
        clientId: 'day0 mcp',
        auth: { method: 'client_secret_basic', secret: 'a b~c' },
        resource: RESOURCE,
        grant: { grant: 'refresh_token', refreshToken: 'r' },
      },
      0,
    );
    const pair = Buffer.from(
      (sent[0].headers.get('authorization') ?? '').replace(/^Basic /, ''),
      'base64',
    ).toString('utf8');
    expect(pair).toBe('day0+mcp:a+b%7Ec');
  });

  it('names the server’s error code and never its description', (): void => {
    let refusal: unknown;
    try {
      readTokenResponse(
        400,
        { error: 'invalid_grant', error_description: 'echo lin_api_secret' },
        0,
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(McpOauthRefusal);
    expect((refusal as McpOauthRefusal).reason).toBe('token-refused');
    expect((refusal as McpOauthRefusal).oauthError).toBe('invalid_grant');
    expect((refusal as Error).message).not.toContain('lin_api_secret');
  });

  it('refuses a token response without a bearer access token', (): void => {
    expect(() => readTokenResponse(200, { access_token: 'x', token_type: 'mac' }, 0)).toThrow(
      McpOauthRefusal,
    );
    expect(() => readTokenResponse(200, { token_type: 'Bearer' }, 0)).toThrow(McpOauthRefusal);
    expect(readTokenResponse(200, { access_token: 'x', token_type: 'bearer' }, 0)).toEqual({
      accessToken: 'x',
    });
  });
});

describe('dynamic registration', (): void => {
  it('registers a public client with the one redirect', async (): Promise<void> => {
    const server = issuer();
    const registration = await registerClient(fetchTo(server), `${ISSUER}/register`, {
      clientName: 'Day0',
      redirectUrl: REDIRECT,
    });
    expect(registration.clientId).toMatch(/^dynamic-/);
    expect(registration.clientSecret).toBeUndefined();
  });

  it('refuses where the server will not register', async (): Promise<void> => {
    const refusing: OauthFetch = async () => Response.json({ error: 'nope' }, { status: 403 });
    expect(
      (
        await refusalOf(
          registerClient(refusing, `${ISSUER}/register`, {
            clientName: 'Day0',
            redirectUrl: REDIRECT,
          }),
        )
      ).reason,
    ).toBe('registration-refused');
  });
});

describe('re-reading a recorded issuer', (): void => {
  it('fetches the issuer’s own metadata and validates it against the recorded issuer', async (): Promise<void> => {
    const metadata = await fetchAuthorisationServerMetadata(fetchTo(issuer()), ISSUER);
    expect(metadata.issParameterSupported).toBe(true);
    expect(metadata.tokenEndpoint).toBe(`${ISSUER}/token`);
  });
});
