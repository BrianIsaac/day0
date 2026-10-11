/**
 * The Yuque documentation reader: one repository's documents, read through Yuque's OpenAPI as
 * Markdown.
 *
 * It reads with a token in `X-Auth-Token`, which Yuque gives on a paid plan. The repository's
 * documents are listed by `offset` and `limit` (`GET /api/v2/repos/{group}/{repository}/docs`)
 * to the listing's end, and each document read by its id: its `body` when its `format` is
 * Markdown, its `body_html` converted otherwise; a sheet, a board, a data table or a thread is
 * named unread with its reason. `content_updated_at` is the revision, and a document of `status`
 * 0 is a draft (V15-3, from Yuque's own copy of its spec). Then the repository's deleted
 * documents are listed (`deleted=true`), and each is archived with nothing of its text kept.
 *
 * Yuque allows 5,000 requests an hour, so requests are spaced 720 ms apart, and a 429 is waited
 * out. Built against the published reference; no space read yet
 * (`docs/running/reader-yuque.md`).
 */
import { log } from '../../lib/logger';
import type { PageStatus } from '../authority';
import type { DocPage, DocSourceRecord } from '../types';
import { parseYuqueLocator, type YuqueLocator } from '../yuque-source';
import {
  ListingChangedError,
  type DocumentationReader,
  type ReadPageBatch,
  type UnreadPage,
} from './batch';
import { DocumentConversionError, documentHtmlToMarkdown, underTitle } from './html-markdown';
import {
  AnswerTooLargeError,
  field,
  ProviderHttp,
  providerBody,
  textField,
  type ProviderAnswer,
  type ProviderHttpOptions,
} from './provider-http';

/** The provider's name in a sentence. */
const PROVIDER = 'Yuque';

/** The least time between two requests: 5,000 an hour. */
const REQUEST_SPACING_MS = 720;

/** The largest answer read: one document with its body, or one listing. */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;

/** The most documents one request lists (the spec's `limit` maximum). */
const MAX_PAGE_LIMIT = 100;

/** The two walks of a repository, in order: its documents, then its deleted ones. */
const PHASES = ['live', 'deleted'] as const;

type Phase = (typeof PHASES)[number];

/** A cursor this reader made: the walk, then the offset of its next page. */
const CURSOR = /^yq\|(live|deleted)\|(\d+)$/;

/** What Yuque calls each kind of entry that is not a document. */
const NOT_DOCUMENTS: Readonly<Record<string, string>> = {
  Sheet: 'sheet',
  Table: 'data table',
  Board: 'board',
  Thread: 'thread',
};

/** What an entry's type is called when it is not a document, or undefined for a document. */
function notDocumentNoun(type: string | undefined): string | undefined {
  return type !== undefined && Object.hasOwn(NOT_DOCUMENTS, type) ? NOT_DOCUMENTS[type] : undefined;
}

/** Why an entry that is not a document is not read. */
function notDocument(title: string, noun: string): string {
  return `"${title}" is a Yuque ${noun}, which Day0 does not read: only documents are read.`;
}

/**
 * What Yuque's `status` says of a document: 0 is a draft, and 1, published, says nothing either
 * way. The spec types it a string; a number is read the same.
 */
export function yuqueNativeStatus(status: unknown): PageStatus | undefined {
  return String(status) === '0' ? 'draft' : undefined;
}

/** One connection to Yuque for a batch. */
interface Session {
  readonly http: ProviderHttp;
  readonly locator: YuqueLocator;
  readonly token: string;
}

/** Reader for one Yuque repository. */
export class YuqueReader implements DocumentationReader {
  private readonly options: ProviderHttpOptions;
  private readonly now: () => number;

  /** @param options - The fetch, clock and timer; the real ones by default. */
  constructor(options: ProviderHttpOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * Read a bounded batch of the repository's documents, each as Markdown under its title.
   *
   * @param source - The linked Yuque source.
   * @param secret - The token.
   * @param cursor - Where the previous batch left the walk.
   * @param limit - The most entries this batch takes.
   * @throws Error when the token or the repository is refused, or Yuque stays limited past the
   *   waits; ListingChangedError for a cursor that is not this reader's.
   */
  async listPageBatch(
    source: DocSourceRecord,
    secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<ReadPageBatch> {
    if (secret === undefined) {
      throw new Error(
        "A Yuque source reads with a token, and this one has none: use Rotate on the source's row to give one.",
      );
    }
    const resumed = cursor === undefined ? undefined : CURSOR.exec(cursor);
    if (cursor !== undefined && resumed === null) throw new ListingChangedError();
    const session: Session = {
      http: new ProviderHttp(PROVIDER, REQUEST_SPACING_MS, this.options),
      locator: parseYuqueLocator(source.locator),
      token: secret,
    };
    const phase: Phase = resumed?.[1] === 'deleted' ? 'deleted' : 'live';
    const offset = Number(resumed?.[2] ?? 0);
    const listed = await this.listing(session, phase, offset, Math.min(limit, MAX_PAGE_LIMIT));
    const pages: DocPage[] = [];
    const unread: UnreadPage[] = [];
    for (const entry of listed.entries) {
      const read =
        phase === 'deleted'
          ? this.deleted(source, entry)
          : await this.document(session, source, entry);
      if (read === undefined) continue;
      if ('markdown' in read) pages.push(read);
      else unread.push(read);
    }
    const next = PHASES[PHASES.indexOf(phase) + 1];
    return {
      pages,
      unread,
      nextCursor: listed.more
        ? `yq|${phase}|${offset + listed.count}`
        : next === undefined
          ? undefined
          : `yq|${next}|0`,
    };
  }

  /** One page of one walk's listing. */
  private async listing(
    session: Session,
    phase: Phase,
    offset: number,
    limit: number,
  ): Promise<{
    /** The entries the walk keeps. */
    readonly entries: readonly unknown[];
    /** How many entries Yuque listed, whatever of them the walk keeps. */
    readonly count: number;
    readonly more: boolean;
  }> {
    const { host, group, book } = session.locator;
    const url = this.address(session, '');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('deleted', String(phase === 'deleted'));
    const answer = await this.send(session, url);
    // A token that may not see the deleted view is refused it: read before any refusal is
    // worded, since the live documents are stored and stand.
    if (phase === 'deleted' && answer.status >= 400 && answer.status < 500) {
      log.info('yuque does not list deleted documents for this token', {
        host,
        status: answer.status,
      });
      return { entries: [], count: 0, more: false };
    }
    const body = this.ownBody(answer, session.locator);
    if (answer.status === 404) {
      throw new Error(
        `Yuque found no repository at ${host}/${group}/${book} that the token's owner may read ` +
          '(HTTP 404): check the address. To change it, unlink the source and link it again.',
      );
    }
    const listed = field(accepted(answer, body), 'data');
    if (!Array.isArray(listed)) {
      throw new Error('Yuque listed documents in a shape Day0 does not read.');
    }
    if (listed.length > limit) {
      throw new Error(`Yuque listed ${listed.length} documents where Day0 asked for ${limit}.`);
    }
    // A space that ignores the deleted view answers its live documents again: only an entry
    // that says when it was deleted is one, and a page of the walk with none ends it.
    const entries =
      phase === 'deleted'
        ? listed.filter((entry: unknown): boolean => textField(entry, 'deleted_at') !== undefined)
        : listed;
    if (phase === 'deleted' && entries.length === 0) {
      if (listed.length > 0) log.info('yuque ignores the deleted view', { host });
      return { entries: [], count: 0, more: false };
    }
    const total = field(field(body, 'meta'), 'total');
    const end = offset + listed.length;
    // The listing's own total says whether more follows, where it gives one: a space may answer
    // fewer than were asked for. An empty page ends the walk whatever the total says.
    const more = typeof total === 'number' ? end < total : listed.length === limit;
    return { entries, count: listed.length, more: listed.length > 0 && more };
  }

  /** One listed entry: a document read, or anything else named unread. */
  private async document(
    session: Session,
    source: DocSourceRecord,
    entry: unknown,
  ): Promise<DocPage | UnreadPage | undefined> {
    const id = field(entry, 'id');
    if (typeof id !== 'number' && typeof id !== 'string') return undefined;
    const ref = String(id);
    const title = textField(entry, 'title')?.trim() || 'Untitled';
    const noun = notDocumentNoun(textField(entry, 'type'));
    if (noun !== undefined) return { ref, reason: notDocument(title, noun), kind: 'not-read' };
    let answer: ProviderAnswer;
    try {
      answer = await this.send(session, this.address(session, `/${encodeURIComponent(ref)}`));
    } catch (error) {
      // A document past the bound is that document's: the rest of the listing is read (W15-R11).
      if (!(error instanceof AnswerTooLargeError)) throw error;
      return {
        ref,
        reason: `"${title}" is larger than the ${MAX_ANSWER_BYTES / (1024 * 1024)} MiB Day0 reads of one Yuque document.`,
      };
    }
    const body = this.ownBody(answer, session.locator);
    if (answer.status === 404) {
      return { ref, reason: `"${title}" was deleted or moved in Yuque after it was listed.` };
    }
    const detail = field(accepted(answer, body), 'data');
    const format = textField(detail, 'format');
    if (format === 'lakesheet') {
      return { ref, reason: notDocument(title, 'sheet'), kind: 'not-read' };
    }
    const html = textField(detail, 'body_html');
    let markdown: string | undefined;
    try {
      markdown =
        format === 'markdown'
          ? textField(detail, 'body')
          : html === undefined
            ? undefined
            : documentHtmlToMarkdown(html);
    } catch (error) {
      // A document the converter cannot take is that document's (W15-R9).
      if (!(error instanceof DocumentConversionError)) throw error;
      return { ref, reason: `"${title}" is not read: ${error.message}.` };
    }
    if (markdown === undefined) {
      return { ref, reason: `Yuque gave no body for "${title}", so Day0 does not read it.` };
    }
    const revision =
      textField(detail, 'content_updated_at') ?? textField(entry, 'content_updated_at');
    const edited = Date.parse(revision ?? textField(detail, 'updated_at') ?? '');
    const slug = textField(detail, 'slug') ?? textField(entry, 'slug');
    const nativeStatus = yuqueNativeStatus(field(detail, 'status') ?? field(entry, 'status'));
    const { host, group, book } = session.locator;
    return {
      sourceId: source._id,
      ref,
      title,
      ...(slug === undefined
        ? {}
        : { url: `https://${host}/${group}/${book}/${encodeURIComponent(slug)}` }),
      markdown: underTitle(title, markdown),
      updatedAt: Number.isFinite(edited) ? edited : this.now(),
      ...(nativeStatus === undefined ? {} : { nativeStatus }),
      ...(revision === undefined ? {} : { sourceRevision: revision }),
    };
  }

  /** One deleted document: archived, and nothing of its text kept (decision X-8). */
  private deleted(source: DocSourceRecord, entry: unknown): DocPage | undefined {
    const id = field(entry, 'id');
    if (typeof id !== 'number' && typeof id !== 'string') return undefined;
    if (notDocumentNoun(textField(entry, 'type')) !== undefined) return undefined;
    const title = textField(entry, 'title')?.trim() || 'Untitled';
    const deletedAt = Date.parse(textField(entry, 'deleted_at') ?? '');
    return {
      sourceId: source._id,
      ref: String(id),
      title,
      markdown: underTitle(title, 'This document was deleted in Yuque.'),
      updatedAt: Number.isFinite(deletedAt) ? deletedAt : this.now(),
      nativeStatus: 'archived',
    };
  }

  /** An address under the repository's documents. */
  private address(session: Session, path: string): URL {
    const { host, group, book } = session.locator;
    return new URL(`https://${host}/api/v2/repos/${group}/${book}/docs${path}`);
  }

  /** One request with the token in Yuque's own header. */
  private async send(session: Session, url: URL): Promise<ProviderAnswer> {
    return await session.http.send(url, {
      headers: { 'x-auth-token': session.token },
      maxBytes: MAX_ANSWER_BYTES,
    });
  }

  /**
   * An answer's body, once the answer is Yuque's own and not a refusal of the token.
   *
   * @throws Error for a refused token, or a repository its owner may not read.
   */
  private ownBody(answer: ProviderAnswer, locator: YuqueLocator): unknown {
    const body = providerBody(PROVIDER, answer);
    if (answer.status === 401) {
      throw new Error(
        `Yuque refused the token this source uses (HTTP ${answer.status}): it may have been ` +
          "revoked, or the paid plan that gives API tokens may have lapsed. Ask the token's owner " +
          "to create a new one in Yuque's account settings, with read access to repositories and " +
          "documents, then use Rotate on the source's row to enter it.",
      );
    }
    if (answer.status === 403) {
      throw new Error(
        `Yuque refused this request for the token's owner (HTTP ${answer.status}): ask a ` +
          `repository administrator to give that account read access to ${locator.group}/${locator.book}, ` +
          "and check the token's scope lets it read repositories and documents.",
      );
    }
    return body;
  }
}

/**
 * An answer's body, once it is a success.
 *
 * @throws Error for an answer that is neither a success nor one of the refusals worded above.
 */
function accepted(answer: ProviderAnswer, body: unknown): unknown {
  if (answer.status >= 200 && answer.status < 300) return body;
  const said = textField(body, 'message');
  throw new Error(
    `Yuque answered HTTP ${answer.status}${said === undefined ? '' : ` (${said})`} to a request ` +
      'Day0 expected it to accept. Re-sync to try again; if it repeats, tell the Day0 maintainers ' +
      'what it said.',
  );
}
