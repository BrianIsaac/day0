import { describe, expect, it } from 'vitest';
import { actionIdempotencyKey } from '../../../src/work/idempotency';

describe('actionIdempotencyKey', (): void => {
  it('is stable for one action of one run and different for the next run or the next action', (): void => {
    const first = actionIdempotencyKey({ workItemId: 'item', runId: 'run-1', actionIndex: 0 });
    expect(actionIdempotencyKey({ workItemId: 'item', runId: 'run-1', actionIndex: 0 })).toBe(
      first,
    );
    expect(actionIdempotencyKey({ workItemId: 'item', runId: 'run-2', actionIndex: 0 })).not.toBe(
      first,
    );
    expect(actionIdempotencyKey({ workItemId: 'item', runId: 'run-1', actionIndex: 1 })).not.toBe(
      first,
    );
  });

  it('carries the three ids in order, so a provider log can be read back to the run', (): void => {
    expect(actionIdempotencyKey({ workItemId: 'item', runId: 'run-1', actionIndex: 2 })).toBe(
      'item:run-1:2',
    );
  });
});
