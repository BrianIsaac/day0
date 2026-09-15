import { describe, expect, it } from 'vitest';
import { UndoLedger } from '../../../scripts/rehearsal/cleanup';

describe('the undo ledger', (): void => {
  it('runs every registered step last-in first-out and reports each outcome', async (): Promise<void> => {
    const order: string[] = [];
    const ledger = new UndoLedger();
    ledger.register('first', async (): Promise<void> => {
      order.push('first');
    });
    ledger.register('second', async (): Promise<void> => {
      order.push('second');
      throw new Error('provider said no');
    });
    ledger.register('third', async (): Promise<void> => {
      order.push('third');
    });
    const results = await ledger.runAll();
    expect(order).toEqual(['third', 'second', 'first']);
    expect(results).toEqual([
      { label: 'third', ok: true },
      { label: 'second', ok: false, error: 'provider said no' },
      { label: 'first', ok: true },
    ]);
    expect(ledger.pending()).toEqual([]);
  });

  it('lists what is still to undo, newest first, without running anything', (): void => {
    const ledger = new UndoLedger();
    ledger.register('a', async (): Promise<void> => undefined);
    ledger.register('b', async (): Promise<void> => undefined);
    expect(ledger.pending()).toEqual(['b', 'a']);
  });
});
