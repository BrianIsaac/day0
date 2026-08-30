import { describe, expect, it } from 'vitest';
import { loadEvaluationTasks } from '../../evaluation/graders';
import {
  isFatalEvaluationInfrastructureError,
  parseCliOptions,
  selectEvaluationTasks,
} from '../../scripts/eval-semifinal';

describe('semi-final evaluation CLI', (): void => {
  it('defaults to the full paired three-run comparison', (): void => {
    expect(parseCliOptions([])).toMatchObject({
      arms: ['day0', 'baseline'],
      runs: 3,
      taskSelectors: [],
      out: 'evaluation/results/semifinal.json',
      approvalDelayMs: 750,
      pollIntervalMs: 500,
    });
  });

  it('accepts arm, run, task and output subsets', (): void => {
    expect(
      parseCliOptions([
        '--arms',
        'baseline',
        '--runs',
        '2',
        '--tasks',
        'docs-team-cadence,EVAL-WRITE-01',
        '--out',
        '/tmp/evidence.json',
        '--approval-delay-ms',
        '20',
        '--poll-ms',
        '10',
      ]),
    ).toMatchObject({
      arms: ['baseline'],
      runs: 2,
      taskSelectors: ['docs-team-cadence', 'EVAL-WRITE-01'],
      out: '/tmp/evidence.json',
      approvalDelayMs: 20,
      pollIntervalMs: 10,
    });
  });

  it("accepts pnpm's optional argument separator", (): void => {
    expect(parseCliOptions(['--', '--arms', 'day0']).arms).toEqual(['day0']);
  });

  it('resolves either stable task ids or external ids in requested order', async (): Promise<void> => {
    const tasks = await loadEvaluationTasks();
    expect(
      selectEvaluationTasks(tasks, ['EVAL-WRITE-01', 'docs-team-cadence']).map((task) => task.id),
    ).toEqual(['write-pipeline-row', 'docs-team-cadence']);
    expect(() => selectEvaluationTasks(tasks, ['missing-task'])).toThrow('unknown evaluation task');
  });

  it('stops a run on hard provider billing or authentication failures', (): void => {
    expect(isFatalEvaluationInfrastructureError('You have no credits remaining.')).toBe(true);
    expect(isFatalEvaluationInfrastructureError('insufficient_quota')).toBe(true);
    expect(isFatalEvaluationInfrastructureError('invalid api key')).toBe(true);
    expect(isFatalEvaluationInfrastructureError('rate limit: retry later')).toBe(false);
    expect(isFatalEvaluationInfrastructureError(undefined)).toBe(false);
  });
});
