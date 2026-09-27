import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  approvedMcpEndpoint,
  checkMcpAddress,
  McpAddressRefusal,
  pinnedFetch,
  type CheckedMcpAddress,
  type HttpsRequest,
} from '../../../src/surfaces/mcp-address';

describe('the approved MCP endpoint', (): void => {
  it('accepts the exact approved public HTTPS endpoint', (): void => {
    expect(approvedMcpEndpoint('https://mcp.atlassian.example/mcp').href).toBe(
      'https://mcp.atlassian.example/mcp',
    );
    expect(approvedMcpEndpoint('https://mcp.example.com:8443/rpc').href).toBe(
      'https://mcp.example.com:8443/rpc',
    );
  });

  it('rejects SSRF targets before any bearer is used', (): void => {
    for (const endpoint of [
      'http://mcp.example.com/mcp',
      'https://localhost/mcp',
      'https://mcp.internal/mcp',
      'https://127.0.0.1/mcp',
      'https://10.0.0.8/mcp',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/mcp',
      'https://user:pass@mcp.example.com/mcp',
      'https://mcp.example.com/mcp#other',
    ]) {
      expect((): URL => approvedMcpEndpoint(endpoint), endpoint).toThrow(
        'approved MCP endpoint must use a public HTTPS hostname',
      );
    }
  });
});

describe('checking an MCP address', (): void => {
  it('returns every public answer the name gave', async (): Promise<void> => {
    const checked = await checkMcpAddress('https://mcp.example.com/mcp', async () => [
      '93.184.216.34',
      '2606:4700:4700::1111',
    ]);
    expect(checked.url.href).toBe('https://mcp.example.com/mcp');
    expect(checked.addresses).toEqual(['93.184.216.34', '2606:4700:4700::1111']);
  });

  it('refuses a name with any non-public answer, as a Day0 limitation', async (): Promise<void> => {
    const refusal = await refusalOf(
      checkMcpAddress('https://mcp.example.com/mcp', async () => [
        '93.184.216.34',
        '169.254.169.254',
      ]),
    );
    expect(refusal.limitation).toBe(true);
    expect(refusal.message).toContain('resolved to a private, loopback, link-local');
  });

  it('tells a name that does not exist from a resolver that would not answer', async (): Promise<void> => {
    const failing = (code: string) => async (): Promise<string[]> => {
      throw Object.assign(new Error(`getaddrinfo ${code}`), { code });
    };
    const missing = await refusalOf(
      checkMcpAddress('https://mcp.example.com/mcp', failing('ENOTFOUND')),
    );
    const silent = await refusalOf(
      checkMcpAddress('https://mcp.example.com/mcp', failing('EAI_AGAIN')),
    );
    expect([missing.limitation, missing.message]).toEqual([
      false,
      'The approved MCP endpoint hostname does not resolve.',
    ]);
    expect(silent.limitation).toBe(true);
  });
});

/** The refusal a pending check rejected with; anything else fails the test. */
async function refusalOf(pending: Promise<unknown>): Promise<McpAddressRefusal> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof McpAddressRefusal) return error;
    throw error;
  }
  throw new Error('expected the check to refuse');
}

interface Dialled {
  url: URL;
  options: RequestOptions;
  resolvedTo: unknown;
  body?: string | Uint8Array;
}

/**
 * The HTTPS transport the pinned fetch dials through: records what it was
 * asked, resolves the host through the lookup it was handed, and answers with
 * a scripted response.
 */
function fakeTransport(
  answer: { status: number; headers?: Record<string, string>; chunks?: readonly string[] },
  dialled: Dialled[],
): HttpsRequest {
  return (url, options, callback) => ({
    on: (): void => undefined,
    end: (body?: string | Uint8Array): void => {
      const entry: Dialled = { url, options, resolvedTo: undefined, body };
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

const CHECKED: CheckedMcpAddress = {
  url: new URL('https://mcp.example.com/mcp'),
  addresses: ['93.184.216.34'],
};

describe('the pinned MCP transport', (): void => {
  it('dials the checked address for the checked host, with the headers and body it was given', async (): Promise<void> => {
    const dialled: Dialled[] = [];
    const fetch = pinnedFetch(
      CHECKED,
      fakeTransport(
        { status: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"ok":true}'] },
        dialled,
      ),
    );
    const response = await fetch('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer lin-secret', 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(dialled).toHaveLength(1);
    expect(dialled[0].resolvedTo).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(dialled[0].options.method).toBe('POST');
    expect(dialled[0].options.headers).toMatchObject({ authorization: 'Bearer lin-secret' });
    expect(dialled[0].body).toBe('{"jsonrpc":"2.0"}');
  });

  it('refuses any other host or scheme before a socket opens', async (): Promise<void> => {
    const dialled: Dialled[] = [];
    const fetch = pinnedFetch(CHECKED, fakeTransport({ status: 200 }, dialled));
    await expect(fetch('https://attacker.example/mcp')).rejects.toThrow('not the checked endpoint');
    await expect(fetch('http://mcp.example.com/mcp')).rejects.toThrow('not the checked endpoint');
    expect(dialled).toEqual([]);
  });

  it('stops reading a response past the limit', async (): Promise<void> => {
    const fetch = pinnedFetch(
      CHECKED,
      fakeTransport({ status: 200, chunks: ['x'.repeat(40), 'x'.repeat(40)] }, []),
      64,
    );
    const response = await fetch('https://mcp.example.com/mcp');
    await expect(response.text()).rejects.toThrow('exceeded 64 bytes');
  });

  it('returns a bodiless status with no body', async (): Promise<void> => {
    const fetch = pinnedFetch(CHECKED, fakeTransport({ status: 202 }, []));
    expect(
      (await fetch('https://mcp.example.com/mcp', { method: 'POST', body: '{}' })).status,
    ).toBe(202);
    const accepted = pinnedFetch(CHECKED, fakeTransport({ status: 204 }, []));
    expect((await accepted('https://mcp.example.com/mcp')).body).toBeNull();
  });
});
