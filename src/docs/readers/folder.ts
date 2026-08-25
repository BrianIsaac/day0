import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DocPage, DocPageBatch, DocSourceReader, DocSourceRecord } from '../types';

/**
 * Read the first level-one Markdown heading.
 *
 * Args:
 *   markdown: Markdown page body.
 *   fallback: Title used when the page has no level-one heading.
 *
 * Returns:
 *   Page title without trailing heading markers.
 */
export function markdownPageTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split('\n')) {
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
 * Args:
 *   source: Source metadata stored by Convex.
 *   directory: Absolute directory to read.
 *   cursor: Optional decimal file offset.
 *   limit: Maximum pages to read.
 *
 * Returns:
 *   Normalised pages and the next safe offset.
 */
export async function readMarkdownDirectoryBatch(
  source: DocSourceRecord,
  directory: string,
  cursor: string | undefined,
  limit: number,
): Promise<DocPageBatch> {
  const files = await markdownFiles(directory);
  const offset = offsetFromCursor(cursor);
  const selected = files.slice(offset, offset + limit);
  const pages = await Promise.all(
    selected.map(async (path): Promise<DocPage> => {
      const [markdown, details] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const ref = relative(directory, path).split(sep).join('/');
      const fallback = basename(path, '.md').replaceAll('-', ' ');
      return {
        sourceId: source._id,
        ref,
        title: markdownPageTitle(markdown, fallback),
        markdown,
        updatedAt: details.mtimeMs,
      };
    }),
  );
  const nextOffset = offset + pages.length;
  return {
    pages,
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
export class FolderReader implements DocSourceReader {
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
   *   Bounded page batch and continuation cursor.
   */
  async listPageBatch(
    source: DocSourceRecord,
    _secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<DocPageBatch> {
    void _secret;
    return await readMarkdownDirectoryBatch(
      source,
      resolveFolderLocator(this.root, source.locator),
      cursor,
      limit,
    );
  }
}
