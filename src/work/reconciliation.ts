import { actionIntent, parseSurfaceAction } from '../surfaces/policy';
import type { MockAction } from './types';

/** The skip reason a run carries when its apply was interrupted after the claim. */
export const INTERRUPTED_APPLY_REASON =
  'apply was interrupted after its claim; provider outcomes are unknown and must be reconciled before retry';
/** The ledger reason for an action whose provider outcome the interrupted apply never learnt. */
export const OUTCOME_UNKNOWN_REASON =
  'outcome unknown after interrupted apply - verify provider before retry';

/** Which phase of a run a ledger entry belongs to. */
export type ReconciliationPhase = 'single' | 'prerequisite' | 'closing';
/** What the manager must confirm about an entry: it landed, or its outcome is unknown. */
export type ReconciliationOutcome = 'landed' | 'outcome-unknown';

/** One ledger entry the manager confirms before a retry, by phase and index. */
export interface ReconciliationEntry {
  phase: ReconciliationPhase;
  actionIndex: number;
  tool: string;
  outcome: ReconciliationOutcome;
  effect?: string;
  reason?: string;
  providerId?: string;
  idempotencyKey?: string;
}

interface LedgerEntry {
  tool?: unknown;
  ok?: boolean;
  held?: boolean;
  outcomeUnknown?: boolean;
  effect?: unknown;
  reason?: unknown;
  providerId?: unknown;
  idempotencyKey?: unknown;
}

/** One phase's actions beside their ledger. */
export interface LedgerPhase {
  phase: ReconciliationPhase;
  actions: MockAction[];
  applied: LedgerEntry[];
}

/** A run's ledger by phase: one for a single-phase run, two once it has a closing phase. */
export function ledgerPhases(output: unknown): LedgerPhase[] {
  const top = (output ?? {}) as {
    actions?: MockAction[];
    applied?: LedgerEntry[];
    initial?: { actions?: MockAction[]; applied?: LedgerEntry[] };
  };
  if (!top.initial) {
    return [{ phase: 'single', actions: top.actions ?? [], applied: top.applied ?? [] }];
  }
  return [
    {
      phase: 'prerequisite',
      actions: top.initial.actions ?? [],
      applied: top.initial.applied ?? [],
    },
    { phase: 'closing', actions: top.actions ?? [], applied: top.applied ?? [] },
  ];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function entryDetails(entry: LedgerEntry): Partial<ReconciliationEntry> {
  const effect = optionalString(entry.effect);
  const reason = optionalString(entry.reason);
  const providerId = optionalString(entry.providerId);
  const idempotencyKey = optionalString(entry.idempotencyKey);
  return {
    ...(effect ? { effect } : {}),
    ...(reason ? { reason } : {}),
    ...(providerId ? { providerId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function landedWrite(action: MockAction | undefined, entry: LedgerEntry): boolean {
  if (entry.ok !== true || entry.held === true) return false;
  if (!action) return true;
  const parsed = parseSurfaceAction(action);
  return !parsed.ok || actionIntent(parsed.action) === 'write';
}

/** The entries of a run's ledger the manager must confirm on the provider before a retry. */
export function providerReconciliationEntries(output: unknown): ReconciliationEntry[] {
  return ledgerPhases(output).flatMap(({ phase, actions, applied }) =>
    applied.flatMap((entry, actionIndex): ReconciliationEntry[] => {
      const tool = optionalString(entry.tool) ?? actions[actionIndex]?.tool ?? 'unknown';
      const outcomeUnknown =
        entry.outcomeUnknown === true || optionalString(entry.reason) === OUTCOME_UNKNOWN_REASON;
      if (outcomeUnknown) {
        return [
          {
            phase,
            actionIndex,
            tool,
            outcome: 'outcome-unknown',
            ...entryDetails(entry),
          },
        ];
      }
      if (!landedWrite(actions[actionIndex], entry)) return [];
      return [
        {
          phase,
          actionIndex,
          tool,
          outcome: 'landed',
          ...entryDetails(entry),
        },
      ];
    }),
  );
}

/** Whether a retry must wait for the provider reconciliation checklist. */
export function retryRequiresProviderReconciliation(output: unknown, skipReason?: string): boolean {
  return (
    skipReason === INTERRUPTED_APPLY_REASON || providerReconciliationEntries(output).length > 0
  );
}
