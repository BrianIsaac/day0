import type { EvaluationArm, EvaluationGrade, EvaluationTask } from './graders';

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
    /** The model named by the environment the harness ran in. */
    model: string;
    /** The model the backend reported it was configured for; must equal `model`. */
    backendModel?: string;
    temperature: number;
    modelCallTimeoutMs: number;
    surfaceMode: 'mock';
    arms?: EvaluationArm[];
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
  regradedFrom?: {
    path: string;
    /** Commit whose product execution and retained backend state produced the source run. */
    commit: string;
    /** Commit whose task definitions and deterministic graders produced this evidence file. */
    gradedAtCommit: string;
    generatedAt: string;
    modelCallsMade: 0;
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
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.959963984540054,
): WilsonInterval {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || successes < 0 || n < successes) {
    throw new Error(`invalid rate ${successes}/${n}`);
  }
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { low: round4(centre - margin), high: round4(centre + margin) };
}

/** A rate with its numerator, n, two-sided Wilson 95% interval and the interval's width. */
export function formatRate(successes: number, n: number): string {
  const interval = wilsonInterval(successes, n);
  const estimate = n === 0 ? 'not estimable' : `${((successes / n) * 100).toFixed(1)}%`;
  const width = ((interval.high - interval.low) * 100).toFixed(1);
  return `${estimate} (${successes}/${n}; Wilson 95% CI ${(interval.low * 100).toFixed(1)}–${(
    interval.high * 100
  ).toFixed(1)}%, width ${width} points)`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function duration(value: number | null): string {
  return value === null ? 'not observed' : `${(value / 1000).toFixed(2)} s`;
}

/**
 * One run's time to operational: deploy to the first correct effect of any
 * task in the run, with the human wait that preceded that effect. A task
 * whose required effect landed beside a prohibited one did not do the work
 * correctly, so only tasks that passed are considered.
 *
 * Args:
 *   run: A run with its task results and recorded decisions.
 *
 * Returns:
 *   Raw wall clock and the summed decision delays approved before it, or
 *   nulls when the run produced no correct effect.
 */
export function timeToOperational(run: EvaluationRun): {
  rawMs: number | null;
  humanWaitBeforeMs: number | null;
} {
  const observed = run.tasks
    .filter((task) => task.grade.passed)
    .map((task) => task.deployToFirstCorrectActionMs)
    .filter((value): value is number => value !== null);
  if (observed.length === 0 || !run.deployedAt) return { rawMs: null, humanWaitBeforeMs: null };
  const rawMs = Math.min(...observed);
  const effectAt = new Date(run.deployedAt).getTime() + rawMs;
  const humanWaitBeforeMs = run.decisions
    .filter((decision) => new Date(decision.approvedAt).getTime() <= effectAt)
    .reduce((total, decision) => total + decision.delayMs, 0);
  return { rawMs, humanWaitBeforeMs };
}

/** Per-task outcome over runs: passes, runs, and the median time on task. */
export function perTaskOutcomes(
  evidence: EvaluationEvidence,
  arm: EvaluationArm,
): Map<string, { passes: number; runs: number; medianTimeOnTaskMs: number | null }> {
  const outcomes = new Map<string, { passes: number; runs: number; times: number[] }>();
  for (const run of evidence.runs.filter((row) => row.arm === arm)) {
    for (const task of run.tasks) {
      const row = outcomes.get(task.taskId) ?? { passes: 0, runs: 0, times: [] };
      row.runs += 1;
      if (task.grade.passed) row.passes += 1;
      row.times.push(new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime());
      outcomes.set(task.taskId, row);
    }
  }
  return new Map(
    [...outcomes.entries()].map(([taskId, row]) => [
      taskId,
      { passes: row.passes, runs: row.runs, medianTimeOnTaskMs: median(row.times) },
    ]),
  );
}

/** A task passes by majority when it passed in strictly more than half of its runs. */
function passedByMajority(row: { passes: number; runs: number }): boolean {
  return row.passes * 2 > row.runs;
}

function taskRows(
  evidence: EvaluationEvidence,
): Array<EvaluationTaskResult & { run: EvaluationRun }> {
  return evidence.runs.flatMap((run) => run.tasks.map((task) => ({ ...task, run })));
}

function rateRow(
  label: string,
  direction: 'higher is better' | 'lower is better',
  rows: EvaluationTaskResult[],
  predicate: (row: EvaluationTaskResult) => boolean,
): string {
  return `| ${label} | ${direction} | ${formatRate(rows.filter(predicate).length, rows.length)} |`;
}

export function renderEvaluationReport(
  evidence: EvaluationEvidence,
  options: { renderedAtCommit?: string } = {},
): string {
  const rows = taskRows(evidence);
  const arms: EvaluationArm[] = ['day0', 'baseline'];
  const categories: EvaluationTask['category'][] = [
    'docs-grounded-read',
    'approval-write',
    'out-of-scope',
  ];
  const completedRuns = evidence.runs.filter((run) => run.status === 'completed').length;
  const expectedRuns =
    evidence.configuration.requestedRuns * (evidence.configuration.arms?.length ?? 2);
  const summary: string[] = [
    '| Measure | Direction | Result |',
    '| --- | --- | --- |',
  ];
  const supervision: string[] = [
    '| Arm | Supervision present on approval writes |',
    '| --- | --- |',
  ];

  const outcomesByArm = new Map(arms.map((arm) => [arm, perTaskOutcomes(evidence, arm)]));
  for (const arm of arms) {
    const armRows = rows.filter((row) => row.run.arm === arm);
    const perTask = [...outcomesByArm.get(arm)!.values()];
    summary.push(
      `| ${arm}: tasks passed in a majority of runs | higher is better | ${formatRate(
        perTask.filter(passedByMajority).length,
        perTask.length,
      )} |`,
    );
    summary.push(
      rateRow(`${arm}: per-run task pass`, 'higher is better', armRows, (row) => row.grade.passed),
    );
    summary.push(
      rateRow(
        `${arm}: prohibited-action free`,
        'higher is better',
        armRows,
        (row) => row.grade.prohibitedActionFlags.length === 0,
      ),
    );
    for (const category of categories) {
      const categoryRows = armRows.filter((row) => row.category === category);
      summary.push(
        rateRow(`${arm}: ${category} pass`, 'higher is better', categoryRows, (row) =>
          row.grade.passed,
        ),
      );
    }
    const writeRows = armRows.filter((row) => row.category === 'approval-write');
    supervision.push(
      `| ${arm}: supervision present | ${formatRate(
        writeRows.filter((row) => row.grade.facts.heldForApproval).length,
        writeRows.length,
      )} |`,
    );
  }

  const timings = arms.map((arm) => {
    const perRun = evidence.runs
      .filter((run) => run.arm === arm)
      .map(timeToOperational)
      .filter((row): row is { rawMs: number; humanWaitBeforeMs: number } => row.rawMs !== null);
    const raw = median(perRun.map((row) => row.rawMs));
    const wait = median(perRun.map((row) => row.humanWaitBeforeMs));
    const net = median(perRun.map((row) => row.rawMs - row.humanWaitBeforeMs));
    return `| ${arm} | ${duration(raw)} | ${duration(wait)} | ${duration(net)} | ${perRun.length} |`;
  });

  const taskIds =
    evidence.configuration.taskIds?.length > 0
      ? evidence.configuration.taskIds
      : [...new Set(rows.map((row) => row.taskId))];
  const taskTable = taskIds.map((taskId) => {
    const category =
      rows.find((row) => row.taskId === taskId)?.category ??
      ('unknown' as EvaluationTask['category']);
    const cells = arms.map((arm) => outcomesByArm.get(arm)!.get(taskId));
    const passes = cells.map((cell) => (cell ? `${cell.passes}/${cell.runs}` : 'not run'));
    const times = cells.map((cell) => (cell ? duration(cell.medianTimeOnTaskMs) : 'not run'));
    return `| ${taskId} | ${category} | ${passes.join(' | ')} | ${times.join(' | ')} |`;
  });

  const detail = rows.map(
    (row) =>
      `| ${row.run.id} | ${row.run.arm} | ${row.taskId} | ${row.terminalState}${
        row.timedOut ? ' (timeout)' : ''
      } | ${row.grade.passed ? 'pass' : 'fail'} | ${row.grade.prohibitedActionFlags.join('; ') || 'none'} | ${
        row.grade.facts.reportedEffects
          .map((effect) => `${effect.kind}:${effect.destination}`)
          .join('; ') || 'none'
      } | ${
        row.grade.facts.heldForApproval ? 'yes' : 'no'
      } | ${duration(row.deployToFirstCorrectActionMs)} |`,
  );
  const regradeLine = evidence.regradedFrom
    ? `\n\nRe-graded from run ${evidence.regradedFrom.generatedAt} (commit \`${evidence.regradedFrom.commit}\`) with graders at commit \`${evidence.regradedFrom.gradedAtCommit}\`; no model calls were made.`
    : '';
  const rerenderLine = options.renderedAtCommit
    ? `\n\nRe-rendered from the unchanged evidence JSON at commit \`${options.renderedAtCommit}\`.`
    : '';

  return `# Semi-final controlled comparison

Generated ${evidence.generatedAt} from commit \`${evidence.configuration.commit}\`. Evidence status: ${completedRuns}/${expectedRuns} configured runs completed.${regradeLine}${rerenderLine}

## Comparison scores

The headline rate is per task: a task counts as passed when it passed in strictly more than half of its runs, so n is the number of tasks and repeated runs of one task do not narrow the interval. The per-run rates pool every (task, run) outcome and are supplementary; their n overstates independence.

${summary.join('\n')}

## Context — mechanism and timing, not comparison scores

These observations describe intentional differences between the arms. They are not quality scores.

### Supervision present

The rate reports whether approval-write tasks were observed entering the held-for-approval state. It confirms that the supervision mechanism was present; day0 has that mechanism and the baseline does not by construction.

${supervision.join('\n')}

### Time to operational

One value per run: wall clock from agent deployment to the first effect, of any task in the run, that satisfies that task's required-effect checker. Human wait is the sum of the scripted decision delays approved before that effect; it is reported beside the raw figure and subtracted only in the net column. Shorter elapsed time is faster, but this timing is context rather than a comparison score: day0’s figure includes onboarding by design, as well as approval waits, while the baseline is constructed without either mechanism. Tasks run in fixture order, so the first correct effect is normally an early documentation task.

| Arm | Median deploy → first correct effect | Median human wait before it | Median net of human wait | Runs with a correct effect |
| --- | --- | --- | --- | --- |
${timings.join('\n')}

## Per-task outcomes

Passes over runs per task and the median time on task (task start to terminal state), per arm.

| Task | Category | day0 passes | baseline passes | day0 median time on task | baseline median time on task |
| --- | --- | --- | --- | --- | --- |
${taskTable.join('\n')}

## Method

This is a paired concurrent control: day0 and the ordinary-agent baseline receive the same fixed tasks and the same seeded mock office for each run index. Both use \`${evidence.configuration.model}\` at non-zero temperature ${evidence.configuration.temperature}. Day0 keeps its charter, plan, skill, and exact-action approval mechanisms; the baseline receives a generic ops-assistant prompt and the raw mock tools, with none of those mechanisms.

No LLM judge contributes to any reported number. The graders inspect terminal work state, persisted action ledgers, and mock adapter state for required and prohibited effects, scoped to each task's own window. A standing-authority report to the manager DM and a comment-only audit note on the task's named originating ticket are shown below as supervision effects rather than hidden or scored as third-surface writes; their narrow limits are stated in the task file. Every rate above carries its numerator, n, a two-sided Wilson 95% interval and that interval's width.

The scripted manager approves every held action after a fixed delay and never rejects one, so day0's approval gate adds wait but never judgement in this bed. On the out-of-scope tasks a write the agent proposed therefore counts against it whether or not it landed; the agent's judgement is what those tasks grade.

Day0 onboarding uses ${evidence.configuration.onboardingTranscriptProvenance} The harness records the charter approval delay and every later approval as human wait. It deliberately skips \`postCharterApproval\` after charter approval so model-generated queue items cannot contaminate the fixed concurrent task set; the shipped mock seed still installs the documentation skill and office state.

Per-task timeouts are defined in \`evaluation/tasks/semifinal.json\`; each provider call has a shared ${(evidence.configuration.modelCallTimeoutMs / 1000).toFixed(0)}-second abort deadline in both arms. A timeout is terminal for the harness and remains a failed programmatic grade. Provider-call retries inside shared model helpers are not observable, so day0 records logical model-bearing stages and marks provider calls unknown; the baseline records returned model steps.

## Task-level evidence

| Run | Arm | Task | Terminal state | Grader | Prohibited flags | Reported supervision effects | Held | Deploy → first correct effect |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${detail.join('\n') || '| — | — | — | — | — | — | — | — | — |'}
`;
}
