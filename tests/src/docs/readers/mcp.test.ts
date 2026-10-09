import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The configurations the production client built, when a test reaches it. */
const mastra = vi.hoisted(() => ({ configs: [] as unknown[] }));

// Only the address tests reach the production client; the rest inject a factory.
vi.mock('@mastra/mcp', () => ({
  MCPClient: class {
    constructor(config: unknown) {
      mastra.configs.push(config);
    }

    __setLogger(): void {}

    async listTools(): Promise<Record<string, unknown>> {
      return { docs_search: {} };
    }

    async disconnect(): Promise<void> {}
  },
}));
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  McpReader,
  DRIVE_INCOMPLETE_SEARCH_REASON,
  TRUNCATED_CONTINUATION_REASON,
  authorizationHeader,
  productionClient,
  sessionBoundFetch,
  unwrapWholePageFence,
  type McpConnectionConfig,
} from '../../../../src/docs/readers/mcp';
import type { DocSourceRecord } from '../../../../src/docs/types';
import { NOTION_DRIVER_ABSENT } from '../../../../src/docs/components';
import { PROVIDER_BACKOFF, TransientProviderError } from '../../../../src/lib/transport-error';
import { notionPageTemplate, type NotionPageName } from '../../../fixtures/notion-pages';

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

/** The Notion component answering, which is all a reachability check asks of it. */
const componentUp = async (): Promise<Response> => new Response('', { status: 406 });

/** The Notion component not started, which is a transport failure and nothing else. */
const componentDown = async (): Promise<Response> => {
  throw new Error('fetch failed');
};

describe('whole-page Markdown fence handling', (): void => {
  it('unwraps the Slack policy while preserving its nested JSON fence', (): void => {
    const policy = notionPageTemplate('slack-day0-app').trim();
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

  it('ignores empty provider blocks after the closing fence, as Notion renders a trailing paragraph', (): void => {
    const body =
      '```markdown\n# Northstar CRM\n\nNo approved surface is recorded.\n```\n<empty-block/>\n';
    expect(unwrapWholePageFence(body)).toBe(
      '# Northstar CRM\n\nNo approved surface is recorded.\n<empty-block/>\n',
    );
    expect(unwrapWholePageFence('```md\n# Page\n```\n<empty-block/>\n<empty-block/>')).toBe(
      '# Page\n<empty-block/>\n<empty-block/>',
    );
    expect(unwrapWholePageFence('```md\n# Page\n```\nTrailing prose')).toBe(
      '```md\n# Page\n```\nTrailing prose',
    );
  });

  it('unwraps each handbook template pasted as one block, with any accepted info string', (): void => {
    const names: NotionPageName[] = [
      'onboarding',
      'linear-automation',
      'slack-day0-app',
      'northstar-crm',
    ];
    for (const name of names) {
      const template = notionPageTemplate(name).trim();
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
    expect(unwrapWholePageFence('')).toBe('');
    expect(unwrapWholePageFence('<empty-block/>\n')).toBe('<empty-block/>\n');
    expect(unwrapWholePageFence('```md\n```')).toBe('');
    expect(unwrapWholePageFence('```md\n```\n<empty-block/>')).toBe('<empty-block/>');
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
    }, componentUp);
    const secret = ['ntn', 'contract-value'].join('_');
    const batch = await reader.listPageBatch(notionSource(), secret, undefined, 25);
    expect(connection?.headers).toEqual({
      'notion-token': secret,
      Authorization: 'Bearer transport-contract-value',
    });
    // Re-pinned at 14-D: the search names its order, oldest edit first (M16).
    expect(search).toHaveBeenCalledWith(
      {
        filter: { property: 'object', value: 'page' },
        sort: { timestamp: 'last_edited_time', direction: 'ascending' },
        page_size: 25,
      },
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

  it('names a Notion page it cannot read and reads the rest of the batch (P5-11)', async (): Promise<void> => {
    vi.stubEnv('DAY0_NOTION_MCP_AUTH_TOKEN', 'transport-contract-value');
    const listed = ['page-1', 'page-2', 'page-3'].map((id) => ({
      id,
      properties: { Name: { type: 'title', title: [{ plain_text: id }] } },
    }));
    const retrieve = vi.fn(async (input: Record<string, unknown>) =>
      input.page_id === 'page-2'
        ? textResult({ markdown: '# Half', truncated: true })
        : textResult({ markdown: `# ${String(input.page_id)}` }),
    );
    const reader = new McpReader(
      () => ({
        listTools: async () => ({
          'docs_API-post-search': {
            execute: async () => textResult({ results: listed, has_more: false }),
          },
          'docs_API-retrieve-page-markdown': { execute: retrieve },
        }),
        resources: { list: async () => ({}), read: async () => ({ contents: [] }) },
        disconnect: async () => undefined,
      }),
      componentUp,
    );
    const batch = await reader.listPageBatch(notionSource(), 'ntn_contract_value', undefined, 25);
    expect(batch.pages.map((page) => page.ref)).toEqual(['page-1', 'page-3']);
    expect(batch.unread).toEqual([
      { ref: 'page-2', reason: 'Notion page Markdown was truncated.' },
    ]);
  });

  it('retries the batch, not the page, when one page read meets a rate limit', async (): Promise<void> => {
    vi.stubEnv('DAY0_NOTION_MCP_AUTH_TOKEN', 'transport-contract-value');
    let limited = true;
    const retrieve = vi.fn(async (input: Record<string, unknown>) => {
      if (input.page_id === 'page-2' && limited) {
        limited = false;
        return textResult({ object: 'error', code: 'rate_limited' });
      }
      return textResult({ markdown: `# ${String(input.page_id)}` });
    });
    const sleeps: number[] = [];
    const reader = new McpReader(
      () => ({
        listTools: async () => ({
          'docs_API-post-search': {
            execute: async () =>
              textResult({ results: [{ id: 'page-1' }, { id: 'page-2' }], has_more: false }),
          },
          'docs_API-retrieve-page-markdown': { execute: retrieve },
        }),
        resources: { list: async () => ({}), read: async () => ({ contents: [] }) },
        disconnect: async () => undefined,
      }),
      componentUp,
      {
        attempts: 2,
        baseMs: 5_000,
        maxWaitMs: 30_000,
        sleep: async (ms: number): Promise<void> => {
          sleeps.push(ms);
        },
      },
    );
    const batch = await reader.listPageBatch(notionSource(), 'ntn_contract_value', undefined, 25);
    expect(batch.pages.map((page) => page.ref)).toEqual(['page-1', 'page-2']);
    expect(batch.unread).toEqual([]);
    expect(sleeps).toEqual([5_000]);
  });

  it('rejects provider errors and always disconnects', async (): Promise<void> => {
    vi.stubEnv('DAY0_NOTION_MCP_AUTH_TOKEN', 'transport-contract-value');
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const reader = new McpReader(
      () => ({
        listTools: async () => ({
          'docs_API-post-search': {
            execute: async () => textResult({ status: 'error', code: 'unauthorised' }),
          },
          'docs_API-retrieve-page-markdown': { execute: async () => textResult({}) },
        }),
        resources: { list: async () => ({}), read: async () => ({ contents: [] }) },
        disconnect,
      }),
      componentUp,
    );
    await expect(
      reader.listPageBatch(notionSource(), ['ntn', 'wrong'].join('_'), undefined, 25),
    ).rejects.toThrow('provider returned an error');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('says which component is not running, before opening a session', async (): Promise<void> => {
    vi.stubEnv('DAY0_NOTION_MCP_AUTH_TOKEN', 'transport-contract-value');
    const built = vi.fn();
    const reader = new McpReader(() => {
      built();
      throw new Error('should not connect');
    }, componentDown);
    await expect(
      reader.listPageBatch(notionSource(), ['ntn', 'value'].join('_'), undefined, 25),
    ).rejects.toThrow(NOTION_DRIVER_ABSENT);
    expect(built).not.toHaveBeenCalled();
  });

  it('keeps the absence code when the component stops after the preflight', async (): Promise<void> => {
    vi.stubEnv('DAY0_NOTION_MCP_AUTH_TOKEN', 'transport-contract-value');
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const reader = new McpReader(
      () => ({
        listTools: async (): Promise<Record<string, never>> => {
          throw new Error(
            'Failed to connect to MCP server docs: Error: Could not connect to server with any available HTTP transport',
          );
        },
        resources: { list: async () => ({}), read: async () => ({ contents: [] }) },
        disconnect,
      }),
      componentUp,
    );

    await expect(reader.listPageBatch(notionSource(), 'ntn_value', undefined, 25)).rejects.toThrow(
      NOTION_DRIVER_ABSENT,
    );
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('records a read cut off after the preflight as a transient with its cause, not as an absent component', async (): Promise<void> => {
    vi.stubEnv('DAY0_NOTION_MCP_AUTH_TOKEN', 'transport-contract-value');
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    let tries = 0;
    const reader = new McpReader(
      () => ({
        listTools: async (): Promise<Record<string, never>> => {
          tries += 1;
          throw new Error('request failed', { cause: reset });
        },
        resources: { list: async () => ({}), read: async () => ({ contents: [] }) },
        disconnect: vi.fn().mockResolvedValue(undefined),
      }),
      componentUp,
      { ...PROVIDER_BACKOFF, sleep: async (): Promise<void> => undefined },
    );
    const failure = await reader.listPageBatch(notionSource(), 'ntn_value', undefined, 25).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TransientProviderError);
    expect((failure as Error).message).not.toContain(NOTION_DRIVER_ABSENT);
    expect((failure as Error).message).toContain('transient');
    expect((failure as Error).message).toContain('read ECONNRESET');
    expect((failure as Error).cause).toBeDefined();
    expect(tries).toBe(PROVIDER_BACKOFF.attempts);
  });

  it('retries a Notion rate limit and reads the batch', async (): Promise<void> => {
    vi.stubEnv('DAY0_NOTION_MCP_AUTH_TOKEN', 'transport-contract-value');
    let searches = 0;
    const waits: number[] = [];
    const reader = new McpReader(
      () => ({
        listTools: async () => ({
          'docs_API-post-search': {
            execute: async () => {
              searches += 1;
              return searches === 1
                ? textResult({ object: 'error', status: 429, code: 'rate_limited' })
                : textResult({ object: 'list', results: [], has_more: false });
            },
          },
          'docs_API-retrieve-page-markdown': { execute: async () => textResult({ markdown: '' }) },
        }),
        resources: { list: async () => ({}), read: async () => ({ contents: [] }) },
        disconnect: vi.fn().mockResolvedValue(undefined),
      }),
      componentUp,
      { ...PROVIDER_BACKOFF, sleep: async (ms: number): Promise<void> => void waits.push(ms) },
    );
    await expect(
      reader.listPageBatch(notionSource(), 'ntn_value', undefined, 25),
    ).resolves.toMatchObject({ pages: [] });
    expect(searches).toBe(2);
    expect(waits).toEqual([PROVIDER_BACKOFF.baseMs]);
  });

  it('refuses a reply with no page list, or a page with no id, instead of completing as empty (P5-13)', async (): Promise<void> => {
    vi.stubEnv('DAY0_NOTION_MCP_AUTH_TOKEN', 'transport-contract-value');
    for (const reply of [
      { object: 'list', has_more: false, data: [{ id: 'page-1' }] },
      { object: 'list', has_more: false, results: [{ title: 'no id' }] },
      { object: 'list', has_more: false, results: ['page-1'] },
    ]) {
      const reader = new McpReader(
        () => ({
          listTools: async () => ({
            'docs_API-post-search': { execute: async () => textResult(reply) },
            'docs_API-retrieve-page-markdown': {
              execute: async () => textResult({ markdown: '# Page' }),
            },
          }),
          resources: { list: async () => ({}), read: async () => ({ contents: [] }) },
          disconnect: vi.fn().mockResolvedValue(undefined),
        }),
        componentUp,
      );
      await expect(
        reader.listPageBatch(notionSource(), 'ntn_value', undefined, 25),
        JSON.stringify(reply),
      ).rejects.toThrow('the sync stops here rather than delete the pages it could not list');
    }
  });

  it('authenticates the private hop under the new service name and the old alias', async (): Promise<void> => {
    vi.stubEnv('DAY0_NOTION_MCP_AUTH_TOKEN', 'transport-contract-value');
    for (const locator of ['http://docs-notion-mcp:3000/mcp', 'http://notion-mcp:3000/mcp']) {
      let connection: McpConnectionConfig | undefined;
      const reader = new McpReader((config) => {
        connection = config;
        throw new Error('stop after the configuration is built');
      }, componentUp);
      await expect(
        reader.listPageBatch({ ...notionSource(), locator }, 'ntn_value', undefined, 25),
      ).rejects.toThrow('stop after the configuration is built');
      expect(connection?.headers.Authorization).toBe('Bearer transport-contract-value');
    }
  });

  it("sends no day0 transport token to somebody else's copy of the same server", async (): Promise<void> => {
    let connection: McpConnectionConfig | undefined;
    const reader = new McpReader((config) => {
      connection = config;
      throw new Error('stop after the configuration is built');
    }, componentUp);
    await expect(
      reader.listPageBatch(
        { ...notionSource(), locator: 'https://notion.internal.example/mcp' },
        'ntn_value',
        undefined,
        25,
      ),
    ).rejects.toThrow('stop after the configuration is built');
    expect(connection?.headers.Authorization).toBeUndefined();
    expect(connection?.headers['notion-token']).toBe('ntn_value');
  });

  it('does not check a component for a server the enterprise runs itself', async (): Promise<void> => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const reader = new McpReader(
      () => ({
        listTools: async () => ({}),
        resources: { list: async () => ({ docs: [] }), read: async () => ({ contents: [] }) },
        disconnect,
      }),
      componentDown,
    );
    await expect(
      reader.listPageBatch(
        { ...notionSource(), serverKind: 'generic', locator: 'https://mcp.internal.example/mcp' },
        'contract-value',
        undefined,
        25,
      ),
    ).rejects.toThrow('escalate');
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

describe('MCP documentation continuations (P10-1)', (): void => {
  /** One source of the given server kind; none of these is a bundled component. */
  const sourceOf = (serverKind: 'confluence' | 'drive' | 'notion'): DocSourceRecord => ({
    _id: `source-${serverKind}` as Id<'docSources'>,
    label: 'Handbook',
    kind: 'mcp',
    locator: `https://${serverKind}.example.test/mcp`,
    serverKind,
  });
  /** A reader whose session answers every tool from the given table. */
  const readerWith = (
    tools: Record<string, (args: Record<string, unknown>) => unknown>,
  ): McpReader =>
    new McpReader(
      () => ({
        listTools: async () =>
          Object.fromEntries(
            Object.entries(tools).map(([name, answer]) => [
              `docs_${name}`,
              { execute: async (args: Record<string, unknown>) => answer(args) },
            ]),
          ),
        resources: { list: async () => ({}), read: async () => ({ contents: [] }) },
        disconnect: async (): Promise<void> => undefined,
      }),
      componentUp,
    );
  const confluence = (
    search: Record<string, unknown>,
    calls: Array<Record<string, unknown>> = [],
  ): McpReader =>
    readerWith({
      getAccessibleAtlassianResources: () => textResult({ resources: [{ id: 'cloud-1' }] }),
      searchConfluenceUsingCql: (args) => {
        calls.push(args);
        return textResult({
          results: [{ content: { id: 'page-1', title: 'Runbook' } }],
          ...search,
        });
      },
      getConfluencePage: () => textResult({ markdown: '# Runbook' }),
    });
  const drive = (search: Record<string, unknown>): McpReader =>
    readerWith({
      search_files: () => textResult({ files: [{ id: 'file-1', title: 'Runbook' }], ...search }),
      read_file_content: () => textResult({ fileContent: '# Runbook' }),
    });
  const notion = (search: Record<string, unknown>): McpReader =>
    readerWith({
      'API-post-search': () => textResult({ results: [{ id: 'page-1' }], ...search }),
      'API-retrieve-page-markdown': () => textResult({ markdown: '# Runbook' }),
    });
  const secret = 'contract-value';

  it('walks Confluence in creation order, which a page edited mid-walk cannot change', async (): Promise<void> => {
    const calls: Array<Record<string, unknown>> = [];
    const batch = await confluence(
      { _links: { next: '/wiki/rest/api/search?cursor=abc&limit=10' } },
      calls,
    ).listPageBatch(sourceOf('confluence'), secret, undefined, 10);
    expect(calls[0]?.cql).toBe('type=page ORDER BY created ASC');
    expect(batch.nextCursor).toBe('abc');
  });

  it('ends a Confluence walk only when no next page is named', async (): Promise<void> => {
    await expect(
      confluence({}).listPageBatch(sourceOf('confluence'), secret, undefined, 10),
    ).resolves.toMatchObject({
      nextCursor: undefined,
    });
    for (const search of [
      { _links: { next: null }, nextCursor: null },
      { _links: { next: '' }, nextCursor: '' },
    ]) {
      await expect(
        confluence(search).listPageBatch(sourceOf('confluence'), secret, undefined, 10),
      ).resolves.toMatchObject({ nextCursor: undefined });
    }
  });

  it('fails a Confluence walk whose next page carries no cursor, instead of completing it', async (): Promise<void> => {
    for (const search of [
      { _links: { next: '/wiki/rest/api/search?limit=10' } },
      { _links: { next: 42 } },
      { nextCursor: 7 },
    ]) {
      await expect(
        confluence(search).listPageBatch(sourceOf('confluence'), secret, undefined, 10),
      ).rejects.toThrow(TRUNCATED_CONTINUATION_REASON);
    }
  });

  it('fails a Drive walk with an unusable token or an unfinished search, and ends one with neither', async (): Promise<void> => {
    await expect(
      drive({ nextPageToken: 'token-2' }).listPageBatch(sourceOf('drive'), secret, undefined, 25),
    ).resolves.toMatchObject({
      nextCursor: 'token-2',
    });
    for (const search of [{}, { nextPageToken: '' }, { nextPageToken: null }]) {
      await expect(
        drive(search).listPageBatch(sourceOf('drive'), secret, undefined, 25),
      ).resolves.toMatchObject({ nextCursor: undefined });
    }
    await expect(
      drive({ nextPageToken: 12 }).listPageBatch(sourceOf('drive'), secret, undefined, 25),
    ).rejects.toThrow(TRUNCATED_CONTINUATION_REASON);
    await expect(
      drive({ incompleteSearch: true }).listPageBatch(sourceOf('drive'), secret, undefined, 25),
    ).rejects.toThrow(DRIVE_INCOMPLETE_SEARCH_REASON);
  });

  it('fails a Notion walk that has more pages and no cursor, and ends one that has none', async (): Promise<void> => {
    await expect(
      notion({ has_more: true, next_cursor: '' }).listPageBatch(
        sourceOf('notion'),
        secret,
        undefined,
        25,
      ),
    ).rejects.toThrow(TRUNCATED_CONTINUATION_REASON);
    await expect(
      notion({ has_more: false, next_cursor: null }).listPageBatch(
        sourceOf('notion'),
        secret,
        undefined,
        25,
      ),
    ).resolves.toMatchObject({ nextCursor: undefined });
  });
});

describe('the Notion walk under an edit (M16)', (): void => {
  /**
   * A Notion workspace as its search answers: pages ordered by `last_edited_time` in the
   * direction the request's `sort` names, most recently edited first when it names none (Notion's
   * documented default), and a cursor that is a position in the order as it stands when the next
   * page is asked for.
   */
  function notionWorkspace(edited: Record<string, number>): {
    readonly reader: McpReader;
    readonly edit: (pageId: string, at: number) => void;
  } {
    const answer = (args: Record<string, unknown>): Record<string, unknown> => {
      const sort = args.sort as { timestamp?: string; direction?: string } | undefined;
      const ascending = sort?.timestamp === 'last_edited_time' && sort.direction === 'ascending';
      const order = Object.keys(edited).sort((left, right) =>
        ascending ? edited[left] - edited[right] : edited[right] - edited[left],
      );
      const start = typeof args.start_cursor === 'string' ? Number(args.start_cursor) : 0;
      const size = Number(args.page_size);
      const listed = order.slice(start, start + size);
      const more = start + size < order.length;
      return textResult({
        results: listed.map((id) => ({
          id,
          last_edited_time: new Date(edited[id]).toISOString(),
        })),
        has_more: more,
        next_cursor: more ? String(start + size) : null,
      });
    };
    const reader = new McpReader(
      () => ({
        listTools: async () => ({
          'docs_API-post-search': {
            execute: async (args: Record<string, unknown>) => answer(args),
          },
          'docs_API-retrieve-page-markdown': {
            execute: async () => textResult({ markdown: '# Page' }),
          },
        }),
        resources: { list: async () => ({}), read: async () => ({ contents: [] }) },
        disconnect: async (): Promise<void> => undefined,
      }),
      componentUp,
    );
    return {
      reader,
      edit: (pageId: string, at: number): void => {
        edited[pageId] = at;
      },
    };
  }

  it('lists a page edited mid-walk, so the finish does not prune it', async (): Promise<void> => {
    const source: DocSourceRecord = {
      _id: 'source-notion-walk' as Id<'docSources'>,
      label: 'Handbook',
      kind: 'mcp',
      locator: 'https://notion.example.test/mcp',
      serverKind: 'notion',
    };
    const workspace = notionWorkspace({
      'page-a': Date.UTC(2026, 9, 1),
      'page-b': Date.UTC(2026, 9, 2),
      'page-c': Date.UTC(2026, 9, 3),
      'page-d': Date.UTC(2026, 9, 4),
      'page-e': Date.UTC(2026, 9, 5),
    });
    const listed: string[] = [];
    let cursor: string | undefined;
    let batches = 0;
    do {
      const batch = await workspace.reader.listPageBatch(source, 'ntn_walk', cursor, 2);
      listed.push(...batch.pages.map((page) => page.ref));
      cursor = batch.nextCursor;
      batches += 1;
      // An author edits a page the walk has not reached yet, after its first batch.
      if (batches === 1) {
        const unread = ['page-a', 'page-b', 'page-c', 'page-d', 'page-e'].find(
          (id) => !listed.includes(id),
        );
        if (unread === undefined) throw new Error('the first batch listed every page');
        workspace.edit(unread, Date.UTC(2026, 9, 6));
      }
    } while (cursor !== undefined && batches < 10);
    expect([...new Set(listed)].sort()).toEqual(['page-a', 'page-b', 'page-c', 'page-d', 'page-e']);
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

describe('the documentation MCP client reaches only the address it checked (M16)', (): void => {
  const config = (locator: string): McpConnectionConfig => ({
    id: 'session',
    url: new URL(locator),
    headers: { Authorization: 'Bearer docs-secret' },
  });

  it('refuses a server that answers with a private address and builds no client', async (): Promise<void> => {
    mastra.configs.length = 0;
    const client = productionClient(config('https://docs.example.com/mcp'), {
      resolveHostname: async (): Promise<string[]> => ['192.168.1.20'],
    });
    await expect(client.listTools()).rejects.toThrow('resolved to a private, loopback');
    expect(mastra.configs).toEqual([]);
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it("refuses a plain HTTP locator for any server but Day0's own component", async (): Promise<void> => {
    mastra.configs.length = 0;
    const client = productionClient(config('http://docs.example.com/mcp'), {
      resolveHostname: async (): Promise<string[]> => ['93.184.216.34'],
    });
    await expect(client.listTools()).rejects.toThrow('public HTTPS hostname');
    expect(mastra.configs).toEqual([]);
  });

  it('connects to the address it checked with the session headers, not to a later answer', async (): Promise<void> => {
    mastra.configs.length = 0;
    let answers = ['93.184.216.34'];
    const dialled: unknown[] = [];
    const sent: unknown[] = [];
    const client = productionClient(config('https://docs.example.com/mcp'), {
      resolveHostname: async (): Promise<string[]> => answers,
      request: (_url, options, callback) => ({
        on: (): void => undefined,
        end: (): void => {
          sent.push(options.headers);
          const lookup = options.lookup as unknown as (
            host: string,
            opts: { all: boolean },
            cb: (error: Error | null, addresses: unknown) => void,
          ) => void;
          lookup('docs.example.com', { all: true }, (_error, addresses): void => {
            dialled.push(addresses);
          });
          const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
          callback(response as unknown as IncomingMessage);
          response.end('{}');
        },
      }),
    });
    await client.listTools();
    answers = ['127.0.0.1'];
    const built = mastra.configs[0] as {
      servers: Record<
        string,
        { allowedHosts: string[]; fetch: (url: URL, init?: RequestInit) => Promise<Response> }
      >;
    };
    expect(built.servers.docs.allowedHosts).toEqual(['docs.example.com']);
    await built.servers.docs.fetch(new URL('https://docs.example.com/mcp'), { method: 'POST' });
    expect(dialled).toEqual([[{ address: '93.184.216.34', family: 4 }]]);
    expect(JSON.stringify(sent)).toContain('Bearer docs-secret');
  });

  it('waits out a 429 from the documentation server and sends the request again', async (): Promise<void> => {
    mastra.configs.length = 0;
    const statuses = [429, 200];
    const waits: number[] = [];
    const client = productionClient(
      config('https://docs.example.com/mcp'),
      {
        resolveHostname: async (): Promise<string[]> => ['93.184.216.34'],
        request: (_url, _options, callback) => ({
          on: (): void => undefined,
          end: (): void => {
            const statusCode = statuses.shift() ?? 200;
            const response = Object.assign(new PassThrough(), {
              statusCode,
              headers: statusCode === 429 ? { 'retry-after': '5' } : {},
            });
            callback(response as unknown as IncomingMessage);
            response.end('{}');
          },
        }),
      },
      { ...PROVIDER_BACKOFF, sleep: async (ms: number): Promise<void> => void waits.push(ms) },
    );
    await client.listTools();
    const built = mastra.configs[0] as {
      servers: Record<string, { fetch: (url: URL, init?: RequestInit) => Promise<Response> }>;
    };
    const response = await built.servers.docs.fetch(new URL('https://docs.example.com/mcp'), {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(waits).toEqual([5_000]);
  });

  it("checks a non-Notion source that names the component's host like any other", async (): Promise<void> => {
    mastra.configs.length = 0;
    const client = productionClient(config('http://docs-notion-mcp:3000/mcp'), {
      resolveHostname: async (): Promise<string[]> => ['93.184.216.34'],
    });
    await expect(client.listTools()).rejects.toThrow('public HTTPS hostname');
    expect(mastra.configs).toEqual([]);
  });

  it("leaves Day0's own Notion component on the compose network unchecked", async (): Promise<void> => {
    mastra.configs.length = 0;
    const client = productionClient(
      { ...config('http://docs-notion-mcp:3000/mcp'), bundled: true },
      {
        resolveHostname: async (): Promise<string[]> => {
          throw new Error('the bundled component was resolved');
        },
      },
    );
    await expect(client.listTools()).resolves.toEqual({ docs_search: {} });
    expect(mastra.configs).toHaveLength(1);
  });
});
