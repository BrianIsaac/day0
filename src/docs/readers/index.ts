import type { DocSourceKind } from '../types';
import type { DocumentationReader } from './batch';
import { ConfluenceDataCenterReader } from './confluence-dc';
import { ConfluenceCloudReader } from './confluence-v2';
import { GoogleDriveReader } from './drive';
import { FeishuReader } from './feishu';
import { FolderReader } from './folder';
import { GitReader } from './git';
import { McpReader } from './mcp';
import { SharePointReader } from './sharepoint';
import { UrlsReader } from './urls';
import { YuqueReader } from './yuque';

/**
 * Resolve a documentation reader.
 *
 * Args:
 *   kind: Persisted source kind.
 *
 * Returns:
 *   Reader implementation for the source, whose batches name the pages they could not read.
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
      return new SharePointReader();
    case 'yuque':
      return new YuqueReader();
    case 'drive':
      return new GoogleDriveReader();
  }
}
