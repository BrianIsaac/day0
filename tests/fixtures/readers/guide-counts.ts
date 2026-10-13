/**
 * The request counts the three reader guides print (`docs/running/reader-sharepoint.md`,
 * `reader-confluence.md`, `reader-drive.md`, "What a read asks of ..."), held in one place so the
 * guides' test and each reader's own test go by the same figures.
 *
 * The thousand-page figures are what each reader's contract test counts on the generated library
 * (`library.ts`): a first read, a read with nothing changed and a read after one page changed.
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
