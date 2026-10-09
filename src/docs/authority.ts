/**
 * Document authority's vocabulary (wave 15, 15-K; A5, A19): how far the manager trusts a
 * documentation source. Pure, and read by `convex/schema.ts`, so it reads no environment variable
 * at load.
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
