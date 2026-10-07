import type { Id } from '../../convex/_generated/dataModel';
import { droppedScriptSuffix } from '../lib/short-hash';

/**
 * How a documentation source is read: an MCP server, a folder, a git repository, a URL list, or
 * a Feishu (or Lark) wiki space or folder.
 */
export type DocSourceKind = 'mcp' | 'folder' | 'git' | 'urls' | 'feishu';
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
