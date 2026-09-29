import { noopLogger } from '@mastra/core/logger';
import { MCPClient, type MCPClientOptions } from '@mastra/mcp';

/**
 * Build an MCP client that cannot forward credential-bearing provider output
 * to runtime logs.
 *
 * Every server throws on a tool error: `isServerToolError` (`mcp.ts`) reads
 * that throw as the server's own refusal, a definite failure, so only a
 * response that was lost leaves a write's outcome unknown (P5-4, E-30).
 */
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
