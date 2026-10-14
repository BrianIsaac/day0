/**
 * The SharePoint documentation reader: one site's document library and its modern pages, read
 * through Microsoft Graph as Markdown.
 *
 * It reads as the app registration IT made, by client credentials (app-only), in the cloud the
 * site's host names. The library is walked by `driveItem` delta from its start: each
 * `@odata.nextLink` is followed until the `@odata.deltaLink` comes, which ends the walk. The
 * delta link is not kept: a sync lists every page each time, since a page two walks miss is
 * pruned, and the store has no place for a reader's link. A link Graph no longer honours is
 * answered `410 Gone`, and the sync then reads the library again from its start. A Markdown file
 * is read as it is, and a Word document converted where the reader runs (`word.ts`, RM9 (b1)),
 * each through the pre-authenticated address Graph redirects to, which gets no token and is held
 * to the page rules (`page-address.ts`); a file with the `deleted` facet is archived. Then the
 * site's pages (`sitePage`) are listed and each read with its `canvasLayout`: the text web parts'
 * HTML, converted; a page checked out or never published is a draft.
 *
 * Both listings give each entry's revision, so a page stored at the revision its listing gives,
 * under the title and the address its listing gives, is kept with no body asked for (the reader
 * contract by revision, wave 17): an unchanged library costs its listings' requests alone. A
 * file's revision is its `cTag`, which moves with its content only, where the delta item carries
 * one, else its `eTag`, which moves with its metadata too; it is stored marked with which it is
 * (`c:` or `e:`), and the two are never compared (X-1). Graph's reference says the delta leaves
 * `cTag` out for OneDrive for Business on a create or a modify, and only a tenant shows what a
 * SharePoint library sends (V17-2). A site page's revision is its listed `eTag`.
 *
 * Graph's reference lists `Files.Read.All` for the delta and the download and `Sites.Read.All`
 * for the site and its pages, and names `Sites.Selected` for none of them, so a site grant is to
 * be confirmed on the first tenant (V15-2; `docs/running/reader-sharepoint.md`). Built against
 * the published reference; no tenant read yet.
 */
import { log } from '../../lib/logger';
import type { PageStatus } from '../authority';
import {
  MICROSOFT_CLOUDS,
  parseSharePointLocator,
  parseSharePointSecret,
  type SharePointApp,
  type SharePointLocator,
} from '../sharepoint-source';
import type { DocPage, DocSourceRecord } from '../types';
import {
  ListingChangedError,
  storedMarks,
  type DocumentationReader,
  type KeptPage,
  type ReadPageBatch,
  type StoredMark,
  type StoredRevisions,
  type UnreadPage,
} from './batch';
import { markdownPageTitle } from './folder';
import { DocumentConversionError, documentHtmlToMarkdown, underTitle } from './html-markdown';
import { checkPageAddress, PageAddressRefusal, pinnedPageFetch } from './page-address';
import {
  AnswerTooLargeError,
  field,
  listField,
  ProviderHttp,
  providerBody,
  textField,
  type ProviderAnswer,
  type ProviderFetch,
  type ProviderHttpOptions,
  webPageInPlaceOf,
} from './provider-http';
import { storedPageTitle } from './stored-title';
import { MAX_WORD_BYTES, WordDocumentError, wordToMarkdown } from './word';

/** What the reader is given instead of the network, the clock and the timer, for tests. */
export interface SharePointReaderOptions extends ProviderHttpOptions {
  /** Fetches a pre-authenticated download address; the checked, pinned fetch by default. */
  readonly download?: ProviderFetch;
}

/** The provider's name in a sentence. */
const PROVIDER = 'Microsoft Graph';

/** The largest answer read from Graph: one site page with its content, or one listing. */
const MAX_GRAPH_BYTES = 16 * 1024 * 1024;

/** The largest Markdown file read, as the URL reader's page bound. */
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

/** A download from the address Graph named, checked first and dialled as checked. */
const checkedDownload: ProviderFetch = async (input: URL, init: RequestInit): Promise<Response> =>
  await pinnedPageFetch(await checkPageAddress(input), MAX_WORD_BYTES)(input, init);

/** The files the reader reads, by extension, and the most it reads of one. */
const READ_KINDS: Readonly<Record<string, { readonly maxBytes: number; readonly noun: string }>> = {
  md: { maxBytes: MAX_MARKDOWN_BYTES, noun: 'file' },
  docx: { maxBytes: MAX_WORD_BYTES, noun: 'Word document' },
};

/**
 * What each listing is asked for: the fields the reader reads of an entry and no others, so a
 * listing of an unchanged library is small.
 */
const FILE_SELECT =
  'id,name,size,file,folder,deleted,lastModifiedDateTime,webUrl,eTag,cTag,parentReference';
const PAGE_SELECT = 'id,name,title,eTag,lastModifiedDateTime,webUrl,publishingState';

/** The marks a file's revision is stored under: which of Graph's two tags it is (X-1). */
const CONTENT_TAG = 'c:';
const ITEM_TAG = 'e:';

/**
 * A library file's revision as it is stored: its `cTag` where the delta item carries one, else
 * its `eTag`, marked with which it is.
 */
function fileRevision(item: unknown): string | undefined {
  const cTag = textField(item, 'cTag');
  if (cTag !== undefined) return `${CONTENT_TAG}${cTag}`;
  const eTag = textField(item, 'eTag');
  return eTag === undefined ? undefined : `${ITEM_TAG}${eTag}`;
}

/**
 * Whether a file was stored at the revision its delta item gives now.
 *
 * A stored `cTag` is compared with the item's `cTag` and a stored `eTag` with its `eTag`, never
 * one with the other: an item that carries a `cTag` is compared by it alone. A revision with no
 * mark is one 0.20.0 stored, which was always the `cTag`.
 */
function storedAtFileRevision(stored: string, item: unknown): boolean {
  const cTag = textField(item, 'cTag');
  if (cTag !== undefined) return stored === `${CONTENT_TAG}${cTag}` || stored === cTag;
  const eTag = textField(item, 'eTag');
  return eTag !== undefined && stored === `${ITEM_TAG}${eTag}`;
}

/**
 * A delta page's items with every occurrence of an item but its last blanked, each place kept.
 *
 * Graph's reference says the same item may appear more than once in a delta feed and that the
 * last occurrence is the one to use: an earlier one may show the file as it was stored and the
 * last as it is now, and the file is then read once and not also kept.
 */
function lastOccurrences(items: readonly unknown[]): readonly unknown[] {
  const last = new Map<string, number>();
  items.forEach((item, index): void => {
    const id = textField(item, 'id');
    if (id !== undefined) last.set(id, index);
  });
  return items.map((item, index): unknown => {
    const id = textField(item, 'id');
    return id === undefined || last.get(id) === index ? item : undefined;
  });
}

/** An address Graph gives, when it is one a page may carry. */
function httpsAddress(url: string | undefined): string | undefined {
  return url?.startsWith('https://') ? url : undefined;
}

/** The two walks of a site, in order: its library's files, then its pages. */
type Phase = 'files' | 'pages';

/** Where a walk stands between batches. */
interface Walk {
  readonly phase: Phase;
  /** The site's id, as Graph's lookup gave it. */
  readonly siteId: string;
  /** The listing page to ask for; the phase's first when absent. */
  readonly link?: string;
  /** How many of that page's entries earlier batches took. */
  readonly skip: number;
}

/** A cursor this reader made. */
const CURSOR_PREFIX = 'sp:';

/** The walk a cursor continues. */
function walkFromCursor(cursor: string): Walk {
  if (!cursor.startsWith(CURSOR_PREFIX)) throw new ListingChangedError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor.slice(CURSOR_PREFIX.length));
  } catch {
    // Not a cursor this reader made: the sync reads the source again from its start.
    throw new ListingChangedError();
  }
  const phase = textField(parsed, 'phase');
  const siteId = textField(parsed, 'siteId');
  const skip = field(parsed, 'skip');
  if ((phase !== 'files' && phase !== 'pages') || siteId === undefined) {
    throw new ListingChangedError();
  }
  return {
    phase,
    siteId,
    link: textField(parsed, 'link'),
    skip: typeof skip === 'number' && Number.isInteger(skip) && skip > 0 ? skip : 0,
  };
}

/** What a file's extension says it is, for the files the reader names and does not read. */
const UNREAD_KINDS: Readonly<Record<string, string>> = {
  pdf: 'PDF',
  ppt: 'slide deck',
  pptx: 'slide deck',
  doc: 'Word document in the old .doc format',
};

/** A file name's extension, lower-cased, and the name without it. */
function splitName(name: string): { readonly stem: string; readonly extension: string } {
  const dot = name.lastIndexOf('.');
  return dot <= 0
    ? { stem: name, extension: '' }
    : { stem: name.slice(0, dot), extension: name.slice(dot + 1).toLowerCase() };
}

/** A byte count as a reason says it. */
function mebibytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}

/** What Graph's `publishingState.level` says of a page: only a published page says nothing. */
export function sharePointPageStatus(level: string | undefined): PageStatus | undefined {
  return level === undefined || level === 'published' ? undefined : 'draft';
}

/** What each call reads and the application permission Graph's reference lists for it. */
const CALLS = {
  site: { does: 'looking the site up', needs: 'Sites.Read.All' },
  files: {
    does: "reading the site's document library",
    needs: 'Files.Read.All, or Sites.Read.All,',
  },
  pages: { does: "reading the site's pages", needs: 'Sites.Read.All' },
} as const;

/**
 * A Graph answer's body, once the answer is a success.
 *
 * @param call - Which call it answers, for the permission a refusal names.
 * @throws Error for a refusal of the app, worded with what IT grants, or any other failure.
 */
function graphBody(answer: ProviderAnswer, call: keyof typeof CALLS): unknown {
  const body = providerBody(PROVIDER, answer);
  if (answer.status >= 200 && answer.status < 300) return body;
  const code = textField(field(body, 'error'), 'code') ?? 'no code';
  if (answer.status === 401 || answer.status === 403) {
    throw new Error(
      `Microsoft Graph refused the app this call (HTTP ${answer.status}, ${code}): ${CALLS[call].does} ` +
        `needs the application permission ${CALLS[call].needs} with admin consent. Ask IT to check ` +
        'the app registration against reader-sharepoint.md; where it was given Sites.Selected ' +
        'alone, ask them to confirm the site was granted to the app, or to grant Sites.Read.All.',
    );
  }
  throw new Error(
    `Microsoft Graph answered HTTP ${answer.status} (${code}) to a request Day0 expected it to ` +
      'accept. Re-sync to try again; if it repeats, tell the Day0 maintainers what it said.',
  );
}

/** One connection to Graph for a batch: where it is, and the token it reads with. */
interface Session {
  readonly http: ProviderHttp;
  /** The connection downloads go through: no token, and the batch's one budget. */
  readonly download: ProviderHttp;
  readonly locator: SharePointLocator;
  /** Graph's origin in the site's cloud. */
  readonly graph: string;
  readonly token: string;
}

/** Reader for one SharePoint site's document library and pages, through Microsoft Graph. */
export class SharePointReader implements DocumentationReader {
  private readonly options: ProviderHttpOptions;
  private readonly download: ProviderFetch;
  private readonly now: () => number;

  /** @param options - The fetches, clock and timer; the real ones by default. */
  constructor(options: SharePointReaderOptions = {}) {
    this.options = options;
    this.download = options.download ?? checkedDownload;
    this.now = options.now ?? Date.now;
  }

  /**
   * Read a bounded batch of the site: its library's files first, then its pages.
   *
   * @param source - The linked SharePoint source.
   * @param secret - The app registration, joined (`sharePointReaderSecret`).
   * @param cursor - Where the previous batch left the walk.
   * @param limit - The most entries this batch reads; an entry kept by its revision is not one.
   * @param stored - What the sync stored each listed page with; none reads every page.
   * @throws Error when the app or the site is refused, or Graph stays throttled past the waits;
   *   ListingChangedError when Graph no longer honours a kept link (410 Gone), so the sync reads
   *   the site again from its start.
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
        "A SharePoint source reads as an app registration, and this one has none: use Rotate on the source's row to give its tenant ID, client ID and client secret.",
      );
    }
    const locator = parseSharePointLocator(source.locator);
    const app = parseSharePointSecret(secret);
    const resumed = cursor === undefined ? undefined : walkFromCursor(cursor);
    const http = new ProviderHttp(PROVIDER, 0, this.options);
    const session: Session = {
      http,
      download: new ProviderHttp(PROVIDER, 0, { ...this.options, fetch: this.download }),
      locator,
      graph: `https://${MICROSOFT_CLOUDS[locator.cloud].graph}`,
      token: await this.accessToken(http, locator, app),
    };
    const walk: Walk = resumed ?? {
      phase: 'files',
      siteId: await this.siteId(session),
      skip: 0,
    };
    return walk.phase === 'files'
      ? await this.files(session, source, walk, limit, stored)
      : await this.pages(session, source, walk, limit, stored);
  }

  /** An app-only access token for Graph in the site's cloud. */
  private async accessToken(
    http: ProviderHttp,
    locator: SharePointLocator,
    app: SharePointApp,
  ): Promise<string> {
    const cloud = MICROSOFT_CLOUDS[locator.cloud];
    const answer = await http.send(
      new URL(`https://${cloud.login}/${encodeURIComponent(app.tenantId)}/oauth2/v2.0/token`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: app.clientId,
          scope: `https://${cloud.graph}/.default`,
          client_secret: app.clientSecret,
          grant_type: 'client_credentials',
        }).toString(),
      },
    );
    const body = providerBody('Microsoft', answer);
    const token = textField(body, 'access_token');
    if (answer.status === 200 && token !== undefined) return token;
    // Only the error's code and its AADSTS number are said: the description repeats the app's ID.
    const code = textField(body, 'error') ?? `HTTP ${answer.status}`;
    const number = /AADSTS\d+/.exec(textField(body, 'error_description') ?? '')?.[0];
    throw new Error(
      `Microsoft refused the app registration this source reads as (${[code, number].filter(Boolean).join(', ')}): ` +
        "its client secret may have expired or been replaced. Ask IT for the registration's tenant " +
        "ID, client ID and current client secret, then use Rotate on the source's row to enter " +
        'them as tenant ID:client ID:client secret.',
    );
  }

  /** The id of the site the locator names. */
  private async siteId(session: Session): Promise<string> {
    const { host, path } = session.locator;
    const answer = await this.graph(
      session,
      new URL(`${session.graph}/v1.0/sites/${host}${path === '' ? '' : `:${path}`}`),
    );
    if (answer.status === 404) {
      throw new Error(
        `Microsoft Graph found no SharePoint site at ${host}${path} (HTTP 404): check the ` +
          'address. To change it, unlink the source and link it again.',
      );
    }
    const id = textField(graphBody(answer, 'site'), 'id');
    if (id === undefined) throw new Error('Microsoft Graph gave the site no id Day0 can read.');
    return id;
  }

  /** A batch of the library's files, from the delta page the walk stands on. */
  private async files(
    session: Session,
    source: DocSourceRecord,
    walk: Walk,
    limit: number,
    stored: StoredRevisions | undefined,
  ): Promise<ReadPageBatch> {
    const url = this.listing(session, walk, `/drive/root/delta`, limit, FILE_SELECT);
    const answer = await this.graph(session, url);
    if (answer.status === 410) {
      // Graph asks for a fresh enumeration; the sync starts the walk again from its first page.
      log.info('sharepoint delta link no longer honoured', {
        sourceId: source._id,
        code: textField(field(providerBody(PROVIDER, answer), 'error'), 'code'),
      });
      throw new ListingChangedError();
    }
    const body = graphBody(answer, 'files');
    const items = lastOccurrences(listField(body, 'value'));
    // Asked once a listing page, before any body: what each file left to take was stored with.
    const marks = await storedMarks(
      stored,
      items.slice(walk.skip).flatMap((item): string[] => {
        const listed = listedFile(item);
        return listed?.kind === undefined || listed.deleted ? [] : [listed.ref];
      }),
    );
    const taken = await this.take(items, walk.skip, limit, (item) =>
      this.file(session, source, item, marks),
    );
    const next = textField(body, '@odata.nextLink');
    return {
      pages: taken.pages,
      unread: taken.unread,
      ...(taken.kept.length > 0 ? { kept: taken.kept } : {}),
      // A delta page may be empty and still name the next: only the delta link ends the walk.
      nextCursor: cursorAfter(
        walk,
        url,
        taken,
        next,
        { phase: 'pages', siteId: walk.siteId, skip: 0 },
        { followEmpty: true },
      ),
    };
  }

  /** A batch of the site's pages, from the listing page the walk stands on. */
  private async pages(
    session: Session,
    source: DocSourceRecord,
    walk: Walk,
    limit: number,
    stored: StoredRevisions | undefined,
  ): Promise<ReadPageBatch> {
    const url = this.listing(session, walk, '/pages/microsoft.graph.sitePage', limit, PAGE_SELECT);
    const body = graphBody(await this.graph(session, url), 'pages');
    const items = listField(body, 'value');
    const marks = await storedMarks(
      stored,
      items.slice(walk.skip).flatMap((item): string[] => {
        const id = textField(item, 'id');
        return id === undefined ? [] : [`page-${id}`];
      }),
    );
    const taken = await this.take(items, walk.skip, limit, (item) =>
      this.sitePage(session, source, walk.siteId, item, marks),
    );
    const next = textField(body, '@odata.nextLink');
    return {
      pages: taken.pages,
      unread: taken.unread,
      ...(taken.kept.length > 0 ? { kept: taken.kept } : {}),
      nextCursor: cursorAfter(walk, url, taken, next, undefined),
    };
  }

  /**
   * The listing page a walk stands on: the link an earlier batch kept, or the phase's first.
   *
   * @param select - The fields the phase's first page is asked for; a link carries its own.
   * @throws Error for a kept link on another host than Graph's, which gets no token.
   */
  private listing(session: Session, walk: Walk, path: string, limit: number, select: string): URL {
    if (walk.link !== undefined) {
      const link = new URL(walk.link);
      if (link.origin !== session.graph) {
        throw new Error(
          'Microsoft Graph named a next page on another host, which Day0 does not follow.',
        );
      }
      return link;
    }
    const first = new URL(`${session.graph}/v1.0/sites/${walk.siteId}${path}`);
    first.searchParams.set('$top', String(limit));
    first.searchParams.set('$select', select);
    return first;
  }

  /**
   * Read a listing page's entries from where earlier batches stopped, until the batch is full.
   *
   * @param read - Reads one entry: a page, an unread record, an entry kept as stored with no
   *   body read, or nothing for an entry passed over.
   * @returns What was read and kept, and how many of the page's entries are now taken. An entry
   *   kept is no part of the batch's limit, which counts the entries read.
   */
  private async take(
    items: readonly unknown[],
    skip: number,
    limit: number,
    read: (item: unknown) => Promise<DocPage | UnreadPage | Kept | undefined>,
  ): Promise<Taken> {
    const pages: DocPage[] = [];
    const unread: UnreadPage[] = [];
    const kept: KeptPage[] = [];
    let index = skip;
    for (; index < items.length && pages.length + unread.length < limit; index += 1) {
      const result = await read(items[index]);
      if (result === undefined) continue;
      if ('kept' in result) kept.push(result.kept);
      else if ('markdown' in result) pages.push(result);
      else unread.push(result);
    }
    return { pages, unread, kept, taken: index, listed: items.length };
  }

  /**
   * One item of the library: a Markdown file or a Word document read, or kept as stored when its
   * listing gives the revision, the title and the address it was stored with; another document
   * named; anything else passed over.
   */
  private async file(
    session: Session,
    source: DocSourceRecord,
    item: unknown,
    marks: ReadonlyMap<string, StoredMark>,
  ): Promise<DocPage | UnreadPage | Kept | undefined> {
    const listed = listedFile(item);
    if (listed === undefined) return undefined;
    const { id, name, ref, stem, extension, kind } = listed;
    const unreadKind = Object.hasOwn(UNREAD_KINDS, extension) ? UNREAD_KINDS[extension] : undefined;
    if (listed.deleted) {
      // Deleted at its source: archived, and nothing of its text is kept (decision X-8).
      return kind === undefined
        ? undefined
        : {
            sourceId: source._id,
            ref,
            title: stem,
            markdown: underTitle(stem, 'This file was deleted in SharePoint.'),
            // The delta item of a deletion carries no date.
            updatedAt: this.now(),
            datedBySource: false,
            nativeStatus: 'archived',
          };
    }
    if (unreadKind !== undefined) {
      return {
        ref,
        reason: `"${name}" is a ${unreadKind}, which Day0 does not read: from a SharePoint library it reads Markdown files, Word documents (.docx) and the site's own pages.`,
        kind: 'not-read',
      };
    }
    if (kind === undefined) return undefined;
    const edited = Date.parse(textField(item, 'lastModifiedDateTime') ?? '');
    const url = httpsAddress(textField(item, 'webUrl'));
    const mark = marks.get(ref);
    // Unchanged since it was stored, by the delta's own revision and address: no body is asked.
    // A Word document is titled by its name. A Markdown file is titled by its own first heading,
    // which its content's tag covers, or by its name, which its address carries: so it is kept
    // only where the listing gives an address to hold a rename to.
    if (
      mark !== undefined &&
      storedAtFileRevision(mark.revision, item) &&
      mark.url === url &&
      (extension === 'md' ? url !== undefined : mark.title === storedPageTitle(stem))
    ) {
      return { kept: { ref, datedBySource: Number.isFinite(edited) } };
    }
    const size = field(item, 'size');
    if (typeof size === 'number' && size > kind.maxBytes) {
      return {
        ref,
        reason: `"${name}" is ${mebibytes(size)}, larger than the ${mebibytes(kind.maxBytes)} Day0 reads of one ${kind.noun}.`,
      };
    }
    const bytes = await this.content(session, item, { id, name, ...kind });
    if (!(bytes instanceof Uint8Array)) return { ref, reason: bytes.reason };
    const markdown =
      extension === 'md' ? new TextDecoder().decode(bytes) : await wordMarkdown(name, bytes);
    if (typeof markdown !== 'string') return { ref, reason: markdown.reason };
    const revision = fileRevision(item);
    return {
      sourceId: source._id,
      ref,
      // A Markdown file names itself by its first heading; a Word document by its file's name.
      title: extension === 'md' ? markdownPageTitle(markdown, stem) : stem,
      ...(url === undefined ? {} : { url }),
      markdown: extension === 'md' ? markdown : underTitle(stem, markdown),
      updatedAt: Number.isFinite(edited) ? edited : this.now(),
      datedBySource: Number.isFinite(edited),
      ...(revision === undefined ? {} : { sourceRevision: revision }),
    };
  }

  /**
   * A file's bytes, through the pre-authenticated address Graph redirects to.
   *
   * @returns The bytes, or why the file is not read when the failure is the file's own.
   */
  private async content(
    session: Session,
    item: unknown,
    file: {
      readonly id: string;
      readonly name: string;
      readonly maxBytes: number;
      readonly noun: string;
    },
  ): Promise<Uint8Array | { readonly reason: string }> {
    const { id, name } = file;
    const driveId = textField(field(item, 'parentReference'), 'driveId');
    if (driveId === undefined) {
      return { reason: `Microsoft Graph listed "${name}" without the library it is in.` };
    }
    // A file that grew after it was listed is that file's, as one listed too large is.
    const tooLarge = {
      reason: `"${name}" is larger than the ${mebibytes(file.maxBytes)} Day0 reads of one ${file.noun}.`,
    };
    let address: URL | undefined;
    try {
      const answered = await session.http.send(
        new URL(
          `${session.graph}/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}/content`,
        ),
        {
          headers: { authorization: `Bearer ${session.token}` },
          redirect: 'manual',
          maxBytes: file.maxBytes,
        },
      );
      if (answered.status === 404) {
        return { reason: `"${name}" was deleted or moved in SharePoint after it was listed.` };
      }
      // Graph may send the file itself; the reference describes the redirect.
      if (answered.status === 200) {
        return webPageInPlaceOf('SharePoint', answered, name) ?? answered.bytes;
      }
      const location = answered.headers.get('location');
      if (answered.status !== 302 || location === null) {
        graphBody(answered, 'files');
        return { reason: `Microsoft Graph gave no download address for "${name}".` };
      }
      address = new URL(location, answered.url);
      // No token goes to the download address: it is pre-authenticated, and on another host.
      const answer = await session.download.send(address, {
        headers: { accept: '*/*' },
        maxBytes: file.maxBytes,
      });
      if (answer.status !== 200) {
        return {
          reason: `${address.host} answered HTTP ${answer.status} for "${name}"; re-sync to try again.`,
        };
      }
      return webPageInPlaceOf('SharePoint', answer, name) ?? answer.bytes;
    } catch (error) {
      if (error instanceof AnswerTooLargeError) return tooLarge;
      if (address === undefined || !(error instanceof Error)) throw error;
      // The download address carries its own authorisation, so no message repeats it whole.
      const said = error.message.replaceAll(address.href, address.origin);
      // An address Day0 does not read from is this file's refusal; the rest of the library is read.
      if (error instanceof PageAddressRefusal) {
        return { reason: `"${name}" could not be downloaded: ${said}` };
      }
      if (said !== error.message) throw new Error(said);
      throw error;
    }
  }

  /**
   * One listed page of the site: read with its content, or kept as stored when its listing gives
   * the `eTag`, the title and the address it was stored with.
   */
  private async sitePage(
    session: Session,
    source: DocSourceRecord,
    siteId: string,
    listed: unknown,
    marks: ReadonlyMap<string, StoredMark>,
  ): Promise<DocPage | UnreadPage | Kept | undefined> {
    const id = textField(listed, 'id');
    if (id === undefined) return undefined;
    const ref = `page-${id}`;
    const title = (textField(listed, 'title') ?? textField(listed, 'name') ?? 'Untitled').trim();
    const listedTag = textField(listed, 'eTag');
    const listedUrl = httpsAddress(textField(listed, 'webUrl'));
    const listedState = field(listed, 'publishingState');
    const mark = marks.get(ref);
    // Unchanged since it was stored, by the listing's own eTag, title and address: no body is
    // asked. A listing that leaves the publishing state out cannot say whether the page is a
    // draft, and a kept page's status is the listing's: such a page is read.
    if (
      mark !== undefined &&
      listedTag !== undefined &&
      listedState !== undefined &&
      mark.revision === listedTag &&
      mark.title === storedPageTitle(title) &&
      mark.url === listedUrl
    ) {
      const status = sharePointPageStatus(textField(listedState, 'level'));
      const dated = Date.parse(textField(listed, 'lastModifiedDateTime') ?? '');
      return {
        kept: {
          ref,
          ...(status === undefined ? {} : { nativeStatus: status }),
          datedBySource: Number.isFinite(dated),
        },
      };
    }
    const url = new URL(
      `${session.graph}/v1.0/sites/${siteId}/pages/${encodeURIComponent(id)}/microsoft.graph.sitePage`,
    );
    url.searchParams.set('$expand', 'canvasLayout');
    let answer: ProviderAnswer;
    try {
      answer = await this.graph(session, url);
    } catch (error) {
      // A page past the bound is that page's: the rest of the site is read (W15-R11).
      if (!(error instanceof AnswerTooLargeError)) throw error;
      return {
        ref,
        reason: `"${title}" is larger than the ${mebibytes(MAX_GRAPH_BYTES)} Day0 reads of one SharePoint page.`,
      };
    }
    if (answer.status === 404) {
      return { ref, reason: `"${title}" was deleted in SharePoint after it was listed.` };
    }
    const page = graphBody(answer, 'pages');
    let body: string;
    try {
      body = documentHtmlToMarkdown(canvasHtml(field(page, 'canvasLayout')));
    } catch (error) {
      // A page the converter cannot take is that page's (W15-R9).
      if (!(error instanceof DocumentConversionError)) throw error;
      return { ref, reason: `"${title}" is not read: ${error.message}.` };
    }
    const state = field(page, 'publishingState');
    const edited = Date.parse(textField(page, 'lastModifiedDateTime') ?? '');
    // The listing's own address and eTag where it gives them, since they are what the next
    // listing is held against; the page's own otherwise.
    const webUrl = listedUrl ?? httpsAddress(textField(page, 'webUrl'));
    const nativeStatus = sharePointPageStatus(textField(state, 'level'));
    const revision = listedTag ?? textField(page, 'eTag');
    return {
      sourceId: source._id,
      ref,
      title,
      ...(webUrl === undefined ? {} : { url: webUrl }),
      markdown: underTitle(title, body),
      updatedAt: Number.isFinite(edited) ? edited : this.now(),
      datedBySource: Number.isFinite(edited),
      ...(nativeStatus === undefined ? {} : { nativeStatus }),
      ...(revision === undefined ? {} : { sourceRevision: revision }),
    };
  }

  /** One authorised GET to Graph; a redirect is handed back, never followed with the token. */
  private async graph(session: Session, url: URL): Promise<ProviderAnswer> {
    return await session.http.send(url, {
      headers: { authorization: `Bearer ${session.token}` },
      redirect: 'manual',
      maxBytes: MAX_GRAPH_BYTES,
    });
  }
}

/**
 * A Word document's Markdown, or why it is not read.
 *
 * @param name - The file's name, for the reason.
 */
async function wordMarkdown(
  name: string,
  bytes: Uint8Array,
): Promise<string | { readonly reason: string }> {
  let markdown: string;
  try {
    markdown = await wordToMarkdown(bytes);
  } catch (error) {
    if (!(error instanceof WordDocumentError)) throw error;
    return { reason: `"${name}" is not read: ${error.message}.` };
  }
  return markdown.trim() === ''
    ? { reason: `"${name}" has no text Day0 can read: it may hold only pictures.` }
    : markdown;
}

/** A listed entry kept as stored by its revision, its body unread. */
interface Kept {
  readonly kept: KeptPage;
}

/** What a delta item says of a file before anything of it is read. */
interface ListedFile {
  readonly id: string;
  readonly name: string;
  readonly ref: string;
  readonly stem: string;
  readonly extension: string;
  /** What the reader reads of this kind of file; undefined for a kind it does not read. */
  readonly kind: (typeof READ_KINDS)[string] | undefined;
  readonly deleted: boolean;
}

/** A delta item as a file, or undefined for a folder or an item with no id or name. */
function listedFile(item: unknown): ListedFile | undefined {
  const id = textField(item, 'id');
  const name = textField(item, 'name');
  if (id === undefined || name === undefined || field(item, 'folder') !== undefined) {
    return undefined;
  }
  const { stem, extension } = splitName(name);
  return {
    id,
    name,
    ref: `file-${id}`,
    stem,
    extension,
    // By its own property only: an extension may be any word, `constructor` among it.
    kind: Object.hasOwn(READ_KINDS, extension) ? READ_KINDS[extension] : undefined,
    deleted: field(item, 'deleted') !== undefined,
  };
}

/** What one batch took of a listing page. */
interface Taken {
  readonly pages: DocPage[];
  readonly unread: UnreadPage[];
  readonly kept: KeptPage[];
  /** How many of the page's entries are taken, this batch's included. */
  readonly taken: number;
  readonly listed: number;
}

/**
 * The cursor after a batch: the same listing page while it has entries left, the next page when
 * Graph names one, or the walk that follows this one.
 *
 * @param after - The walk to go on to once this one's listing ends; none ends the sync's read.
 * @param options - `followEmpty` for a delta walk, which an empty page does not end.
 * @throws Error for a next link that is the page just read, which would never end.
 */
function cursorAfter(
  walk: Walk,
  url: URL,
  taken: Taken,
  next: string | undefined,
  after: Walk | undefined,
  options: { readonly followEmpty?: boolean } = {},
): string | undefined {
  const cursor = (to: Walk): string => `${CURSOR_PREFIX}${JSON.stringify(to)}`;
  if (taken.taken < taken.listed) return cursor({ ...walk, link: url.href, skip: taken.taken });
  // A delta walk follows its next link whatever the page held, since only the delta link ends it
  // (W15-R30); a listing's empty page ends it. A walk that keeps naming more is stopped by the
  // run's own count of its listings (`listingOverrun`).
  if (next !== undefined && (taken.listed > 0 || options.followEmpty === true)) {
    if (next === url.href) {
      throw new Error('Microsoft Graph named the page just read as the next one.');
    }
    return cursor({ ...walk, link: next, skip: 0 });
  }
  return after === undefined ? undefined : cursor(after);
}

/** The HTML of a page's text web parts, in reading order: each section's columns, then the vertical section. */
function canvasHtml(canvas: unknown): string {
  const webparts = [
    ...listField(canvas, 'horizontalSections').flatMap((section) =>
      listField(section, 'columns').flatMap((column) => listField(column, 'webparts')),
    ),
    ...listField(field(canvas, 'verticalSection'), 'webparts'),
  ];
  // A text web part is the one that carries HTML; an image or a list view carries none.
  return webparts
    .map((webpart) => textField(webpart, 'innerHtml'))
    .filter((html): html is string => html !== undefined)
    .join('\n');
}
