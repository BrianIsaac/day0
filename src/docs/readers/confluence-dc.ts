/**
 * The Confluence Data Center documentation reader: one space's pages on the customer's own
 * server, read through its REST API as Markdown (decision X-2).
 *
 * It reads with a personal access token sent as a bearer (Confluence 7.9 and later), and walks
 * `GET /rest/api/content?spaceKey=&type=page&status=current&expand=version` by `start` and
 * `limit` to the listing's end, without the pages' bodies. Then it asks once more with
 * `status=archived`: Data Center's reference documents `current`, `trashed` and `any`, so whether
 * a server lists its archived pages is unverified (V15-1b); one that does has them marked
 * archived, and one that refuses the status is logged and its current pages stand.
 *
 * A listed page stored at the version, the title and the address its listing gives is kept with
 * no body asked for (the reader contract by revision, wave 17), so an unchanged space costs its
 * listings' requests alone. A page that changed is read by its id
 * (`GET /rest/api/content/{id}?expand=body.storage,version`, under the status it was listed
 * with), its body converted from the storage format as the Cloud reader's is.
 *
 * The server is the customer's, so its address is held to the page rules before any request
 * (`page-address.ts`): https on a public host, or a host `DAY0_PRIVATE_HOSTS` lists, dialled at
 * the addresses that were checked.
 *
 * Atlassian ends Data Center on 28 March 2029 (`docs/running/reader-confluence.md`). Built
 * against the published reference (8.9.3); no server read yet.
 */
import { log } from '../../lib/logger';
import {
  parseConfluenceDataCenterLocator,
  type ConfluenceDataCenterLocator,
} from '../confluence-source';
import type { DocPage, DocSourceRecord } from '../types';
import {
  ListingChangedError,
  storedMarks,
  type DocumentationReader,
  type KeptPage,
  type ReadPageBatch,
  type StoredRevisions,
  type UnreadPage,
} from './batch';
import {
  confluencePage,
  goneSinceListed,
  keptConfluencePage,
  type ListedConfluencePage,
} from './confluence-v2';
import { checkPageAddress, pinnedPageFetch } from './page-address';
import {
  AnswerTooLargeError,
  field,
  ProviderHttp,
  providerBody,
  textField,
  type ProviderAnswer,
  type ProviderFetch,
  type ProviderHttpOptions,
} from './provider-http';

/** The provider's name in a sentence. */
const PROVIDER = 'Confluence';

/** The largest answer read: a listing page, or one page with its body. */
const MAX_LISTING_BYTES = 48 * 1024 * 1024;

/** The two walks of a space, in order: its current pages, then its archived ones. */
const PHASES = ['current', 'archived'] as const;

type Phase = (typeof PHASES)[number];

/** A cursor this reader made: the walk, then the `start` of its next page. */
const CURSOR = /^dc\|(current|archived)\|(\d+)$/;

/** A request to the customer's server, at an address checked first and dialled as checked. */
const checkedFetch: ProviderFetch = async (input: URL, init: RequestInit): Promise<Response> =>
  await pinnedPageFetch(await checkPageAddress(input), MAX_LISTING_BYTES)(input, init);

/** One page of a walk. */
interface ListedPages {
  /** How many pages the server listed, whatever of them the walk keeps. */
  readonly count: number;
  readonly results: readonly unknown[];
  readonly base: string | undefined;
  /** Whether the server says more of this walk follows. */
  readonly more: boolean;
  /** Whether the server refused the archived walk (a 4xx on it). */
  readonly refused?: boolean;
}

/** Reader for one space of a Confluence Data Center server. */
export class ConfluenceDataCenterReader implements DocumentationReader {
  private readonly options: ProviderHttpOptions;

  /** @param options - The fetch, clock and timer; the checked fetch and the real ones by default. */
  constructor(options: ProviderHttpOptions = {}) {
    this.options = { ...options, fetch: options.fetch ?? checkedFetch };
  }

  /**
   * Read a bounded batch of the space's pages, each as Markdown under its title.
   *
   * @param source - The linked Confluence Data Center source.
   * @param secret - The personal access token.
   * @param cursor - Where the previous batch left the walk.
   * @param limit - The most pages this batch lists.
   * @param stored - What the sync stored each listed page with; none reads every page.
   * @throws Error when the token, the address or the space is refused, or the server stays
   *   limited past the waits; PageAddressRefusal for an address Day0 does not read from;
   *   ListingChangedError for a cursor that is not this reader's.
   */
  async listPageBatch(
    source: DocSourceRecord,
    secret: string | undefined,
    cursor: string | undefined,
    limit: number,
    stored?: StoredRevisions,
  ): Promise<ReadPageBatch> {
    if (secret === undefined) {
      throw new Error(
        "A Confluence Data Center source reads with a personal access token, and this one has none: use Rotate on the source's row to give one.",
      );
    }
    const locator = parseConfluenceDataCenterLocator(source.locator);
    const http = new ProviderHttp(PROVIDER, 0, this.options);
    const resumed = cursor === undefined ? undefined : CURSOR.exec(cursor);
    if (cursor !== undefined && resumed === null) throw new ListingChangedError();
    if (resumed === undefined) await this.checkSpace(http, locator, secret);
    const phase: Phase = resumed?.[1] === 'archived' ? 'archived' : 'current';
    const start = Number(resumed?.[2] ?? 0);
    const session: Session = { http, locator, token: secret };
    const listed = await this.listing(session, { phase, start, limit });
    const entries = listed.results.map((result) => listedPage(result, listed.base));
    // Asked once a listing page, before any body: what each listed page was stored with.
    const marks = await storedMarks(
      stored,
      entries.map((entry) => entry.id),
    );
    const pages: DocPage[] = [];
    const unread: UnreadPage[] = [];
    const kept: KeptPage[] = [];
    for (const entry of entries) {
      const keep = keptConfluencePage(entry, marks.get(entry.id));
      if (keep !== undefined) {
        kept.push(keep);
        continue;
      }
      const read = await this.page(session, source, entry, { phase, base: listed.base });
      if ('markdown' in read) pages.push(read);
      else unread.push(read);
    }
    return {
      pages,
      unread,
      ...(kept.length > 0 ? { kept } : {}),
      ...(listed.refused === true ? { archivedWalkRefused: true } : {}),
      nextCursor: nextCursor(phase, start, listed),
    };
  }

  /**
   * Check the space is there and the token may view it, so a wrong address or key is said as
   * that rather than read as an empty space.
   */
  private async checkSpace(
    http: ProviderHttp,
    locator: ConfluenceDataCenterLocator,
    token: string,
  ): Promise<void> {
    const url = new URL(`${locator.base}/rest/api/space/${encodeURIComponent(locator.spaceKey)}`);
    const answer = await http.send(url, this.request(token));
    const body = this.ownBody(answer, locator);
    if (answer.status === 404) {
      throw new Error(
        `Confluence found no space with the key "${locator.spaceKey}" at ${locator.base} that ` +
          "the token's owner may view (HTTP 404): check the space's address, with the server's " +
          'context path if it has one. To change it, unlink the source and link it again.',
      );
    }
    accepted(answer, body);
  }

  /**
   * One page of one walk, without the pages' bodies: each entry's version, title, status and
   * address are what a page is kept by.
   */
  private async listing(
    session: Session,
    at: {
      readonly phase: Phase;
      readonly start: number;
      readonly limit: number;
    },
  ): Promise<ListedPages> {
    const { http, locator, token } = session;
    const url = new URL(`${locator.base}/rest/api/content`);
    url.searchParams.set('spaceKey', locator.spaceKey);
    url.searchParams.set('type', 'page');
    url.searchParams.set('status', at.phase);
    url.searchParams.set('expand', 'version');
    url.searchParams.set('start', String(at.start));
    url.searchParams.set('limit', String(at.limit));
    const answer = await http.send(url, { ...this.request(token), maxBytes: MAX_LISTING_BYTES });
    const ended: ListedPages = { count: 0, results: [], base: undefined, more: false };
    // A server that does not list archived pages refuses the status, or the token for it: read
    // before any refusal is worded, since the current pages are stored and stand.
    if (at.phase === 'archived' && answer.status >= 400 && answer.status < 500) {
      log.info('confluence data center does not list archived pages', {
        host: url.host,
        status: answer.status,
      });
      return { ...ended, refused: true };
    }
    const body = this.ownBody(answer, locator);
    const listed = field(accepted(answer, body), 'results');
    if (!Array.isArray(listed)) {
      throw new Error('Confluence listed pages in a shape Day0 does not read.');
    }
    if (listed.length > at.limit) {
      throw new Error(`Confluence listed ${listed.length} pages where Day0 asked for ${at.limit}.`);
    }
    // A server that ignores a status it does not know answers its current pages again: only a
    // page that says it is archived is one, and a page of the walk with none ends it.
    const results =
      at.phase === 'archived'
        ? listed.filter((result: unknown): boolean => textField(result, 'status') === 'archived')
        : listed;
    if (at.phase === 'archived' && results.length === 0) {
      if (listed.length > 0) {
        log.info('confluence data center ignores the archived status', { host: url.host });
      }
      return ended;
    }
    const links = field(body, '_links');
    return {
      count: listed.length,
      results,
      base: textField(links, 'base'),
      // An empty page that says more follows would never end the walk.
      more: textField(links, 'next') !== undefined && listed.length > 0,
    };
  }

  /**
   * One listed page that changed, read by its id as Markdown, or why it is not read.
   *
   * @param at - The walk that listed it, whose status it is found under, and the listing's base
   *   address for a page whose own answer names none.
   */
  private async page(
    session: Session,
    source: DocSourceRecord,
    listed: ListedConfluencePage,
    at: { readonly phase: Phase; readonly base: string | undefined },
  ): Promise<DocPage | UnreadPage> {
    const { http, locator, token } = session;
    const now = this.options.now ?? Date.now;
    const url = new URL(`${locator.base}/rest/api/content/${encodeURIComponent(listed.id)}`);
    url.searchParams.set('expand', 'body.storage,version');
    // The reference's default is `current`: an archived page is found under its own status.
    url.searchParams.set('status', at.phase);
    let answer: ProviderAnswer;
    try {
      answer = await http.send(url, { ...this.request(token), maxBytes: MAX_LISTING_BYTES });
    } catch (error) {
      // A page past what one answer may hold is that page's: the rest of the walk is read (W15-R11).
      if (!(error instanceof AnswerTooLargeError)) throw error;
      return confluencePage(source, { ...listed, oversize: true }, now);
    }
    // A server that lists its archived pages is not known to give one by its id under that
    // status (V15-1b): where it will not, that is this page's, whose last version stands, and
    // the walk goes on. Read before any refusal is worded, as the walk's own refusal is; a 401
    // is never the page's, since it is the token that was refused, and is worded below.
    if (
      at.phase === 'archived' &&
      answer.status >= 400 &&
      answer.status < 500 &&
      answer.status !== 401
    ) {
      log.info('confluence data center lists an archived page and does not give it by id', {
        host: url.host,
        status: answer.status,
      });
      return {
        ref: listed.id,
        reason:
          `Confluence listed "${listed.title?.trim() || 'Untitled'}" among its archived pages and ` +
          `then answered HTTP ${answer.status} for the page itself, so Day0 keeps what it last ` +
          'read of it.',
      };
    }
    const body = this.ownBody(answer, locator);
    if (answer.status === 404) return goneSinceListed(listed);
    const page = accepted(answer, body);
    // As its own answer has the page, which is the body's own version.
    return confluencePage(
      source,
      listedPage(page, textField(field(page, '_links'), 'base') ?? at.base),
      now,
    );
  }

  /** The headers every request carries; a redirect is handed back, never followed. */
  private request(token: string): {
    headers: Record<string, string>;
    redirect: 'manual';
  } {
    return { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' };
  }

  /**
   * An answer's body, once the answer is the server's own and not a refusal of the token.
   *
   * @throws Error for a sign-in redirect, a refused token, or a space the token may not view.
   */
  private ownBody(answer: ProviderAnswer, locator: ConfluenceDataCenterLocator): unknown {
    if (answer.status >= 300 && answer.status < 400) {
      throw new Error(
        `${answer.url.host} answered with a redirect (HTTP ${answer.status}) where its REST API ` +
          'should answer, which is what a sign-in page in front of Confluence does: ask IT to ' +
          `let personal access tokens reach ${new URL(locator.base).pathname.replace(/\/$/, '')}/rest/api ` +
          'without the sign-in redirect.',
      );
    }
    const body = providerBody(PROVIDER, answer);
    if (answer.status === 401) {
      throw new Error(
        `Confluence refused the personal access token this source uses (HTTP ${answer.status}): ` +
          'it may have expired or been revoked. Ask the person it belongs to to create a new one ' +
          'in Confluence (their profile picture, Settings, Personal access tokens), then use ' +
          "Rotate on the source's row to enter it.",
      );
    }
    if (answer.status === 403) {
      throw new Error(
        `Confluence refused this request for the token's owner (HTTP ${answer.status}): ask a ` +
          `space administrator to give that person View permission in the space ${locator.spaceKey}.`,
      );
    }
    return body;
  }
}

/** One connection to the server for a batch. */
interface Session {
  readonly http: ProviderHttp;
  readonly locator: ConfluenceDataCenterLocator;
  readonly token: string;
}

/**
 * One page as the server answers it, in a listing or by id: what the readers read of it.
 *
 * @param base - The server's address the answer names, which a page's own address is under.
 * @throws Error for a page with no id.
 */
function listedPage(result: unknown, base: string | undefined): ListedConfluencePage {
  const id = textField(result, 'id');
  if (id === undefined) throw new Error('Confluence listed a page with no id.');
  const version = field(result, 'version');
  const webui = textField(field(result, '_links'), 'webui');
  return {
    id,
    title: textField(result, 'title'),
    status: textField(result, 'status'),
    storage: textField(field(field(result, 'body'), 'storage'), 'value'),
    versionNumber: field(version, 'number'),
    editedAt: textField(version, 'when'),
    url: base?.startsWith('https://') && webui !== undefined ? `${base}${webui}` : undefined,
  };
}

/**
 * A listing's body, once its answer is a success.
 *
 * @throws Error for an answer that is neither a success nor one of the refusals worded above.
 */
function accepted(answer: ProviderAnswer, body: unknown): unknown {
  if (answer.status >= 200 && answer.status < 300) return body;
  const said = textField(body, 'message');
  throw new Error(
    `Confluence answered HTTP ${answer.status}${said === undefined ? '' : ` (${said})`} to a ` +
      'request Day0 expected it to accept. Re-sync to try again; if it repeats, tell the Day0 ' +
      'maintainers what it said.',
  );
}

/** Where the walk goes after a page: on in its walk, on to the next walk, or nowhere. */
function nextCursor(phase: Phase, start: number, listed: ListedPages): string | undefined {
  if (listed.more) return `dc|${phase}|${start + listed.count}`;
  const next = PHASES[PHASES.indexOf(phase) + 1];
  return next === undefined ? undefined : `dc|${next}|0`;
}
