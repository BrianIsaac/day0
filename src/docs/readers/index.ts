import type { DocSourceKind, DocSourceReader } from '../types';
import { FolderReader } from './folder';
import { GitReader } from './git';
import { McpReader } from './mcp';
import { UrlsReader } from './urls';

/**
 * Resolve a documentation reader.
 *
 * Args:
 *   kind: Persisted source kind.
 *
 * Returns:
 *   Reader implementation for the source.
 *
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
      return new McpReader();
  }
}
