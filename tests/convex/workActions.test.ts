/** @vitest-environment node */

import { describe, expect, it } from 'vitest';
import { completionFailure } from '../../convex/workActions';
import type { AppliedAction } from '../../src/surfaces/types';

describe('work action completion evidence', (): void => {
  it('refuses an empty ledger', (): void => {
    expect(completionFailure([])).toContain('nothing in the work environment changed');
  });

  it('names every failed adapter result', (): void => {
    const applied: AppliedAction[] = [
      { tool: 'ticket.update', ok: false, reason: 'no ticket', idempotencyKey: 'run:0' },
      { tool: 'slack.postMessage', ok: true, effect: 'sent', idempotencyKey: 'run:1' },
    ];
    expect(completionFailure(applied)).toBe(
      '1 of 2 actions did not change the work environment: ticket.update (no ticket)',
    );
  });

  it('accepts only a non-empty all-success ledger', (): void => {
    expect(
      completionFailure([
        { tool: 'ticket.update', ok: true, effect: 'updated', idempotencyKey: 'run:0' },
      ]),
    ).toBeUndefined();
  });
});
