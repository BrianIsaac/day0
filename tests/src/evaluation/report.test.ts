import { describe, expect, it } from 'vitest';
import {
  formatRate,
  renderEvaluationReport,
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
    expect(formatRate(5, 10)).toBe('50.0% (5/10; Wilson 95% CI 23.7–76.3%)');
    expect(formatRate(0, 0)).toBe('not estimable (0/0; Wilson 95% CI 0.0–100.0%)');
  });

  it('renders the fixed concurrent control and programmatic-grading methodology', (): void => {
    const report = renderEvaluationReport(evidence());

    expect(report).toContain('1/1; Wilson 95% CI');
    expect(report).toContain('No LLM judge');
    expect(report).toContain('same fixed tasks');
    expect(report).toContain('human wait');
    expect(report).toContain('not a verbatim transcript');
    expect(report).toContain('| day0-r1 | day0 | docs-team-cadence | completed | pass |');
  });
});
