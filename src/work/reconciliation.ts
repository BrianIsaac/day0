import { actionIntent, parseSurfaceAction } from '../surfaces/policy';
import type { MockAction } from './types';

export const INTERRUPTED_APPLY_REASON =
  'apply was interrupted after its claim; provider outcomes are unknown and must be reconciled before retry';
export const OUTCOME_UNKNOWN_REASON =
  'outcome unknown after interrupted apply - verify provider before retry';

export type ReconciliationPhase = 'single' | 'prerequisite' | 'closing';
export type ReconciliationOutcome = 'landed' | 'outcome-unknown';

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

interface LedgerPhase {
  phase: ReconciliationPhase;
  actions: MockAction[];
  applied: LedgerEntry[];
}

function phasesOf(output: unknown): LedgerPhase[] {
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

export function providerReconciliationEntries(output: unknown): ReconciliationEntry[] {
  return phasesOf(output).flatMap(({ phase, actions, applied }) =>
    applied.flatMap((entry, actionIndex): ReconciliationEntry[] => {
      const tool = optionalString(entry.tool) ?? actions[actionIndex]?.tool ?? 'unknown';
      const outcomeUnknown =
        entry.outcomeUnknown === true || optionalString(entry.reason) === OUTCOME_UNKNOWN_REASON;
      if (outcomeUnknown && entry.held !== true) {
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

export function retryRequiresProviderReconciliation(
  output: unknown,
  skipReason?: string,
): boolean {
  return (
    skipReason === INTERRUPTED_APPLY_REASON || providerReconciliationEntries(output).length > 0
  );
}
