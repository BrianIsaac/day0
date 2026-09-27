import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DocPage, DocSourceRecord } from '../types';
import {
  splitPageReads,
  unreadReason,
  type DocumentationReader,
  type ReadPageBatch,
} from './batch';

/** An opening or closing code fence: three or more backticks or tildes. */
const CODE_FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Read the first level-one Markdown heading outside a fenced code block.
 *
 * A `# ` line inside a fence is a shell comment or an example page, not the
 * page's heading, so it never names the page.
 *
 * @param markdown - Markdown page body.
 * @param fallback - Title used when the page has no level-one heading.
 * @returns Page title without trailing heading markers.
 */
export function markdownPageTitle(markdown: string, fallback: string): string {
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const marker = CODE_FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1].replace(/\s+#+$/, '').trim();
  }
  return fallback;
}

/**
 * Resolve a source locator without allowing it to escape its mounted root.
 *
 * Args:
 *   root: Absolute documentation root.
 *   locator: Relative source directory.
 *
 * Returns:
 *   Absolute directory inside the root.
 *
 * Raises:
 *   Error: If the locator is absolute or escapes the root.
 */
export function resolveFolderLocator(root: string, locator: string): string {
  if (isAbsolute(locator)) throw new Error('Folder locator must be relative to DAY0_DOCS_ROOT.');
  const absoluteRoot = resolve(root);
  const directory = resolve(absoluteRoot, locator || '.');
  const fromRoot = relative(absoluteRoot, directory);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('Folder locator must stay inside DAY0_DOCS_ROOT.');
  }
  return directory;
}

/**
 * Find Markdown pages recursively in stable reference order.
 *
 * Args:
 *   directory: Directory currently being traversed.
 *
 * Returns:
 *   Absolute Markdown file paths. Symbolic links are ignored.
 */
async function markdownFiles(directory: string): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right): number =>
    left.name.localeCompare(right.name),
  );
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path);
    else if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
  }
  return files;
}

/**
 * Parse an offset cursor emitted by a filesystem-backed reader.
 *
 * Args:
 *   cursor: Optional decimal offset.
 *
 * Returns:
 *   Non-negative page offset.
 *
 * Raises:
 *   Error: If the cursor is not a canonical non-negative integer.
 */
export function offsetFromCursor(cursor?: string): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error('Documentation cursor is invalid.');
  return Number(cursor);
}

/**
 * Read one bounded batch of Markdown files.
 *
 * A file listed but not readable (removed since the listing, no permission)
 * is named as unread and the batch goes on, so one file never fails the
 * source (P5-11).
 *
 * Args:
 *   source: Source metadata stored by Convex.
 *   directory: Absolute directory to read.
 *   cursor: Optional decimal file offset.
 *   limit: Maximum pages to read.
 *
 * Returns:
 *   Normalised pages, the files that could not be read, and the next safe offset.
 */
export async function readMarkdownDirectoryBatch(
  source: DocSourceRecord,
  directory: string,
  cursor: string | undefined,
  limit: number,
): Promise<ReadPageBatch> {
  const files = await markdownFiles(directory);
  const offset = offsetFromCursor(cursor);
  const selected = files.slice(offset, offset + limit);
  const reads = await Promise.all(
    selected.map(async (path) => {
      const ref = relative(directory, path).split(sep).join('/');
      try {
        const [markdown, details] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
        const fallback = basename(path, '.md').replaceAll('-', ' ');
        return {
          sourceId: source._id,
          ref,
          title: markdownPageTitle(markdown, fallback),
          markdown,
          updatedAt: details.mtimeMs,
        } satisfies DocPage;
      } catch (error) {
        // Every failure here is this one file's: the listing already succeeded.
        return { ref, reason: unreadReason(error) };
      }
    }),
  );
  const nextOffset = offset + selected.length;
  return {
    ...splitPageReads(reads),
    nextCursor: nextOffset < files.length ? String(nextOffset) : undefined,
  };
}

/**
 * Read all Markdown pages below a known-safe directory.
 *
 * Args:
 *   source: Source metadata stored by Convex.
 *   directory: Absolute directory to read.
 *
 * Returns:
 *   Normalised documentation pages.
 */
export async function readMarkdownDirectory(
  source: DocSourceRecord,
  directory: string,
): Promise<DocPage[]> {
  return (await readMarkdownDirectoryBatch(source, directory, undefined, Number.MAX_SAFE_INTEGER))
    .pages;
}

/** Reader for Markdown mounted below `DAY0_DOCS_ROOT`. */
export class FolderReader implements DocumentationReader {
  readonly root: string;

  /**
   * Create a folder reader.
   *
   * Args:
   *   root: Absolute documentation root. Defaults to the backend mount.
   */
  constructor(root: string = process.env.DAY0_DOCS_ROOT || '/docs') {
    this.root = resolve(root);
  }

  /**
   * Read every Markdown page under a source locator.
   *
   * Args:
   *   source: Linked folder source.
   *   _secret: Unused because folder sources need no credential.
   *
   * Returns:
   *   Normalised pages in deterministic reference order.
   */
  async listPages(source: DocSourceRecord, _secret?: string): Promise<DocPage[]> {
    void _secret;
    return await readMarkdownDirectory(source, resolveFolderLocator(this.root, source.locator));
  }

  /**
   * Read at most one sync action's worth of Markdown pages.
   *
   * Args:
   *   source: Linked folder source.
   *   _secret: Unused because folder sources need no credential.
   *   cursor: Optional decimal file offset.
   *   limit: Maximum pages to read.
   *
   * Returns:
   *   Bounded page batch, its unread files and continuation cursor.
   */
  async listPageBatch(
    source: DocSourceRecord,
    _secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<ReadPageBatch> {
    void _secret;
    return await readMarkdownDirectoryBatch(
      source,
      resolveFolderLocator(this.root, source.locator),
      cursor,
      limit,
    );
  }
}
