/**
 * The Confluence Cloud documentation reader: one space's pages, read through REST v2 as Markdown.
 *
 * It reads as a service account, with a scoped API token sent as a bearer through Atlassian's
 * gateway (`https://api.atlassian.com/ex/confluence/<cloud ID>`, decision X-1): token traffic keeps
 * Confluence's burst limits and stays outside the hourly points a 3LO app shares across tenants
 * (the rate limiting page, read 10 October 2026). The space's pages are listed oldest id first,
 * `current` and `archived` (`GET /wiki/api/v2/spaces/{id}/pages`), with each body in the storage
 * format, which `html-markdown.ts` converts; the next page is the `cursor` of the `Link` header's
 * `next` address. A page's `version.number` is its revision and an archived page says so
 * (`DocPage.nativeStatus`). A 429, or a 503, is waited out for the seconds its `Retry-After`
 * names.
 *
 * Built against the published reference (the v2 OpenAPI, `info.version` 2.0.0); no tenant read
 * yet (`docs/running/reader-confluence.md`).
 */
import type { PageStatus } from '../authority';
import {
  ATLASSIAN_GATEWAY_HOST,
  parseConfluenceCloudLocator,
  type ConfluenceCloudLocator,
} from '../confluence-source';
import type { DocPage, DocSourceRecord } from '../types';
import {
  ListingChangedError,
  type DocumentationReader,
  type ReadPageBatch,
  type UnreadPage,
} from './batch';
import { confluenceStorageToMarkdown, underTitle } from './html-markdown';
import {
  field,
  listField,
  ProviderHttp,
  providerBody,
  textField,
  type ProviderAnswer,
  type ProviderHttpOptions,
} from './provider-http';

/** The provider's name in a sentence. */
const PROVIDER = 'Confluence';

/** The most pages one request lists (the reference's `limit` maximum). */
const MAX_PAGE_LIMIT = 250;

/**
 * The largest listing answer read: a batch of pages with their bodies. A page the store would
 * take is under a mebibyte, so a batch of them is well inside this.
 */
const MAX_LISTING_BYTES = 48 * 1024 * 1024;

/** A cursor this reader made: the space's numeric id, then Confluence's own cursor. */
const CURSOR = /^v2\|(\d+)\|(.+)$/s;

/**
 * What Confluence's word for a page's status says of the page, in Day0's four statuses (K-10).
 * `current` says nothing either way, so a marker, a relation or the source's default still
 * decide; an archived page is archived, and one in the trash is too.
 */
export function confluenceNativeStatus(status: string | undefined): PageStatus | undefined {
  switch (status) {
    case 'archived':
    case 'trashed':
    case 'deleted':
      return 'archived';
    case 'draft':
      return 'draft';
    default:
      return undefined;
  }
}

/** Why the token was refused, with what IT does about it. */
function tokenRefused(answer: ProviderAnswer): Error {
  return new Error(
    `Confluence refused the API token this source uses (HTTP ${answer.status}): it may have expired ` +
      '(a token lasts a year at most) or been revoked. Ask IT to create a new API token for the ' +
      "service account with the scopes reader-confluence.md lists, then use Rotate on the source's " +
      'row to enter it.',
  );
}

/** Why the service account may not make the request, with what IT checks. */
function accountRefused(answer: ProviderAnswer): Error {
  return new Error(
    `Confluence refused this request for the service account (HTTP ${answer.status}): ask IT to ` +
      'check that its API token has the scopes reader-confluence.md lists (read:space:confluence ' +
      'and read:page:confluence), that the service account has access to Confluence, and that it ' +
      'may view the space.',
  );
}

/** One page as either Confluence lists it: what both readers read of it. */
export interface ListedConfluencePage {
  readonly id: string;
  readonly title: string | undefined;
  /** Confluence's word for the page's status. */
  readonly status: string | undefined;
  /** The body in the storage format, when the listing gave one. */
  readonly storage: string | undefined;
  readonly versionNumber: unknown;
  /** When the current version was made, as an ISO time. */
  readonly editedAt: string | undefined;
  /** Where the page opens in a browser. */
  readonly url: string | undefined;
}

/**
 * One listed Confluence page as Markdown under its title, or why it is not read.
 *
 * Shared by the Cloud and the Data Center readers, which list the same page in two shapes.
 *
 * @param now - The clock a page with no version time is stamped with.
 */
export function confluencePage(
  source: DocSourceRecord,
  listed: ListedConfluencePage,
  now: () => number,
): DocPage | UnreadPage {
  const title = listed.title?.trim() || 'Untitled';
  if (listed.storage === undefined) {
    return {
      ref: listed.id,
      reason: `Confluence gave no body in its storage format for "${title}", so Day0 does not read it.`,
    };
  }
  const edited = Date.parse(listed.editedAt ?? '');
  const nativeStatus = confluenceNativeStatus(listed.status);
  return {
    sourceId: source._id,
    ref: listed.id,
    title,
    ...(listed.url === undefined ? {} : { url: listed.url }),
    markdown: underTitle(title, confluenceStorageToMarkdown(listed.storage)),
    updatedAt: Number.isFinite(edited) ? edited : now(),
    ...(nativeStatus === undefined ? {} : { nativeStatus }),
    ...(typeof listed.versionNumber === 'number'
      ? { sourceRevision: String(listed.versionNumber) }
      : {}),
  };
}

/** One page of the listing, as the batch needs it. */
interface ListedPages {
  readonly results: readonly unknown[];
  readonly base: string | undefined;
  readonly next: string | undefined;
}

/** Reader for one space of a Confluence Cloud site, through REST v2. */
export class ConfluenceCloudReader implements DocumentationReader {
  private readonly options: ProviderHttpOptions;

  /** @param options - The fetch, clock and timer; the real ones by default. */
  constructor(options: ProviderHttpOptions = {}) {
    this.options = options;
  }

  /**
   * Read a bounded batch of the space's pages, each as Markdown under its title.
   *
   * @param source - The linked Confluence Cloud source.
   * @param secret - The service account's API token.
   * @param cursor - Where the previous batch left the listing.
   * @param limit - The most pages this batch takes.
   * @throws Error when the token, the cloud ID or the space is refused, or Confluence stays
   *   limited past the waits; ListingChangedError when a kept cursor is refused, so the sync
   *   reads the space again from its first page.
   */
  async listPageBatch(
    source: DocSourceRecord,
    secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<ReadPageBatch> {
    if (secret === undefined) {
      throw new Error(
        "A Confluence Cloud source reads with a service account's API token, and this one has none: use Rotate on the source's row to give one.",
      );
    }
    const locator = parseConfluenceCloudLocator(source.locator);
    // No request spacing is published for token traffic; a burst limit is answered with a wait.
    const http = new ProviderHttp(PROVIDER, 0, this.options);
    const resumed = cursor === undefined ? undefined : CURSOR.exec(cursor);
    if (cursor !== undefined && resumed === null) throw new ListingChangedError();
    const spaceId = resumed?.[1] ?? (await this.spaceId(http, locator, secret));
    const listed = await this.pages(http, locator, secret, spaceId, resumed?.[2], limit);
    const pages: DocPage[] = [];
    const unread: UnreadPage[] = [];
    for (const result of listed.results) {
      const read = this.page(source, result, listed.base);
      if ('markdown' in read) pages.push(read);
      else unread.push(read);
    }
    return {
      pages,
      unread,
      nextCursor: listed.next === undefined ? undefined : `v2|${spaceId}|${listed.next}`,
    };
  }

  /** The numeric id of the space the locator names by key. */
  private async spaceId(
    http: ProviderHttp,
    locator: ConfluenceCloudLocator,
    token: string,
  ): Promise<string> {
    const url = this.address(locator, '/wiki/api/v2/spaces');
    url.searchParams.set('keys', locator.spaceKey);
    url.searchParams.set('limit', '1');
    const answer = await http.send(url, { headers: { authorization: `Bearer ${token}` } });
    const body = providerBody(PROVIDER, answer);
    if (answer.status === 401) throw tokenRefused(answer);
    if (answer.status === 403) throw accountRefused(answer);
    if (answer.status === 404) {
      throw new Error(
        'Atlassian found no Confluence site with this cloud ID (HTTP 404): check that the ' +
          "location uses the site's cloud ID, the string after /s/ in the address of " +
          'admin.atlassian.com, and not the organisation ID. To change it, unlink the source and ' +
          'link it again.',
      );
    }
    const id = textField(listField(accepted(answer, body), 'results')[0], 'id');
    if (id === undefined || !/^\d+$/.test(id)) {
      throw new Error(
        `Confluence found no space with the key "${locator.spaceKey}" that the service account ` +
          'may view: check the key, and ask IT to give the service account View permission in ' +
          'the space.',
      );
    }
    return id;
  }

  /** One page of the space's listing, bodies included. */
  private async pages(
    http: ProviderHttp,
    locator: ConfluenceCloudLocator,
    token: string,
    spaceId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<ListedPages> {
    const url = this.address(locator, `/wiki/api/v2/spaces/${spaceId}/pages`);
    // Archived pages are asked for by name, so one is marked rather than dropped (V15-1).
    url.searchParams.append('status', 'current');
    url.searchParams.append('status', 'archived');
    url.searchParams.set('body-format', 'storage');
    // Oldest id first, which an edit never changes, so an edit mid-walk moves no page across it.
    url.searchParams.set('sort', 'id');
    url.searchParams.set('limit', String(Math.min(limit, MAX_PAGE_LIMIT)));
    if (cursor !== undefined) url.searchParams.set('cursor', cursor);
    const answer = await http.send(url, {
      headers: { authorization: `Bearer ${token}` },
      maxBytes: MAX_LISTING_BYTES,
    });
    const body = providerBody(PROVIDER, answer);
    if (answer.status === 401) throw tokenRefused(answer);
    if (answer.status === 403) throw accountRefused(answer);
    // A cursor an earlier batch kept and Confluence no longer honours: the listing moved on.
    if (cursor !== undefined && (answer.status === 400 || answer.status === 404)) {
      throw new ListingChangedError();
    }
    const results = field(accepted(answer, body), 'results');
    if (!Array.isArray(results)) {
      throw new Error('Confluence listed pages in a shape Day0 does not read.');
    }
    if (results.length > limit) {
      throw new Error(`Confluence listed ${results.length} pages where Day0 asked for ${limit}.`);
    }
    const next = nextCursor(answer, body);
    if (next !== undefined && next === cursor) {
      throw new Error('Confluence said more of the listing follows but gave no new cursor.');
    }
    return { results, base: textField(field(body, '_links'), 'base'), next };
  }

  /** One listed page as Markdown, or why it is not read. */
  private page(
    source: DocSourceRecord,
    result: unknown,
    base: string | undefined,
  ): DocPage | UnreadPage {
    const id = textField(result, 'id');
    if (id === undefined) throw new Error('Confluence listed a page with no id.');
    const version = field(result, 'version');
    const webui = textField(field(result, '_links'), 'webui');
    return confluencePage(
      source,
      {
        id,
        title: textField(result, 'title'),
        status: textField(result, 'status'),
        storage: textField(field(field(result, 'body'), 'storage'), 'value'),
        versionNumber: field(version, 'number'),
        editedAt: textField(version, 'createdAt'),
        url: base?.startsWith('https://') && webui !== undefined ? `${base}${webui}` : undefined,
      },
      this.options.now ?? Date.now,
    );
  }

  /** An address under the gateway for this site. */
  private address(locator: ConfluenceCloudLocator, path: string): URL {
    return new URL(`https://${ATLASSIAN_GATEWAY_HOST}/ex/confluence/${locator.cloudId}${path}`);
  }
}

/**
 * A listing's body, once its answer is a success.
 *
 * @throws Error for an answer that is neither a success nor one of the refusals worded above.
 */
function accepted(answer: ProviderAnswer, body: unknown): unknown {
  if (answer.status >= 200 && answer.status < 300) return body;
  const said = textField(body, 'message') ?? textField(listField(body, 'errors')[0], 'title');
  throw new Error(
    `Confluence answered HTTP ${answer.status}${said === undefined ? '' : ` (${said})`} to a ` +
      'request Day0 expected it to accept. Re-sync to try again; if it repeats, tell the Day0 ' +
      'maintainers what it said.',
  );
}

/**
 * The cursor of the listing's next page: from the `Link` header's `next` address, or the same
 * address in the body's `_links`; undefined at the listing's end.
 *
 * @throws Error for a next address that names no cursor.
 */
function nextCursor(answer: ProviderAnswer, body: unknown): string | undefined {
  const link = /<([^>]+)>\s*;\s*rel="?next"?/.exec(answer.headers.get('link') ?? '')?.[1];
  const next = link ?? textField(field(body, '_links'), 'next');
  if (next === undefined) return undefined;
  const cursor = new URL(next, `https://${ATLASSIAN_GATEWAY_HOST}`).searchParams.get('cursor');
  if (cursor === null || cursor === '') {
    throw new Error('Confluence said more of the listing follows but gave no cursor.');
  }
  return cursor;
}
