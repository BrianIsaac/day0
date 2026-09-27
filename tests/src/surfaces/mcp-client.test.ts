import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  configs: [] as unknown[],
  loggers: [] as unknown[],
  discoveryOptions: [] as unknown[],
  errors: {} as Record<string, string>,
}));

const quietLogger = vi.hoisted(() => ({ name: 'quiet' }));

vi.mock('@mastra/core/logger', () => ({ noopLogger: quietLogger }));
vi.mock('@mastra/mcp', () => ({
  MCPClient: class {
    constructor(config: unknown) {
      fake.configs.push(config);
    }

    __setLogger(logger: unknown): void {
      fake.loggers.push(logger);
    }

    async listToolsWithErrors(options: unknown): Promise<{
      tools: Record<string, never>;
      errors: Record<string, string>;
    }> {
      fake.discoveryOptions.push(options);
      return { tools: {}, errors: fake.errors };
    }

    async disconnect(): Promise<void> {}
  },
}));

import { createMastraMcpClient, MCP_TIMEOUT_MS } from '../../../src/surfaces/mcp';
import { createSecretMcpClient } from '../../../src/surfaces/mcp-client';

/** A public DNS answer for the bearer clients, so no test reaches a real resolver. */
const PUBLIC_ANSWER = async (): Promise<string[]> => ['93.184.216.34'];

/** The browser driver's client is never checked; a resolver it reached would fail the test. */
const NO_RESOLUTION = async (): Promise<string[]> => {
  throw new Error('a credentialless client resolved its host');
};

beforeEach((): void => {
  fake.configs.length = 0;
  fake.loggers.length = 0;
  fake.discoveryOptions.length = 0;
  fake.errors = {};
});

describe('Mastra MCP client safety configuration', (): void => {
  it('restricts the host, throws tool errors and disables provider logging', async (): Promise<void> => {
    const client = createMastraMcpClient(
      { serverName: 'linear', url: new URL('https://mcp.linear.app/mcp'), bearer: 'lin-secret' },
      { resolveHostname: PUBLIC_ANSWER },
    );
    await client.listTools();
    const config = fake.configs[0] as {
      timeout: number;
      servers: Record<string, Record<string, unknown>>;
    };
    expect(config.timeout).toBe(MCP_TIMEOUT_MS);
    expect(config.servers.linear).toMatchObject({
      allowedHosts: ['mcp.linear.app'],
      enableServerLogs: false,
      onToolError: 'throw',
      requestInit: { headers: { Authorization: 'Bearer lin-secret' } },
    });
    expect(fake.loggers).toEqual([quietLogger]);
    expect(fake.discoveryOptions).toEqual([{ perServerTimeoutMs: MCP_TIMEOUT_MS }]);
  });

  it('refuses a bearer client whose hostname now answers with a private address', async (): Promise<void> => {
    const client = createMastraMcpClient(
      { serverName: 'linear', url: new URL('https://mcp.linear.app/mcp'), bearer: 'lin-secret' },
      { resolveHostname: async (): Promise<string[]> => ['127.0.0.1'] },
    );
    await expect(client.listTools()).rejects.toThrow('resolved to a private, loopback');
    expect(fake.configs).toEqual([]);
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it('connects a bearer client to the address it checked, not to a later answer', async (): Promise<void> => {
    let answers = ['93.184.216.34'];
    const dialled: unknown[] = [];
    const client = createMastraMcpClient(
      { serverName: 'linear', url: new URL('https://mcp.linear.app/mcp'), bearer: 'lin-secret' },
      {
        resolveHostname: async (): Promise<string[]> => answers,
        request: (_url, options, callback) => ({
          on: (): void => undefined,
          end: (): void => {
            const lookup = options.lookup as unknown as (
              host: string,
              opts: { all: boolean },
              cb: (error: Error | null, addresses: unknown) => void,
            ) => void;
            lookup('mcp.linear.app', { all: true }, (_error, addresses): void => {
              dialled.push(addresses);
            });
            const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
            callback(response as unknown as IncomingMessage);
            response.end('{}');
          },
        }),
      },
    );
    await client.listTools();
    answers = ['127.0.0.1'];
    const config = fake.configs[0] as {
      servers: Record<string, { fetch: (url: string, init?: RequestInit) => Promise<Response> }>;
    };
    await config.servers.linear.fetch('https://mcp.linear.app/mcp', { method: 'POST', body: '{}' });
    expect(dialled).toEqual([[{ address: '93.184.216.34', family: 4 }]]);
  });

  it('omits authentication for a credentialless server and exposes discovery errors', async (): Promise<void> => {
    const client = createMastraMcpClient(
      { serverName: 'playwright', url: new URL('http://playwright:8931/mcp') },
      { resolveHostname: NO_RESOLUTION },
    );
    fake.errors = { playwright: 'connection refused' };
    await expect(client.listTools()).rejects.toThrow('connection refused');
    const config = fake.configs[0] as { servers: Record<string, Record<string, unknown>> };
    expect(config.servers.playwright).not.toHaveProperty('requestInit');
    expect(config.servers.playwright).not.toHaveProperty('fetch');
  });

  it('overrides unsafe logging options for every configured server', (): void => {
    const client = createSecretMcpClient({
      servers: {
        docs: { url: new URL('https://docs.example/mcp'), enableServerLogs: true },
        surface: { url: new URL('https://surface.example/mcp'), onToolError: 'return' },
      },
    });
    const config = fake.configs[0] as { servers: Record<string, Record<string, unknown>> };
    expect(config.servers.docs).toMatchObject({
      enableServerLogs: false,
      onToolError: 'throw',
    });
    expect(config.servers.surface).toMatchObject({
      enableServerLogs: false,
      onToolError: 'throw',
    });
    expect(client).toBeDefined();
    expect(fake.loggers).toEqual([quietLogger]);
  });
});
