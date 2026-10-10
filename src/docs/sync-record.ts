/**
 * The record a documentation sync run keeps of the pages it could not read.
 *
 * A page one sync cannot read keeps its last stored version (P5-11), and the
 * run says which pages those were, so the operator can see why a page did not
 * change. The record lives on the run's own `unread` field: a count of every
 * such page and `MAX_UNREAD_LISTED` of them by name, each reason on one
 * bounded line. The source's line on the documentation page carries the same
 * record on one line. The run's `reason` says only why it ended short, so a
 * rewrite of the reason never touches the record (D D1 (a)).
 *
 * Two kinds of page are in the record, and it keeps them apart (W14-R40): a
 * page a read failed on (forbidden, too large, gone), which keeps its last
 * version and is read again; and a page of a kind Day0 does not read (a
 * sheet, a slide deck, a PDF), which no sync will read. The failures are
 * named first, so a wiki's sheets never hide its one forbidden document behind
 * "and N more", and only a failure is said to be read again. The record's
 * shape holds no kind, so a reason says which it is: a reader words a kind it
 * does not read with `which Day0 does not read` (`isKindNotRead`).
 *
 * Releases before 0.6.0 wrote the record as text below the reason; the
 * `sync-runs-unread` migration moved each onto the field at 0.6.0, and from
 * 0.16.0 only that migration reads the text.
 */

import type { UnreadPage } from './readers/batch';

/** The most unread pages a record names; the rest are counted. */
export const MAX_UNREAD_LISTED = 10;

/** The longest a page's reference or reason in a record may be. */
const MAX_RECORD_LINE = 240;

/**
 * The pages a sync run could not read: how many, and some of them by name, a failed read ahead
 * of a kind Day0 does not read.
 */
export interface UnreadRecord {
  readonly count: number;
  readonly pages: UnreadPage[];
}

/** The record fields of a run, as a run row carries them. */
export interface RunRecordFields {
  readonly unread?: UnreadRecord;
  readonly reason?: string;
}

/**
 * Whether a page's reason says the page is of a kind Day0 does not read, rather than that a read
 * of it failed. Every reader words such a page with the clause this looks for.
 *
 * @param reason - A page's reason, as its reader wrote it.
 */
export function isKindNotRead(reason: string): boolean {
  return /\bwhich day0 does not read\b/i.test(reason);
}

/**
 * A page's reason on one bounded line that still says which kind of reason it is: a long name
 * in front of "which Day0 does not read" is cut, never the clause, since the record reads the
 * clause back to tell a kind from a failure.
 */
function reasonLine(reason: string): string {
  const line = recordLine(reason);
  if (!isKindNotRead(reason) || isKindNotRead(line)) return line;
  const whole = reason.replace(/\s+/g, ' ').trim();
  const clause = whole.slice(whole.search(/\bwhich day0 does not read\b/i));
  const kept = clause.length > 120 ? `${clause.slice(0, 117)}...` : clause;
  return `${whole.slice(0, MAX_RECORD_LINE - kept.length - 4)}... ${kept}`;
}

/**
 * Text on one bounded line, so a failure's own line breaks never read as
 * more than one line of the record (review, adversarial pass). Callers
 * redact first: a secret cut across the bound would no longer match its
 * redaction.
 */
export function recordLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_RECORD_LINE ? `${line.slice(0, MAX_RECORD_LINE - 3)}...` : line;
}

/** The header for a count of unread pages. */
function header(count: number): string {
  return count === 1
    ? '1 page could not be read this sync and keeps its last stored version'
    : `${count} pages could not be read this sync and keep their last stored version`;
}

/**
 * Add a batch's unread pages to a run's record.
 *
 * @param record - The run's record so far, or nothing.
 * @param unread - The pages this batch could not read, their reasons redacted.
 * @returns The record counting every page and naming at most `MAX_UNREAD_LISTED`, each on one
 *   bounded line, the pages a read failed on ahead of the pages of a kind Day0 does not read; or
 *   the record unchanged when the batch read every page.
 */
export function withUnreadPages(
  record: UnreadRecord | undefined,
  unread: readonly UnreadPage[],
): UnreadRecord | undefined {
  if (unread.length === 0) return record;
  const seen = [
    ...(record?.pages ?? []),
    ...unread.map(
      (page): UnreadPage => ({ ref: recordLine(page.ref), reason: reasonLine(page.reason) }),
    ),
  ];
  const pages = [
    ...seen.filter((page): boolean => !isKindNotRead(page.reason)),
    ...seen.filter((page): boolean => isKindNotRead(page.reason)),
  ].slice(0, MAX_UNREAD_LISTED);
  return { count: (record?.count ?? 0) + unread.length, pages };
}

/**
 * The record on one line, for the source's status on the documentation page.
 *
 * @param record - A completed run's record, or nothing.
 * @param nothingStored - Whether the source holds no page at all, so no page keeps a last version
 *   (W14-R11).
 * @returns The line, or undefined when the run read every page.
 */
export function unreadPagesLine(
  record: UnreadRecord | undefined,
  nothingStored = false,
): string | undefined {
  if (record === undefined || record.count === 0) return undefined;
  const failed = record.pages.filter((page): boolean => !isKindNotRead(page.reason));
  const kinds = record.pages.filter((page): boolean => isKindNotRead(page.reason));
  // Failures take the named places first, so while a page of a kind is still named every
  // failure is: the failures are then counted exactly, and the rest of the count is kinds.
  // Once ten failures fill the list no kind is named and the record holds no count of them, so
  // the pages it does not name are counted with the failures, as every page was before.
  const failures = kinds.length > 0 ? failed.length : record.count;
  const kindCount = record.count - failures;
  const unnamed = record.count - record.pages.length;
  const named = (pages: readonly UnreadPage[], more: number): string =>
    // Each reason is a sentence of its own; joined, only the line's last full stop is kept.
    [
      // A reason that names its page (a URL reader's does, since a redirect may end elsewhere)
      // is not prefixed with it again.
      ...pages.map((page): string => {
        const reason = page.reason.replace(/\.$/, '');
        return reason.includes(page.ref) ? reason : `${page.ref}: ${reason}`;
      }),
      ...(more > 0 ? [`and ${more} more`] : []),
    ].join('; ');
  const kindLine =
    kindCount === 0
      ? undefined
      : `${kindCount}${failures > 0 ? ' more' : ''} listed ${kindCount === 1 ? 'page is' : 'pages are'} ` +
        `of a kind Day0 does not read: ${named(kinds, kindCount - kinds.length)}.`;
  if (failures === 0) return kindLine;
  const failedNames = named(failed, kinds.length > 0 ? 0 : unnamed);
  let failureLine: string;
  if (nothingStored) {
    const pages = failures === 1 ? '1 page' : `${failures} pages`;
    const it = failures === 1 ? 'it' : 'them';
    failureLine = `${pages} could not be read, and nothing from this source is stored yet: ${failedNames}. Day0 reads ${it} again at the next sync; a page it refuses stays unread until the page or its address changes.`;
  } else {
    failureLine = `${header(failures)}: ${failedNames}. The next sync reads them again.`;
  }
  return kindLine === undefined ? failureLine : `${failureLine} ${kindLine}`;
}

/**
 * A run's reason for ending short, on one line.
 *
 * @param ending - Why the run ended: its failure, or the run that replaced it.
 */
export function endedShort(ending: string): string {
  return ending.replace(/\s+/g, ' ').trim();
}

/**
 * A run's record of its unread pages: its `unread` field. The text a release
 * before 0.6.0 wrote below the reason was moved onto the field by the
 * `sync-runs-unread` migration, which every deployment has run.
 *
 * @param run - The run's record fields.
 */
export function unreadRecordIn(run: RunRecordFields | undefined): UnreadRecord | undefined {
  return run?.unread;
}

const LEGACY_HEADER = /^(\d+) pages? could not be read this sync/;
const LEGACY_MORE = /^- and \d+ more$/;
const LEGACY_PAGE = /^- (.*?): (.*)$/;

/** Where an earlier release's record starts in a run's reason, or -1 when it holds none. */
function legacyRecordStart(lines: readonly string[]): number {
  return lines.findIndex((line: string): boolean => LEGACY_HEADER.test(line));
}

/**
 * The unread-pages record a release before 0.6.0 wrote as text in a run's
 * reason: a header counting the pages, then one `- <ref>: <reason>` line per
 * named page and a `- and <n> more` line. Read by the `sync-runs-unread`
 * migration only, which still runs over a new volume's empty table.
 *
 * @param reason - A run's reason, or nothing.
 * @returns The record, or undefined when the reason holds none.
 */
export function legacyUnreadRecord(reason: string | undefined): UnreadRecord | undefined {
  const lines = (reason ?? '').split('\n');
  const start = legacyRecordStart(lines);
  if (start === -1) return undefined;
  const count = Number(LEGACY_HEADER.exec(lines[start])?.[1] ?? 0);
  const pages = lines
    .slice(start + 1)
    .filter((line: string): boolean => !LEGACY_MORE.test(line))
    .flatMap((line: string): UnreadPage[] => {
      const match = LEGACY_PAGE.exec(line);
      return match ? [{ ref: match[1], reason: match[2] }] : [];
    });
  return { count, pages };
}

/**
 * A run's reason without the record a release before 0.6.0 wrote below it:
 * the line saying why the run ended short, or nothing when the record was
 * all it held (a completed run's). Read by the `sync-runs-unread` migration
 * only.
 *
 * @param reason - A run's reason, or nothing.
 */
export function reasonWithoutLegacyRecord(reason: string | undefined): string | undefined {
  const lines = (reason ?? '').split('\n');
  const start = legacyRecordStart(lines);
  if (start === -1) return reason;
  const ending = lines.slice(0, start).join('\n').trim();
  return ending === '' ? undefined : ending;
}
