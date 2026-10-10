import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkPageAddress,
  pinnedPageFetch,
  PageAddressRefusal,
  type CheckedPageAddress,
  type PageRequest,
} from '../../../../src/docs/readers/page-address';
import { privateHostAllowlist } from '../../../../src/lib/private-hosts';

afterEach((): void => {
  vi.unstubAllEnvs();
});

/** A resolver that answers from a table and fails a name it does not hold as unknown. */
function resolverOf(answers: Record<string, string[]>): (hostname: string) => Promise<string[]> {
  return async (hostname: string): Promise<string[]> => {
    const found = answers[hostname];
    if (found === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    }
    return found;
  };
}

describe('checkPageAddress', (): void => {
  const none = privateHostAllowlist('');

  it('admits a public page over https with the addresses its host answered with', async (): Promise<void> => {
    const checked = await checkPageAddress(
      new URL('https://docs.example.com/runbook'),
      resolverOf({ 'docs.example.com': ['93.184.215.14'] }),
      none,
    );
    expect(checked.addresses).toEqual(['93.184.215.14']);
    expect(checked.url.href).toBe('https://docs.example.com/runbook');
  });

  it('admits plain http, and a private answer, only from a listed host', async (): Promise<void> => {
    const resolve = resolverOf({ 'wiki.corp.internal': ['10.1.2.3'] });
    await expect(
      checkPageAddress(new URL('http://wiki.corp.internal/start'), resolve, none),
    ).rejects.toThrow('plain http on a host DAY0_PRIVATE_HOSTS does not list');
    await expect(
      checkPageAddress(
        new URL('http://wiki.corp.internal/start'),
        resolve,
        privateHostAllowlist('wiki.corp.internal'),
      ),
    ).resolves.toMatchObject({ addresses: ['10.1.2.3'] });
  });

  it('reads plain http from a listed name only while every address it answers is inside the network (W14-R34)', async (): Promise<void> => {
    const listed = privateHostAllowlist('mcp.linear.app wiki.corp.internal');
    await expect(
      checkPageAddress(
        new URL('http://mcp.linear.app/'),
        resolverOf({ 'mcp.linear.app': ['93.184.216.34'] }),
        listed,
      ),
    ).rejects.toThrow(
      'http://mcp.linear.app/ is plain http, and its host, though DAY0_PRIVATE_HOSTS lists it, answers with a public address: Day0 reads plain http only from a host inside your network.',
    );
    await expect(
      checkPageAddress(
        new URL('http://wiki.corp.internal/'),
        resolverOf({ 'wiki.corp.internal': ['10.0.0.8', '93.184.216.34'] }),
        listed,
      ),
    ).rejects.toThrow('answers with a public address');
    // Over https a listed name may answer publicly, as before.
    await expect(
      checkPageAddress(
        new URL('https://mcp.linear.app/'),
        resolverOf({ 'mcp.linear.app': ['93.184.216.34'] }),
        listed,
      ),
    ).resolves.toMatchObject({ addresses: ['93.184.216.34'] });
  });

  it('says a fake-IP proxy\u2019s answer for what it is, with the two ways past it (W14-R43)', async (): Promise<void> => {
    await expect(
      checkPageAddress(
        new URL('https://docs.partner.example/handbook'),
        resolverOf({ 'docs.partner.example': ['198.18.0.5'] }),
        privateHostAllowlist(''),
      ),
    ).rejects.toThrow(
      'https://docs.partner.example/handbook: its host answers with 198.18.0.5, an address of the range a fake-IP proxy hands out (198.18.0.0/15), so Day0 cannot tell what it reaches and does not read it. Set the proxy\u2019s DNS to answer real addresses, or list the host in DAY0_PRIVATE_HOSTS.',
    );
  });

  it('refuses an unlisted private name or address literal before resolving it', async (): Promise<void> => {
    const resolve = vi.fn(resolverOf({}));
    for (const page of ['https://intranet/start', 'https://10.0.0.5/start', 'https://[::1]/']) {
      await expect(checkPageAddress(new URL(page), resolve, none)).rejects.toThrow(
        'names a host inside a private network that DAY0_PRIVATE_HOSTS does not list',
      );
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a listed host that answers with loopback, and an unlisted one that answers privately', async (): Promise<void> => {
    await expect(
      checkPageAddress(
        new URL('https://wiki.corp.internal/'),
        resolverOf({ 'wiki.corp.internal': ['10.1.2.3', '127.0.0.1'] }),
        privateHostAllowlist('.corp.internal'),
      ),
    ).rejects.toThrow('answers with a loopback, link-local, multicast or unspecified address');
    await expect(
      checkPageAddress(
        new URL('https://docs.example.com/'),
        resolverOf({ 'docs.example.com': ['93.184.215.14', '169.254.169.254'] }),
        none,
      ),
    ).rejects.toThrow(
      'answers with a private, loopback, link-local or otherwise non-public address',
    );
  });

  it('says a host does not resolve, and tells a resolver that did not answer apart from it', async (): Promise<void> => {
    await expect(
      checkPageAddress(new URL('https://gone.example.com/'), resolverOf({}), none),
    ).rejects.toThrow(
      new PageAddressRefusal('https://gone.example.com/: its host does not resolve.'),
    );
    const silent = async (): Promise<string[]> => {
      throw Object.assign(new Error('queryA ETIMEOUT'), { code: 'ETIMEOUT' });
    };
    const failure = await checkPageAddress(new URL('https://docs.example.com/'), silent, none).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(PageAddressRefusal);
    expect((failure as Error).message).toBe(
      "https://docs.example.com/: Day0's resolver did not answer for its host.",
    );
  });

  it('reads a resolver that failed without an error object as a resolver that did not answer', async (): Promise<void> => {
    // A resolver can reject with anything, even null; the check must not trip over it.
    const failing = (): Promise<string[]> => Promise.reject(null);
    await expect(
      checkPageAddress(new URL('https://docs.example.com/'), failing, none),
    ).rejects.toThrow("https://docs.example.com/: Day0's resolver did not answer for its host.");
  });

  it('refuses a written-in login and any scheme but http and https', async (): Promise<void> => {
    const resolve = resolverOf({ 'docs.example.com': ['93.184.215.14'] });
    await expect(
      checkPageAddress(new URL('https://user:pw@docs.example.com/'), resolve, none),
    ).rejects.toThrow('carries a user name or password');
    await expect(
      checkPageAddress(new URL('ftp://docs.example.com/'), resolve, none),
    ).rejects.toThrow('is not an http or https address');
  });

  it('reads the list from DAY0_PRIVATE_HOSTS, and reads no page while it cannot be parsed', async (): Promise<void> => {
    const resolve = resolverOf({ 'wiki.corp.internal': ['10.1.2.3'] });
    vi.stubEnv('DAY0_PRIVATE_HOSTS', 'wiki.corp.internal');
    await expect(
      checkPageAddress(new URL('http://wiki.corp.internal/'), resolve),
    ).resolves.toMatchObject({ addresses: ['10.1.2.3'] });
    vi.stubEnv('DAY0_PRIVATE_HOSTS', 'localhost');
    await expect(checkPageAddress(new URL('http://wiki.corp.internal/'), resolve)).rejects.toThrow(
      'DAY0_PRIVATE_HOSTS cannot be read',
    );
  });
});

/** What one dial was asked, and where its lookup sent it. */
interface Dialled {
  readonly url: URL;
  readonly options: RequestOptions;
  resolvedTo: unknown;
}

/** A transport that records the dial, resolves through the lookup it was handed, and answers. */
function fakeTransport(
  answer: {
    status: number;
    headers?: Record<string, string>;
    chunks?: ReadonlyArray<string | Buffer>;
  },
  dialled: Dialled[],
): PageRequest {
  return (url, options, callback) => ({
    on: (): void => undefined,
    end: (): void => {
      const entry: Dialled = { url, options, resolvedTo: undefined };
      dialled.push(entry);
      const lookup = options.lookup as unknown as (
        host: string,
        opts: { all: boolean },
        cb: (error: Error | null, addresses: unknown) => void,
      ) => void;
      lookup(url.hostname, { all: true }, (_error, addresses): void => {
        entry.resolvedTo = addresses;
      });
      const response = Object.assign(new PassThrough(), {
        statusCode: answer.status,
        statusMessage: 'OK',
        headers: answer.headers ?? {},
      });
      callback(response as unknown as IncomingMessage);
      for (const chunk of answer.chunks ?? []) response.write(chunk);
      response.end();
    },
  });
}

/** A transport that fails as a refused connection does. */
const refusingTransport: PageRequest = () => {
  const listeners: Array<(error: Error) => void> = [];
  return {
    on: (_event: 'error', listener: (error: Error) => void): void => {
      listeners.push(listener);
    },
    end: (): void => {
      const error = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:80'), {
        code: 'ECONNREFUSED',
      });
      for (const listener of listeners) listener(error);
    },
  };
};

describe('pinnedPageFetch', (): void => {
  const checked: CheckedPageAddress = {
    url: new URL('http://wiki.corp.internal/start'),
    addresses: ['10.1.2.3'],
  };

  it('dials the plain http page through the http transport at the checked address', async (): Promise<void> => {
    const http: Dialled[] = [];
    const https: Dialled[] = [];
    const fetch = pinnedPageFetch(checked, 1024, {
      http: fakeTransport({ status: 200, chunks: ['# Start'] }, http),
      https: fakeTransport({ status: 200 }, https),
    });
    const response = await fetch(new URL('http://wiki.corp.internal/start'), {
      headers: { Accept: 'text/markdown' },
    });
    expect(await response.text()).toBe('# Start');
    expect(https).toEqual([]);
    expect(http[0].resolvedTo).toEqual([{ address: '10.1.2.3', family: 4 }]);
    expect(http[0].options.headers).toMatchObject({ accept: 'text/markdown' });
  });

  it('names itself and accepts a compressed page, which it reads decoded (second pass)', async (): Promise<void> => {
    const dialled: Dialled[] = [];
    const transport = fakeTransport(
      {
        status: 200,
        headers: { 'content-encoding': 'gzip', 'content-type': 'text/markdown' },
        chunks: [gzipSync('# Start\n\nThe whole page.')],
      },
      dialled,
    );
    const response = await pinnedPageFetch(checked, 1024, { http: transport, https: transport })(
      new URL('http://wiki.corp.internal/start'),
    );
    expect(await response.text()).toBe('# Start\n\nThe whole page.');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(dialled[0].options.headers).toMatchObject({
      'user-agent': 'Day0 documentation reader',
      'accept-encoding': 'gzip, deflate, br',
    });
  });

  it('bounds a compressed page by what it decodes to, not by what was sent', async (): Promise<void> => {
    const transport = fakeTransport(
      {
        status: 200,
        headers: { 'content-encoding': 'gzip' },
        chunks: [gzipSync('x'.repeat(4096))],
      },
      [],
    );
    const response = await pinnedPageFetch(checked, 1024, { http: transport, https: transport })(
      new URL('http://wiki.corp.internal/start'),
    );
    await expect(response.text()).rejects.toThrow(
      'http://wiki.corp.internal/start exceeds 1024 bytes.',
    );
  });

  it('returns a redirect for the caller to check instead of following it', async (): Promise<void> => {
    const dialled: Dialled[] = [];
    const transport = fakeTransport(
      { status: 302, headers: { location: 'http://169.254.169.254/latest' } },
      dialled,
    );
    const response = await pinnedPageFetch(checked, 1024, { http: transport, https: transport })(
      new URL('http://wiki.corp.internal/start'),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://169.254.169.254/latest');
    expect(dialled).toHaveLength(1);
  });

  it('refuses another host or scheme than the one it checked, before a socket opens', async (): Promise<void> => {
    const dialled: Dialled[] = [];
    const transport = fakeTransport({ status: 200 }, dialled);
    const fetch = pinnedPageFetch(checked, 1024, { http: transport, https: transport });
    await expect(fetch(new URL('http://other.corp.internal/start'))).rejects.toThrow(
      'which is not the address it checked',
    );
    await expect(fetch(new URL('https://wiki.corp.internal/start'))).rejects.toThrow(
      'which is not the address it checked',
    );
    expect(dialled).toEqual([]);
  });

  it('stops reading a page past its limit, and names the limit', async (): Promise<void> => {
    const transport = fakeTransport(
      { status: 200, chunks: ['x'.repeat(600), 'x'.repeat(600)] },
      [],
    );
    const response = await pinnedPageFetch(checked, 1024, { http: transport, https: transport })(
      new URL('http://wiki.corp.internal/start'),
    );
    await expect(response.text()).rejects.toThrow(
      'http://wiki.corp.internal/start exceeds 1024 bytes.',
    );
  });

  it('fails a refused connection as the global fetch would word it', async (): Promise<void> => {
    const failure = await pinnedPageFetch(checked, 1024, {
      http: refusingTransport,
      https: refusingTransport,
    })(new URL('http://wiki.corp.internal/start')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).toBe('fetch failed');
    expect(((failure as TypeError).cause as Error).message).toBe(
      'connect ECONNREFUSED 10.1.2.3:80',
    );
  });
});
