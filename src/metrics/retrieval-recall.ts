import type { RetrievalRecall } from './types';

/**
 * The documentation selection's recall on the labelled set, as its newest tracked grade
 * (`evaluation/retrieval/<stamp>/grade.json`, written by `pnpm eval:retrieval`) records it: the
 * recall half of the supervision page's retrieval figure (A9). A test holds it to that grade, so
 * a new grade is copied here in the commit that tracks it.
 */
export const RETRIEVAL_RECALL: RetrievalRecall = {
  pages: 0.953125,
  blocks: 0.9375,
  cases: 32,
  corpusPages: 21,
  gradedAt: '2026-10-11T06:01:52.993Z',
  commit: '39755260b01d42bc138fb8c0024ad2638f032ad0',
};
