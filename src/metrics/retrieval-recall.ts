import type { RetrievalRecall } from './types';

/**
 * The documentation selection's recall on the labelled set, as its newest tracked grade
 * (`evaluation/retrieval/<stamp>/grade.json`, written by `pnpm eval:retrieval`) records it: the
 * recall half of the supervision page's retrieval figure (A9). A test holds it to that grade, so
 * a new grade is copied here in the commit that tracks it.
 */
export const RETRIEVAL_RECALL: RetrievalRecall = {
  pages: 0.95,
  blocks: 0.9333333333333333,
  cases: 30,
  gradedAt: '2026-10-07T19:39:48.260Z',
  commit: '6c2963b22cbb6d5bdd3a055702a2732ba8d6578f',
};
