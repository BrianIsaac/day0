import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  McpReader,
  authorizationHeader,
  sessionBoundFetch,
  unwrapWholePageFence,
  type McpConnectionConfig,
} from '../../../../src/docs/readers/mcp';
import type { DocSourceRecord } from '../../../../src/docs/types';

/** Wrap one object in the MCP text-content result shape. */
function textResult(value: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** Build one Notion source without embedding credential material. */
function notionSource(): DocSourceRecord {
  return {
    _id: 'source-notion' as Id<'docSources'>,
    label: 'Handbook',
    kind: 'mcp',
    locator: 'http://notion-mcp:3000/mcp',
    serverKind: 'notion',
  };
}

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('whole-page Markdown fence handling', (): void => {
  it('unwraps the Slack policy while preserving its nested JSON fence', (): void => {
    const policy = readFileSync('docs/submission/notion-pages/slack-day0-app.md', 'utf8').trim();
    const providerBody = `\`\`\`\`markdown\n${policy}\n\`\`\`\``;
    const unwrapped = unwrapWholePageFence(providerBody);
    expect(unwrapped).toContain('# Slack automation policy');
    expect(unwrapped).toContain('```json');
    expect(unwrapped).toContain('"display_information"');
  });

  it('does not unwrap a manifest-only JSON page', (): void => {
    const manifest = '```json\n{"name":"Day0"}\n```';
    expect(unwrapWholePageFence(manifest)).toBe(manifest);
  });

  it('unwraps each handbook template pasted as one block, with any accepted info string', (): void => {
    for (const name of [
      'onboarding.md',
      'linear-automation.md',
      'slack-day0-app.md',
      'northstar-crm.md',
    ]) {
      const template = readFileSync(`docs/submission/notion-pages/${name}`, 'utf8').trim();
      for (const opener of ['```', '```md', '```markdown', '```MARKDOWN', '~~~', '````markdown']) {
        const closer = opener.replace(/[^`~]/g, '');
        expect(unwrapWholePageFence(`\n${opener}\n${template}\n${closer}\n\n`)).toBe(
          `\n${template}\n\n`,
        );
      }
      expect(unwrapWholePageFence(`\`\`\`json\n${template}\n\`\`\``)).toBe(
        `\`\`\`json\n${template}\n\`\`\``,
      );
    }
  });

  it('keeps a same-length nested fence and refuses a page made of two blocks', (): void => {
    const nested = '```markdown\n# Policy\n\n```json\n{"name":"Day0"}\n```\n\nAfter\n```';
    expect(unwrapWholePageFence(nested)).toBe('# Policy\n\n```json\n{"name":"Day0"}\n```\n\nAfter');
    const twoBlocks = '```md\nA\n```\n\n```md\nB\n```';
    expect(unwrapWholePageFence(twoBlocks)).toBe(twoBlocks);
    const mixed = '```md\nA\n~~~\nB\n~~~\n```';
    expect(unwrapWholePageFence(mixed)).toBe('A\n~~~\nB\n~~~');
    const unclosedInner = '```md\nA\n```json\n{}\n```';
    expect(unwrapWholePageFence(unclosedInner)).toBe(unclosedInner);
    expect(unwrapWholePageFence('```md\r\nA\r\nB\r\n```\r\n')).toBe('A\nB\n');
    expect(unwrapWholePageFence('# Plain\n\nNo fence')).toBe('# Plain\n\nNo fence');
    expect(unwrapWholePageFence('```md\n```')).toBe('');
  });
});

describe('MCP documentation reader', (): void => {
  it('preserves explicit Basic authentication and defaults raw tokens to Bearer', (): void => {
    expect(authorizationHeader('Basic contract-value')).toBe('Basic contract-value');
    expect(authorizationHeader('contract-value')).toBe('Bearer contract-value');
  });

  it('binds the Notion secret to one session and calls the exact Markdown tools', async (): Promise<void> => {
    vi.stubEnv('DAY0_NOTION_MCP_AUTH_TOKEN', 'transport-contract-value');
    const search = vi.fn().mockResolvedValue(
      textResult({
        results: [
          {
            id: 'page-1',
            url: 'https://notion.so/page-1',
            last_edited_time: '2026-08-26T00:00:00.000Z',
            properties: {
              Name: { type: 'title', title: [{ plain_text: 'Linear automation' }] },
            },
          },
        ],
        has_more: true,
        next_cursor: 'cursor-2',
      }),
    );
    const retrieve = vi
      .fn()
      .mockResolvedValue(textResult({ markdown: '```markdown\n# Linear automation\n```' }));
    const disconnect = vi.fn().mockResolvedValue(undefined);
    let connection: McpConnectionConfig | undefined;
    const reader = new McpReader((config) => {
      connection = config;
      return {
        listTools: async () => ({
          'docs_API-post-search': { execute: search },
          'docs_API-retrieve-page-markdown': { execute: retrieve },
        }),
        resources: {
          list: async () => ({}),
          read: async () => ({ contents: [] }),
        },
        disconnect,
      };
    });
    const secret = ['ntn', 'contract-value'].join('_');
    const batch = await reader.listPageBatch(notionSource(), secret, undefined, 25);
    expect(connection?.headers).toEqual({
      'notion-token': secret,
      Authorization: 'Bearer transport-contract-value',
    });
    expect(search).toHaveBeenCalledWith(
      { filter: { property: 'object', value: 'page' }, page_size: 25 },
      {},
    );
    expect(retrieve).toHaveBeenCalledWith({ page_id: 'page-1', include_transcript: false }, {});
    expect(batch.pages[0]).toMatchObject({
      ref: 'page-1',
      title: 'Linear automation',
      markdown: '# Linear automation',
    });
    expect(batch.nextCursor).toBe('cursor-2');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('rejects provider errors and always disconnects', async (): Promise<void> => {
    vi.stubEnv('DAY0_NOTION_MCP_AUTH_TOKEN', 'transport-contract-value');
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const reader = new McpReader(() => ({
      listTools: async () => ({
        'docs_API-post-search': {
          execute: async () => textResult({ status: 'error', code: 'unauthorised' }),
        },
        'docs_API-retrieve-page-markdown': { execute: async () => textResult({}) },
      }),
      resources: { list: async () => ({}), read: async () => ({ contents: [] }) },
      disconnect,
    }));
    await expect(
      reader.listPageBatch(notionSource(), ['ntn', 'wrong'].join('_'), undefined, 25),
    ).rejects.toThrow('provider returned an error');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('escalates a generic server with no resources', async (): Promise<void> => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const reader = new McpReader(() => ({
      listTools: async () => ({}),
      resources: { list: async () => ({ docs: [] }), read: async () => ({ contents: [] }) },
      disconnect,
    }));
    await expect(
      reader.listPageBatch(
        { ...notionSource(), serverKind: 'generic' },
        'contract-value',
        undefined,
        25,
      ),
    ).rejects.toThrow('escalate');
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe('MCP session termination', (): void => {
  it('adds the session headers to every request and deletes the server session once', async (): Promise<void> => {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];
    const transport: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
      });
      return new Response('{}', { headers: { 'mcp-session-id': 'session-1' } });
    };
    const config: McpConnectionConfig = {
      id: 'contract',
      url: new URL('http://notion-mcp:3000/mcp'),
      headers: { 'notion-token': ['ntn', 'contract-value'].join('_'), Authorization: 'Bearer t' },
    };
    const session = sessionBoundFetch(config, transport);
    await session.fetch(config.url, { method: 'POST', headers: { 'content-type': 'x' } });
    expect(calls[0].headers.get('notion-token')).toBe(['ntn', 'contract-value'].join('_'));
    expect(calls[0].headers.get('Authorization')).toBe('Bearer t');
    expect(calls[0].headers.get('content-type')).toBe('x');
    await session.terminate();
    await session.terminate();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ url: 'http://notion-mcp:3000/mcp', method: 'DELETE' });
    expect(calls[1].headers.get('mcp-session-id')).toBe('session-1');
    expect(calls[1].headers.get('Authorization')).toBe('Bearer t');
    expect(calls[1].headers.get('notion-token')).toBeNull();
  });

  it('is a no-op without a session and swallows a failed delete', async (): Promise<void> => {
    let deletes = 0;
    const transport: typeof fetch = async (_input, init) => {
      if (init?.method === 'DELETE') {
        deletes += 1;
        throw new Error('connection reset');
      }
      return new Response('{}', { headers: { 'mcp-session-id': 'session-2' } });
    };
    const config: McpConnectionConfig = {
      id: 'contract',
      url: new URL('http://notion-mcp:3000/mcp'),
      headers: {},
    };
    const idle = sessionBoundFetch(config, transport);
    await idle.terminate();
    expect(deletes).toBe(0);
    const active = sessionBoundFetch(config, transport);
    await active.fetch(config.url, { method: 'POST' });
    await expect(active.terminate()).resolves.toBeUndefined();
    expect(deletes).toBe(1);
  });
});
