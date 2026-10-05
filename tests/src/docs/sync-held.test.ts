import { describe, expect, it } from 'vitest';
import { isSyncHeldReason, SYNC_HELD_REASON } from '../../../src/docs/sync-held';

describe('a documentation sync the deployment’s pause held (W12V-2)', (): void => {
  it('reads this release’s reason and the one before as a hold, and nothing else', (): void => {
    expect(isSyncHeldReason(SYNC_HELD_REASON)).toBe(true);
    expect(
      isSyncHeldReason(
        "Held: this deployment's scheduled work is paused, and the sync goes on from where it stopped once it runs again.",
      ),
    ).toBe(true);
    expect(isSyncHeldReason('The folder could not be read: ENOENT.')).toBe(false);
    expect(isSyncHeldReason(undefined)).toBe(false);
  });

  it('says when the sync goes on, since an unpause alone waits for the next scheduled turn', (): void => {
    expect(SYNC_HELD_REASON).toBe(
      "Held: this deployment's scheduled work is paused. The sync goes on from where it stopped at its next scheduled turn after the work resumes (within 15 minutes), or at once with Re-sync.",
    );
  });
});
