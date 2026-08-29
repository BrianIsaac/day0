import type {
  EvaluationArm,
  EvaluationGrade,
  EvaluationTask,
} from './graders';

export interface EvaluationDecision {
  kind: 'charter' | 'skill' | 'plan' | 'actions';
  taskId?: string;
  requestedAt: string;
  approvedAt: string;
  delayMs: number;
}

export interface EvaluationTaskResult {
  taskId: string;
  externalId: string;
  category: EvaluationTask['category'];
  workItemId: string;
  terminalState: string;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
  deployToFirstCorrectActionMs: number | null;
  humanWaitMs: number;
  decisions: EvaluationDecision[];
  modelCalls: {
    /** Model-bearing stages invoked by the harness; retries are not observable. */
    logicalStages: number;
    /** Provider steps only where the action returns them, otherwise null. */
    observableProviderCalls: number | null;
  };
  grade: EvaluationGrade;
  error?: string;
}

export interface EvaluationRun {
  id: string;
  arm: EvaluationArm;
  run: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  agentId?: string;
  deployedAt?: string;
  completedAt?: string;
  humanWaitMs: number;
  decisions: EvaluationDecision[];
  tasks: EvaluationTaskResult[];
  error?: string;
}

export interface EvaluationEvidence {
  schemaVersion: 1;
  experiment: 'day0-semifinal-controlled-comparison';
  generatedAt: string;
  configuration: {
    commit: string;
    model: string;
    temperature: number;
    surfaceMode: 'mock';
    requestedRuns: number;
    taskIds: string[];
    taskTimeoutMs?: Record<string, number>;
    approvalDelayMs: number;
    pollIntervalMs: number;
    noLlmJudge: true;
    onboardingTranscriptProvenance: string;
    onboardingTranscriptPath?: string;
    postCharterApprovalSkipped?: boolean;
  };
  runs: EvaluationRun[];
}

export interface WilsonInterval {
  low: number;
  high: number;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Two-sided score interval. n=0 deliberately reports the full uncertainty range. */
export function wilsonInterval(successes: number, n: number, z = 1.959963984540054): WilsonInterval {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || successes < 0 || n < successes) {
    throw new Error(`invalid rate ${successes}/${n}`);
  }
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { low: round4(centre - margin), high: round4(centre + margin) };
}

export function formatRate(successes: number, n: number): string {
  const interval = wilsonInterval(successes, n);
  const estimate = n === 0 ? 'not estimable' : `${((successes / n) * 100).toFixed(1)}%`;
  return `${estimate} (${successes}/${n}; Wilson 95% CI ${(interval.low * 100).toFixed(1)}–${(
    interval.high * 100
  ).toFixed(1)}%)`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function duration(value: number | null): string {
  return value === null ? 'not observed' : `${(value / 1000).toFixed(2)} s`;
}

function taskRows(evidence: EvaluationEvidence): Array<EvaluationTaskResult & { run: EvaluationRun }> {
  return evidence.runs.flatMap((run) => run.tasks.map((task) => ({ ...task, run })));
}

function rateRow(label: string, rows: EvaluationTaskResult[], predicate: (row: EvaluationTaskResult) => boolean): string {
  return `| ${label} | ${formatRate(rows.filter(predicate).length, rows.length)} |`;
}

export function renderEvaluationReport(evidence: EvaluationEvidence): string {
  const rows = taskRows(evidence);
  const arms: EvaluationArm[] = ['day0', 'baseline'];
  const categories: EvaluationTask['category'][] = [
    'docs-grounded-read',
    'approval-write',
    'out-of-scope',
  ];
  const completedRuns = evidence.runs.filter((run) => run.status === 'completed').length;
  const expectedRuns = evidence.configuration.requestedRuns * 2;
  const summary: string[] = ['| Measure | Result |', '| --- | --- |'];

  for (const arm of arms) {
    const armRows = rows.filter((row) => row.run.arm === arm);
    summary.push(rateRow(`${arm}: task pass`, armRows, (row) => row.grade.passed));
    summary.push(
      rateRow(
        `${arm}: prohibited-action free`,
        armRows,
        (row) => row.grade.prohibitedActionFlags.length === 0,
      ),
    );
    for (const category of categories) {
      const categoryRows = armRows.filter((row) => row.category === category);
      summary.push(
        rateRow(`${arm}: ${category} pass`, categoryRows, (row) => row.grade.passed),
      );
    }
    const writeRows = armRows.filter((row) => row.category === 'approval-write');
    summary.push(
      rateRow(
        `${arm}: writes observed held for approval`,
        writeRows,
        (row) => row.grade.facts.heldForApproval,
      ),
    );
  }

  const timings = arms.map((arm) => {
    const armRows = rows.filter((row) => row.run.arm === arm);
    const observed = armRows
      .map((row) => row.deployToFirstCorrectActionMs)
      .filter((value): value is number => value !== null);
    const humanWait = evidence.runs
      .filter((run) => run.arm === arm)
      .map((run) => run.humanWaitMs);
    return `| ${arm} | ${duration(median(observed))} (${observed.length} observed tasks) | ${duration(
      median(humanWait),
    )} (${humanWait.length} runs) |`;
  });

  const detail = rows.map(
    (row) =>
      `| ${row.run.id} | ${row.run.arm} | ${row.taskId} | ${row.terminalState}${
        row.timedOut ? ' (timeout)' : ''
      } | ${row.grade.passed ? 'pass' : 'fail'} | ${row.grade.prohibitedActionFlags.join('; ') || 'none'} | ${
        row.grade.facts.heldForApproval ? 'yes' : 'no'
      } | ${duration(row.deployToFirstCorrectActionMs)} |`,
  );

  return `# Semi-final controlled comparison

Generated ${evidence.generatedAt} from commit \`${evidence.configuration.commit}\`. Evidence status: ${completedRuns}/${expectedRuns} configured runs completed.

## Results

${summary.join('\n')}

## Time to operational

Wall clock is measured from agent deployment to the first task effect that satisfies that task's required-effect checker. Human wait is recorded separately and is not subtracted from wall time.

| Arm | Median deploy → first correct effect | Median human wait |
| --- | --- | --- |
${timings.join('\n')}

## Method

This is a paired concurrent control: day0 and the ordinary-agent baseline receive the same fixed tasks and the same seeded mock office for each run index. Both use \`${evidence.configuration.model}\` at non-zero temperature ${evidence.configuration.temperature}. Day0 keeps its charter, plan, skill, and exact-action approval mechanisms; the baseline receives a generic ops-assistant prompt and the raw mock tools, with none of those mechanisms.

No LLM judge contributes to any reported number. The graders inspect terminal work state, persisted action ledgers, and mock adapter state for required and prohibited effects. The task file states each exact check. Every rate above carries its numerator, n, and a two-sided Wilson 95% interval.

Day0 onboarding uses ${evidence.configuration.onboardingTranscriptProvenance} The harness records the charter approval delay and every later approval as human wait. It deliberately skips \`postCharterApproval\` after charter approval so model-generated queue items cannot contaminate the fixed concurrent task set; the shipped mock seed still installs the documentation skill and office state.

Per-task timeouts are defined in \`evaluation/tasks/semifinal.json\`. A timeout is terminal for the harness and remains a failed programmatic grade. Provider-call retries inside shared model helpers are not observable, so day0 records logical model-bearing stages and marks provider calls unknown; the baseline records returned model steps.

## Task-level evidence

| Run | Arm | Task | Terminal state | Grader | Prohibited flags | Held | Deploy → first correct effect |
| --- | --- | --- | --- | --- | --- | --- | --- |
${detail.join('\n') || '| — | — | — | — | — | — | — | — |'}
`;
}
