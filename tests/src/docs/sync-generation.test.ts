import { describe, expect, it } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import { generationRefusal, SUPERSEDED_GENERATION_REASON } from '../../../src/docs/sync-generation';

const SOURCE = 'source-1' as Id<'docSources'>;
const RUN = 'run-1' as Id<'docSyncRuns'>;

describe('the sync generation fence', (): void => {
  it('lets only the source’s running generation write', (): void => {
    const run = { _id: RUN, sourceId: SOURCE, state: 'running' as const };
    expect(generationRefusal(SOURCE, { activeSyncId: RUN }, run)).toBeUndefined();
    expect(generationRefusal(SOURCE, { activeSyncId: 'run-2' as Id<'docSyncRuns'> }, run)).toBe(
      SUPERSEDED_GENERATION_REASON,
    );
    expect(generationRefusal(SOURCE, { activeSyncId: RUN }, { ...run, state: 'superseded' })).toBe(
      SUPERSEDED_GENERATION_REASON,
    );
    expect(
      generationRefusal(SOURCE, { activeSyncId: undefined }, { ...run, state: 'completed' }),
    ).toBe(SUPERSEDED_GENERATION_REASON);
  });

  it('refuses a generation of another source, or one whose source or run is gone', (): void => {
    const run = { _id: RUN, sourceId: 'source-2' as Id<'docSources'>, state: 'running' as const };
    expect(generationRefusal(SOURCE, { activeSyncId: RUN }, run)).toBe(
      'the sync is not this source’s',
    );
    expect(generationRefusal(SOURCE, null, run)).toBe(
      'the documentation source or its sync is gone',
    );
    expect(generationRefusal(SOURCE, { activeSyncId: RUN }, null)).toBe(
      'the documentation source or its sync is gone',
    );
  });
});
