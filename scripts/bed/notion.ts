/**
 * Read the Notion pages the way documentation sync will, and compare them
 * with the tracked texts.
 *
 * The bundled Notion component is reachable only on the Compose network, so
 * the read runs inside its own container: `docker compose exec` pipes a small
 * MCP client into the container's Node, which speaks to the server on its own
 * loopback with the transport token the container already holds. The Notion
 * token travels as an environment variable named on the command line, never
 * as its value, and is never printed.
 */

import { unwrapWholePageFence } from '../../src/docs/readers/mcp';
import { NOTION_TOKEN_ENV } from './spec';

/** The parent page the Notion README asks for; its body is the list of its pages. */
export const NOTION_PARENT_TITLE = 'Kestrel Supply handbook';
/** The one line the operator changes before pasting, as a pattern over the tracked text. */
export const TOKEN_LINE = /^- Service token \(company automation\): `([^`]*)`$/;
export const TOKEN_PLACEHOLDER = 'PASTE_LINEAR_API_KEY_HERE';

export interface NotionPage {
  id: string;
  title: string;
  markdown: string;
}

/**
 * The MCP client run inside the component's container, as Node reads it on stdin.
 *
 * It initialises one session, lists every page the integration can see with
 * `API-post-search`, reads each with `API-retrieve-page-markdown` (the two
 * tools sync uses), ends the session, and prints `{ pages }` or `{ error }`
 * as one JSON line. `MCP_URL` exists for the test's fake server.
 */
export const NOTION_READER_SCRIPT = String.raw`
const url = process.env.MCP_URL || 'http://127.0.0.1:3000/mcp';
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: 'Bearer ' + (process.env.AUTH_TOKEN || ''),
  'notion-token': process.env.${NOTION_TOKEN_ENV} || '',
};
let session;
let next = 1;
async function send(method, params, notification) {
  const body = { jsonrpc: '2.0', method, params };
  const id = notification ? undefined : next++;
  if (id !== undefined) body.id = id;
  const response = await fetch(url, {
    method: 'POST',
    headers: session ? { ...headers, 'mcp-session-id': session } : headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  session = session || response.headers.get('mcp-session-id') || undefined;
  if (notification) return undefined;
  if (!response.ok) throw new Error(method + ' answered HTTP ' + response.status);
  const text = await response.text();
  const messages = (response.headers.get('content-type') || '').includes('text/event-stream')
    ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(text)];
  const answer = messages.find((message) => message && message.id === id);
  if (!answer) throw new Error(method + ' returned no answer');
  if (answer.error) throw new Error(method + ': ' + (answer.error.message || 'error'));
  return answer.result;
}
function payload(result) {
  if (!result || result.isError) throw new Error('the Notion component returned an error');
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  return JSON.parse(text);
}
function title(result) {
  for (const property of Object.values(result.properties || {})) {
    if (property && property.type === 'title' && Array.isArray(property.title)) {
      const text = property.title.map((part) => part.plain_text || '').join('').trim();
      if (text) return text;
    }
  }
  return 'Notion page ' + result.id;
}
try {
  await send('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'day0-bed-company-check', version: '1' },
  });
  await send('notifications/initialized', {}, true);
  const pages = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const found = payload(await send('tools/call', {
      name: 'API-post-search',
      arguments: { filter: { property: 'object', value: 'page' }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    }));
    for (const result of found.results || []) {
      const read = payload(await send('tools/call', {
        name: 'API-retrieve-page-markdown',
        arguments: { page_id: result.id, include_transcript: false },
      }));
      pages.push({ id: result.id, title: title(result), markdown: String(read.markdown || '') });
    }
    if (!found.has_more || !found.next_cursor) break;
    cursor = found.next_cursor;
  }
  console.log(JSON.stringify({ pages }));
} catch (error) {
  console.log(JSON.stringify({ error: String(error && error.message ? error.message : error) }));
} finally {
  if (session) {
    await fetch(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session } }).catch(() => undefined);
  }
}
`;

/**
 * Read the container read's output.
 *
 * Args:
 *   stdout: What the script printed.
 *
 * Returns:
 *   The pages the integration can see.
 *
 * Raises:
 *   Error: If the script reported an error or printed nothing usable.
 */
export function parseNotionRead(stdout: string): NotionPage[] {
  const line = stdout
    .split('\n')
    .map((value: string): string => value.trim())
    .filter(Boolean)
    .pop();
  if (!line) throw new Error('the Notion read printed nothing');
  const parsed = JSON.parse(line) as { pages?: NotionPage[]; error?: string };
  if (parsed.error !== undefined) throw new Error(parsed.error);
  if (!Array.isArray(parsed.pages)) throw new Error('the Notion read printed no page list');
  return parsed.pages;
}

/**
 * A page's text reduced to what pasting cannot change: the provider's outer
 * fence and empty trailing blocks removed, line ends trimmed, blank runs
 * collapsed.
 *
 * Args:
 *   markdown: A tracked text or a page as the component renders it.
 *
 * Returns:
 *   Its lines.
 */
export function comparableLines(markdown: string): string[] {
  const lines = unwrapWholePageFence(markdown)
    .split(/\r?\n/)
    .map((line: string): string => line.trimEnd())
    .filter((line: string): boolean => !/^\s*<[a-z][a-z0-9-]*\/>\s*$/i.test(line));
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line === '' && (collapsed.length === 0 || collapsed[collapsed.length - 1] === '')) continue;
    collapsed.push(line);
  }
  while (collapsed[collapsed.length - 1] === '') collapsed.pop();
  return collapsed;
}

export type PageComparison =
  | { kind: 'same'; token: 'pasted' | 'placeholder' | 'none' }
  | { kind: 'differs'; line: number; expected: string; found: string };

/**
 * Compare a Notion page with its tracked text, the token line apart.
 *
 * The page may omit the tracked text's `# ` heading, which Notion also
 * carries as the page's title. The token line matches whatever value it
 * holds; whether that value is still the placeholder is reported, never the
 * value itself.
 *
 * Args:
 *   tracked: The text under `bed/company/notion/`.
 *   page: The page's Markdown as the component returns it.
 *
 * Returns:
 *   Whether they match, and where they first differ when they do not.
 */
export function comparePage(tracked: string, page: string): PageComparison {
  let expected = comparableLines(tracked);
  const found = comparableLines(page);
  if (expected[0]?.startsWith('# ') && found[0] !== expected[0]) {
    expected = expected.slice(1);
    while (expected[0] === '') expected = expected.slice(1);
  }
  let token: 'pasted' | 'placeholder' | 'none' = 'none';
  for (let index = 0; index < Math.max(expected.length, found.length); index += 1) {
    const want = expected[index];
    const have = found[index];
    const tokenLine = want === undefined ? null : TOKEN_LINE.exec(want);
    if (tokenLine && have !== undefined) {
      const value = TOKEN_LINE.exec(have)?.[1];
      if (value !== undefined) {
        token = value === TOKEN_PLACEHOLDER || value.trim() === '' ? 'placeholder' : 'pasted';
        continue;
      }
    }
    if (want !== have) {
      return {
        kind: 'differs',
        line: index + 1,
        expected: want ?? '(nothing)',
        // The token line is the one line a pasted value can reach; it is never echoed.
        found: have === undefined ? '(nothing)' : TOKEN_LINE.test(have) ? '(the token line)' : have,
      };
    }
  }
  return { kind: 'same', token };
}
