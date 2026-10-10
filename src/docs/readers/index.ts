import { notReadYet, type DocSourceKind } from '../types';
import type { DocumentationReader } from './batch';
import { ConfluenceDataCenterReader } from './confluence-dc';
import { ConfluenceCloudReader } from './confluence-v2';
import { FeishuReader } from './feishu';
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
 *   Reader implementation for the source, whose batches name the pages they could not read.
 *
 * Raises:
 *   Error: For a kind whose reader has not landed (`PENDING_READER_NAMES`).
 */
export function readerFor(kind: DocSourceKind): DocumentationReader {
  switch (kind) {
    case 'folder':
      return new FolderReader();
    case 'git':
      return new GitReader();
    case 'urls':
      return new UrlsReader();
    case 'mcp':
      return new McpReader();
    case 'feishu':
      return new FeishuReader();
    case 'confluence-v2':
      return new ConfluenceCloudReader();
    case 'confluence-dc':
      return new ConfluenceDataCenterReader();
    case 'sharepoint':
    case 'yuque':
    case 'drive':
      // Declared by the schema before its reader lands (K-3); the link refuses such a source.
      throw new Error(notReadYet(kind));
  }
}
