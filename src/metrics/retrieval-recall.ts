import type { RetrievalRecall } from './types';

/**
 * The documentation selection's recall on the labelled set, as the newest tracked grade taken on a
 * bed's own search records it (`evaluation/retrieval/<stamp>/grade.json` with `scout: "backend"`,
 * written by `evaluation/retrieval/backend-run.ts`): the recall half of the supervision page's
 * retrieval figure (A9). It describes the search the product runs, and the card prints the day it
 * was graded, so an older export read later says how old its recall is. The emulated scout's
 * grades stay as the offline test that reproduces the selector's recall. A test holds this to that
 * grade, so a new backend grade is copied here in the commit that tracks it.
 */
export const RETRIEVAL_RECALL: RetrievalRecall = {
  pages: 0.953125,
  blocks: 0.921875,
  cases: 32,
  corpusPages: 21,
  gradedAt: '2026-10-11T06:25:06.572Z',
  commit: '68fe852f0dcfc99247d227846fb242c33c0ee08b',
};
