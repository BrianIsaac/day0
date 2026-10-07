import { sha256OfText } from '../lib/sha256';

/*
 * A documentation page as blocks for the search index (wave 14, 14-I; the wave file's section
 * 6.1): split at headings, a section longer than one window cut on paragraph boundaries, tables,
 * fenced code and lists kept as their own blocks. Pure, so the sync, the backfill and the tests
 * split a page the same way without a backend.
 *
 * The search half is the shared CJK-aware tokeniser. The self-hosted backend tokenises with
 * Tantivy's SimpleTokenizer (alphanumeric runs, lower-cased, a term of 32 UTF-8 bytes or more
 * dropped), so an unspaced Chinese sentence is one term and a run of eleven or more CJK
 * characters is not indexed at all (14-I's proof, 8 October 2026). Every block's `searchText`
 * therefore also carries each CJK run as overlapping bigrams, and a query is written the same
 * way (`searchTerms`), cut to the sixteen terms the backend reads (`blockSearchQuery`).
 */

/** What a block holds: prose, a table, fenced code or a list. */
export const BLOCK_KINDS = ['text', 'table', 'code', 'list'] as const;

/** A block's kind. */
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** The most characters one block holds; a longer line or word is cut at the window. */
export const BLOCK_WINDOW_CHARS = 1_200;

/**
 * The most blocks one page is split into. A page whose headings or kinds would cut it finer is
 * packed into windows across its headings instead, which a stored page (at most 768 KiB) always
 * fits: two adjacent windows always hold more than one window's characters.
 */
export const MAX_BLOCKS_PER_PAGE = 1_500;

/** The terms the backend reads of a search; it silently drops every later one (14-I's proof). */
export const SEARCH_TERM_LIMIT = 16;

/** The filter expressions one search may carry; a ninth is refused (14-I's proof). */
export const SEARCH_FILTER_LIMIT = 8;

/** The results one search may scan; `take` past it, or `collect`, is refused (14-I's proof). */
export const SEARCH_SCAN_LIMIT = 1_024;

/** The longest term the index keeps, in UTF-8 bytes (Tantivy's limit of 32 drops 32 and more). */
export const SEARCH_TERM_MAX_BYTES = 31;

/** One block of a page, in document order. */
export interface DocBlock {
  /** Its place in the page, from 0. */
  readonly index: number;
  /** The headings it sits under, outermost first; empty before the first heading. */
  readonly headingPath: readonly string[];
  /** The block's Markdown as the page holds it (already redacted when the page is). */
  readonly text: string;
  /** What the index reads: the heading path, the text and the bigrams of every CJK run. */
  readonly searchText: string;
  readonly kind: BlockKind;
  /** SHA-256 of the heading path, the kind and the text: unchanged blocks keep their row. */
  readonly hash: string;
  /** The text's length in characters (code points). */
  readonly chars: number;
}

/** A run of Chinese, Japanese or Korean characters. */
const CJK_RUN =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]+/gu;

/** Whether text holds a CJK character (no global flag, so no state between calls). */
const HAS_CJK =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u;

/** What Tantivy's SimpleTokenizer keeps of text: runs of letters and digits. */
const TERM = /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]+/gu;

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TABLE_ROW = /^ {0,3}\|/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const INDENTED = /^(?: {2,}|\t)\S/;

/**
 * The most characters of one heading a block's path keeps: every block of a section carries its
 * whole path twice (`headingPath` and `searchText`), so a heading of thousands of characters would
 * otherwise multiply into rows past a document's size.
 */
const HEADING_PATH_CHARS = 200;

/** The first `limit` characters (code points) of a string. */
function truncated(text: string, limit: number): string {
  return charCount(text) <= limit ? text : [...text].slice(0, limit).join('');
}

/** One piece of a section: a paragraph, a table, a fenced block or a list. */
interface Unit {
  readonly kind: BlockKind;
  readonly text: string;
}

/** The units under one heading path. */
interface Section {
  readonly headingPath: readonly string[];
  readonly units: readonly Unit[];
}

/** A piece of a page before it is numbered and hashed. */
interface Piece {
  readonly headingPath: readonly string[];
  readonly kind: BlockKind;
  readonly text: string;
}

/**
 * Split a page's Markdown into blocks for the search index.
 *
 * @param markdown - The page as stored (redacted): the sync splits after redaction, the backfill
 *   splits what is stored, so no block holds a value the page does not.
 * @returns The blocks in document order; none for a page with no text under any heading.
 */
export function splitPage(markdown: string): DocBlock[] {
  const sections = sectionsOf(markdown.replace(/\r\n?/g, '\n'));
  let pieces = sections.flatMap(piecesOfSection);
  if (pieces.length > MAX_BLOCKS_PER_PAGE) pieces = windowsAcrossHeadings(sections);
  return pieces.map((piece, index): DocBlock => blockOf(piece, index));
}

/** Number, hash and index one piece. */
function blockOf(piece: Piece, index: number): DocBlock {
  return {
    index,
    headingPath: piece.headingPath,
    text: piece.text,
    searchText: searchTextOf(piece.headingPath, piece.text),
    kind: piece.kind,
    hash: sha256OfText(JSON.stringify([piece.headingPath, piece.kind, piece.text])),
    chars: charCount(piece.text),
  };
}

/** The page's sections, each with its heading path and its units; headings outside code only. */
function sectionsOf(markdown: string): Section[] {
  const sections: Section[] = [];
  const path: string[] = [];
  const levels: number[] = [];
  let lines: string[] = [];
  let inFence: string | undefined;
  const close = (): void => {
    const units = unitsOf(lines);
    if (units.length > 0) sections.push({ headingPath: [...path], units });
    lines = [];
  };
  for (const line of markdown.split('\n')) {
    const fence = FENCE.exec(line)?.[1];
    if (inFence !== undefined) {
      if (fence !== undefined && fence[0] === inFence[0] && fence.length >= inFence.length) {
        inFence = undefined;
      }
      lines.push(line);
      continue;
    }
    if (fence !== undefined) {
      inFence = fence;
      lines.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading === null) {
      lines.push(line);
      continue;
    }
    close();
    const level = heading[1].length;
    while (levels.length > 0 && levels[levels.length - 1] >= level) {
      levels.pop();
      path.pop();
    }
    levels.push(level);
    path.push(truncated(heading[2].trim(), HEADING_PATH_CHARS));
  }
  close();
  return sections;
}

/** The kind a line opens, outside a fence. */
function lineKind(line: string): BlockKind {
  if (FENCE.test(line)) return 'code';
  if (TABLE_ROW.test(line)) return 'table';
  if (LIST_ITEM.test(line)) return 'list';
  return 'text';
}

/**
 * A section's lines as units: a fenced block whole (blank lines and all), a table's run of rows,
 * a list's items with their indented and lazy continuation lines (a blank line inside a list
 * keeps it open when the next line is an item or indented), and paragraphs at blank lines.
 */
function unitsOf(lines: readonly string[]): Unit[] {
  const units: Unit[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const kind = lineKind(line);
    const start = index;
    index += 1;
    if (kind === 'code') {
      const fence = FENCE.exec(line)![1];
      while (index < lines.length) {
        const closing = FENCE.exec(lines[index])?.[1];
        index += 1;
        if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length) {
          break;
        }
      }
    } else if (kind === 'table') {
      while (index < lines.length && TABLE_ROW.test(lines[index])) index += 1;
    } else if (kind === 'list') {
      index = listEnd(lines, index);
    } else {
      while (
        index < lines.length &&
        lines[index].trim() !== '' &&
        lineKind(lines[index]) === 'text'
      ) {
        index += 1;
      }
    }
    units.push({ kind, text: trimBlankEdges(lines.slice(start, index)).join('\n') });
  }
  return units;
}

/** Where a list that began before `from` ends. */
function listEnd(lines: readonly string[], from: number): number {
  let index = from;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      // Past the run of blank lines in one step, so a loose list is read in one pass.
      let next = index + 1;
      while (next < lines.length && lines[next].trim() === '') next += 1;
      if (next === lines.length || !(LIST_ITEM.test(lines[next]) || INDENTED.test(lines[next]))) {
        return index;
      }
      index = next;
      continue;
    }
    const kind = lineKind(line);
    if (kind === 'list' || kind === 'text' || INDENTED.test(line)) {
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

/** Lines without blank lines at either end. */
function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

/**
 * A section's pieces: consecutive paragraphs packed up to the window, every table, code block
 * and list its own piece, and any unit longer than the window cut into windows.
 */
function piecesOfSection(section: Section): Piece[] {
  const pieces: Piece[] = [];
  let pending: string[] = [];
  const flush = (): void => {
    if (pending.length > 0) {
      pieces.push(...packed(section.headingPath, 'text', pending));
      pending = [];
    }
  };
  for (const unit of section.units) {
    if (unit.kind === 'text') {
      pending.push(unit.text);
      continue;
    }
    flush();
    pieces.push(...packed(section.headingPath, unit.kind, [unit.text]));
  }
  flush();
  return pieces;
}

/** The fallback for a page the block bound refuses: every unit, headings as lines, in windows. */
function windowsAcrossHeadings(sections: readonly Section[]): Piece[] {
  const pieces: Piece[] = [];
  let pending: { readonly headingPath: readonly string[]; readonly texts: string[] } | undefined;
  let kinds = new Set<BlockKind>();
  let chars = 0;
  const flush = (): void => {
    if (pending === undefined) return;
    const kind = kinds.size === 1 ? [...kinds][0] : 'text';
    pieces.push({ headingPath: pending.headingPath, kind, text: pending.texts.join('\n\n') });
    pending = undefined;
    kinds = new Set();
    chars = 0;
  };
  for (const section of sections) {
    const heading = section.headingPath.at(-1);
    const units: Unit[] = [
      ...(heading === undefined
        ? []
        : [
            { kind: 'text' as const, text: `${'#'.repeat(section.headingPath.length)} ${heading}` },
          ]),
      ...section.units,
    ];
    for (const unit of units) {
      for (const text of windowsOf(unit.text)) {
        const length = charCount(text);
        if (pending !== undefined && chars + 2 + length > BLOCK_WINDOW_CHARS) flush();
        pending ??= { headingPath: section.headingPath, texts: [] };
        chars += (pending.texts.length > 0 ? 2 : 0) + length;
        pending.texts.push(text);
        kinds.add(unit.kind);
      }
    }
  }
  flush();
  return pieces;
}

/** Units of one kind packed into windows, each joined by a blank line. */
function packed(
  headingPath: readonly string[],
  kind: BlockKind,
  texts: readonly string[],
): Piece[] {
  const pieces: Piece[] = [];
  let window: string[] = [];
  let chars = 0;
  for (const text of texts.flatMap(windowsOf)) {
    const length = charCount(text);
    if (window.length > 0 && chars + 2 + length > BLOCK_WINDOW_CHARS) {
      pieces.push({ headingPath, kind, text: window.join('\n\n') });
      window = [];
      chars = 0;
    }
    chars += (window.length > 0 ? 2 : 0) + length;
    window.push(text);
  }
  if (window.length > 0) pieces.push({ headingPath, kind, text: window.join('\n\n') });
  return pieces;
}

/**
 * One unit as windows of at most `BLOCK_WINDOW_CHARS`: whole when it fits, else cut at line
 * ends, then at spaces, then (a single word longer than a window) at the window's length.
 */
function windowsOf(text: string): string[] {
  if (charCount(text) <= BLOCK_WINDOW_CHARS) return [text];
  const lines = text.split('\n');
  if (lines.length > 1) return joinedWithin(lines.flatMap(windowsOf), '\n');
  const words = text.split(' ');
  if (words.length > 1) return joinedWithin(words.flatMap(windowsOf), ' ');
  const characters = [...text];
  const windows: string[] = [];
  for (let start = 0; start < characters.length; start += BLOCK_WINDOW_CHARS) {
    windows.push(characters.slice(start, start + BLOCK_WINDOW_CHARS).join(''));
  }
  return windows;
}

/** Parts joined by `separator` into as few windows as fit, counting as it goes. */
function joinedWithin(parts: readonly string[], separator: string): string[] {
  const windows: string[] = [];
  let current: string[] = [];
  let chars = 0;
  for (const part of parts) {
    const length = charCount(part);
    if (current.length > 0 && chars + separator.length + length > BLOCK_WINDOW_CHARS) {
      windows.push(current.join(separator));
      current = [];
      chars = 0;
    }
    chars += (current.length > 0 ? separator.length : 0) + length;
    current.push(part);
  }
  if (current.length > 0) windows.push(current.join(separator));
  return windows;
}

/** A string's length in characters (code points), as a reader counts it. */
function charCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // A low surrogate continues the character before it.
    if (code < 0xdc00 || code > 0xdfff) count += 1;
  }
  return count;
}

/**
 * One CJK run as overlapping bigrams: `刷新看板` is `刷新 新看 看板`; a single character is itself.
 *
 * @param run - Characters of one CJK run, with nothing between them.
 */
export function cjkBigrams(run: string): string[] {
  const characters = [...run];
  if (characters.length < 2) return characters;
  return characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`);
}

/**
 * The shared CJK-aware tokeniser: text as the terms a search on `searchText` matches. Latin and
 * other spaced scripts split on anything not a letter or a digit, in lower case; every CJK run
 * becomes its bigrams; a term the index would drop (32 UTF-8 bytes or more) is dropped.
 *
 * @returns The terms in text order, repeats kept (a caller ranks or dedupes them).
 */
export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  const encoder = new TextEncoder();
  for (const match of text.matchAll(TERM)) {
    let rest = match[0];
    for (const run of match[0].matchAll(CJK_RUN)) {
      const [before, after] = splitOnce(rest, run[0]);
      terms.push(...latinTerms(before), ...cjkBigrams(run[0]));
      rest = after;
    }
    terms.push(...latinTerms(rest));
  }
  return terms.filter((term) => encoder.encode(term).length <= SEARCH_TERM_MAX_BYTES);
}

/** A run of non-CJK letters and digits as its one lower-case term, or none. */
function latinTerms(run: string): string[] {
  return run === '' ? [] : [run.toLowerCase()];
}

/** Text before and after the first occurrence of `part`. */
function splitOnce(text: string, part: string): [string, string] {
  const at = text.indexOf(part);
  return [text.slice(0, at), text.slice(at + part.length)];
}

/**
 * What the index reads for a block: its heading path and text, then a line of the terms the
 * index would miss, so a search written by `searchTerms` finds them. Those are the bigrams of
 * every CJK run, and any Latin word written against one (`请在Slack里发布`), which the index
 * would otherwise keep only inside the whole run.
 *
 * @param headingPath - The headings the block sits under.
 * @param text - The block's text.
 */
export function searchTextOf(headingPath: readonly string[], text: string): string {
  const written = [...headingPath.filter((heading) => heading !== ''), text].join('\n');
  const missed = [...written.matchAll(TERM)]
    .filter((term) => HAS_CJK.test(term[0]))
    .flatMap((term) => searchTerms(term[0]));
  return missed.length === 0 ? written : `${written}\n${missed.join(' ')}`;
}

/**
 * A search string the backend reads whole: the text's distinct terms, in order, cut to
 * `limit`. The backend drops every term after the sixteenth without a word, so the cut is made
 * here, where a caller can order the terms that matter first.
 *
 * @param text - What to search for, in any script.
 * @param limit - How many terms to keep; at most `SEARCH_TERM_LIMIT`.
 * @returns The terms joined by spaces; empty when the text has none.
 */
export function blockSearchQuery(text: string, limit: number = SEARCH_TERM_LIMIT): string {
  const distinct = [...new Set(searchTerms(text))];
  return distinct.slice(0, Math.min(limit, SEARCH_TERM_LIMIT)).join(' ');
}
