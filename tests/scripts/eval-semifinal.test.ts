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

import { getFunctionName } from 'convex/server';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Doc } from '../../convex/_generated/dataModel';
import { driveBaselineState, driveDay0State, type HarnessContext } from '../../scripts/eval-semifinal';

interface RecordedCall {
  kind: 'query' | 'mutation' | 'action';
  name: string;
  args: unknown;
}

async function stubContext(
  responses: Partial<Record<string, unknown>> = {},
): Promise<{ context: HarnessContext; calls: RecordedCall[] }> {
  const calls: RecordedCall[] = [];
  const respond = (kind: RecordedCall['kind']) => async (fn: unknown, args: unknown) => {
    const name = getFunctionName(fn as never);
    calls.push({ kind, name, args });
    return responses[name] ?? {};
  };
  const dir = await mkdtemp(join(process.env.SCRATCHPAD_DIR ?? tmpdir(), 'eval-'));
  const context = {
    client: { query: respond('query'), mutation: respond('mutation'), action: respond('action') },
    authenticatedAt: Date.now(),
    evidence: {
      schemaVersion: 1,
      experiment: 'day0-semifinal-controlled-comparison',
      generatedAt: '',
      configuration: {} as never,
      runs: [],
    },
    outPath: join(dir, 'out.json'),
    reportPath: join(dir, 'out.md'),
    options: {
      arms: ['day0', 'baseline'],
      runs: 1,
      taskSelectors: [],
      out: join(dir, 'out.json'),
      approvalDelayMs: 1,
      pollIntervalMs: 1,
      help: false,
    },
  } as unknown as HarnessContext;
  return { context, calls };
}

function workItem(overrides: Partial<Doc<'workItems'>>): Doc<'workItems'> {
  return {
    _id: 'work-1',
    _creationTime: 0,
    agentId: 'agent-1',
    sourceCategory: 'inbox',
    sourceSystem: 'docs',
    externalId: 'EVAL-DOC-01',
    title: 'x',
    contentSummary: 'y',
    contentRefs: [],
    state: 'discovered',
    observedAt: 0,
    createdAt: 0,
    ...overrides,
  } as Doc<'workItems'>;
}

function activeTask() {
  return {
    taskId: 'docs-team-cadence',
    startedAt: new Date().toISOString(),
    humanWaitMs: 0,
    decisions: [],
    logicalStages: 0,
    observableProviderCalls: null,
  };
}

describe('headless day0 driver', (): void => {
  it('approves a held run once and then waits for the scheduled apply', async (): Promise<void> => {
    const { context, calls } = await stubContext();
    const run = { id: 'day0-r1', arm: 'day0', run: 1, status: 'running', humanWaitMs: 0, decisions: [], tasks: [] } as never;
    const pending = workItem({
      state: 'actions-pending',
      pendingRunId: 'run-1' as never,
      actionVerdicts: [{ disposition: 'held', reason: 'held' }] as never,
    });
    const active = activeTask();
    await driveDay0State(context, run, active, pending);
    expect(calls.map((call) => call.name)).toEqual(['work:approveActions']);
    expect(active.decisions).toHaveLength(1);

    await driveDay0State(context, run, active, { ...pending, approvedIndexes: [0] });
    expect(calls.map((call) => call.name)).toEqual(['work:approveActions']);
    expect(active.decisions).toHaveLength(1);
  });
});

describe('headless baseline driver', (): void => {
  it('executes only a discovered item and otherwise waits for the claimed run', async (): Promise<void> => {
    const { context, calls } = await stubContext({
      'baselineActions:executeTask': { ok: true, modelCalls: 3, toolCalls: 2 },
    });
    const active = activeTask();
    await driveBaselineState(context, active, workItem({ state: 'executing' }));
    expect(calls).toEqual([]);

    await driveBaselineState(context, active, workItem({ state: 'discovered' }));
    expect(calls.map((call) => call.name)).toEqual(['baselineActions:executeTask']);
    expect(active.logicalStages).toBe(3);
    expect(active.observableProviderCalls).toBe(3);
  });
});
