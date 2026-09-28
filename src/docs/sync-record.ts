/**
 * The words a documentation sync run records about the pages it could not read.
 *
 * A page one sync cannot read keeps its last stored version (P5-11), and the
 * run says which pages those were, so the operator can see why a page did not
 * change. The record lives in the run's `reason`, one page to a line under a
 * header that counts them all, and the source's line on the documentation
 * page carries the same record on one line.
 */

import type { UnreadPage } from './readers/batch';

/** The most unread pages a record names; the rest are counted. */
export const MAX_UNREAD_LISTED = 10;

/** The longest one page's line in a record may be. */
const MAX_RECORD_LINE = 240;

/**
 * Text on one bounded line, so a failure's own line breaks never read as
 * pages of the record (review, adversarial pass). Callers redact first: a
 * secret cut across the bound would no longer match its redaction.
 */
export function recordLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_RECORD_LINE ? `${line.slice(0, MAX_RECORD_LINE - 3)}...` : line;
}

const HEADER = /^(\d+) pages? could not be read this sync/;
const MORE = /^- and \d+ more$/;

/** The header line for a count of unread pages. */
function header(count: number): string {
  return count === 1
    ? '1 page could not be read this sync and keeps its last stored version'
    : `${count} pages could not be read this sync and keep their last stored version`;
}

/**
 * How many unread pages a record counts.
 *
 * @param record - A run's reason, or nothing.
 * @returns The count its header states, or 0 when it is not an unread-pages record.
 */
export function unreadPageCount(record: string | undefined): number {
  const match = HEADER.exec(record ?? '');
  return match ? Number(match[1]) : 0;
}

/**
 * The unread-pages record inside a run's reason, wherever it starts.
 *
 * A run that ended short records why on its first line and keeps the
 * record of the pages it could not read below it, so a sync that resumes
 * the run carries that record on.
 *
 * @param reason - A run's reason, or nothing.
 * @returns The record, or undefined when the reason holds none.
 */
export function unreadRecordIn(reason: string | undefined): string | undefined {
  const lines = (reason ?? '').split('\n');
  const start = lines.findIndex((line: string): boolean => HEADER.test(line));
  return start === -1 ? undefined : lines.slice(start).join('\n');
}

/**
 * A run's reason for ending short, with the record of its unread pages kept below it.
 *
 * @param ending - Why the run ended: its failure, or the run that replaced it.
 * @param reason - The run's reason so far, which may hold an unread-pages record.
 */
export function endedShort(ending: string, reason: string | undefined): string {
  const record = unreadRecordIn(reason);
  // The ending is one line, so no line of a failure's text is read as the record.
  const line = ending.replace(/\s+/g, ' ').trim();
  return record === undefined ? line : `${line}\n${record}`;
}

/**
 * Add a batch's unread pages to a run's record.
 *
 * @param record - The run's record so far, or nothing.
 * @param unread - The pages this batch could not read.
 * @returns The record naming at most `MAX_UNREAD_LISTED` pages and counting all of them, or the
 *   record unchanged when the batch read every page.
 */
export function withUnreadPages(
  record: string | undefined,
  unread: readonly UnreadPage[],
): string | undefined {
  if (unread.length === 0) return record;
  const previous = unreadPageCount(record);
  const listed =
    previous === 0
      ? []
      : (record ?? '')
          .split('\n')
          .slice(1)
          .filter((line: string): boolean => !MORE.test(line));
  for (const page of unread) {
    if (listed.length >= MAX_UNREAD_LISTED) break;
    listed.push(recordLine(`- ${page.ref}: ${page.reason}`));
  }
  const count = previous + unread.length;
  const more = count - listed.length;
  return [header(count), ...listed, ...(more > 0 ? [`- and ${more} more`] : [])].join('\n');
}

/**
 * The record on one line, for the source's status on the documentation page.
 *
 * @param record - A completed run's reason, or nothing.
 * @returns The line, or undefined when the run read every page.
 */
export function unreadPagesLine(record: string | undefined): string | undefined {
  if (unreadPageCount(record) === 0) return undefined;
  const [first, ...lines] = (record ?? '').split('\n');
  const named = lines.map((line: string): string => line.replace(/^- /, '')).join('; ');
  return `${first}: ${named.replace(/\.$/, '')}. The next sync reads them again.`;
}
