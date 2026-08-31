import { createHash } from 'node:crypto';
import type { EvaluationAction } from './graders';
import { ACTION_ARGUMENT_KEYS, parseSurfaceAction, reviewPayload } from '../src/surfaces/policy';
import type { MockAction } from '../src/work/types';

export interface ActionArgumentAuditRow {
  phase: 'initial' | 'output';
  index: number;
  tool: string;
  argumentKeys: string[];
  irrelevantArgumentKeys: string[];
  consumedEffectDigest: string;
}

export interface ActionArgumentAudit {
  totalActions: number;
  actionsWithIrrelevantArguments: number;
  argumentCounts: number[];
  actions: ActionArgumentAuditRow[];
  duplicateEffects: Array<{
    tool: string;
    actions: Array<{ phase: ActionArgumentAuditRow['phase']; index: number }>;
  }>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function actionsOf(value: unknown): EvaluationAction[] {
  const actions = record(value).actions;
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((action) => {
    const row = record(action);
    return typeof row.tool === 'string' ? [{ tool: row.tool, args: row.args }] : [];
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function consumedEffect(action: EvaluationAction): unknown {
  const mockAction = action as MockAction;
  if (action.tool === 'mcp.call' || action.tool === 'http.request') {
    const parsed = parseSurfaceAction(mockAction);
    if (parsed.ok) return parsed.action;
  }
  const reviewed = reviewPayload(mockAction);
  if (action.tool !== 'spreadsheet.appendRow') return reviewed;
  const args = record(action.args);
  const cells = Array.isArray(args.cells) ? args.cells : [];
  const row: Record<string, string> = {};
  for (const cell of cells) {
    const entry = record(cell);
    if (typeof entry.header === 'string' && typeof entry.value === 'string') {
      row[entry.header] = entry.value;
    }
  }
  return {
    tool: action.tool,
    args: {
      sheetSlug: args.sheetSlug,
      tabName: args.tabName,
      cells: row,
    },
  };
}

function digest(action: EvaluationAction): string {
  return createHash('sha256').update(canonicalJson(consumedEffect(action))).digest('hex');
}

/** Retain action shape and equality evidence without retaining model-produced values. */
export function auditActionArguments(output: unknown): ActionArgumentAudit {
  const root = record(output);
  const phases: Array<{
    phase: ActionArgumentAuditRow['phase'];
    actions: EvaluationAction[];
  }> = [
    ...(root.initial === undefined
      ? []
      : [{ phase: 'initial' as const, actions: actionsOf(root.initial) }]),
    { phase: 'output', actions: actionsOf(root) },
  ];
  const actions = phases.flatMap(({ phase, actions: rows }) =>
    rows.map((action, index): ActionArgumentAuditRow => {
      const argumentKeys = Object.keys(record(action.args)).sort();
      const allowed = new Set(ACTION_ARGUMENT_KEYS[action.tool] ?? []);
      return {
        phase,
        index,
        tool: action.tool,
        argumentKeys,
        irrelevantArgumentKeys: argumentKeys.filter((key) => !allowed.has(key)),
        consumedEffectDigest: digest(action),
      };
    }),
  );
  const groups = new Map<string, ActionArgumentAuditRow[]>();
  for (const action of actions) {
    const key = `${action.tool}:${action.consumedEffectDigest}`;
    const rows = groups.get(key) ?? [];
    rows.push(action);
    groups.set(key, rows);
  }
  return {
    totalActions: actions.length,
    actionsWithIrrelevantArguments: actions.filter(
      (action) => action.irrelevantArgumentKeys.length > 0,
    ).length,
    argumentCounts: actions.map((action) => action.argumentKeys.length),
    actions,
    duplicateEffects: [...groups.values()]
      .filter((rows) => rows.length > 1)
      .map((rows) => ({
        tool: rows[0]!.tool,
        actions: rows.map(({ phase, index }) => ({ phase, index })),
      })),
  };
}
