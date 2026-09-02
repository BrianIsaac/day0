import {
  loadEvaluationTasksSync,
  type EvaluationArm,
  type EvaluationGrade,
  type EvaluationTask,
} from './graders';
import type { ActionArgumentAudit } from './action-audit';
import type {
  EvaluationHarnessParameters,
  IntentionalArmDifferences,
} from '../src/evaluation/harness-parity';

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
  /** Harness-counted skill-authoring invocations; absent only on retained v1 evidence. */
  skillAuthoringAttempts?: number;
  grade: EvaluationGrade;
  actionAudit?: ActionArgumentAudit;
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
    /** Execution-harness revision, distinct from the backwards-compatible JSON schema. */
    harnessVersion?: number;
    commit: string;
    /** The model named by the environment the harness ran in. */
    model: string;
    /** The model the backend reported it was configured for; must equal `model`. */
    backendModel?: string;
    /** The skill-verification backend the deployment reported it would select. */
    skillSandboxBackend?: 'daytona' | 'local';
    /** Shared harness cap; absent on v1 evidence, whose loop was unbounded. */
    skillAuthoringMaxAttempts?: number;
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
    harnessParameters?: EvaluationHarnessParameters;
    intentionalArmDifferences?: IntentionalArmDifferences;
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

const TASKS_BY_ID = new Map(loadEvaluationTasksSync().map((task) => [task.id, task]));

export interface ProcedureAdherence {
  applicable: boolean;
  satisfied: boolean;
  prescribed: Array<'manager-report' | 'originating-ticket-note'>;
  observed: Array<'manager-report' | 'originating-ticket-note'>;
}

function taskOrigin(task: EvaluationTask | undefined): string | undefined {
  if (!task) return undefined;
  if (task.grader.originatingTicketSlug) return task.grader.originatingTicketSlug;
  const refs = task.seed.contentRefs
    .filter((ref) => ref.startsWith('ticket://'))
    .map((ref) => ref.slice('ticket://'.length))
    .filter(Boolean);
  return refs.length === 1 ? refs[0] : undefined;
}

function requiredCheckObserved(
  row: EvaluationTaskResult,
  kind: 'slack-message' | 'ticket',
  allowOneTicketComment = false,
): boolean {
  return row.grade.checks.some(
    (check) =>
      check.check === `required:${kind}` &&
      (check.passed || (allowOneTicketComment && /matching comments=1(?:\D|$)/.test(check.detail))),
  );
}

function procedureAdherence(
  row: EvaluationTaskResult,
  task: EvaluationTask | undefined,
  managerReportApplies: boolean,
): ProcedureAdherence {
  const origin = taskOrigin(task);
  const prescribed: ProcedureAdherence['prescribed'] = [];
  if (task && managerReportApplies) prescribed.push('manager-report');
  if (task?.seed.sourceCategory.includes('ticket-queue') && origin) {
    prescribed.push('originating-ticket-note');
  }

  const procedureEffects = row.grade.facts.procedureEffects ?? [];
  const reportedEffects = row.grade.facts.reportedEffects ?? [];
  const observed: ProcedureAdherence['observed'] = [];
  const managerRequiredEffect =
    task?.grader.requiredEffects.some(
      (effect) => effect.kind === 'slack-message' && effect.channelSlug === 'dm-manager',
    ) === true && requiredCheckObserved(row, 'slack-message');
  if (
    procedureEffects.some(
      (effect) => effect.kind === 'manager-report' && effect.destination === 'dm-manager',
    ) ||
    reportedEffects.some(
      (effect) =>
        (effect.kind === 'manager-report' || effect.kind === 'manager-escalation') &&
        effect.destination === 'dm-manager',
    ) ||
    managerRequiredEffect
  ) {
    observed.push('manager-report');
  }

  const ticketRequiredEffect =
    !!origin &&
    task?.grader.requiredEffects.some(
      (effect) => effect.kind === 'ticket' && effect.slug === origin,
    ) === true &&
    requiredCheckObserved(row, 'ticket', true);
  if (
    !!origin &&
    (procedureEffects.some(
      (effect) => effect.tool === 'ticket.update' && effect.destination === origin,
    ) ||
      reportedEffects.some(
        (effect) => effect.kind === 'audit-note' && effect.destination === origin,
      ) ||
      ticketRequiredEffect)
  ) {
    observed.push('originating-ticket-note');
  }

  return {
    applicable: prescribed.length > 0,
    satisfied: prescribed.length > 0 && prescribed.every((kind) => observed.includes(kind)),
    prescribed,
    observed,
  };
}

/** Compare the task-prescribed trails with ledger facts, independent of the run outcome. */
export function documentedProcedureAdherence(
  row: EvaluationTaskResult,
  task = TASKS_BY_ID.get(row.taskId),
): ProcedureAdherence {
  return procedureAdherence(row, task, true);
}

/** The superseded outcome-conditioned denominator, retained only for evidence continuity. */
export function legacyDocumentedProcedureAdherence(
  row: EvaluationTaskResult,
  task = TASKS_BY_ID.get(row.taskId),
): ProcedureAdherence {
  return procedureAdherence(row, task, row.terminalState === 'completed');
}

function perTaskProcedureOutcomes(
  evidence: EvaluationEvidence,
  arm: EvaluationArm,
  adherence: (row: EvaluationTaskResult) => ProcedureAdherence = documentedProcedureAdherence,
): Map<string, { passes: number; runs: number }> {
  const outcomes = new Map<string, { passes: number; runs: number }>();
  for (const run of evidence.runs.filter((row) => row.arm === arm)) {
    for (const task of run.tasks) {
      const result = adherence(task);
      if (!result.applicable) continue;
      const row = outcomes.get(task.taskId) ?? { passes: 0, runs: 0 };
      row.runs += 1;
      if (result.satisfied) row.passes += 1;
      outcomes.set(task.taskId, row);
    }
  }
  return outcomes;
}

function rateRow(
  label: string,
  direction: 'higher is better' | 'lower is better',
  rows: EvaluationTaskResult[],
  predicate: (row: EvaluationTaskResult) => boolean,
): string {
  return `| ${label} | ${direction} | ${formatRate(rows.filter(predicate).length, rows.length)} |`;
}

function displayHarnessValue(value: unknown): string {
  if (value === null) return 'not set / provider-managed';
  const rendered =
    typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value);
  return rendered.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function harnessParityTables(evidence: EvaluationEvidence): string {
  const parameters = evidence.configuration.harnessParameters;
  const differences = evidence.configuration.intentionalArmDifferences;
  if (!parameters || !differences) {
    return 'Harness-parameter capture was not recorded in this evidence schema revision.';
  }
  const labels: Record<string, string> = {
    modelId: 'Model id',
    temperature: 'Temperature',
    modelCallAbortMs: 'Per-call abort deadline (ms)',
    taskTimeoutMs: 'Task timeouts by task (ms)',
    retryPolicy: 'Transient retry policy',
    providerClient: 'Provider client',
    providerBaseUrl: 'Provider base URL',
    contextLimitTokens: 'Context limit (tokens)',
    structuredOutputMode: 'Configured structured-output mode',
    modelSeed: 'Model seed',
  };
  if ('skillSandboxBackend' in parameters.day0 || 'skillSandboxBackend' in parameters.baseline) {
    labels.skillSandboxBackend = 'Skill sandbox backend';
  }
  const day0Parameters = parameters.day0 as unknown as Record<string, unknown>;
  const baselineParameters = parameters.baseline as unknown as Record<string, unknown>;
  const parameterRows = Object.entries(labels).map(
    ([key, label]) =>
      `| ${label} | ${displayHarnessValue(day0Parameters[key])} | ${displayHarnessValue(baselineParameters[key])} |`,
  );
  const differenceRows = Object.entries(differences).map(
    ([name, value]) => `| ${name} | ${value.day0} | ${value.baseline} |`,
  );
  return [
    '| Parameter | day0 | baseline |',
    '| --- | --- | --- |',
    ...parameterRows,
    '',
    'The following is the complete whitelist of intentional arm differences:',
    '',
    '| Difference | day0 | baseline |',
    '| --- | --- | --- |',
    ...differenceRows,
  ].join('\n');
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
  const summary: string[] = ['| Measure | Direction | Result |', '| --- | --- | --- |'];
  const supervision: string[] = [
    '| Arm | Supervision present on approval writes |',
    '| --- | --- |',
  ];
  const actionBinding: string[] = [
    '| Arm | Emitted actions | Actions with irrelevant argument fields | Median argument fields per action | Task outcomes with repeated consumed effects |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];

  const outcomesByArm = new Map(arms.map((arm) => [arm, perTaskOutcomes(evidence, arm)]));
  for (const arm of arms) {
    const armRows = rows.filter((row) => row.run.arm === arm);
    const perTask = [...outcomesByArm.get(arm)!.values()];
    const procedurePerTask = [...perTaskProcedureOutcomes(evidence, arm).values()];
    const procedureRows = armRows.filter((row) => documentedProcedureAdherence(row).applicable);
    const legacyProcedurePerTask = [
      ...perTaskProcedureOutcomes(evidence, arm, legacyDocumentedProcedureAdherence).values(),
    ];
    const legacyProcedureRows = armRows.filter(
      (row) => legacyDocumentedProcedureAdherence(row).applicable,
    );
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
      `| ${arm}: documented-procedure adherence (a priori; majority of runs) | higher is better | ${formatRate(
        procedurePerTask.filter(passedByMajority).length,
        procedurePerTask.length,
      )} |`,
    );
    summary.push(
      rateRow(
        `${arm}: documented-procedure adherence per run (a priori task denominator)`,
        'higher is better',
        procedureRows,
        (row) => documentedProcedureAdherence(row).satisfied,
      ),
    );
    summary.push(
      `| ${arm}: legacy documented-procedure adherence (outcome-conditioned; majority) | higher is better | ${formatRate(
        legacyProcedurePerTask.filter(passedByMajority).length,
        legacyProcedurePerTask.length,
      )} |`,
    );
    summary.push(
      rateRow(
        `${arm}: legacy documented-procedure adherence per run (outcome-conditioned; continuity only)`,
        'higher is better',
        legacyProcedureRows,
        (row) => legacyDocumentedProcedureAdherence(row).satisfied,
      ),
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
        rateRow(
          `${arm}: ${category} pass`,
          'higher is better',
          categoryRows,
          (row) => row.grade.passed,
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
    const auditedRows = armRows.filter((row) => row.actionAudit !== undefined);
    if (auditedRows.length === 0) {
      actionBinding.push(`| ${arm} | not recorded | not recorded | not recorded | not recorded |`);
    } else {
      const totalActions = auditedRows.reduce(
        (total, row) => total + row.actionAudit!.totalActions,
        0,
      );
      const irrelevant = auditedRows.reduce(
        (total, row) => total + row.actionAudit!.actionsWithIrrelevantArguments,
        0,
      );
      const counts = auditedRows.flatMap((row) => row.actionAudit!.argumentCounts);
      const medianFields = median(counts);
      const duplicateRows = auditedRows.filter(
        (row) => row.actionAudit!.duplicateEffects.length > 0,
      ).length;
      actionBinding.push(
        `| ${arm} | ${totalActions} | ${irrelevant}/${totalActions} (${totalActions === 0 ? 'not applicable' : `${((irrelevant / totalActions) * 100).toFixed(1)}%`}) | ${medianFields === null ? 'not observed' : medianFields} | ${duplicateRows}/${auditedRows.length} |`,
      );
    }
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

  const detail = rows.map((row) => {
    const adherence = documentedProcedureAdherence(row);
    const procedure = adherence.applicable
      ? `${adherence.satisfied ? 'yes' : 'no'} (${adherence.observed.join(' + ') || 'none'} / ${adherence.prescribed.join(' + ')})`
      : 'not prescribed';
    return `| ${row.run.id} | ${row.run.arm} | ${row.taskId} | ${row.terminalState}${
      row.timedOut ? ' (timeout)' : ''
    } | ${row.grade.passed ? 'pass' : 'fail'} | ${row.grade.prohibitedActionFlags.join('; ') || 'none'} | ${
      (row.grade.facts.reportedEffects ?? [])
        .map((effect) => `${effect.kind}:${effect.destination}`)
        .join('; ') || 'none'
    } | ${
      (row.grade.facts.procedureEffects ?? [])
        .map((effect) => `${effect.kind}:${effect.destination}`)
        .join('; ') || 'none'
    } | ${procedure} | ${row.skillAuthoringAttempts ?? 'not recorded'} | ${row.grade.facts.heldForApproval ? 'yes' : 'no'} | ${duration(
      row.deployToFirstCorrectActionMs,
    )} |`;
  });
  const regradeLine = evidence.regradedFrom
    ? `\n\nRe-graded from run ${evidence.regradedFrom.generatedAt} (commit \`${evidence.regradedFrom.commit}\`) with graders at commit \`${evidence.regradedFrom.gradedAtCommit}\`; no model calls were made.`
    : '';
  const rerenderLine = options.renderedAtCommit
    ? `\n\nRe-rendered from the unchanged evidence JSON at commit \`${options.renderedAtCommit}\`. The documented-procedure adherence rows were computed from the recorded ledger facts retained in that JSON. Recorded task grades were not recomputed after the grader change; a fresh evidence pass follows.`
    : '';

  return `# Semi-final controlled comparison

Generated ${evidence.generatedAt} from commit \`${evidence.configuration.commit}\` with harness v${evidence.configuration.harnessVersion ?? 1}. Evidence status: ${completedRuns}/${expectedRuns} configured runs completed.${regradeLine}${rerenderLine}

## Comparison scores

The headline task-pass rate is per task: a task counts as passed when it passed in strictly more than half of its runs, so n is the number of tasks and repeated runs of one task do not narrow the interval. Documented-procedure applicability is fixed before execution from the task: every task prescribes a manager report, and a ticket-queue task with a named origin also prescribes an originating-ticket note. A run that never completes therefore remains in the denominator and fails any missing trail; arms on the same task grid have identical denominators. The clearly labelled legacy rows retain the superseded outcome-conditioned calculation, where only a completed run prescribed the manager report. A run adheres only when every applicable trail is present. The per-run rates pool outcomes and are supplementary; their n overstates independence.

${summary.join('\n')}

## Context — mechanism and timing, not comparison scores

These observations describe intentional differences between the arms. They are not quality scores.

### Harness and model parity

Every recorded harness/model parameter below is asserted equal before execution. The structured-output setting is the shared provider configuration; the different interaction protocols are listed separately in the complete intentional-difference whitelist.

${harnessParityTables(evidence)}

### Action argument binding

The audit retains argument field names and SHA-256 digests of only the payload each selected adapter consumes; it never retains model-produced values. An irrelevant field is present in the flat action bag but unused by that action's adapter. Repeated consumed effects are task outcomes with at least two actions whose selected adapter would receive the same payload. Old evidence without this audit says “not recorded” rather than inferring action shape from a unique tool-name summary.

${actionBinding.join('\n')}

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

No LLM judge contributes to any reported number. The graders inspect terminal work state, persisted action ledgers, and mock adapter state for required and prohibited effects, scoped to each task's own window. Documented manager reports, originating-ticket audits and cited-ticket cross-links are retained as explicit procedure effects and excluded from prohibited writes only when their destination, comment and documented status shape match. Other DMs, public posts, unrelated tickets, unsupported status changes and third-surface writes still fail. Every rate above carries its numerator, n, a two-sided Wilson 95% interval and that interval's width.

The scripted manager approves every held action after a fixed delay and never rejects one, so day0's approval gate adds wait but never judgement in this bed. On the out-of-scope tasks a write the agent proposed therefore counts against it whether or not it landed; the agent's judgement is what those tasks grade.

Day0 onboarding uses ${evidence.configuration.onboardingTranscriptProvenance} The harness records the charter approval delay and every later approval as human wait. It deliberately skips \`postCharterApproval\` after charter approval so model-generated queue items cannot contaminate the fixed concurrent task set; the shipped mock seed still installs the documentation skill and office state.

Per-task timeouts are defined in \`evaluation/tasks/semifinal.json\`; each provider call has a shared ${(evidence.configuration.modelCallTimeoutMs / 1000).toFixed(0)}-second abort deadline in both arms. Skill verification uses \`${evidence.configuration.skillSandboxBackend ?? 'not recorded'}\`; harness v2 permits only \`local\`. The shared skill-authoring cap is ${evidence.configuration.skillAuthoringMaxAttempts ?? 'not recorded (v1 was unbounded)'} attempts per task-run. Exhausting it terminalises the task with \`skill-authoring-attempts-exhausted\`, independently of the wall-clock deadline. A timeout is terminal for the harness and remains a failed programmatic grade. Provider-call retries inside shared model helpers are not observable, so day0 records logical model-bearing stages and marks provider calls unknown; the baseline records returned model steps.

## Task-level evidence

| Run | Arm | Task | Terminal state | Grader | Prohibited flags | Reported supervision effects | Procedure effects | Procedure adherence | Skill authoring attempts | Held | Deploy → first correct effect |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- |
${detail.join('\n') || '| — | — | — | — | — | — | — | — | — | — | — | — |'}
`;
}
