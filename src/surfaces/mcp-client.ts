import { noopLogger } from '@mastra/core/logger';
import { MCPClient, type MCPClientOptions } from '@mastra/mcp';

/** Build an MCP client that cannot forward credential-bearing provider output to runtime logs. */
export function createSecretMcpClient(options: MCPClientOptions): MCPClient {
  const servers = Object.fromEntries(
    Object.entries(options.servers).map(([name, server]) => [
      name,
      { ...server, enableServerLogs: false, onToolError: 'throw' as const },
    ]),
  );
  const client = new MCPClient({ ...options, servers });
  client.__setLogger(noopLogger);
  return client;
}
