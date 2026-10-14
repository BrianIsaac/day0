/**
 * The Google Drive documentation reader: one folder and the folders under it, read through the
 * Drive API as Markdown (beside the MCP path, which reads through a server the customer runs).
 *
 * It reads as a service account: an assertion signed with the account's key is exchanged for a
 * read-only token (no domain-wide delegation), and the account sees what the folder's owner
 * shared with its address. The token is asked for once a sync: each batch hands it back beside its
 * cursor and the next reads with it while it serves (X-1; wave 18, 18-X). Each folder is listed with `files.list`, `nextPageToken` followed to
 * the list's end, and the folders found are read after it. A Google Doc is exported as
 * `text/markdown`, which Google bounds at 10 MB: a larger one is named unread. A Word document
 * is downloaded and converted where the reader runs (`word.ts`, RM9 (b1)). The file's `version`
 * is its revision, and a file in the bin is read and marked archived.
 *
 * The listing gives each file's `version`, so a file stored at the version, the name and the
 * address its listing gives is kept with no export or download asked for (the reader contract by
 * revision, wave 17): an unchanged folder costs its listings' requests alone. `version` moves
 * with every change on the server, one nobody can see among them (a share, a comment), so it
 * reads a file more often than its text changes and never less.
 *
 * A 403 `userRateLimitExceeded` or `rateLimitExceeded`, or a 429, is backed off with a doubling
 * wait (the quota units of 1 May 2026).
 *
 * Built against the published reference; no project read yet (`docs/running/reader-drive.md`).
 */
import { createSign } from 'node:crypto';
import { parseDriveLocator, parseDriveSecret, type DriveServiceAccount } from '../drive-source';
import type { DocPage, DocSourceRecord } from '../types';
import {
  ListingChangedError,
  storedMarks,
  type DocumentationReader,
  type KeptPage,
  type ReadPageBatch,
  type ReaderToken,
  type StoredMark,
  type StoredRevisions,
  type UnreadPage,
} from './batch';
import { underTitle } from './html-markdown';
import {
  AnswerTooLargeError,
  answerText,
  field,
  listField,
  ProviderHttp,
  providerBody,
  textField,
  type ProviderAnswer,
  type ProviderHttpOptions,
  webPageInPlaceOf,
} from './provider-http';
import { BatchToken, issuedToken, type IssuedToken } from './reader-token';
import { holdsListedTitle } from './stored-title';
import { MAX_WORD_BYTES, WordDocumentError, wordToMarkdown } from './word';

/** The provider's name in a sentence. */
const PROVIDER = 'Google Drive';

/** Where the Drive API and Google's token endpoint answer. */
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** The one scope the reader asks for. */
const READ_ONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/** The most Google exports of one document, and a margin for the answer around it. */
const MAX_EXPORT_BYTES = 10 * 1024 * 1024 + 64 * 1024;

/** The most folders one source walks: past this it is linked by a smaller folder. */
const MAX_FOLDERS = 2_000;

/** The MIME types the reader lists, by what each is to it. */
const MIME = {
  document: 'application/vnd.google-apps.document',
  word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  folder: 'application/vnd.google-apps.folder',
} as const;

/** The files the reader lists so it can say it does not read them. */
const UNREAD_KINDS: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.presentation': 'slide deck',
  'application/pdf': 'PDF',
  'application/msword': 'Word document in the old .doc format',
};

/** The fields asked of each listed file. */
const FILE_FIELDS = 'id,name,mimeType,trashed,version,modifiedTime,webViewLink,size';

/** Where a walk stands between batches: the folders still to list, and the page of the first. */
interface Walk {
  readonly queue: readonly string[];
  readonly pageToken?: string;
  /** How many folders the walk has met, the first included. */
  readonly folders: number;
}

/** A cursor this reader made. */
const CURSOR_PREFIX = 'gd:';

/** The walk a cursor continues. */
function walkFromCursor(cursor: string): Walk {
  if (!cursor.startsWith(CURSOR_PREFIX)) throw new ListingChangedError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor.slice(CURSOR_PREFIX.length));
  } catch {
    // Not a cursor this reader made: the sync reads the folder again from its start.
    throw new ListingChangedError();
  }
  const queue = listField(parsed, 'queue').filter(
    (id): id is string => typeof id === 'string' && id !== '',
  );
  const folders = field(parsed, 'folders');
  if (queue.length === 0 || typeof folders !== 'number') throw new ListingChangedError();
  return { queue, pageToken: textField(parsed, 'pageToken'), folders };
}

/** The reason word of a Drive error body: `error.errors[0].reason`. */
function reasonOf(body: unknown): string | undefined {
  return textField(listField(field(body, 'error'), 'errors')[0], 'reason');
}

/** Whether an answer is Drive's "not now": a quota or rate limit under 403. */
function isRateLimited(answer: ProviderAnswer): boolean {
  if (answer.status !== 403) return false;
  let body: unknown;
  try {
    body = JSON.parse(answerText(answer));
  } catch {
    // Not Drive's JSON: not a rate limit, and worded by whoever reads the answer.
    return false;
  }
  const reason = reasonOf(body);
  return reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded';
}

/** Base64url of text or bytes. */
function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** One connection to Drive for a batch. */
interface Session {
  readonly http: ProviderHttp;
  readonly account: DriveServiceAccount;
  readonly token: BatchToken;
}

/** Reader for one Google Drive folder and the folders under it. */
export class GoogleDriveReader implements DocumentationReader {
  private readonly options: ProviderHttpOptions;
  private readonly now: () => number;

  /** @param options - The fetch, clock and timer; the real ones by default. */
  constructor(options: ProviderHttpOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * Read a bounded batch of the folder: one listing page's documents, each as Markdown.
   *
   * @param source - The linked Google Drive source.
   * @param secret - The service account's JSON key.
   * @param cursor - Where the previous batch left the walk.
   * @param limit - The most entries this batch lists.
   * @param stored - What the sync stored each listed file with; none reads every file.
   * @param token - The token an earlier batch of this sync handed back; while it serves, the
   *   batch signs in with no request of its own (X-1).
   * @returns The batch, with the token it signed in for where it asked for one.
   * @throws Error when the key or the folder is refused, or Drive stays limited past the waits;
   *   ListingChangedError for a cursor that is not this reader's, or a page token Drive no longer
   *   honours.
   */
  async listPageBatch(
    source: DocSourceRecord,
    secret: string | undefined,
    cursor: string | undefined,
    limit: number,
    stored?: StoredRevisions,
    token?: ReaderToken,
  ): Promise<ReadPageBatch> {
    if (secret === undefined) {
      throw new Error(
        "A Google Drive source reads as a service account, and this one has no key: use Rotate on the source's row to paste the service account's JSON key.",
      );
    }
    const locator = parseDriveLocator(source.locator);
    const account = parseDriveSecret(secret);
    const resumed = cursor === undefined ? undefined : walkFromCursor(cursor);
    const http = new ProviderHttp(PROVIDER, 0, this.options);
    const session: Session = {
      http,
      account,
      token: await BatchToken.open({
        handed: token,
        now: this.now,
        ask: async (): Promise<IssuedToken> => await this.accessToken(http, account),
        provider: PROVIDER,
        sourceId: source._id,
      }),
    };
    if (resumed === undefined) await this.checkFolder(session, locator.folderId);
    const walk: Walk = resumed ?? { queue: [locator.folderId], folders: 1 };
    const listed = await this.listing(session, walk, limit);
    // Asked once a listing page, before any body: what each listed document was stored with.
    const marks = await storedMarks(
      stored,
      listed.files.flatMap((file): string[] => {
        const id = textField(file, 'id');
        return id === undefined || !isDocument(textField(file, 'mimeType')) ? [] : [id];
      }),
    );
    const pages: DocPage[] = [];
    const unread: UnreadPage[] = [];
    const kept: KeptPage[] = [];
    const found: string[] = [];
    for (const file of listed.files) {
      const id = textField(file, 'id');
      if (id === undefined) continue;
      if (textField(file, 'mimeType') === MIME.folder) {
        found.push(id);
        continue;
      }
      const keep = keptFile(file, id, marks.get(id));
      if (keep !== undefined) {
        kept.push(keep);
        continue;
      }
      const read = await this.file(session, source, file, id);
      if ('markdown' in read) pages.push(read);
      else unread.push(read);
    }
    return {
      pages,
      unread,
      ...(kept.length > 0 ? { kept } : {}),
      nextCursor: cursorAfter(walk, listed.nextPageToken, found),
      ...handedBack(session.token),
    };
  }

  /**
   * A read-only access token for the service account, from an assertion it signs, with the
   * lifetime Google gave it.
   */
  private async accessToken(
    http: ProviderHttp,
    account: DriveServiceAccount,
  ): Promise<IssuedToken> {
    const issued = Math.floor(this.now() / 1_000);
    const unsigned = [
      base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
      base64url(
        JSON.stringify({
          iss: account.clientEmail,
          scope: READ_ONLY_SCOPE,
          aud: TOKEN_ENDPOINT,
          iat: issued,
          exp: issued + 3_600,
        }),
      ),
    ].join('.');
    let signature: string;
    try {
      signature = base64url(createSign('RSA-SHA256').update(unsigned).sign(account.privateKey));
    } catch {
      // The key's own text is in the failure, so nothing of it is repeated.
      throw new Error(
        "Day0 could not sign with the private key in this source's service account key: paste " +
          "the JSON key file whole, as Google Cloud downloaded it, with Rotate on the source's row.",
      );
    }
    const answer = await http.send(new URL(TOKEN_ENDPOINT), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }).toString(),
    });
    const body = providerBody('Google', answer);
    const token = textField(body, 'access_token');
    if (answer.status === 200 && token !== undefined) {
      return issuedToken(token, field(body, 'expires_in'), this.now());
    }
    throw new Error(
      `Google refused the service account key this source uses (${textField(body, 'error') ?? `HTTP ${answer.status}`}): ` +
        'the key may have been deleted, or the service account disabled. Ask IT to create a new ' +
        `JSON key for ${account.clientEmail} in Google Cloud, then use Rotate on the source's row ` +
        'to paste it.',
    );
  }

  /** Check the folder is there and shared with the service account, so a wrong one is said as that. */
  private async checkFolder(session: Session, folderId: string): Promise<void> {
    const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(folderId)}`);
    url.searchParams.set('fields', 'id,name,mimeType,trashed');
    url.searchParams.set('supportsAllDrives', 'true');
    const answer = await this.drive(session, url);
    if (answer.status === 404) {
      throw new Error(
        'Google Drive found no folder at this address that the service account may read (HTTP ' +
          `404): share the folder with ${session.account.clientEmail} as a Viewer, and check the ` +
          'address. To change the address, unlink the source and link it again.',
      );
    }
    const folder = accepted(answer);
    if (textField(folder, 'mimeType') !== MIME.folder) {
      throw new Error(
        'This Google Drive address is a file, not a folder: link the folder the documents are ' +
          'in. To change the address, unlink the source and link it again.',
      );
    }
  }

  /** One page of the listing of the folder at the head of the walk. */
  private async listing(
    session: Session,
    walk: Walk,
    limit: number,
  ): Promise<{ readonly files: readonly unknown[]; readonly nextPageToken: string | undefined }> {
    const kinds = [MIME.document, MIME.word, MIME.folder, ...Object.keys(UNREAD_KINDS)];
    const url = new URL(`${DRIVE_API}/files`);
    // A file in the bin is listed too, so it is marked archived rather than dropped.
    url.searchParams.set(
      'q',
      `'${walk.queue[0]}' in parents and (${kinds.map((kind) => `mimeType = '${kind}'`).join(' or ')})`,
    );
    url.searchParams.set('pageSize', String(limit));
    url.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (walk.pageToken !== undefined) url.searchParams.set('pageToken', walk.pageToken);
    const answer = await this.drive(session, url);
    // A page token an earlier batch kept and Drive no longer honours: the listing moved on.
    if (walk.pageToken !== undefined && answer.status === 400) throw new ListingChangedError();
    const body = accepted(answer);
    const files = field(body, 'files');
    if (!Array.isArray(files)) {
      throw new Error('Google Drive listed files in a shape Day0 does not read.');
    }
    const counted = files.filter((file) => textField(file, 'mimeType') !== MIME.folder).length;
    if (counted > limit) {
      throw new Error(`Google Drive listed ${counted} files where Day0 asked for ${limit}.`);
    }
    const nextPageToken = textField(body, 'nextPageToken');
    if (nextPageToken !== undefined && nextPageToken === walk.pageToken) {
      throw new Error('Google Drive said more of the listing follows but gave no new page token.');
    }
    return { files, nextPageToken };
  }

  /** One listed file: a document read, or anything else named unread. */
  private async file(
    session: Session,
    source: DocSourceRecord,
    file: unknown,
    id: string,
  ): Promise<DocPage | UnreadPage> {
    const name = textField(file, 'name')?.trim() || 'Untitled';
    const mimeType = textField(file, 'mimeType') ?? '';
    const unreadKind = Object.hasOwn(UNREAD_KINDS, mimeType) ? UNREAD_KINDS[mimeType] : undefined;
    if (unreadKind !== undefined) {
      return {
        ref: id,
        reason: `"${name}" is a ${unreadKind}, which Day0 does not read: from a Google Drive folder it reads Google Docs and Word documents (.docx).`,
        kind: 'not-read',
      };
    }
    const isWord = mimeType === MIME.word;
    const title = documentTitle(file);
    const markdown = isWord
      ? await this.word(session, file, id, name)
      : await this.exported(session, id, name);
    if (typeof markdown !== 'string') return { ref: id, reason: markdown.reason };
    const edited = Date.parse(textField(file, 'modifiedTime') ?? '');
    const url = documentAddress(file);
    const version = field(file, 'version');
    return {
      sourceId: source._id,
      ref: id,
      title,
      ...(url === undefined ? {} : { url }),
      markdown: underTitle(title, markdown),
      updatedAt: Number.isFinite(edited) ? edited : this.now(),
      datedBySource: Number.isFinite(edited),
      ...(field(file, 'trashed') === true ? { nativeStatus: 'archived' as const } : {}),
      ...(typeof version === 'string' || typeof version === 'number'
        ? { sourceRevision: String(version) }
        : {}),
    };
  }

  /** A Google Doc as Markdown, or why it is not read. */
  private async exported(
    session: Session,
    id: string,
    name: string,
  ): Promise<string | { readonly reason: string }> {
    const tooLarge = {
      reason: `"${name}" is larger than the 10 MB Google exports, so Day0 does not read it.`,
    };
    const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(id)}/export`);
    url.searchParams.set('mimeType', 'text/markdown');
    let answer: ProviderAnswer;
    try {
      answer = await this.drive(session, url, MAX_EXPORT_BYTES);
    } catch (error) {
      if (error instanceof AnswerTooLargeError) return tooLarge;
      throw error;
    }
    if (answer.status === 200)
      return webPageInPlaceOf(PROVIDER, answer, name) ?? answerText(answer);
    const reason = reasonOf(providerBody(PROVIDER, answer));
    if (reason === 'exportSizeLimitExceeded') return tooLarge;
    return fileRefusal(answer, name, reason);
  }

  /** A Word document as Markdown, or why it is not read. */
  private async word(
    session: Session,
    file: unknown,
    id: string,
    name: string,
  ): Promise<string | { readonly reason: string }> {
    const size = Number(field(file, 'size'));
    if (Number.isFinite(size) && size > MAX_WORD_BYTES) {
      return {
        reason: `"${name}" is ${Math.ceil(size / (1024 * 1024))} MiB, larger than the ${MAX_WORD_BYTES / (1024 * 1024)} MiB Day0 reads of one Word document.`,
      };
    }
    const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(id)}`);
    url.searchParams.set('alt', 'media');
    url.searchParams.set('supportsAllDrives', 'true');
    let answer: ProviderAnswer;
    try {
      answer = await this.drive(session, url, MAX_WORD_BYTES);
    } catch (error) {
      // A file that grew after it was listed is that file's, as one listed too large is.
      if (!(error instanceof AnswerTooLargeError)) throw error;
      return {
        reason: `"${name}" is larger than the ${MAX_WORD_BYTES / (1024 * 1024)} MiB Day0 reads of one Word document.`,
      };
    }
    if (answer.status !== 200) {
      return fileRefusal(answer, name, reasonOf(providerBody(PROVIDER, answer)));
    }
    const page = webPageInPlaceOf(PROVIDER, answer, name);
    if (page !== undefined) return page;
    let markdown: string;
    try {
      markdown = await wordToMarkdown(answer.bytes);
    } catch (error) {
      if (!(error instanceof WordDocumentError)) throw error;
      return { reason: `"${name}" is not read: ${error.message}.` };
    }
    return markdown.trim() === ''
      ? { reason: `"${name}" has no text Day0 can read: it may hold only pictures.` }
      : markdown;
  }

  /** One authorised GET to Drive, a rate limit under 403 waited out as one under 429 is. */
  private async drive(session: Session, url: URL, maxBytes?: number): Promise<ProviderAnswer> {
    const send = async (): Promise<ProviderAnswer> =>
      await session.http.send(url, {
        headers: { authorization: `Bearer ${session.token.bearer}` },
        limited: isRateLimited,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      });
    const answer = await send();
    // A token an earlier batch handed back and Google refuses is asked for again, once (X-1).
    return answer.status === 401 && (await session.token.renew()) ? await send() : answer;
  }
}

/** The token a batch hands back beside its cursor, as the batch's field, where it has one. */
function handedBack(token: BatchToken): { readonly token?: ReaderToken } {
  const handBack = token.handBack();
  return handBack === undefined ? {} : { token: handBack };
}

/** Whether a listed file is one the reader reads: a Google Doc or a Word document. */
function isDocument(mimeType: string | undefined): boolean {
  return mimeType === MIME.document || mimeType === MIME.word;
}

/** A listed document's title: its name, a Word document's without its extension. */
function documentTitle(file: unknown): string {
  const name = textField(file, 'name')?.trim() || 'Untitled';
  return textField(file, 'mimeType') === MIME.word ? name.replace(/\.docx$/i, '') : name;
}

/** Where a listed document opens in a browser, when Drive gives an address a page may carry. */
function documentAddress(file: unknown): string | undefined {
  const url = textField(file, 'webViewLink');
  return url?.startsWith('https://') ? url : undefined;
}

/**
 * A listed document kept as stored, or undefined for one to export or download.
 *
 * It is kept when the sync stored it at the `version` its listing gives, under the title its
 * listing gives (`holdsListedTitle`: by its keyed hash, else as the store writes it) and at the
 * address its listing gives: a move to the bin that leaves the version is kept and marked
 * archived. A listing that gives no version for a file, or does not say whether it is in the bin
 * (which a kept page's status is read from), has it read as before.
 *
 * @param mark - What the sync stored the document with; undefined for one it does not answer for.
 */
function keptFile(file: unknown, id: string, mark: StoredMark | undefined): KeptPage | undefined {
  if (mark === undefined || !isDocument(textField(file, 'mimeType'))) return undefined;
  const version = field(file, 'version');
  const trashed = field(file, 'trashed');
  if (typeof version !== 'string' && typeof version !== 'number') return undefined;
  if (typeof trashed !== 'boolean') return undefined;
  if (mark.revision !== String(version)) return undefined;
  if (!holdsListedTitle(mark, documentTitle(file))) return undefined;
  if (mark.url !== documentAddress(file)) return undefined;
  return {
    ref: id,
    ...(trashed ? { nativeStatus: 'archived' as const } : {}),
    datedBySource: Number.isFinite(Date.parse(textField(file, 'modifiedTime') ?? '')),
  };
}

/**
 * A Drive answer's body, once the answer is a success.
 *
 * @throws Error for a refusal of the project or the account, worded with what IT does.
 */
function accepted(answer: ProviderAnswer): unknown {
  const body = providerBody(PROVIDER, answer);
  if (answer.status >= 200 && answer.status < 300) return body;
  const reason = reasonOf(body) ?? 'no reason given';
  if (reason === 'accessNotConfigured') {
    throw new Error(
      `Google Drive refused this request (HTTP ${answer.status}, ${reason}): the Google Drive API ` +
        "is not enabled in the service account's Google Cloud project. Ask IT to enable it there " +
        '(APIs and services, Library, Google Drive API).',
    );
  }
  throw new Error(
    `Google Drive answered HTTP ${answer.status} (${reason}) to a request Day0 expected it to ` +
      'accept. Re-sync to try again; if it repeats, tell the Day0 maintainers what it said.',
  );
}

/** Why one file was not given, when the refusal is the file's own. */
function fileRefusal(
  answer: ProviderAnswer,
  name: string,
  reason: string | undefined,
): { readonly reason: string } {
  if (answer.status === 404) {
    return { reason: `"${name}" was deleted or moved in Google Drive after it was listed.` };
  }
  if (answer.status !== 403) accepted(answer);
  return {
    reason:
      `Google Drive would not give "${name}" (HTTP ${answer.status}, ${reason ?? 'no reason given'}). ` +
      "Re-sync to try again; if it repeats, ask the document's owner whether viewers may download it.",
  };
}

/**
 * The cursor after a batch: the same folder's next page, or the next folder in the queue with
 * the folders this page found behind it; undefined once no folder is left.
 *
 * @throws Error past `MAX_FOLDERS`.
 */
function cursorAfter(
  walk: Walk,
  nextPageToken: string | undefined,
  found: readonly string[],
): string | undefined {
  const folders = walk.folders + found.length;
  if (folders > MAX_FOLDERS) {
    throw new Error(
      `This Google Drive folder holds more than ${MAX_FOLDERS.toLocaleString('en-GB')} folders, ` +
        'the most Day0 walks from one source: link a smaller folder.',
    );
  }
  const queue =
    nextPageToken === undefined ? [...walk.queue.slice(1), ...found] : [...walk.queue, ...found];
  if (queue.length === 0) return undefined;
  const next: Walk = {
    queue,
    ...(nextPageToken === undefined ? {} : { pageToken: nextPageToken }),
    folders,
  };
  return `${CURSOR_PREFIX}${JSON.stringify(next)}`;
}
