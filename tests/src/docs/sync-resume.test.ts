import { describe, expect, it } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import { FINISHING_CURSOR, finishingCursor } from '../../../src/docs/finishing';
import { listingCursor } from '../../../src/docs/readers/batch';
import { RESUMABLE_RUN_MS, runToResume, type ResumeCandidate } from '../../../src/docs/sync-resume';

const NOW = 1_790_000_000_000;

/** A listing of 500 pages, as a folder reader lists them. */
const LISTING = Array.from({ length: 500 }, (_, index) => `page-${index}.md`);

function run(fields: Partial<ResumeCandidate> & Pick<ResumeCandidate, 'state'>): ResumeCandidate {
  return {
    _id: `run-${Math.random()}` as Id<'docSyncRuns'>,
    cursor: listingCursor(300, LISTING),
    listing: 1,
    pageCount: 300,
    createdAt: NOW - 60_000,
    ...fields,
  };
}

describe('the run a new documentation sync takes over (step 17)', (): void => {
  it('takes over a run that failed or was abandoned with a cursor', (): void => {
    const failed = run({ state: 'error' });
    expect(runToResume(failed, undefined, NOW)).toBe(failed);
    const abandoned = run({ state: 'running' });
    expect(runToResume(abandoned, run({ state: 'completed', cursor: undefined }), NOW)).toBe(
      abandoned,
    );
  });

  it('starts from page one after a completed run, or a run that never recorded a cursor', (): void => {
    expect(runToResume(run({ state: 'completed' }), undefined, NOW)).toBeUndefined();
    expect(runToResume(run({ state: 'error', cursor: undefined }), undefined, NOW)).toBeUndefined();
    expect(runToResume(undefined, undefined, NOW)).toBeUndefined();
  });

  it('starts from page one after a run that carries no listing, which no batch could stamp under (13-K)', (): void => {
    expect(
      runToResume(run({ state: 'error', listing: undefined }), undefined, NOW),
    ).toBeUndefined();
  });

  it('starts from page one when the run is too old to finish a generation with', (): void => {
    const old = run({ state: 'error', createdAt: NOW - RESUMABLE_RUN_MS - 1 });
    expect(runToResume(old, undefined, NOW)).toBeUndefined();
  });

  it('starts from page one when the run was itself a resume that got no further', (): void => {
    const first = run({ state: 'error' });
    const again = run({ state: 'error' });
    expect(runToResume(again, first, NOW)).toBeUndefined();
    const progressed = run({
      state: 'error',
      cursor: listingCursor(325, LISTING),
      pageCount: 325,
    });
    expect(runToResume(progressed, first, NOW)).toBe(progressed);
  });

  it('starts from page one after a provider cursor or a bare offset, which no listing can check (D D5)', (): void => {
    for (const cursor of ['25', 'eyJwYWdlIjoyfQ', 'v1.pageToken.ABC123', '25@']) {
      expect(runToResume(run({ state: 'error', cursor }), undefined, NOW), cursor).toBeUndefined();
    }
  });

  it('resumes a finish cut off part-way from its own checkpoint', (): void => {
    for (const cursor of [
      FINISHING_CURSOR,
      finishingCursor({ phase: 'mirrors', cursor: 'opaque-page-cursor' }),
    ]) {
      const finishing = run({ state: 'error', cursor });
      expect(runToResume(finishing, undefined, NOW), cursor).toBe(finishing);
    }
  });
});
