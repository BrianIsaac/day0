import { describe, expect, it } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import type { ActionCtx } from '../../../convex/_generated/server';
import { TransientProviderError } from '../../../src/lib/transport-error';
import {
  forgetNangoConnection,
  nangoConfigFrom,
  nangoLocation,
  NangoRefusal,
  nangoTokenBackend,
  parseNangoLocation,
  readNangoToken,
  type NangoConfig,
  type NangoFetch,
} from '../../../src/surfaces/nango-token-store';

const SECRET_KEY = '3f1c2a9e-5b7d-4c8a-9e21-0a6b4d2c8f17';
const CONFIG: NangoConfig = { baseUrl: new URL('http://nango-server:3003'), secretKey: SECRET_KEY };
const REF = { providerConfigKey: 'tracker-cc', connectionId: 'employee 1/tracker' };
const ctx = {} as ActionCtx;
const CREDENTIAL = 'credential-1' as Id<'credentials'>;

/*
 * The answers below are the shapes Nango 0.71.11 (the free self-hosted edition, digest
 * sha256:c41e96bc...) gave on the V-A4 spike, 2 October 2026, with fake values in the tree's short
 * shapes: a read of a client-credentials connection, a refused refresh, the back-off after it, an
 * unknown connection and a key Nango refuses.
 */
const CC_CONNECTION = {
  id: 8,
  connection_id: 'employee 1/tracker',
  provider_config_key: 'tracker-cc',
  provider: 'tracker-oauth2-cc',
  errors: [],
  credentials: {
    type: 'OAUTH2_CC',
    token: 'fake-cc-4',
    client_id: 'client-1234567890',
    client_secret: 'secret-abcdefghij',
    expires_at: '2026-10-02T11:13:50.598Z',
    raw: { access_token: 'fake-cc-4', token_type: 'Bearer', expires_in: 1200 },
  },
};
const REFUSED = {
  error: {
    code: 'invalid_credentials',
    message:
      'Failed to fetch client credentials token: {"connection":{"id":6,"credentials_iv":"JRBGnM3sdTibpLdE","credentials_tag":"+uYFoWvdwQsDhi51bwYmtQ=="}}',
  },
};
const BACKING_OFF = {
  error: {
    code: 'invalid_credentials',
    message: 'A recent refresh attempt failed. Backing off before retrying.',
  },
};

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

function nango(answer: (url: URL, init: RequestInit) => Response): {
  fetch: NangoFetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (input: URL, init: RequestInit): Promise<Response> => {
      calls.push({ url: input.href, init });
      return answer(input, init);
    },
  };
}

describe('the Nango location a credential row seals', (): void => {
  it('round-trips a connection, escaping what a path or a query would read', (): void => {
    const location = nangoLocation(REF);
    expect(location).toBe('nango:tracker-cc/employee%201%2Ftracker');
    expect(parseNangoLocation(location)).toEqual(REF);
  });

  it('refuses a location that is not a Nango connection', (): void => {
    for (const location of ['', 'tracker-cc/conn', 'nango:', 'nango:only-a-key', 'nango:/conn']) {
      expect(() => parseNangoLocation(location)).toThrow(NangoRefusal);
    }
  });
});

describe('the Nango configuration', (): void => {
  it('reads the address and the key the setup writes', (): void => {
    expect(
      nangoConfigFrom({
        DAY0_NANGO_URL: 'http://nango-server:3003',
        DAY0_NANGO_SECRET_KEY: SECRET_KEY,
      }),
    ).toEqual(CONFIG);
  });

  it('names what is missing when Nango is not configured', (): void => {
    expect(() => nangoConfigFrom({})).toThrow(
      'Nango is not configured on this deployment: DAY0_NANGO_URL and DAY0_NANGO_SECRET_KEY are unset.',
    );
    expect(() => nangoConfigFrom({ DAY0_NANGO_URL: 'http://nango-server:3003' })).toThrow(
      'DAY0_NANGO_SECRET_KEY is unset',
    );
  });

  it('refuses a key Nango itself would refuse, and an address that is not plain HTTP', (): void => {
    expect(() =>
      nangoConfigFrom({ DAY0_NANGO_URL: 'http://nango-server:3003', DAY0_NANGO_SECRET_KEY: 'k' }),
    ).toThrow('DAY0_NANGO_SECRET_KEY is not a version 4 UUID');
    for (const url of ['ftp://nango-server', 'http://user:pass@nango-server:3003', 'not a url']) {
      expect(() =>
        nangoConfigFrom({ DAY0_NANGO_URL: url, DAY0_NANGO_SECRET_KEY: SECRET_KEY }),
      ).toThrow('DAY0_NANGO_URL');
    }
  });
});

describe('reading a token from Nango', (): void => {
  it('reads the access token alone, without asking for the refresh token or a forced refresh', async (): Promise<void> => {
    const fake = nango(() => Response.json(CC_CONNECTION));
    await expect(readNangoToken(fake.fetch, CONFIG, REF)).resolves.toEqual({
      accessToken: 'fake-cc-4',
      expiresAt: Date.parse('2026-10-02T11:13:50.598Z'),
    });
    expect(fake.calls).toHaveLength(1);
    const url = new URL(fake.calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(
      'http://nango-server:3003/connections/employee%201%2Ftracker',
    );
    expect([...url.searchParams.keys()]).toEqual(['provider_config_key']);
    expect(url.searchParams.get('provider_config_key')).toBe('tracker-cc');
    expect(fake.calls[0].init.method).toBe('GET');
    expect(fake.calls[0].init.redirect).toBe('manual');
    expect(new Headers(fake.calls[0].init.headers).get('authorization')).toBe(
      `Bearer ${SECRET_KEY}`,
    );
  });

  it('reads the access token of an OAuth 2 connection', async (): Promise<void> => {
    const fake = nango(() =>
      Response.json({
        credentials: { type: 'OAUTH2', access_token: 'fake-access-1', expires_at: null },
      }),
    );
    await expect(readNangoToken(fake.fetch, CONFIG, REF)).resolves.toEqual({
      accessToken: 'fake-access-1',
    });
  });

  it('reads a refused refresh as a refusal and never repeats what Nango said about its row', async (): Promise<void> => {
    for (const [status, body] of [
      [400, REFUSED],
      [424, BACKING_OFF],
    ] as const) {
      const fake = nango(() => Response.json(body, { status }));
      const refusal = await readNangoToken(fake.fetch, CONFIG, REF).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(NangoRefusal);
      expect(refusal).toMatchObject({ reason: 'refresh-refused' });
      expect(String((refusal as Error).message)).not.toContain('credentials_iv');
      expect(String((refusal as Error).message)).toContain('the provider refused');
    }
  });

  it('names an unknown connection and a key Nango refuses', async (): Promise<void> => {
    await expect(
      readNangoToken(
        nango(() =>
          Response.json(
            { error: { code: 'not_found', message: 'Failed to find connection' } },
            { status: 404 },
          ),
        ).fetch,
        CONFIG,
        REF,
      ),
    ).rejects.toMatchObject({ reason: 'not-found' });
    await expect(
      readNangoToken(
        nango(() =>
          Response.json(
            { error: { code: 'invalid_secret_key_format', message: 'not a UUID v4' } },
            { status: 401 },
          ),
        ).fetch,
        CONFIG,
        REF,
      ),
    ).rejects.toMatchObject({ reason: 'key-refused' });
  });

  it('reads a busy or failing Nango as transient, so a probe tries again', async (): Promise<void> => {
    for (const status of [429, 502]) {
      await expect(
        readNangoToken(nango(() => new Response('busy', { status })).fetch, CONFIG, REF),
      ).rejects.toBeInstanceOf(TransientProviderError);
    }
  });

  it('refuses an answer that carries no access token', async (): Promise<void> => {
    for (const body of [
      { credentials: { type: 'API_KEY', apiKey: 'k' } },
      { credentials: { type: 'OAUTH2_CC', token: '' } },
      { nothing: true },
    ]) {
      await expect(
        readNangoToken(nango(() => Response.json(body)).fetch, CONFIG, REF),
      ).rejects.toMatchObject({ reason: 'malformed-answer' });
    }
  });

  it('says Nango could not be reached when the request fails', async (): Promise<void> => {
    const unreachable: NangoFetch = async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };
    await expect(readNangoToken(unreachable, CONFIG, REF)).rejects.toMatchObject({
      reason: 'unavailable',
      message: 'Nango could not be reached: fetch failed',
    });
  });
});

describe('forgetting a Nango connection', (): void => {
  it('deletes the connection, and reads one already gone as forgotten', async (): Promise<void> => {
    const deleted = nango(() => Response.json({ success: true }));
    await forgetNangoConnection(deleted.fetch, CONFIG, REF);
    expect(deleted.calls[0].init.method).toBe('DELETE');
    expect(deleted.calls[0].url).toBe(
      'http://nango-server:3003/connections/employee%201%2Ftracker?provider_config_key=tracker-cc',
    );
    const gone = nango(() => Response.json({ error: { code: 'not_found' } }, { status: 404 }));
    await expect(forgetNangoConnection(gone.fetch, CONFIG, REF)).resolves.toBeUndefined();
    // Recorded on the 11-AT bed, 2 October: Nango 0.71.11 answers a second delete of the same
    // connection, or one it never held, with 400 and this code rather than 404.
    const unknown = nango(() =>
      Response.json({ error: { code: 'unknown_connection' } }, { status: 400 }),
    );
    await expect(forgetNangoConnection(unknown.fetch, CONFIG, REF)).resolves.toBeUndefined();
  });

  it('refuses when Nango does not delete it', async (): Promise<void> => {
    await expect(
      forgetNangoConnection(nango(() => Response.json({}, { status: 401 })).fetch, CONFIG, REF),
    ).rejects.toMatchObject({ reason: 'key-refused' });
  });
});

describe('the Nango backend of the token store', (): void => {
  it('opens the row for its location and answers with the token Nango holds there', async (): Promise<void> => {
    const fake = nango(() => Response.json(CC_CONNECTION));
    const opened: string[] = [];
    const backend = nangoTokenBackend({
      fetch: fake.fetch,
      config: (): NangoConfig => CONFIG,
      location: async (_context, credentialId): Promise<string> => {
        opened.push(credentialId);
        return nangoLocation(REF);
      },
    });
    expect(backend.kind).toBe('nango');
    await expect(backend.accessTokenFor(ctx, CREDENTIAL)).resolves.toBe('fake-cc-4');
    expect(opened).toEqual([CREDENTIAL]);
  });

  it('refuses before opening the row when Nango is not configured', async (): Promise<void> => {
    const opened: string[] = [];
    const backend = nangoTokenBackend({
      fetch: nango(() => Response.json(CC_CONNECTION)).fetch,
      config: (): NangoConfig => nangoConfigFrom({}),
      location: async (_context, credentialId): Promise<string> => {
        opened.push(credentialId);
        return nangoLocation(REF);
      },
    });
    await expect(backend.accessTokenFor(ctx, CREDENTIAL)).rejects.toMatchObject({
      reason: 'not-configured',
    });
    expect(opened).toEqual([]);
  });
});
