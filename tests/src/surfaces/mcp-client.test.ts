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

beforeEach((): void => {
  fake.configs.length = 0;
  fake.loggers.length = 0;
  fake.discoveryOptions.length = 0;
  fake.errors = {};
});

describe('Mastra MCP client safety configuration', (): void => {
  it('restricts the host, throws tool errors and disables provider logging', async (): Promise<void> => {
    const client = createMastraMcpClient({
      serverName: 'linear',
      url: new URL('https://mcp.linear.app/mcp'),
      bearer: 'lin-secret',
    });
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
    await client.listTools();
    expect(fake.discoveryOptions).toEqual([{ perServerTimeoutMs: MCP_TIMEOUT_MS }]);
  });

  it('omits authentication for a credentialless server and exposes discovery errors', async (): Promise<void> => {
    const client = createMastraMcpClient({
      serverName: 'playwright',
      url: new URL('http://playwright:8931/mcp'),
    });
    const config = fake.configs[0] as { servers: Record<string, Record<string, unknown>> };
    expect(config.servers.playwright).not.toHaveProperty('requestInit');
    fake.errors = { playwright: 'connection refused' };
    await expect(client.listTools()).rejects.toThrow('connection refused');
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
