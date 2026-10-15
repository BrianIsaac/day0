import type { Id } from '../../convex/_generated/dataModel';
import { droppedScriptSuffix } from '../lib/short-hash';
import type { PageStatus } from './authority';

/**
 * How a documentation source is read: an MCP server, a folder, a git repository, a URL list, a
 * Feishu (or Lark) wiki space or folder, a SharePoint site, a Confluence space (Cloud or Data
 * Center), a Yuque repository, or a Google Drive folder.
 */
export type DocSourceKind =
  | 'mcp'
  | 'folder'
  | 'git'
  | 'urls'
  | 'feishu'
  | 'sharepoint'
  | 'confluence-v2'
  | 'confluence-dc'
  | 'yuque'
  | 'drive';

/** Which MCP documentation server a source speaks to. */
export type DocServerKind = 'notion' | 'confluence' | 'drive' | 'generic';

/** A linked documentation source as the readers take it. */
export interface DocSourceRecord {
  _id: Id<'docSources'>;
  label: string;
  kind: DocSourceKind;
  locator: string;
  serverKind?: DocServerKind;
  credentialId?: Id<'credentials'>;
}

/** One documentation page as a reader returns it, normalised to Markdown. */
export interface DocPage {
  sourceId: Id<'docSources'>;
  ref: string;
  title: string;
  url?: string;
  markdown: string;
  updatedAt: number;
  /**
   * What the source says of the page's status (an archive, a trash, a draft flag, front matter or
   * a path), where its reader reads one; stored as `docPages.nativeStatus` (wave 15, 15-K).
   */
  nativeStatus?: PageStatus;
  /** The page's revision as its source numbers it, where it gives one (`docPages.sourceRevision`). */
  sourceRevision?: string;
  /**
   * Set when the page was read but its revision was not, for a reason that passes (a transient
   * answer): the revision it was stored with stands, where none would clear it (W15-R30).
   */
  revisionUnread?: boolean;
  /**
   * Whether `updatedAt` is the source's own edit time (true) or the time the reader read the page,
   * its source having given no date it could read (false); stored as `docPages.datedBySource`
   * (wave 17, D-8). Every reader sets it: a folder's file time counts as its source's (X-3), and a
   * page from a git checkout or a list of URLs is dated by the read. A page from an MCP server is
   * dated by its source where its server names a time that parses (Notion's `last_edited_time`, a
   * Drive server's `modifiedTime`, Atlassian's `lastModified`; RM42 (b), wave 18), and a generic
   * server's resource, which names none, by the read. Absent only on a page object no reader made.
   */
  datedBySource?: boolean;
}

/** What every documentation reader provides: one batch of pages at a time. */
export interface DocSourceReader {
  listPageBatch(
    source: DocSourceRecord,
    secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<DocPageBatch>;
}

/** One batch of pages and the cursor for the next. */
export interface DocPageBatch {
  pages: DocPage[];
  nextCursor?: string;
}

/**
 * Build a collision-resistant mock-document slug for one linked page.
 *
 * A reference with letters outside `[a-z0-9]`, such as a Chinese file name,
 * keeps a digest of itself beside the ASCII part, so two such pages in one
 * source are two documents, not one (N8).
 *
 * Args:
 *   sourceId: Documentation source id.
 *   ref: Stable page reference within the source.
 *
 * Returns:
 *   Slug safe for the existing `mockDocs` index.
 */
export function mirroredDocSlug(sourceId: Id<'docSources'>, ref: string): string {
  const sourcePart = String(sourceId).slice(-10).toLowerCase();
  const refPart = ref
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
  return `source-${sourcePart}-${refPart || 'page'}${droppedScriptSuffix(ref)}`;
}
