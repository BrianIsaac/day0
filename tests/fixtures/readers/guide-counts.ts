/**
 * The request counts the three reader guides print (`docs/running/reader-sharepoint.md`,
 * `reader-confluence.md`, `reader-drive.md`, "What a read asks of ..."), held in one place so the
 * guides' test and each reader's own test go by the same figures.
 *
 * The thousand-page figures are what each reader's contract test counts on the generated library
 * (`library.ts`): a first read, a read with nothing changed and a read after one page changed.
 * The bed's figures are what the bed `day0-w17x` counted from the fakes' own log on 13 October
 * 2026, a running day0 in real mode reading 250 pages of the same library; no test can count
 * them again, so they are pinned here as the bed recorded them.
 */
import type { LibraryKind } from './library';

/** What three reads of one library cost in requests. */
export interface ReadCosts {
  readonly first: number;
  readonly unchanged: number;
  readonly oneChanged: number;
}

/** A thousand pages, counted by each reader's own test. */
export const THOUSAND_PAGE_REQUESTS: Readonly<Record<LibraryKind, ReadCosts>> = {
  sharepoint: { first: 2_043, unchanged: 83, oneChanged: 85 },
  'confluence-v2': { first: 81, unchanged: 41, oneChanged: 42 },
  'confluence-dc': { first: 1_042, unchanged: 42, oneChanged: 43 },
  drive: { first: 1_081, unchanged: 81, oneChanged: 82 },
};

/** 250 pages, counted on the bed. */
export const BED_REQUESTS: Readonly<Record<LibraryKind, ReadCosts>> = {
  sharepoint: { first: 513, unchanged: 23, oneChanged: 25 },
  'confluence-v2': { first: 21, unchanged: 11, oneChanged: 12 },
  'confluence-dc': { first: 262, unchanged: 12, oneChanged: 13 },
  drive: { first: 271, unchanged: 21, oneChanged: 22 },
};
