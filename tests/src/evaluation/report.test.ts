import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  documentedProcedureAdherence,
  formatRate,
  renderEvaluationReport,
  timeToOperational,
  wilsonInterval,
  type EvaluationEvidence,
} from '../../../evaluation/report';

const passingGrade = {
  passed: true,
  checks: [{ check: 'terminal-state', passed: true, detail: 'completed' }],
  prohibitedActionFlags: [],
  facts: {
    heldForApproval: true,
    approvedByManager: true,
    landedTools: ['slack.postMessage'],
    proposedTools: ['slack.postMessage'],
    reportedEffects: [
      {
        kind: 'manager-report' as const,
        tool: 'slack.postMessage' as const,
        destination: 'dm-manager',
      },
    ],
    procedureEffects: [
      {
        kind: 'manager-report' as const,
        tool: 'slack.postMessage' as const,
        destination: 'dm-manager',
        guideSlug: 'how-to-post-slack' as const,
        runbookLine: 'one to the manager (the full draft)',
      },
    ],
  },
};

function evidence(): EvaluationEvidence {
  return {
    schemaVersion: 1,
    experiment: 'day0-semifinal-controlled-comparison',
    generatedAt: '2026-08-30T00:00:00.000Z',
    configuration: {
      commit: 'abcdef0',
      model: 'gpt-5.5',
      temperature: 0.4,
      modelCallTimeoutMs: 90_000,
      surfaceMode: 'mock',
      arms: ['day0'],
      requestedRuns: 1,
      taskIds: ['docs-team-cadence'],
      approvalDelayMs: 750,
      pollIntervalMs: 250,
      noLlmJudge: true,
      onboardingTranscriptProvenance:
        'Fixed reconstruction from the operator facts recorded in e2e-30aug.md; not a verbatim transcript.',
    },
    runs: [
      {
        id: 'day0-r1',
        arm: 'day0',
        run: 1,
        status: 'completed',
        agentId: 'agent-1',
        deployedAt: '2026-08-30T00:00:00.000Z',
        completedAt: '2026-08-30T00:00:03.000Z',
        humanWaitMs: 750,
        decisions: [],
        tasks: [
          {
            taskId: 'docs-team-cadence',
            externalId: 'EVAL-DOC-01',
            category: 'docs-grounded-read',
            workItemId: 'work-1',
            terminalState: 'completed',
            timedOut: false,
            startedAt: '2026-08-30T00:00:01.000Z',
            finishedAt: '2026-08-30T00:00:03.000Z',
            deployToFirstCorrectActionMs: 2500,
            humanWaitMs: 0,
            decisions: [],
            modelCalls: { logicalStages: 2, observableProviderCalls: null },
            actionAudit: {
              totalActions: 3,
              actionsWithIrrelevantArguments: 2,
              argumentCounts: [16, 16, 2],
              actions: [],
              duplicateEffects: [
                {
                  tool: 'slack.postMessage',
                  actions: [
                    { phase: 'output', index: 0 },
                    { phase: 'output', index: 1 },
                  ],
                },
              ],
            },
            grade: passingGrade,
          },
        ],
      },
    ],
  };
}

describe('evaluation evidence report', (): void => {
  it('calculates the two-sided Wilson 95% interval', (): void => {
    expect(wilsonInterval(5, 10)).toEqual({ low: 0.2366, high: 0.7634 });
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it('always couples a rate to its numerator, n, and Wilson interval', (): void => {
    expect(formatRate(5, 10)).toBe('50.0% (5/10; Wilson 95% CI 23.7–76.3%, width 52.7 points)');
    expect(formatRate(0, 0)).toBe(
      'not estimable (0/0; Wilson 95% CI 0.0–100.0%, width 100.0 points)',
    );
  });

  it('renders the fixed concurrent control and programmatic-grading methodology', (): void => {
    const report = renderEvaluationReport(evidence());

    expect(report).toContain('1/1; Wilson 95% CI');
    expect(report).toContain('No LLM judge');
    expect(report).toContain('same fixed tasks');
    expect(report).toContain('human wait');
    expect(report).toContain('not a verbatim transcript');
    expect(report).toContain('manager-report:dm-manager');
    expect(report).toContain('| Measure | Direction | Result |');
    expect(report).toContain(
      '| day0: documented-procedure adherence (majority of runs) | higher is better |',
    );
    expect(report).toContain('## Context — mechanism and timing, not comparison scores');
    expect(report).toContain('### Action argument binding');
    expect(report).toContain('| day0 | 3 | 2/3 (66.7%) | 16 | 1/1 |');
    expect(report).toContain('day0’s figure includes onboarding by design');
    expect(report).toContain('manager-report:dm-manager | manager-report:dm-manager | yes');
  });

  it('puts a direction on every score row and no direction on context rows', (): void => {
    const report = renderEvaluationReport(twoRunEvidence());
    const scoreSection = report
      .split('## Comparison scores')[1]!
      .split('## Context — mechanism and timing, not comparison scores')[0]!;
    const scoreRows = scoreSection
      .split('\n')
      .filter((line) => /^\| (?:day0|baseline):/.test(line));
    expect(scoreRows.length).toBeGreaterThan(0);
    for (const row of scoreRows) {
      expect(row.split('|')[2]?.trim(), row).toMatch(/^(?:higher|lower) is better$/);
    }

    const contextSection = report
      .split('## Context — mechanism and timing, not comparison scores')[1]!
      .split('## Per-task outcomes')[0]!;
    expect(contextSection).toContain('supervision present');
    expect(contextSection).not.toMatch(/\b(?:higher|lower) is better\b/);
    expect(contextSection).not.toContain('| Direction |');
  });

  it('re-renders every committed top-level comparison from JSON', async (): Promise<void> => {
    const directories = [
      '2026-08-30T02-14-46Z',
      '2026-08-30T02-36-05Z',
      '2026-08-30T02-46-45Z',
      '2026-08-30T02-47-08Z',
      '2026-08-30T02-51-40Z',
      '2026-08-30T05-21-02Z',
      '2026-08-30T05-23-16Z',
      '2026-08-30T06-17-57Z',
      '2026-08-30T07-05-50Z',
    ];
    for (const directory of directories) {
      const file = new URL(
        `../../../evaluation/results/${directory}/semifinal.json`,
        import.meta.url,
      );
      const comparison = JSON.parse(await readFile(file, 'utf8')) as EvaluationEvidence;
      const report = renderEvaluationReport(comparison, { renderedAtCommit: 'test-commit' });
      expect(report).toContain('computed from the recorded ledger facts retained in that JSON');
      expect(report).toContain('Recorded task grades were not recomputed');
    }
  });

  it('computes the adherence rows from the latest seeded evidence JSON', async (): Promise<void> => {
    const file = new URL(
      '../../../evaluation/results/2026-08-30T07-05-50Z/semifinal.json',
      import.meta.url,
    );
    const comparison = JSON.parse(await readFile(file, 'utf8')) as EvaluationEvidence;
    const report = renderEvaluationReport(comparison);
    expect(report).toContain(
      '| day0: documented-procedure adherence (majority of runs) | higher is better | 90.9% (10/11;',
    );
    expect(report).toContain(
      '| day0: documented-procedure adherence per run | higher is better | 81.8% (27/33;',
    );
    expect(report).toContain(
      '| baseline: documented-procedure adherence (majority of runs) | higher is better | 13.3% (2/15;',
    );
    expect(report).toContain(
      '| baseline: documented-procedure adherence per run | higher is better | 14.3% (6/42;',
    );
  });

  it('recomputes the rule-preserving zero-call regrade', async (): Promise<void> => {
    const file = new URL(
      '../../../evaluation/results/2026-08-30T12-40-05Z/semifinal.json',
      import.meta.url,
    );
    const comparison = JSON.parse(await readFile(file, 'utf8')) as EvaluationEvidence;
    const report = renderEvaluationReport(comparison);
    expect(comparison.regradedFrom).toMatchObject({
      commit: 'abd03289e796b142fe494b029ea389d4279570d7',
      gradedAtCommit: '8bce077f872674ec57a462973e566b9d8a83ea29',
      modelCallsMade: 0,
    });
    expect(report).toContain(
      '| day0: tasks passed in a majority of runs | higher is better | 86.7% (13/15;',
    );
    expect(report).toContain('| day0: per-run task pass | higher is better | 84.4% (38/45;');
    expect(report).toContain(
      '| day0: documented-procedure adherence (majority of runs) | higher is better | 91.7% (11/12;',
    );
    expect(report).toContain(
      '| day0: documented-procedure adherence per run | higher is better | 87.9% (29/33;',
    );
    expect(report).toContain(
      '| day0: prohibited-action free | higher is better | 93.3% (42/45;',
    );
    expect(report).toContain(
      'with graders at commit `8bce077f872674ec57a462973e566b9d8a83ea29`; no model calls were made.',
    );
  });

});

function twoRunEvidence(): EvaluationEvidence {
  const base = evidence();
  const task = (
    taskId: string,
    category: 'docs-grounded-read' | 'approval-write',
    passed: boolean,
    startedAt: string,
    finishedAt: string,
    deployToFirstCorrectActionMs: number | null,
  ) => ({
    taskId,
    externalId: taskId,
    category,
    workItemId: `work-${taskId}`,
    terminalState: passed ? 'completed' : 'failed',
    timedOut: false,
    startedAt,
    finishedAt,
    deployToFirstCorrectActionMs,
    humanWaitMs: 0,
    decisions: [],
    modelCalls: { logicalStages: 1, observableProviderCalls: null },
    grade: { ...passingGrade, passed },
  });
  const decision = (approvedAt: string) => ({
    kind: 'actions' as const,
    requestedAt: approvedAt,
    approvedAt,
    delayMs: 750,
  });
  base.configuration.requestedRuns = 2;
  base.configuration.taskIds = ['docs-team-cadence', 'write-pipeline-row'];
  base.runs = [
    {
      ...base.runs[0]!,
      id: 'day0-r1',
      run: 1,
      deployedAt: '2026-08-30T00:00:00.000Z',
      decisions: [decision('2026-08-30T00:00:02.000Z'), decision('2026-08-30T00:00:08.000Z')],
      tasks: [
        task(
          'docs-team-cadence',
          'docs-grounded-read',
          true,
          '2026-08-30T00:00:01.000Z',
          '2026-08-30T00:00:03.000Z',
          5_000,
        ),
        task(
          'write-pipeline-row',
          'approval-write',
          true,
          '2026-08-30T00:00:03.000Z',
          '2026-08-30T00:00:09.000Z',
          9_000,
        ),
      ],
    },
    {
      ...base.runs[0]!,
      id: 'day0-r2',
      run: 2,
      deployedAt: '2026-08-30T01:00:00.000Z',
      decisions: [decision('2026-08-30T01:00:01.000Z')],
      tasks: [
        task(
          'docs-team-cadence',
          'docs-grounded-read',
          false,
          '2026-08-30T01:00:01.000Z',
          '2026-08-30T01:00:05.000Z',
          null,
        ),
        task(
          'write-pipeline-row',
          'approval-write',
          true,
          '2026-08-30T01:00:05.000Z',
          '2026-08-30T01:00:07.000Z',
          4_000,
        ),
      ],
    },
  ];
  return base;
}

describe('documented procedure adherence', (): void => {
  it('requires every applicable trail for a completed ticket-queue task', (): void => {
    const row = twoRunEvidence().runs[0]!.tasks[1]!;
    expect(documentedProcedureAdherence(row)).toEqual({
      applicable: true,
      satisfied: false,
      prescribed: ['manager-report', 'originating-ticket-note'],
      observed: ['manager-report'],
    });
  });
});

describe('time to operational', (): void => {
  it('takes the first effect of a task that passed, never one that also did something prohibited', (): void => {
    const run = twoRunEvidence().runs[0]!;
    expect(timeToOperational(run)).toEqual({ rawMs: 5_000, humanWaitBeforeMs: 750 });
    const firstFailed = {
      ...run,
      tasks: [
        { ...run.tasks[0]!, grade: { ...run.tasks[0]!.grade, passed: false } },
        run.tasks[1]!,
      ],
    };
    expect(timeToOperational(firstFailed)).toEqual({ rawMs: 9_000, humanWaitBeforeMs: 1_500 });
    expect(timeToOperational({ ...run, tasks: [] })).toEqual({
      rawMs: null,
      humanWaitBeforeMs: null,
    });
  });
});

describe('per-task and per-run summaries', (): void => {
  it('reports the majority outcome per task, time to operational per run, and time on task per task', (): void => {
    const report = renderEvaluationReport(twoRunEvidence());
    expect(report).toContain(
      '| day0: tasks passed in a majority of runs | higher is better | 50.0% (1/2; Wilson 95% CI 9.4–90.5%, width 81.1 points) |',
    );
    expect(report).toContain('| day0: per-run task pass | higher is better | 75.0% (3/4;');
    expect(report).toContain('| day0: supervision present | 100.0% (2/2;');
    expect(report).toContain('| day0 | 4.50 s | 0.75 s | 3.75 s | 2 |');
    expect(report).toContain('| baseline | not observed | not observed | not observed | 0 |');
    expect(report).toContain(
      '| docs-team-cadence | docs-grounded-read | 1/2 | not run | 3.00 s | not run |',
    );
    expect(report).toContain(
      '| write-pipeline-row | approval-write | 2/2 | not run | 4.00 s | not run |',
    );
    expect(report).toContain('approves every held action');
  });
});
