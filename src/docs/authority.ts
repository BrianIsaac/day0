/**
 * Document authority's vocabulary (wave 15, 15-K; A5, A19): how far the manager trusts a
 * documentation source, and what status a page has and who or what decided it. Pure, and read by
 * `convex/schema.ts`, so it reads no environment variable at load.
 */

/**
 * How far a source is trusted, most first: official beats team beats personal; within a source a
 * page's own status decides, and recency only breaks ties (A5).
 */
export const SOURCE_AUTHORITIES = ['official', 'team', 'personal'] as const;

/** One source's trust. */
export type SourceAuthority = (typeof SOURCE_AUTHORITIES)[number];

/** The statuses a source may give its pages when nothing else decides one. */
export const DEFAULT_PAGE_STATUSES = ['active', 'draft'] as const;

/** A source's default page status. */
export type DefaultPageStatus = (typeof DEFAULT_PAGE_STATUSES)[number];

/**
 * A page's status: current (`active`), not yet current (`draft`), replaced by another page
 * (`superseded`), or kept only for the record (`archived`). Only an active page is current.
 */
export const PAGE_STATUSES = ['active', 'draft', 'superseded', 'archived'] as const;

/** One page's status. */
export type PageStatus = (typeof PAGE_STATUSES)[number];

/**
 * What decided a page's status (K-2): the manager, the source itself (an archive, a trash, a draft
 * flag, front matter or a path), a marker in the page's text judged by the model (N20), a
 * confirmed relation to another page, or the source's default.
 */
export const STATUS_SOURCES = [
  'manager',
  'source-native',
  'marker',
  'relation',
  'default',
] as const;

/** What decided one page's status. */
export type StatusSource = (typeof STATUS_SOURCES)[number];
