import type { DocSourceKind, DocSourceReader } from '../types';
import { FolderReader } from './folder';
import { GitReader } from './git';
import { UrlsReader } from './urls';

/**
 * Resolve a non-MCP documentation reader.
 *
 * Args:
 *   kind: Persisted source kind.
 *
 * Returns:
 *   Reader implementation for the source.
 *
 * Raises:
 *   Error: When an MCP source is requested before its credential-backed
 *     binding has been verified.
 */
export function readerFor(kind: DocSourceKind): DocSourceReader {
  switch (kind) {
    case 'folder':
      return new FolderReader();
    case 'git':
      return new GitReader();
    case 'urls':
      return new UrlsReader();
    case 'mcp':
      throw new Error('MCP documentation reader is pending credential-backed verification.');
  }
}
