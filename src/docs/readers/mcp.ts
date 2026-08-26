import { randomUUID } from 'node:crypto';
import { MCPClient } from '@mastra/mcp';
import type { DocPage, DocPageBatch, DocSourceReader, DocSourceRecord } from '../types';
import { markdownPageTitle, offsetFromCursor } from './folder';

const SERVER_NAME = 'docs';

interface McpTool {
  execute?: (input: Record<string, unknown>, context: Record<string, never>) => Promise<unknown>;
}

interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  mimeType?: string;
}

interface McpClientLike {
  listTools(): Promise<Record<string, McpTool>>;
  resources: {
    list(): Promise<Record<string, McpResource[]>>;
    read(
      serverName: string,
      uri: string,
    ): Promise<{
      contents: Array<{ text?: string; blob?: string; uri: string; mimeType?: string }>;
    }>;
  };
  disconnect(): Promise<void>;
}

export interface McpConnectionConfig {
  id: string;
  url: URL;
  headers: Record<string, string>;
}

type McpClientFactory = (config: McpConnectionConfig) => McpClientLike;

export interface SessionBoundFetch {
  fetch: typeof fetch;
  terminate(): Promise<void>;
}

/**
 * Bind one session's headers to fetch and remember its server session id.
 *
 * Mastra's `disconnect()` only aborts the client side. A Streamable HTTP
 * server keeps the session, and for the Notion server the per-token proxy
 * behind it, until it receives `DELETE` with the session id, so every sync
 * batch would otherwise leave one session behind for the life of the
 * container.
 *
 * Args:
 *   config: Credential-bound connection configuration.
 *   transport: Underlying fetch, injectable for tests.
 *
 * Returns:
 *   A fetch that adds the session headers, and a terminator that closes the
 *   server session once and never throws.
 */
export function sessionBoundFetch(
  config: McpConnectionConfig,
  transport: typeof fetch = fetch,
): SessionBoundFetch {
  let sessionId: string | undefined;
  const boundFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(config.headers)) headers.set(name, value);
    const response = await transport(input, { ...init, headers });
    const id = response.headers.get('mcp-session-id');
    if (id) sessionId = id;
    return response;
  };
  return {
    fetch: boundFetch,
    async terminate(): Promise<void> {
      if (!sessionId) return;
      const id = sessionId;
      sessionId = undefined;
      const headers: Record<string, string> = { 'mcp-session-id': id };
      if (config.headers.Authorization) headers.Authorization = config.headers.Authorization;
      try {
        await transport(config.url, { method: 'DELETE', headers });
      } catch {
        // The server drops the session on its next restart; nothing to retry.
      }
    },
  };
}

/** Create the production Mastra client for one credential-bound session. */
function productionClient(config: McpConnectionConfig): McpClientLike {
  const session = sessionBoundFetch(config);
  const client = new MCPClient({
    id: config.id,
    servers: {
      [SERVER_NAME]: {
        url: config.url,
        allowedHosts: [config.url.host],
        fetch: session.fetch,
      },
    },
    timeout: 60_000,
  }) as unknown as McpClientLike;
  return {
    listTools: (): Promise<Record<string, McpTool>> => client.listTools(),
    resources: client.resources,
    async disconnect(): Promise<void> {
      try {
        await client.disconnect();
      } finally {
        await session.terminate();
      }
    },
  };
}

/** Build one credential-bound MCP session configuration. */
function connectionConfig(source: DocSourceRecord, secret: string): McpConnectionConfig {
  if (!source.serverKind) throw new Error('MCP server kind is unavailable.');
  const url = new URL(source.locator);
  let headers: Record<string, string>;
  if (source.serverKind === 'notion') {
    headers = { 'notion-token': secret };
    if (url.hostname === 'notion-mcp') {
      const transportToken = process.env.DAY0_NOTION_MCP_AUTH_TOKEN;
      if (!transportToken) {
        throw new Error('Notion MCP transport authentication is unavailable.');
      }
      headers.Authorization = `Bearer ${transportToken}`;
    }
  } else {
    headers = { Authorization: authorizationHeader(secret) };
  }
  return { id: randomUUID(), url, headers };
}

/**
 * Discover provider tool names using a source's decrypted stored credential.
 *
 * Args:
 *   source: Linked MCP documentation source.
 *   secret: Decrypted source credential.
 *
 * Returns:
 *   Sorted provider tool names without Mastra's server namespace.
 */
export async function discoverMcpTools(source: DocSourceRecord, secret: string): Promise<string[]> {
  const client = productionClient(connectionConfig(source, secret));
  try {
    const names = Object.keys(await client.listTools())
      .map((name: string): string =>
        name.startsWith(`${SERVER_NAME}_`) ? name.slice(SERVER_NAME.length + 1) : name,
      )
      .sort((left: string, right: string): number => left.localeCompare(right));
    if (names.length === 0) throw new Error('Documentation MCP server returned no tools.');
    return names;
  } finally {
    await client.disconnect();
  }
}

const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * Decide whether the lines between an outer fence pair are one block's body.
 *
 * Inner fences may open and close (the Slack policy carries a JSON manifest),
 * but a closing line that matches no open inner fence would close the outer
 * block instead, which means the page is several blocks, not one.
 *
 * Args:
 *   lines: Lines strictly between the outer opener and closer.
 *   marker: Outer fence character.
 *   minimum: Outer fence length.
 *
 * Returns:
 *   True when every inner fence is balanced and none closes the outer one.
 */
function innerFencesBalanced(lines: string[], marker: string, minimum: number): boolean {
  const open: number[] = [];
  for (const line of lines) {
    const fence = FENCE_LINE.exec(line);
    if (!fence || fence[1][0] !== marker) continue;
    const length = fence[1].length;
    const closes = fence[2].trim() === '' && open.length > 0 && length >= open[open.length - 1];
    if (closes) {
      open.pop();
    } else if (fence[2].trim() === '' && length >= minimum) {
      return false;
    } else {
      open.push(length);
    }
  }
  return open.length === 0;
}

/** Provider markup for an empty block after the page's content, such as Notion's trailing paragraph. */
const TRAILING_PROVIDER_TAG = /^\s*<[a-z][a-z0-9-]*\/>\s*$/i;

/**
 * Remove one outer Markdown fence without parsing its nested content.
 *
 * A page pasted as one code block renders as the fence, optionally followed
 * by empty provider blocks (`<empty-block/>` for Notion's trailing empty
 * paragraph); those are ignored when locating the closing fence and kept
 * after the unwrapped content.
 *
 * Args:
 *   markdown: Provider-rendered page body.
 *
 * Returns:
 *   Inner Markdown only when the first and last non-empty lines form one
 *   empty, `md`, or `markdown` fence around balanced content; otherwise the
 *   original body.
 */
export function unwrapWholePageFence(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const first = lines.findIndex((line: string): boolean => line.trim().length > 0);
  let last = lines.length - 1;
  while (last >= 0 && (lines[last].trim().length === 0 || TRAILING_PROVIDER_TAG.test(lines[last]))) {
    last -= 1;
  }
  if (first < 0 || last <= first) return markdown;
  const opener = /^\s*(`{3,}|~{3,})\s*(|md|markdown)\s*$/i.exec(lines[first]);
  if (!opener) return markdown;
  const marker = opener[1][0];
  const minimum = opener[1].length;
  const closer = new RegExp(`^\\s*${marker}{${minimum},}\\s*$`);
  if (!closer.test(lines[last])) return markdown;
  const inner = lines.slice(first + 1, last);
  if (!innerFencesBalanced(inner, marker, minimum)) return markdown;
  return [...lines.slice(0, first), ...inner, ...lines.slice(last + 1)].join('\n');
}

/**
 * Return the executable tool with an exact server-qualified name.
 *
 * Args:
 *   tools: Tools discovered for the credential-bound session.
 *   name: Unqualified provider tool name.
 *
 * Returns:
 *   Executable Mastra tool.
 *
 * Raises:
 *   Error: If the required tool is absent.
 */
function requiredTool(tools: Record<string, McpTool>, name: string): McpTool {
  const tool = tools[`${SERVER_NAME}_${name}`];
  if (!tool?.execute) throw new Error(`Documentation MCP server is missing ${name}.`);
  return tool;
}

/**
 * Parse one JSON provider payload from an MCP text result.
 *
 * Args:
 *   result: Mastra tool result.
 *
 * Returns:
 *   Decoded provider object.
 *
 * Raises:
 *   Error: If MCP or the provider returned an error or malformed payload.
 */
function providerValue(result: unknown): unknown {
  if (!result || typeof result !== 'object') throw new Error('Documentation MCP returned no data.');
  const envelope = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (envelope.isError) throw new Error('Documentation MCP returned an error.');
  let value = envelope.structuredContent;
  if (value === undefined) {
    const text = envelope.content
      ?.filter((item): boolean => item.type === 'text' && typeof item.text === 'string')
      .map((item): string => item.text!)
      .join('\n');
    if (!text) throw new Error('Documentation MCP returned no text content.');
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const payload = value as Record<string, unknown>;
    if (payload.status === 'error' || payload.object === 'error') {
      const code = typeof payload.code === 'string' ? ` (${payload.code})` : '';
      throw new Error(`Documentation provider returned an error${code}.`);
    }
  }
  return value;
}

/** Return an object-shaped provider payload. */
function providerPayload(result: unknown): Record<string, unknown> {
  const value = providerValue(result);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Documentation MCP returned an invalid payload.');
  }
  return value as Record<string, unknown>;
}

/**
 * Derive a Notion page title from its search result.
 *
 * Args:
 *   result: Notion search result object.
 *
 * Returns:
 *   Page title, with a stable id fallback.
 */
function notionPageTitle(result: Record<string, unknown>): string {
  const properties = result.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const property of Object.values(properties)) {
      if (!property || typeof property !== 'object') continue;
      const title = (property as { type?: unknown; title?: unknown }).title;
      if ((property as { type?: unknown }).type !== 'title' || !Array.isArray(title)) continue;
      const text = title
        .map((part: unknown): string =>
          part &&
          typeof part === 'object' &&
          typeof (part as { plain_text?: unknown }).plain_text === 'string'
            ? (part as { plain_text: string }).plain_text
            : '',
        )
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return typeof result.id === 'string' ? `Notion page ${result.id}` : 'Notion page';
}

/** Convert one resource result into Markdown text. */
function resourceMarkdown(
  contents: Array<{ text?: string; blob?: string; uri: string; mimeType?: string }>,
): string {
  return contents
    .map((content): string => {
      if (typeof content.text === 'string') return content.text;
      if (typeof content.blob === 'string')
        return Buffer.from(content.blob, 'base64').toString('utf8');
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Preserve an explicitly supplied authentication scheme, defaulting to Bearer. */
export function authorizationHeader(secret: string): string {
  return /^(?:Bearer|Basic)\s+/i.test(secret) ? secret : `Bearer ${secret}`;
}

/** Read a nested string without trusting a provider response shape. */
function nestedString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

/** Derive an Atlassian continuation cursor from common response fields. */
function atlassianCursor(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.nextCursor === 'string') return payload.nextCursor;
  const next = nestedString(payload, ['_links', 'next']);
  if (!next) return undefined;
  try {
    return new URL(next, 'https://mcp.atlassian.com').searchParams.get('cursor') || undefined;
  } catch {
    return undefined;
  }
}

/** Reader for credential-bound MCP documentation locations. */
export class McpReader implements DocSourceReader {
  /** Create an MCP reader with an injectable client boundary for tests. */
  constructor(private readonly clientFactory: McpClientFactory = productionClient) {}

  /**
   * Read every page, following provider cursors with isolated sessions.
   *
   * Args:
   *   source: Linked MCP source.
   *   secret: Decrypted connection credential.
   *
   * Returns:
   *   All normalised provider pages.
   */
  async listPages(source: DocSourceRecord, secret?: string): Promise<DocPage[]> {
    const pages: DocPage[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const batch = await this.listPageBatch(source, secret, cursor, 25);
      pages.push(...batch.pages);
      cursor = batch.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Documentation MCP repeated its cursor.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return pages;
  }

  /**
   * Read at most one sync action's worth of MCP pages.
   *
   * Args:
   *   source: Linked MCP source.
   *   secret: Decrypted connection credential.
   *   cursor: Provider cursor or generic resource offset.
   *   limit: Maximum pages to retrieve.
   *
   * Returns:
   *   Bounded page batch and continuation cursor.
   */
  async listPageBatch(
    source: DocSourceRecord,
    secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<DocPageBatch> {
    if (!secret) throw new Error('Documentation credential is unavailable.');
    const client = this.clientFactory(connectionConfig(source, secret));
    try {
      if (source.serverKind === 'notion') {
        return await this.readNotionBatch(client, source, cursor, Math.min(limit, 25));
      }
      if (source.serverKind === 'generic') {
        return await this.readResourceBatch(client, source, cursor, limit);
      }
      if (source.serverKind === 'drive') {
        return await this.readDriveBatch(client, source, cursor, limit);
      }
      return await this.readConfluenceBatch(client, source, cursor, Math.min(limit, 10));
    } finally {
      await client.disconnect();
    }
  }

  /** Read one Google Drive search page and each file's text content. */
  private async readDriveBatch(
    client: McpClientLike,
    source: DocSourceRecord,
    cursor: string | undefined,
    limit: number,
  ): Promise<DocPageBatch> {
    const tools = await client.listTools();
    const search = requiredTool(tools, 'search_files');
    const read = requiredTool(tools, 'read_file_content');
    const searchResult = providerPayload(
      await search.execute!(
        {
          query: "mimeType = 'application/vnd.google-apps.document'",
          pageSize: Math.min(limit, 100),
          excludeContentSnippets: true,
          ...(cursor ? { pageToken: cursor } : {}),
        },
        {},
      ),
    );
    const files = Array.isArray(searchResult.files) ? searchResult.files : [];
    const pages: DocPage[] = [];
    for (const value of files) {
      if (!value || typeof value !== 'object') continue;
      const file = value as Record<string, unknown>;
      if (typeof file.id !== 'string') continue;
      const content = providerPayload(
        await read.execute!({ fileId: file.id, includeComments: false }, {}),
      );
      if (typeof content.fileContent !== 'string') {
        throw new Error('Google Drive file content is unavailable.');
      }
      pages.push({
        sourceId: source._id,
        ref: file.id,
        title: typeof file.title === 'string' ? file.title : `Google Drive file ${file.id}`,
        url: typeof file.viewUrl === 'string' ? file.viewUrl : undefined,
        markdown: content.fileContent,
        updatedAt:
          typeof file.modifiedTime === 'string' && Number.isFinite(Date.parse(file.modifiedTime))
            ? Date.parse(file.modifiedTime)
            : Date.now(),
      });
    }
    return {
      pages,
      nextCursor:
        typeof searchResult.nextPageToken === 'string' && searchResult.nextPageToken
          ? searchResult.nextPageToken
          : undefined,
    };
  }

  /** Read one Atlassian CQL page and retrieve each Confluence page as Markdown. */
  private async readConfluenceBatch(
    client: McpClientLike,
    source: DocSourceRecord,
    cursor: string | undefined,
    limit: number,
  ): Promise<DocPageBatch> {
    const tools = await client.listTools();
    const accessible = requiredTool(tools, 'getAccessibleAtlassianResources');
    const search = requiredTool(tools, 'searchConfluenceUsingCql');
    const retrieve = requiredTool(tools, 'getConfluencePage');
    const accessibleValue = providerValue(await accessible.execute!({}, {}));
    const resources = Array.isArray(accessibleValue)
      ? accessibleValue
      : accessibleValue && typeof accessibleValue === 'object'
        ? ((accessibleValue as Record<string, unknown>).resources ??
          (accessibleValue as Record<string, unknown>).values)
        : undefined;
    const first = Array.isArray(resources) ? resources[0] : undefined;
    const cloudId =
      first && typeof first === 'object'
        ? ((first as Record<string, unknown>).id ?? (first as Record<string, unknown>).cloudId)
        : undefined;
    if (typeof cloudId !== 'string') {
      throw new Error('Confluence cloud id is unavailable; escalate this documentation source.');
    }
    const searchResult = providerPayload(
      await search.execute!(
        {
          cloudId,
          cql: 'type=page ORDER BY lastmodified DESC',
          limit,
          ...(cursor ? { cursor } : {}),
        },
        {},
      ),
    );
    const results = Array.isArray(searchResult.results) ? searchResult.results : [];
    const pages: DocPage[] = [];
    for (const value of results) {
      if (!value || typeof value !== 'object') continue;
      const result = value as Record<string, unknown>;
      const content =
        result.content && typeof result.content === 'object' && !Array.isArray(result.content)
          ? (result.content as Record<string, unknown>)
          : result;
      const pageId = typeof content.id === 'string' ? content.id : undefined;
      if (!pageId) continue;
      const retrieved = providerValue(
        await retrieve.execute!({ cloudId, pageId, contentFormat: 'markdown' }, {}),
      );
      const markdown =
        typeof retrieved === 'string'
          ? retrieved
          : (nestedString(retrieved, ['markdown']) ??
            nestedString(retrieved, ['body']) ??
            nestedString(retrieved, ['body', 'value']));
      if (!markdown) throw new Error('Confluence page Markdown is unavailable.');
      const title =
        typeof content.title === 'string'
          ? content.title
          : typeof result.title === 'string'
            ? result.title
            : `Confluence page ${pageId}`;
      const modified =
        typeof result.lastModified === 'string'
          ? result.lastModified
          : nestedString(retrieved, ['version', 'createdAt']);
      pages.push({
        sourceId: source._id,
        ref: pageId,
        title,
        url: typeof result.url === 'string' ? result.url : undefined,
        markdown: unwrapWholePageFence(markdown),
        updatedAt:
          modified && Number.isFinite(Date.parse(modified)) ? Date.parse(modified) : Date.now(),
      });
    }
    return { pages, nextCursor: atlassianCursor(searchResult) };
  }

  /** Read one Notion search page and its Markdown bodies. */
  private async readNotionBatch(
    client: McpClientLike,
    source: DocSourceRecord,
    cursor: string | undefined,
    limit: number,
  ): Promise<DocPageBatch> {
    const tools = await client.listTools();
    const search = requiredTool(tools, 'API-post-search');
    const retrieve = requiredTool(tools, 'API-retrieve-page-markdown');
    const searchResult = providerPayload(
      await search.execute!(
        {
          filter: { property: 'object', value: 'page' },
          page_size: limit,
          ...(cursor ? { start_cursor: cursor } : {}),
        },
        {},
      ),
    );
    const results = Array.isArray(searchResult.results) ? searchResult.results : [];
    const pages: DocPage[] = [];
    for (const value of results) {
      if (!value || typeof value !== 'object') continue;
      const result = value as Record<string, unknown>;
      if (typeof result.id !== 'string') continue;
      const retrieved = providerPayload(
        await retrieve.execute!({ page_id: result.id, include_transcript: false }, {}),
      );
      if (typeof retrieved.markdown !== 'string') {
        throw new Error('Notion page Markdown is unavailable.');
      }
      if (retrieved.truncated === true) throw new Error('Notion page Markdown was truncated.');
      const markdown = unwrapWholePageFence(retrieved.markdown);
      pages.push({
        sourceId: source._id,
        ref: result.id,
        title: notionPageTitle(result),
        url: typeof result.url === 'string' ? result.url : undefined,
        markdown,
        updatedAt:
          typeof result.last_edited_time === 'string' &&
          Number.isFinite(Date.parse(result.last_edited_time))
            ? Date.parse(result.last_edited_time)
            : Date.now(),
      });
    }
    return {
      pages,
      nextCursor:
        searchResult.has_more === true && typeof searchResult.next_cursor === 'string'
          ? searchResult.next_cursor
          : undefined,
    };
  }

  /** Read one bounded slice from a server exposing standard MCP resources. */
  private async readResourceBatch(
    client: McpClientLike,
    source: DocSourceRecord,
    cursor: string | undefined,
    limit: number,
  ): Promise<DocPageBatch> {
    const resources = (await client.resources.list())[SERVER_NAME] ?? [];
    if (resources.length === 0) {
      throw new Error('MCP server exposes no resources; escalate this documentation source.');
    }
    const offset = offsetFromCursor(cursor);
    const selected = resources.slice(offset, offset + limit);
    const pages: DocPage[] = [];
    for (const resource of selected) {
      const result = await client.resources.read(SERVER_NAME, resource.uri);
      const markdown = resourceMarkdown(result.contents);
      const fallback = resource.title || resource.name || resource.uri;
      pages.push({
        sourceId: source._id,
        ref: resource.uri,
        title: resource.title || resource.name || markdownPageTitle(markdown, fallback),
        url: /^https?:\/\//.test(resource.uri) ? resource.uri : undefined,
        markdown,
        updatedAt: Date.now(),
      });
    }
    const nextOffset = offset + pages.length;
    return {
      pages,
      nextCursor: nextOffset < resources.length ? String(nextOffset) : undefined,
    };
  }
}
