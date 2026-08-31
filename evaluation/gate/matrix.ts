import type { ActionDisposition } from '../../src/surfaces/policy';
import { reviewActions } from '../../src/surfaces/policy';
import {
  GATE_FIXTURE,
  GATE_FIXTURE_NOW,
  GATE_GRANTS,
  GATE_REPLY_TARGET,
  GATE_SURFACES,
  type GatePolicyLabel,
} from './fixture';

export type GateMode = 'off' | 'on';

export interface GateObservation {
  id: string;
  label: GatePolicyLabel;
  rationale: string;
  mode: GateMode;
  verdict: ActionDisposition;
  reason?: string;
}

export interface GateMatrixCell {
  label: GatePolicyLabel;
  verdict: ActionDisposition;
  count: number;
}

export interface GateModeSummary {
  mode: GateMode;
  n: number;
  cells: GateMatrixCell[];
  refusalCodes: Record<string, number>;
  humanOverride: { reject: number; held: number; rate: number | null };
}

export interface GateMatrixEvidence {
  schemaVersion: 1;
  experiment: 'day0-gate-accuracy';
  generatedAt: string;
  fixtureSize: number;
  observations: GateObservation[];
  summaries: GateModeSummary[];
  noModelCalls: true;
}

const LABELS: readonly GatePolicyLabel[] = ['in-policy', 'out-of-policy', 'boundary'];
const VERDICTS: readonly ActionDisposition[] = ['auto', 'held', 'refused'];

function refusalCode(reason: string): string {
  const parenthesis = reason.indexOf(' (');
  return parenthesis === -1 ? reason : reason.slice(0, parenthesis);
}

export function gateObservations(): GateObservation[] {
  return (['off', 'on'] as const).flatMap((mode) =>
    GATE_FIXTURE.map((fixture): GateObservation => {
      const [verdict] = reviewActions(
        [fixture.action],
        GATE_SURFACES,
        GATE_GRANTS,
        GATE_FIXTURE_NOW,
        {
          autonomousActions: mode === 'on',
          replyTarget: GATE_REPLY_TARGET,
        },
      );
      return {
        id: fixture.id,
        label: fixture.label,
        rationale: fixture.rationale,
        mode,
        verdict: verdict.disposition,
        ...('reason' in verdict ? { reason: verdict.reason } : {}),
      };
    }),
  );
}

export function summariseGateMode(
  observations: readonly GateObservation[],
  mode: GateMode,
): GateModeSummary {
  const rows = observations.filter((row) => row.mode === mode);
  const cells = LABELS.flatMap((label) =>
    VERDICTS.map(
      (verdict): GateMatrixCell => ({
        label,
        verdict,
        count: rows.filter((row) => row.label === label && row.verdict === verdict).length,
      }),
    ),
  );
  const refusalCodes: Record<string, number> = {};
  for (const row of rows) {
    if (row.verdict !== 'refused' || !row.reason) continue;
    const code = refusalCode(row.reason);
    refusalCodes[code] = (refusalCodes[code] ?? 0) + 1;
  }
  const held = rows.filter((row) => row.verdict === 'held');
  const reject = held.filter((row) => row.label === 'out-of-policy').length;
  return {
    mode,
    n: rows.length,
    cells,
    refusalCodes: Object.fromEntries(
      Object.entries(refusalCodes).sort(([left], [right]) => left.localeCompare(right)),
    ),
    humanOverride: {
      reject,
      held: held.length,
      rate: held.length > 0 ? reject / held.length : null,
    },
  };
}

export function buildGateMatrix(now = new Date()): GateMatrixEvidence {
  const observations = gateObservations();
  return {
    schemaVersion: 1,
    experiment: 'day0-gate-accuracy',
    generatedAt: now.toISOString(),
    fixtureSize: GATE_FIXTURE.length,
    observations,
    summaries: (['off', 'on'] as const).map((mode) => summariseGateMode(observations, mode)),
    noModelCalls: true,
  };
}

function cell(
  summary: GateModeSummary,
  label: GatePolicyLabel,
  verdict: ActionDisposition,
): number {
  return summary.cells.find((row) => row.label === label && row.verdict === verdict)?.count ?? 0;
}

function percent(rate: number | null): string {
  return rate === null ? 'not defined (0 held actions)' : `${(rate * 100).toFixed(1)}%`;
}

export function renderGateMatrix(evidence: GateMatrixEvidence): string {
  const lines = [
    '# Gate-accuracy confusion matrix',
    '',
    `Generated ${evidence.generatedAt} from ${evidence.fixtureSize} pre-labelled actions, each reviewed once with autonomous actions off and once with them on (n=${evidence.observations.length} verdicts). No model calls were made.`,
    '',
    '`in-policy` means intrinsically allowed; `out-of-policy` means the gate should refuse it; `boundary` means it is allowed only through an explicit supervision boundary, including the autonomous switch or literal manager approval.',
    '',
  ];
  for (const summary of evidence.summaries) {
    lines.push(
      `## Autonomous actions ${summary.mode}`,
      '',
      `n=${summary.n}.`,
      '',
      '| Human label | auto | held | refused |',
      '|---|---:|---:|---:|',
      ...(['in-policy', 'out-of-policy', 'boundary'] as const).map(
        (label) =>
          `| ${label} | ${cell(summary, label, 'auto')} | ${cell(summary, label, 'held')} | ${cell(summary, label, 'refused')} |`,
      ),
      '',
      `Human override rate: ${summary.humanOverride.reject}/${summary.humanOverride.held} held actions = ${percent(summary.humanOverride.rate)}. This is the share a reviewer would have to reject to keep the pre-labelled policy; it is computed from the labels, not from a person.`,
      '',
      'Refusal codes:',
      '',
      ...Object.entries(summary.refusalCodes).map(([reason, count]) => `- ${reason}: ${count}`),
      '',
    );
  }
  lines.push(
    '## Action-level observations',
    '',
    '| id | label | switch | verdict | reason | rationale |',
    '|---|---|---|---|---|---|',
    ...evidence.observations.map(
      (row) =>
        `| ${row.id} | ${row.label} | ${row.mode} | ${row.verdict} | ${row.reason ?? '—'} | ${row.rationale} |`,
    ),
    '',
    'Context: `reviewActions` is the hold-time gate. Some out-of-policy cases are deliberately enforced later by the adapter or by result-dependent checks; where this matrix shows `auto` or `held`, that is a measured limit of hold-time classification rather than a claim that the provider transport will accept the action.',
    '',
  );
  return `${lines.join('\n')}\n`;
}
