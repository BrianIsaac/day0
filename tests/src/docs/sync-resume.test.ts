import { describe, expect, it } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import { RESUMABLE_RUN_MS, runToResume, type ResumeCandidate } from '../../../src/docs/sync-resume';

const NOW = 1_790_000_000_000;

function run(fields: Partial<ResumeCandidate> & Pick<ResumeCandidate, 'state'>): ResumeCandidate {
  return {
    _id: `run-${Math.random()}` as Id<'docSyncRuns'>,
    cursor: '300',
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

  it('starts from page one when the run is too old to finish a generation with', (): void => {
    const old = run({ state: 'error', createdAt: NOW - RESUMABLE_RUN_MS - 1 });
    expect(runToResume(old, undefined, NOW)).toBeUndefined();
  });

  it('starts from page one when the run was itself a resume that got no further', (): void => {
    const first = run({ state: 'error' });
    const again = run({ state: 'error' });
    expect(runToResume(again, first, NOW)).toBeUndefined();
    const progressed = run({ state: 'error', cursor: '325', pageCount: 325 });
    expect(runToResume(progressed, first, NOW)).toBe(progressed);
  });
});
