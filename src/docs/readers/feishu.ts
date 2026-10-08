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
 * a page, and the walk is carried from batch to batch in the run's cursor
 * (`feishu-walk.ts`), so each listing page is asked for about once a sync
 * rather than once a batch (second pass). Each new-style
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
  ListingChangedError,
  type DocumentationReader,
  type ReadPageBatch,
  type UnreadPage,
} from './batch';
import { firstWalk, walkCursor, walkFromCursor, type FeishuWalk } from './feishu-walk';

/** How one request is made: the reader's fetch, which a test answers in-process. */
export type FeishuFetch = (input: URL, init: RequestInit) => Promise<Response>;

/** What the reader is given instead of the network, the clock and the timer, for tests. */
export interface FeishuReaderOptions {
  /** Sends one request; the platform's `fetch` by default. */
  readonly fetch?: FeishuFetch;
  /** The clock the token's life and the request spacing are read against. */
  readonly now?: () => number;
  /** Waits between requests and before a retry. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long one batch may spend waiting on Feishu; `BATCH_BUDGET_MS` by default. */
  readonly batchBudgetMs?: number;
}

/** How long one request may take. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long one batch may spend before a wait would run past it: under the
 * ten minutes a Convex action has, so a limit that keeps resetting fails the
 * batch, which records why, rather than the action being stopped mid-batch.
 */
const BATCH_BUDGET_MS = 6 * 60_000;

/**
 * How long before its expiry a token is replaced. Feishu answers a token
 * request with a new token once the old one has under 30 minutes left, so ten
 * minutes always gets a new one and never sends one that lapses mid-batch.
 */
const TOKEN_REFRESH_MARGIN_MS = 10 * 60_000;

/** The most nodes and folders one source lists: past this it is linked by a smaller folder. */
const MAX_LISTED_NODES = 2_000;

/** The most listing requests one batch makes (a minute of wiki listings at 100 a minute). */
const MAX_LISTING_REQUESTS_PER_BATCH = 100;

/** The most listing requests a whole sync makes, so a listing that never ends is stopped. */
const MAX_LISTING_REQUESTS = 5_000;

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

/** A server failure Feishu answered with a code: tried again, and its code kept for the words. */
class FeishuServerError extends TransientProviderError {
  readonly feishuCode: number;

  constructor(status: number, feishuCode: number) {
    super(`Feishu answered HTTP ${status} (code ${feishuCode}).`, { status });
    this.name = 'FeishuServerError';
    this.feishuCode = feishuCode;
  }
}

/**
 * A refusal of the app itself rather than of one request (a missing scope, an
 * unpublished version), worded with what IT checks.
 */
/**
 * An answer that is not Feishu's JSON (a proxy's or a firewall's page, or a host without the
 * endpoint): never a page's refusal, so it fails the batch with what stands between (W14-R9).
 */
class FeishuGatewayError extends Error {
  constructor(host: string, status: number) {
    super(
      `${host} answered HTTP ${status} with a page that is not Feishu’s own answer, so something ` +
        'between day0 and Feishu (a proxy or a firewall) may be stopping the request: ask IT ' +
        `whether the machine day0 runs on reaches ${host} directly.`,
    );
    this.name = 'FeishuGatewayError';
  }
}

class FeishuAppError extends Error {
  constructor(error: FeishuApiError) {
    super(
      `Feishu refused the request as this app (Feishu code ${error.code}, ${error.feishuMessage}): ` +
        'check that the app has the scopes reader-feishu.md lists and that its latest version is ' +
        'published.',
      { cause: error },
    );
    this.name = 'FeishuAppError';
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

/** One listed item: a page to take, a parent (or folder) to list later, or both. */
interface ListedItem {
  readonly entry?: ListedEntry;
  readonly child?: string;
}

/** One listing page: its items in order, and the next page's token. */
interface ListedPage {
  readonly items: readonly ListedItem[];
  readonly next: string | undefined;
  /** Why the parent's children are not read, when Feishu refused to list them (W14-R10). */
  readonly refused?: string;
}

/** One source's read: where it is, the app it reads as. */
interface FeishuSession {
  readonly locator: FeishuLocator;
  readonly app: FeishuApp;
  /** The time, on the system clock the backoff reads, past which no wait may run. */
  readonly deadline: number;
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
    return `"${entry.title}" is a shortcut; day0 reads the page it points to where that page lives, if that is in this source.`;
  }
  const noun = TYPE_NOUNS[entry.type] ?? `${entry.type} node`;
  return `"${entry.title}" is a Feishu ${noun}, which day0 does not read: only documents (docx) are read, as Markdown.`;
}

/** Why a document could not be read, from Feishu's refusal. */
function pageFailureReason(entry: ListedEntry, error: FeishuApiError): string {
  if (error.code === CONTENT_TOO_LARGE) {
    return `"${entry.title}" is larger than the 10 MB Feishu exports as Markdown, so it is not read.`;
  }
  // Feishu answers a deleted document with 403 too, so the code is read before the status.
  if (DOCUMENT_GONE.has(error.code)) {
    return `"${entry.title}" was deleted or moved in Feishu after it was listed (Feishu code ${error.code}).`;
  }
  if (DOCUMENT_FORBIDDEN.has(error.code) || error.status === 403) {
    return (
      `The Feishu app cannot read "${entry.title}" (Feishu code ${error.code}): add the app to ` +
      'the document, or to its wiki space as a member.'
    );
  }
  return (
    `Feishu could not give "${entry.title}" as Markdown (Feishu code ${error.code}, ` +
    `${error.feishuMessage}). Re-sync to try again; if it repeats, ask IT to look the code up in ` +
    "Feishu's documentation."
  );
}

/**
 * Why a document was not read, when the failure is the document's: a refusal
 * of it, or a server failure that outlasted every retry. Anything else (the
 * app, the limit, the transport) is thrown for the batch.
 */
function documentFailure(entry: ListedEntry, error: unknown): string {
  if (error instanceof FeishuApiError && error.code < 99_990_000) {
    return pageFailureReason(entry, error);
  }
  // An export that keeps timing out is that document's, as a server failure is (W14-R10).
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `Feishu did not give "${entry.title}" as Markdown within ${REQUEST_TIMEOUT_MS / 1_000} seconds, each time it was asked; re-sync to try again.`;
  }
  if (
    error instanceof TransientProviderError &&
    error.status !== undefined &&
    error.status >= 500
  ) {
    const code = error instanceof FeishuServerError ? ` (Feishu code ${error.feishuCode})` : '';
    return `Feishu answered HTTP ${error.status} for "${entry.title}" each time it was asked${code}; re-sync to try again.`;
  }
  throw error;
}

/** What makes two documents' failures one cause: the code, the status, or the timeout. */
function failureCause(error: unknown): string {
  if (error instanceof FeishuApiError) return `code ${error.code}`;
  if (error instanceof FeishuServerError) return `HTTP ${error.status} code ${error.feishuCode}`;
  if (error instanceof TransientProviderError) return `HTTP ${error.status ?? ''}`;
  return error instanceof Error ? error.name : 'unknown';
}

/** The sentence for a listing Feishu refused. */
function listingFailure(scope: FeishuLocator['scope'], error: FeishuApiError): Error {
  if (scope.kind === 'wiki' && error.code === 131006) {
    return new Error(
      'The Feishu app is not a member of this wiki space, or may not read its pages (Feishu code ' +
        '131006): add a group chat ' +
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
  private readonly batchBudgetMs: number;
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
    this.batchBudgetMs = options.batchBudgetMs ?? BATCH_BUDGET_MS;
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
   * @param cursor - Where the previous batch left the walk (`walkCursor`).
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
        "A Feishu source reads with its app ID and secret, and this one has none: use Rotate on the source's row to give them.",
      );
    }
    const session: FeishuSession = {
      locator: parseFeishuLocator(source.locator),
      app: parseFeishuSecret(secret),
      deadline: Date.now() + this.batchBudgetMs,
    };
    const scope = session.locator.scope;
    const walk =
      cursor === undefined
        ? firstWalk(scope.kind === 'wiki' ? null : scope.folderToken)
        : walkFromCursor(cursor);
    const listed = await this.listBatch(session, walk, limit);
    const pages: DocPage[] = [];
    const unread: UnreadPage[] = [...listed.refused];
    const failed: Array<{ readonly reason: string; readonly cause: string }> = [];
    for (const entry of listed.entries) {
      if (entry.type !== 'docx' || entry.shortcut) {
        unread.push({ ref: entry.ref, reason: notReadReason(entry) });
        continue;
      }
      try {
        pages.push(await this.readDocument(session, source, entry));
      } catch (error) {
        // A refusal of this document is the page's; the token, the limit or the
        // transport are the batch's, for its retry and the sync's resume.
        const reason = documentFailure(entry, error);
        unread.push({ ref: entry.ref, reason });
        failed.push({ reason, cause: failureCause(error) });
      }
    }
    // Every document unread for one cause is the source's failure, not each page's (W14-R9).
    if (
      pages.length === 0 &&
      failed.length >= 2 &&
      new Set(failed.map((f) => f.cause)).size === 1
    ) {
      throw new Error(
        `Feishu gave none of the ${failed.length} documents in this batch, each for the same reason: ${failed[0].reason}`,
      );
    }
    return {
      pages,
      unread,
      nextCursor: listed.walk === undefined ? undefined : walkCursor(listed.walk),
    };
  }

  /**
   * The next entries of the walk, at most `limit`, and where the walk then stands.
   *
   * Each parent's listing pages are read in turn, its children queued behind
   * the parents already waiting (breadth first). A batch ends once it has its
   * entries or has made `MAX_LISTING_REQUESTS_PER_BATCH` requests, part way
   * through a page if need be: the next batch asks for that page again and
   * skips what this one took.
   *
   * @returns The entries, and the walk to continue from, or undefined once every parent is listed.
   * @throws ListingChangedError when a page token an earlier batch kept is refused, so the sync
   *   reads the source again from the first page.
   */
  private async listBatch(
    session: FeishuSession,
    start: FeishuWalk,
    limit: number,
  ): Promise<{ entries: ListedEntry[]; walk: FeishuWalk | undefined; refused: UnreadPage[] }> {
    const entries: ListedEntry[] = [];
    const refused: UnreadPage[] = [];
    let { queue, pageToken, skip, listed, requests } = start;
    for (let made = 0; queue.length > 0 && entries.length < limit; made += 1) {
      if (made === MAX_LISTING_REQUESTS_PER_BATCH) break;
      if (requests >= MAX_LISTING_REQUESTS) throw endlessListing();
      const page = await this.listedPage(session, queue[0], pageToken, made === 0 && skip > 0);
      requests += 1;
      if (page.refused !== undefined) refused.push({ ref: queue[0]!, reason: page.refused });
      let index = skip;
      const children: string[] = [];
      for (; index < page.items.length && entries.length < limit; index += 1) {
        const item = page.items[index];
        listed += 1;
        if (listed > MAX_LISTED_NODES) throw tooManyNodes();
        if (item.entry !== undefined) entries.push(item.entry);
        if (item.child !== undefined) children.push(item.child);
      }
      queue = [...queue, ...children];
      if (index < page.items.length) {
        skip = index;
      } else if (page.next !== undefined) {
        if (page.next === pageToken) throw noNewPageToken();
        [pageToken, skip] = [page.next, 0];
      } else {
        [queue, pageToken, skip] = [queue.slice(1), null, 0];
      }
    }
    return {
      entries,
      walk: queue.length === 0 ? undefined : { queue, pageToken, skip, listed, requests },
      refused,
    };
  }

  /**
   * One listing page of a parent: a wiki node's children, or a folder's files.
   *
   * @param resumed - Whether the page token was kept by an earlier batch, whose refusal means the
   *   listing moved on and the sync starts again.
   */
  private async listedPage(
    session: FeishuSession,
    parent: string | null,
    pageToken: string | null,
    resumed: boolean,
  ): Promise<ListedPage> {
    const scope = session.locator.scope;
    try {
      return scope.kind === 'wiki'
        ? await this.wikiPage(session, scope.spaceId, parent, pageToken)
        : await this.folderPage(session, parent ?? scope.folderToken, pageToken);
    } catch (error) {
      if (!(error instanceof FeishuApiError) || error.code >= 99_990_000) throw error;
      if (resumed && pageToken !== null) throw new ListingChangedError();
      // A child the app may not list is recorded and passed over, so the rest is read (W14-R10);
      // a refused top of the source is the source's.
      const top = scope.kind === 'wiki' ? null : scope.folderToken;
      if (parent !== null && parent !== top) {
        return {
          items: [],
          next: undefined,
          refused:
            `Feishu would not list the pages under this one (Feishu code ${error.code}, ` +
            `${error.feishuMessage}), so they are not read: add the app to them, or to the ` +
            `${scope.kind === 'wiki' ? 'wiki space as a member' : 'folder'}.`,
        };
      }
      throw listingFailure(scope, error);
    }
  }

  /** One page of a wiki parent's children (the top level for null). */
  private async wikiPage(
    session: FeishuSession,
    spaceId: string,
    parent: string | null,
    pageToken: string | null,
  ): Promise<ListedPage> {
    const data = await this.call(
      session,
      'wiki',
      `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`,
      {
        page_size: '50',
        ...(parent === null ? {} : { parent_node_token: parent }),
        ...(pageToken === null ? {} : { page_token: pageToken }),
      },
    );
    const items = field(data, 'items') ?? [];
    if (!Array.isArray(items)) {
      throw new Error('Feishu listed wiki nodes in a shape day0 does not read.');
    }
    return {
      items: items.map((item: unknown): ListedItem => {
        const ref = text(item, 'node_token');
        if (ref === undefined) return {};
        const shortcut = text(item, 'node_type') === 'shortcut';
        return {
          entry: {
            ref,
            title: text(item, 'title')?.trim() || 'Untitled',
            type: text(item, 'obj_type') ?? 'unknown',
            objToken: text(item, 'obj_token') ?? '',
            shortcut,
            editedAt: secondsToMs(text(item, 'obj_edit_time')),
            url: `https://${BROWSER_HOSTS[session.locator.region]}/wiki/${ref}`,
          },
          // A shortcut's children are listed where the page it points to lives.
          ...(field(item, 'has_child') === true && !shortcut ? { child: ref } : {}),
        };
      }),
      next: nextPageToken(data, 'page_token'),
    };
  }

  /** One page of a Drive folder's files; a folder in it is a child, walked later. */
  private async folderPage(
    session: FeishuSession,
    folder: string,
    pageToken: string | null,
  ): Promise<ListedPage> {
    const data = await this.call(session, 'drive', '/open-apis/drive/v1/files', {
      folder_token: folder,
      page_size: '200',
      // Oldest first by creation, which an edit never changes, so an edit mid-sync moves no
      // file across the walk.
      order_by: 'CreatedTime',
      direction: 'ASC',
      ...(pageToken === null ? {} : { page_token: pageToken }),
    });
    const files = field(data, 'files') ?? [];
    if (!Array.isArray(files)) {
      throw new Error('Feishu listed a folder in a shape day0 does not read.');
    }
    return {
      items: files.map((file: unknown): ListedItem => {
        const ref = text(file, 'token');
        const type = text(file, 'type') ?? 'unknown';
        if (ref === undefined) return {};
        if (type === 'folder') return { child: ref };
        const url = text(file, 'url');
        return {
          entry: {
            ref,
            title: text(file, 'name')?.trim() || 'Untitled',
            type,
            objToken: ref,
            shortcut: type === 'shortcut',
            editedAt: secondsToMs(text(file, 'modified_time')),
            url: url?.startsWith('https://') ? url : undefined,
          },
        };
      }),
      next: nextPageToken(data, 'next_page_token'),
    };
  }

  /**
   * One document as Markdown. Its `revision_id` is then read and logged for
   * wave 15's change check (the store has no field for it yet); a refusal of
   * that read is logged and the page kept, since nothing depends on it.
   */
  private async readDocument(
    session: FeishuSession,
    source: DocSourceRecord,
    entry: ListedEntry,
  ): Promise<DocPage> {
    const content = await this.call(session, 'content', '/open-apis/docs/v1/content', {
      doc_token: entry.objToken,
      doc_type: 'docx',
      content_type: 'markdown',
    });
    const markdown = text(content, 'content');
    if (markdown === undefined) {
      throw new FeishuApiError(0, 200, 'the answer carried no Markdown');
    }
    log.info('feishu document read', {
      sourceId: source._id,
      ref: entry.ref,
      revision: await this.revision(session, entry),
    });
    return {
      sourceId: source._id,
      ref: entry.ref,
      title: entry.title,
      ...(entry.url === undefined ? {} : { url: entry.url }),
      markdown,
      updatedAt: entry.editedAt ?? this.now(),
    };
  }

  /** A document's `revision_id`, or null when Feishu would not say. */
  private async revision(session: FeishuSession, entry: ListedEntry): Promise<number | null> {
    try {
      const document = await this.call(
        session,
        'document',
        `/open-apis/docx/v1/documents/${encodeURIComponent(entry.objToken)}`,
        {},
      );
      const revision = field(field(document, 'document'), 'revision_id');
      return typeof revision === 'number' ? revision : null;
    } catch (error) {
      // Whatever went wrong, the page was read and the revision is kept nowhere yet (W14-R10):
      // logged, never the page's or the batch's failure.
      log.warn('feishu document revision not read', {
        ref: entry.ref,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
          { ...FEISHU_BACKOFF, sleep: this.sleep, deadline: session.deadline },
        );
      } catch (error) {
        if (!(error instanceof FeishuApiError) || error.code < 99_990_000) throw error;
        // A token Feishu stopped honouring before its time is replaced once.
        if (refreshed || !TOKEN_REFUSED.has(error.code)) throw new FeishuAppError(error);
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
        { ...FEISHU_BACKOFF, sleep: this.sleep, deadline: session.deadline },
      );
    } catch (error) {
      if (!(error instanceof FeishuApiError)) throw error;
      throw new Error(
        `Feishu refused the app ID and secret this source uses (Feishu code ${error.code}, ` +
          `${error.feishuMessage}): use Rotate on the source's row to enter the app's current ID ` +
          'and secret.',
        { cause: error },
      );
    }
    const value = text(body, 'tenant_access_token');
    const expire = field(body, 'expire');
    if (value === undefined || typeof expire !== 'number') {
      throw new Error('Feishu answered the token request in a shape day0 does not read.');
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
      throw new FeishuGatewayError(url.host, response.status);
    }
    if (body.code === 0) return body;
    // A server failure is tried again, except a document too large to export, which stays so.
    if (response.status >= 500 && body.code !== CONTENT_TOO_LARGE) {
      throw new FeishuServerError(response.status, body.code);
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

/**
 * The body of a Feishu answer, or undefined when it is not Feishu's JSON.
 *
 * The body is read whole before it is parsed, so a read cut off part way
 * throws as the transport failure it is, for the backoff to try again; only
 * a body that is not Feishu's JSON (a gateway's page) is answered undefined.
 */
async function readBody(response: Response): Promise<FeishuBody | undefined> {
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON (a gateway's page): the caller words the status instead.
    return undefined;
  }
  const code = field(parsed, 'code');
  if (typeof code !== 'number') return undefined;
  return { ...(parsed as Record<string, unknown>), code, msg: text(parsed, 'msg') ?? '' };
}

/**
 * The listing's next page token, or undefined at its end.
 *
 * @throws Error for a page that says more follow and names no token.
 */
function nextPageToken(data: unknown, name: string): string | undefined {
  if (field(data, 'has_more') !== true) return undefined;
  const next = text(data, name);
  if (next === undefined || next === '') throw noNewPageToken();
  return next;
}

/** The refusal for a listing that says more follows and gives no new page token. */
function noNewPageToken(): Error {
  return new Error('Feishu said more of the listing follows but gave no new page token.');
}

/** The refusal for a listing that never ends. */
function endlessListing(): Error {
  return new Error(
    `Feishu kept listing this source past ${MAX_LISTING_REQUESTS.toLocaleString('en-GB')} ` +
      'requests without reaching its end, so day0 stopped; link a smaller wiki space or folder.',
  );
}

/** The refusal for a source past the listing bound. */
function tooManyNodes(): Error {
  return new Error(
    `This Feishu source has more than ${MAX_LISTED_NODES.toLocaleString('en-GB')} pages, the ` +
      'most day0 reads from one source: link a smaller wiki space or a Drive folder.',
  );
}
