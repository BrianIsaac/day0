/**
 * The Feishu (and Lark) documentation reader: a wiki space or a Drive folder, read as Markdown.
 *
 * Feishu's open platform answers the app, not a person: the source's reader
 * secret is the app's ID and secret, exchanged for a `tenant_access_token`
 * that lives up to two hours, and the app reads a wiki space once a group chat
 * with the app as its bot is one of the space's members (the wiki FAQ, read 8
 * October 2026; `docs/running/reader-feishu.md`). The region is the locator's
 * host: `open.feishu.cn` for Feishu, `open.larksuite.com` for Lark.
 *
 * The listing walks the space breadth first, one parent at a time, 50 nodes
 * a page, and every batch walks it again, so the cursor is bound to the
 * listing (`listingCursor`) as a folder's or a repository's is: a node added
 * or moved mid-sync restarts the sync rather than losing a page. Each new-style
 * document (`docx`) is read as Markdown by `docs/v1/content`; every other node
 * (a sheet, a base, a mind note, a file, an old-style document) is named unread
 * with its reason. Requests are spaced to each endpoint's documented limit,
 * and a limit Feishu still answers (429, or 400 with code 99991400) is waited
 * out for the seconds `x-ogw-ratelimit-reset` names.
 */
import { log } from '../../lib/logger';
import { TransientProviderError, withBackoff, type BackoffPolicy } from '../../lib/transport-error';
import {
  BROWSER_HOSTS,
  parseFeishuLocator,
  parseFeishuSecret,
  type FeishuApp,
  type FeishuLocator,
} from '../feishu-source';
import type { DocPage, DocSourceRecord } from '../types';
import {
  listingCursor,
  offsetInListing,
  type DocumentationReader,
  type ReadPageBatch,
  type UnreadPage,
} from './batch';

/** How one request is made: the reader's fetch, which a test answers in-process. */
export type FeishuFetch = (input: URL, init: RequestInit) => Promise<Response>;

/** What the reader is given instead of the network, the clock and the timer, for tests. */
export interface FeishuReaderOptions {
  readonly fetch?: FeishuFetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** How long one request may take. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long before its expiry a token is replaced. Feishu answers a token
 * request with a new token once the old one has under 30 minutes left, so ten
 * minutes always gets a new one and never sends one that lapses mid-batch.
 */
const TOKEN_REFRESH_MARGIN_MS = 10 * 60_000;

/** The most nodes one source lists: a wiki past this is linked by a smaller space or folder. */
const MAX_LISTED_NODES = 2_000;

/**
 * How a limited or failed request is tried again: a minute's limit can name a
 * reset of up to sixty seconds, which the reader waits out, three times at most.
 */
const FEISHU_BACKOFF: BackoffPolicy = { attempts: 4, baseMs: 1_000, maxWaitMs: 65_000 };

/** The least time between two requests to each endpoint, from its documented limit (C5). */
const REQUEST_SPACING_MS = {
  /** Wiki node listing: 100 a minute. */
  wiki: 600,
  /** `docs/v1/content`: 5 a second. */
  content: 200,
  /** `docx/v1/documents`: 5 a second for the app. */
  document: 200,
  /** Drive folder listing: 20 a second. */
  drive: 50,
  token: 0,
} as const;

type Endpoint = keyof typeof REQUEST_SPACING_MS;

/** Feishu's code for a request over its limit, under HTTP 429 or, from older APIs, 400. */
const RATE_LIMITED = 99991400;

/** The codes that say the token sent is missing or no longer valid. */
const TOKEN_REFUSED: ReadonlySet<number> = new Set([99991661, 99991663, 99991665]);

/** A document above the 10 MB `docs/v1/content` exports. */
const CONTENT_TOO_LARGE = 2889925;

/** The codes that say the app may not read a document. */
const DOCUMENT_FORBIDDEN: ReadonlySet<number> = new Set([2889902, 1770032]);

/** The codes that say a listed document is gone. */
const DOCUMENT_GONE: ReadonlySet<number> = new Set([2889906, 2889914, 1770002, 1770003]);

/** An answer from Feishu that refused the request, with its code and message. */
class FeishuApiError extends Error {
  readonly code: number;
  readonly status: number;
  readonly feishuMessage: string;

  constructor(code: number, status: number, feishuMessage: string) {
    super(`Feishu answered code ${code} (HTTP ${status}): ${feishuMessage}`);
    this.name = 'FeishuApiError';
    this.code = code;
    this.status = status;
    this.feishuMessage = feishuMessage;
  }
}

/** One node or file a listing found, in the words the batch needs. */
interface ListedEntry {
  readonly ref: string;
  readonly title: string;
  readonly type: string;
  readonly objToken: string;
  readonly shortcut: boolean;
  readonly editedAt?: number;
  readonly url?: string;
}

/** One source's read: where it is, the app it reads as. */
interface FeishuSession {
  readonly locator: FeishuLocator;
  readonly app: FeishuApp;
}

/** A Feishu answer's parsed body. */
interface FeishuBody {
  readonly code: number;
  readonly msg: string;
  readonly data?: unknown;
  readonly [field: string]: unknown;
}

/** An object's field, when the value is an object. */
function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/** A string field, or undefined. */
function text(value: unknown, name: string): string | undefined {
  const found = field(value, name);
  return typeof found === 'string' ? found : undefined;
}

/** Epoch milliseconds from Feishu's epoch-second strings. */
function secondsToMs(value: string | undefined): number | undefined {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) * 1_000 : undefined;
}

/** The wait a limited answer asks for: `x-ogw-ratelimit-reset` seconds, or `Retry-After`. */
function resetMs(response: Response): number | undefined {
  const reset =
    response.headers.get('x-ogw-ratelimit-reset') ?? response.headers.get('retry-after');
  return reset !== null && /^\d+$/.test(reset.trim()) ? Number(reset.trim()) * 1_000 : undefined;
}

/** What a node type is called in a sentence the manager reads. */
const TYPE_NOUNS: Readonly<Record<string, string>> = {
  sheet: 'sheet',
  bitable: 'base',
  mindnote: 'mind note',
  file: 'file',
  slides: 'slide deck',
  doc: 'document in the old format',
};

/** Why a listed node is not read, when it is not a document. */
function notReadReason(entry: ListedEntry): string {
  if (entry.shortcut) {
    return `"${entry.title}" is a shortcut; Day0 reads the page it points to where that page lives.`;
  }
  const noun = TYPE_NOUNS[entry.type] ?? `${entry.type} node`;
  return `"${entry.title}" is a Feishu ${noun}, which Day0 does not read: only documents (docx) are read, as Markdown.`;
}

/** Why a document could not be read, from Feishu's refusal. */
function pageFailureReason(entry: ListedEntry, error: FeishuApiError): string {
  if (error.code === CONTENT_TOO_LARGE) {
    return `"${entry.title}" is larger than the 10 MB Feishu exports as Markdown, so it is not read.`;
  }
  if (DOCUMENT_FORBIDDEN.has(error.code) || error.status === 403) {
    return (
      `The Feishu app cannot read "${entry.title}" (Feishu code ${error.code}): add the app to ` +
      'the document, or to its wiki space as a member.'
    );
  }
  if (DOCUMENT_GONE.has(error.code)) {
    return `"${entry.title}" was deleted or moved in Feishu after it was listed (Feishu code ${error.code}).`;
  }
  return `Feishu could not give "${entry.title}" as Markdown (Feishu code ${error.code}, ${error.feishuMessage}).`;
}

/** The sentence for a listing Feishu refused. */
function listingFailure(scope: FeishuLocator['scope'], error: FeishuApiError): Error {
  if (scope.kind === 'wiki' && error.code === 131006) {
    return new Error(
      'The Feishu app is not a member of this wiki space (Feishu code 131006): add a group chat ' +
        "that has the app as its bot to the space's members.",
      { cause: error },
    );
  }
  if (scope.kind === 'wiki' && error.code === 131005) {
    return new Error(
      'Feishu found no wiki space with this ID (Feishu code 131005): check the space ID.',
      { cause: error },
    );
  }
  return new Error(
    `Feishu refused the ${scope.kind === 'wiki' ? 'wiki space' : 'folder'} listing (Feishu code ` +
      `${error.code}, ${error.feishuMessage}): share it with a group chat that has the app as its bot.`,
    { cause: error },
  );
}

/** Reader for a Feishu or Lark wiki space, or a Drive folder, as Markdown. */
export class FeishuReader implements DocumentationReader {
  private readonly fetch: FeishuFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lastRequestAt = new Map<Endpoint, number>();
  /**
   * The tenant token, for the app it was issued to. Held by this reader only:
   * the sync makes one reader a batch, so a token is asked for once a batch
   * and never stored in a row.
   */
  private token?: { readonly key: string; readonly value: string; readonly expiresAt: number };

  /** @param options - The fetch, clock and timer; the real ones by default. */
  constructor(options: FeishuReaderOptions = {}) {
    this.fetch = options.fetch ?? ((input, init): Promise<Response> => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms: number): Promise<void> =>
        new Promise((resolve): void => {
          setTimeout(resolve, ms);
        }));
  }

  /**
   * Read a bounded batch of the source's listing: each document as Markdown,
   * every other node named unread with its reason.
   *
   * @param source - The linked Feishu source.
   * @param secret - The app's ID and secret, joined (`feishuReaderSecret`).
   * @param cursor - Where the previous batch stopped, bound to the listing.
   * @param limit - The most listed nodes this batch takes.
   * @throws Error when the app or the listing is refused, or Feishu stays limited past the waits;
   *   the batch's own retry and the sync's resume are for those.
   */
  async listPageBatch(
    source: DocSourceRecord,
    secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<ReadPageBatch> {
    if (secret === undefined) {
      throw new Error(
        'A Feishu source reads with its app ID and secret, and this one has none; link it again with them.',
      );
    }
    const session: FeishuSession = {
      locator: parseFeishuLocator(source.locator),
      app: parseFeishuSecret(secret),
    };
    const listing = await this.list(session);
    const refs = listing.map((entry): string => entry.ref);
    const offset = offsetInListing(cursor, refs);
    const selected = listing.slice(offset, offset + limit);
    const pages: DocPage[] = [];
    const unread: UnreadPage[] = [];
    for (const entry of selected) {
      if (entry.type !== 'docx' || entry.shortcut) {
        unread.push({ ref: entry.ref, reason: notReadReason(entry) });
        continue;
      }
      try {
        pages.push(await this.readDocument(session, source, entry));
      } catch (error) {
        // A refusal of this document is the page's; the token, the limit or the
        // transport are the batch's, for its retry and the sync's resume.
        if (!(error instanceof FeishuApiError) || error.code >= 99_990_000) throw error;
        unread.push({ ref: entry.ref, reason: pageFailureReason(entry, error) });
      }
    }
    const nextOffset = offset + selected.length;
    return {
      pages,
      unread,
      nextCursor: nextOffset < listing.length ? listingCursor(nextOffset, refs) : undefined,
    };
  }

  /** Every node or file the source lists, in reading order. */
  private async list(session: FeishuSession): Promise<ListedEntry[]> {
    const scope = session.locator.scope;
    try {
      return scope.kind === 'wiki'
        ? await this.listWiki(session, scope.spaceId)
        : await this.listFolder(session, scope.folderToken);
    } catch (error) {
      if (error instanceof FeishuApiError && error.code < 99_990_000) {
        throw listingFailure(scope, error);
      }
      throw error;
    }
  }

  /** The wiki space's nodes, breadth first: each parent's pages before its children's. */
  private async listWiki(session: FeishuSession, spaceId: string): Promise<ListedEntry[]> {
    const entries: ListedEntry[] = [];
    const parents: Array<string | undefined> = [undefined];
    const visited = new Set<string>();
    const path = `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`;
    for (let index = 0; index < parents.length; index += 1) {
      const parent = parents[index];
      let pageToken: string | undefined;
      do {
        const data = await this.call(session, 'wiki', path, {
          page_size: '50',
          ...(parent === undefined ? {} : { parent_node_token: parent }),
          ...(pageToken === undefined ? {} : { page_token: pageToken }),
        });
        const items = field(data, 'items') ?? [];
        if (!Array.isArray(items))
          throw new Error('Feishu listed wiki nodes in a shape Day0 does not read.');
        for (const item of items) {
          const ref = text(item, 'node_token');
          if (ref === undefined || visited.has(ref)) continue;
          visited.add(ref);
          const shortcut = text(item, 'node_type') === 'shortcut';
          entries.push({
            ref,
            title: text(item, 'title')?.trim() || 'Untitled',
            type: text(item, 'obj_type') ?? 'unknown',
            objToken: text(item, 'obj_token') ?? '',
            shortcut,
            editedAt: secondsToMs(text(item, 'obj_edit_time')),
            url: `https://${BROWSER_HOSTS[session.locator.region]}/wiki/${ref}`,
          });
          // A shortcut's children are listed where the page it points to lives.
          if (field(item, 'has_child') === true && !shortcut) parents.push(ref);
        }
        if (entries.length > MAX_LISTED_NODES) throw tooManyNodes();
        pageToken = nextPageToken(data, 'page_token', pageToken);
      } while (pageToken !== undefined);
    }
    return entries;
  }

  /** The folder's files and those of the folders under it, breadth first. */
  private async listFolder(session: FeishuSession, folderToken: string): Promise<ListedEntry[]> {
    const entries: ListedEntry[] = [];
    const folders = [folderToken];
    const visited = new Set<string>(folders);
    for (let index = 0; index < folders.length; index += 1) {
      const folder = folders[index];
      let pageToken: string | undefined;
      do {
        const data = await this.call(session, 'drive', '/open-apis/drive/v1/files', {
          folder_token: folder,
          page_size: '200',
          // Oldest first by creation, which an edit never changes, so an edit mid-sync moves no
          // file across the cursor.
          order_by: 'CreatedTime',
          direction: 'ASC',
          ...(pageToken === undefined ? {} : { page_token: pageToken }),
        });
        const files = field(data, 'files') ?? [];
        if (!Array.isArray(files))
          throw new Error('Feishu listed a folder in a shape Day0 does not read.');
        for (const file of files) {
          const ref = text(file, 'token');
          if (ref === undefined || visited.has(ref)) continue;
          visited.add(ref);
          const type = text(file, 'type') ?? 'unknown';
          if (type === 'folder') {
            folders.push(ref);
            continue;
          }
          const url = text(file, 'url');
          entries.push({
            ref,
            title: text(file, 'name')?.trim() || 'Untitled',
            type,
            objToken: ref,
            shortcut: type === 'shortcut',
            editedAt: secondsToMs(text(file, 'modified_time')),
            url: url?.startsWith('https://') ? url : undefined,
          });
        }
        if (entries.length > MAX_LISTED_NODES) throw tooManyNodes();
        pageToken = nextPageToken(data, 'next_page_token', pageToken);
      } while (pageToken !== undefined);
    }
    return entries;
  }

  /**
   * One document as Markdown. Its `revision_id` is read and logged for wave
   * 15's change check: the store has no field for it yet.
   */
  private async readDocument(
    session: FeishuSession,
    source: DocSourceRecord,
    entry: ListedEntry,
  ): Promise<DocPage> {
    const document = await this.call(
      session,
      'document',
      `/open-apis/docx/v1/documents/${encodeURIComponent(entry.objToken)}`,
      {},
    );
    const revision = field(field(document, 'document'), 'revision_id');
    log.info('feishu document read', {
      sourceId: source._id,
      ref: entry.ref,
      revision: typeof revision === 'number' ? revision : null,
    });
    const content = await this.call(session, 'content', '/open-apis/docs/v1/content', {
      doc_token: entry.objToken,
      doc_type: 'docx',
      content_type: 'markdown',
    });
    const markdown = text(content, 'content');
    if (markdown === undefined) {
      throw new FeishuApiError(0, 200, 'the answer carried no Markdown');
    }
    return {
      sourceId: source._id,
      ref: entry.ref,
      title: entry.title,
      ...(entry.url === undefined ? {} : { url: entry.url }),
      markdown,
      updatedAt: entry.editedAt ?? this.now(),
    };
  }

  /**
   * One authorised GET, spaced to its endpoint's limit, retried while Feishu says it is limited.
   *
   * @returns The answer's `data`.
   * @throws FeishuApiError for a refusal; TransientProviderError when the limit outlasts the waits.
   */
  private async call(
    session: FeishuSession,
    endpoint: Endpoint,
    path: string,
    query: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const url = new URL(`https://${session.locator.host}${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    let refreshed = false;
    for (;;) {
      const token = await this.tenantToken(session, refreshed);
      try {
        return await withBackoff(
          async (): Promise<unknown> =>
            (await this.request(endpoint, url, { headers: { authorization: `Bearer ${token}` } }))
              .data,
          { ...FEISHU_BACKOFF, sleep: this.sleep },
        );
      } catch (error) {
        // A token Feishu stopped honouring before its time is replaced once.
        if (refreshed || !(error instanceof FeishuApiError) || !TOKEN_REFUSED.has(error.code)) {
          throw error;
        }
        refreshed = true;
      }
    }
  }

  /** The tenant token for the session's app, asked for again before it lapses. */
  private async tenantToken(session: FeishuSession, force: boolean): Promise<string> {
    const key = `${session.locator.host}\n${session.app.appId}\n${session.app.appSecret}`;
    const held = this.token;
    if (!force && held?.key === key && this.now() < held.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return held.value;
    }
    const askedAt = this.now();
    let body: FeishuBody;
    try {
      body = await withBackoff(
        async (): Promise<FeishuBody> =>
          await this.request(
            'token',
            new URL(
              `https://${session.locator.host}/open-apis/auth/v3/tenant_access_token/internal`,
            ),
            {
              method: 'POST',
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: JSON.stringify({
                app_id: session.app.appId,
                app_secret: session.app.appSecret,
              }),
            },
          ),
        { ...FEISHU_BACKOFF, sleep: this.sleep },
      );
    } catch (error) {
      if (!(error instanceof FeishuApiError)) throw error;
      throw new Error(
        `Feishu refused the app ID and secret this source was linked with (Feishu code ${error.code}, ` +
          `${error.feishuMessage}); link it again with the app's current secret.`,
        { cause: error },
      );
    }
    const value = text(body, 'tenant_access_token');
    const expire = field(body, 'expire');
    if (value === undefined || typeof expire !== 'number') {
      throw new Error('Feishu answered the token request in a shape Day0 does not read.');
    }
    this.token = { key, value, expiresAt: askedAt + expire * 1_000 };
    return value;
  }

  /**
   * One request: spaced, sent, and its body read.
   *
   * @returns The body, when its code is 0.
   * @throws TransientProviderError for a limit or a server failure; FeishuApiError for a refusal.
   */
  private async request(endpoint: Endpoint, url: URL, init: RequestInit): Promise<FeishuBody> {
    await this.pace(endpoint);
    const response = await this.fetch(url, {
      ...init,
      // A redirect would carry the token to wherever it points.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await readBody(response);
    if (response.status === 429 || body?.code === RATE_LIMITED) {
      throw new TransientProviderError(
        `Feishu was rate limited (HTTP ${response.status}, code ${RATE_LIMITED}).`,
        { retryAfterMs: resetMs(response), status: response.status },
      );
    }
    if (body === undefined) {
      if (response.status >= 500) {
        throw new TransientProviderError(`Feishu answered HTTP ${response.status}.`, {
          status: response.status,
        });
      }
      throw new Error(`Feishu answered HTTP ${response.status} with a body Day0 does not read.`);
    }
    if (body.code === 0) return body;
    // A server failure is tried again, except a document too large to export, which stays so.
    if (response.status >= 500 && body.code !== CONTENT_TOO_LARGE) {
      throw new TransientProviderError(
        `Feishu answered HTTP ${response.status} (code ${body.code}).`,
        { status: response.status },
      );
    }
    throw new FeishuApiError(body.code, response.status, body.msg);
  }

  /** Wait until this endpoint's spacing since its last request has passed. */
  private async pace(endpoint: Endpoint): Promise<void> {
    const last = this.lastRequestAt.get(endpoint);
    const wait = last === undefined ? 0 : last + REQUEST_SPACING_MS[endpoint] - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt.set(endpoint, this.now());
  }
}

/** The body of a Feishu answer, or undefined when it is not one. */
async function readBody(response: Response): Promise<FeishuBody | undefined> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    // Not JSON (a gateway's page): the caller words the status instead.
    return undefined;
  }
  const code = field(parsed, 'code');
  if (typeof code !== 'number') return undefined;
  return { ...(parsed as Record<string, unknown>), code, msg: text(parsed, 'msg') ?? '' };
}

/** The listing's next page token, refusing a page that says more follow and names none. */
function nextPageToken(
  data: unknown,
  name: string,
  current: string | undefined,
): string | undefined {
  if (field(data, 'has_more') !== true) return undefined;
  const next = text(data, name);
  if (next === undefined || next === '' || next === current) {
    throw new Error('Feishu said more of the listing follows but gave no new page token.');
  }
  return next;
}

/** The refusal for a source past the listing bound. */
function tooManyNodes(): Error {
  return new Error(
    `This Feishu source lists more than ${MAX_LISTED_NODES.toLocaleString('en-GB')} pages, more ` +
      'than Day0 reads from one source; link a smaller wiki space or folder.',
  );
}
