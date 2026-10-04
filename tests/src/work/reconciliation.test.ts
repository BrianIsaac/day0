import { describe, expect, it } from 'vitest';
import {
  answeredEntries,
  isOutcomeUnknownReason,
  landedRowCount,
  OUTCOME_UNKNOWN_AFTER_STOP_REASON,
  OUTCOME_UNKNOWN_REASON,
  providerReconciliationEntries,
  reconcilerOf,
  reconciliationAnswered,
  reconciliationOwed,
  type ReconciliationEntry,
} from '../../../src/work/reconciliation';

describe('landedRowCount', (): void => {
  it('counts every row that reached the work environment, in both phases, reads and writes alike', (): void => {
    expect(
      landedRowCount({
        initial: {
          actions: [{ tool: 'linear.get_issue', args: {} }],
          applied: [{ tool: 'linear.get_issue', ok: true }],
        },
        actions: [
          { tool: 'linear.save_comment', args: {} },
          { tool: 'linear.save_issue', args: {} },
        ],
        applied: [
          { tool: 'linear.save_comment', ok: true },
          { tool: 'linear.save_issue', ok: false },
        ],
      }),
    ).toBe(2);
  });

  it('counts no held, refused or missing row', (): void => {
    expect(landedRowCount({ applied: [{ ok: true, held: true }, { ok: false }] })).toBe(0);
    expect(landedRowCount(undefined)).toBe(0);
    expect(landedRowCount({})).toBe(0);
  });
});

describe('the reconciliation answered per entry (U17 D1)', () => {
  const landed: ReconciliationEntry = {
    phase: 'single',
    actionIndex: 0,
    tool: 'mcp.call',
    outcome: 'landed',
  };
  const unknown: ReconciliationEntry = {
    phase: 'single',
    actionIndex: 1,
    tool: 'mcp.call',
    outcome: 'outcome-unknown',
  };

  it('owes an answer for every write of unknown outcome, and none for a landed one', () => {
    expect(answeredEntries([landed, unknown], [])).toEqual({ ok: false, unanswered: [unknown] });
    expect(
      answeredEntries([landed, unknown], [{ phase: 'single', actionIndex: 1, answer: 'not-sent' }]),
    ).toEqual({
      ok: true,
      entries: [
        { ...landed, answer: 'landed' },
        { ...unknown, answer: 'not-sent' },
      ],
    });
  });

  it('takes the answer given for a landed entry, and reads an answer only at its own place', () => {
    expect(
      answeredEntries(
        [landed, unknown],
        [
          { phase: 'single', actionIndex: 0, answer: 'not-sent' },
          { phase: 'closing', actionIndex: 1, answer: 'landed' },
        ],
      ),
    ).toEqual({ ok: false, unanswered: [unknown] });
  });
});

describe('an outcome unknown, whichever ended the apply', (): void => {
  it('reads an apply the manager stopped as unknown, as it reads an interrupted one', (): void => {
    for (const reason of [OUTCOME_UNKNOWN_REASON, OUTCOME_UNKNOWN_AFTER_STOP_REASON]) {
      expect(isOutcomeUnknownReason(reason)).toBe(true);
      expect(
        providerReconciliationEntries({
          actions: [{ tool: 'http.request', args: {} }],
          applied: [{ tool: 'http.request', ok: false, reason }],
        }),
      ).toEqual([
        {
          phase: 'single',
          actionIndex: 0,
          tool: 'http.request',
          outcome: 'outcome-unknown',
          reason,
        },
      ]);
    }
    expect(isOutcomeUnknownReason('HTTP 500 · {"ok":false}')).toBe(false);
  });

  // Re-pinned for W12-R9: the reasons reach the manager on the card, in their words.
  it('says a stopped apply was stopped, never that it was interrupted', (): void => {
    expect(OUTCOME_UNKNOWN_AFTER_STOP_REASON).not.toContain('interrupted');
    expect(OUTCOME_UNKNOWN_AFTER_STOP_REASON).toContain(
      'check whether it arrived before you retry',
    );
  });

  it('words both reasons for a manager, with no spaced hyphen, and still reads the old words (W12-R9)', (): void => {
    for (const reason of [OUTCOME_UNKNOWN_REASON, OUTCOME_UNKNOWN_AFTER_STOP_REASON]) {
      expect(reason).not.toMatch(/ - |\bapply\b|\bprovider\b/);
    }
    const legacy = 'outcome unknown after interrupted apply - verify provider before retry';
    expect(isOutcomeUnknownReason(legacy)).toBe(true);
    expect(
      isOutcomeUnknownReason(
        'outcome unknown after the apply was stopped - verify provider before retry',
      ),
    ).toBe(true);
    // A row recorded before v0.16.0 is listed in the words a row carries now.
    expect(
      providerReconciliationEntries({
        actions: [{ tool: 'http.request', args: {} }],
        applied: [{ tool: 'http.request', ok: false, reason: legacy, idempotencyKey: 'k' }],
      })[0]?.reason,
    ).toBe(OUTCOME_UNKNOWN_REASON);
  });
});

describe('reconcilerOf', (): void => {
  it('names the manager who checked as you, or one before a handover, and never by the owner key', (): void => {
    expect(reconcilerOf('dev-no-auth|local-boss', 'dev-no-auth|local-boss')).toBe('you');
    expect(reconcilerOf('issuer|old-manager', 'issuer|new-manager')).toBe('previous-manager');
    expect(reconcilerOf('issuer|old-manager', undefined)).toBeUndefined();
  });
});

describe('a reconciliation recorded before the per-entry answers (W12-R3, D-9 (a))', (): void => {
  const unknown: ReconciliationEntry = {
    phase: 'single',
    actionIndex: 0,
    tool: 'mcp.call',
    outcome: 'outcome-unknown',
  };
  const landed: ReconciliationEntry = { ...unknown, actionIndex: 1, outcome: 'landed' };
  const output = {
    actions: [{ tool: 'mcp.call', args: {} }],
    applied: [{ tool: 'mcp.call', ok: false, outcomeUnknown: true, idempotencyKey: 'k' }],
  };

  it('counts as answered only once every write of unknown outcome has an answer', (): void => {
    expect(reconciliationAnswered(undefined)).toBe(false);
    expect(reconciliationAnswered({ entries: [unknown, landed] })).toBe(false);
    expect(reconciliationAnswered({ entries: [{ ...unknown, answer: 'not-sent' }, landed] })).toBe(
      true,
    );
    expect(reconciliationAnswered({ entries: [landed] })).toBe(true);
  });

  it('owes the check until it is answered, and never where nothing may have landed', (): void => {
    expect(reconciliationOwed({ output })).toBe(true);
    expect(reconciliationOwed({ output, providerReconciliation: { entries: [unknown] } })).toBe(
      true,
    );
    expect(
      reconciliationOwed({
        output,
        providerReconciliation: { entries: [{ ...unknown, answer: 'landed' }] },
      }),
    ).toBe(false);
    expect(reconciliationOwed({ output: { actions: [], applied: [] } })).toBe(false);
  });
});
