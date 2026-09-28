/**
 * The record a documentation sync run keeps of the pages it could not read.
 *
 * A page one sync cannot read keeps its last stored version (P5-11), and the
 * run says which pages those were, so the operator can see why a page did not
 * change. The record lives on the run's own `unread` field: a count of every
 * such page and the first `MAX_UNREAD_LISTED` of them by name, each reason on
 * one bounded line. The source's line on the documentation page carries the
 * same record on one line. The run's `reason` says only why it ended short,
 * so a rewrite of the reason never touches the record (D D1 (a)).
 *
 * Releases before 0.6.0 wrote the record as text below the reason; the
 * `sync-runs-unread` migration moves each onto the field, and until it has
 * run `unreadRecordIn` still reads the text.
 */

import type { UnreadPage } from './readers/batch';

/** The most unread pages a record names; the rest are counted. */
export const MAX_UNREAD_LISTED = 10;

/** The longest a page's reference or reason in a record may be. */
const MAX_RECORD_LINE = 240;

/** The pages a sync run could not read: how many, and the first of them by name. */
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
 *   bounded line, or the record unchanged when the batch read every page.
 */
export function withUnreadPages(
  record: UnreadRecord | undefined,
  unread: readonly UnreadPage[],
): UnreadRecord | undefined {
  if (unread.length === 0) return record;
  const pages = [...(record?.pages ?? [])];
  for (const page of unread) {
    if (pages.length >= MAX_UNREAD_LISTED) break;
    pages.push({ ref: recordLine(page.ref), reason: recordLine(page.reason) });
  }
  return { count: (record?.count ?? 0) + unread.length, pages };
}

/**
 * The record on one line, for the source's status on the documentation page.
 *
 * @param record - A completed run's record, or nothing.
 * @returns The line, or undefined when the run read every page.
 */
export function unreadPagesLine(record: UnreadRecord | undefined): string | undefined {
  if (record === undefined || record.count === 0) return undefined;
  const more = record.count - record.pages.length;
  const named = [
    ...record.pages.map((page): string => `${page.ref}: ${page.reason}`),
    ...(more > 0 ? [`and ${more} more`] : []),
  ].join('; ');
  return `${header(record.count)}: ${named.replace(/\.$/, '')}. The next sync reads them again.`;
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
 * A run's record of its unread pages: its `unread` field, or the text an
 * earlier release wrote below its reason while the migration has not moved it.
 *
 * @param run - The run's record fields.
 */
export function unreadRecordIn(run: RunRecordFields | undefined): UnreadRecord | undefined {
  return run?.unread ?? legacyUnreadRecord(run?.reason);
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
 * named page and a `- and <n> more` line. Read by `unreadRecordIn` and the
 * `sync-runs-unread` migration only; the release after it removes both reads.
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
 * all it held (a completed run's).
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
