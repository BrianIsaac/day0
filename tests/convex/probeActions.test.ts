/** @vitest-environment node */

import { describe, expect, it } from 'vitest';
import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import { probeMcpHandler } from '../../convex/probeActions';

const sourceId = 'source-1' as Id<'docSources'>;

/** A context whose source read and credential decrypt answer from the arguments. */
function contextWith(
  source: Record<string, unknown> | null,
  credential = 'plain-token',
): ActionCtx {
  return {
    runQuery: async (): Promise<Record<string, unknown> | null> => source,
    runAction: async (): Promise<string> => credential,
  } as unknown as ActionCtx;
}

describe('the MCP documentation probe', (): void => {
  it('discovers the provider tool names with the decrypted credential and times the discovery', async (): Promise<void> => {
    const seen: string[] = [];
    const result = await probeMcpHandler(
      contextWith({ _id: sourceId, kind: 'mcp', credentialId: 'cred-1', locator: 'https://x' }),
      { docSourceId: sourceId },
      async (_source, credential): Promise<string[]> => {
        seen.push(credential);
        return ['save_issue', 'list_issues'];
      },
    );
    expect(result.toolNames).toEqual(['save_issue', 'list_issues']);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(seen).toEqual(['plain-token']);
  });

  it('refuses a source that is missing, not MCP, or without a credential', async (): Promise<void> => {
    for (const source of [
      null,
      { _id: sourceId, kind: 'folder', credentialId: 'c' },
      { _id: sourceId, kind: 'mcp' },
    ]) {
      await expect(
        probeMcpHandler(contextWith(source), { docSourceId: sourceId }, async () => []),
      ).rejects.toThrow('Credential-backed MCP documentation source not found.');
    }
  });
});
