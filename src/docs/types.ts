import type { Id } from '../../convex/_generated/dataModel';

export type DocSourceKind = 'mcp' | 'folder' | 'git' | 'urls';
export type DocServerKind = 'notion' | 'confluence' | 'drive' | 'generic';

export interface DocSourceRecord {
  _id: Id<'docSources'>;
  label: string;
  kind: DocSourceKind;
  locator: string;
  serverKind?: DocServerKind;
  credentialId?: Id<'credentials'>;
}

export interface DocPage {
  sourceId: Id<'docSources'>;
  ref: string;
  title: string;
  url?: string;
  markdown: string;
  updatedAt: number;
}

export interface DocSourceReader {
  listPages(source: DocSourceRecord, secret?: string): Promise<DocPage[]>;
  listPageBatch(
    source: DocSourceRecord,
    secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<DocPageBatch>;
}

export interface DocPageBatch {
  pages: DocPage[];
  nextCursor?: string;
}

/**
 * Build a collision-resistant mock-document slug for one linked page.
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
  return `source-${sourcePart}-${refPart || 'page'}`;
}
