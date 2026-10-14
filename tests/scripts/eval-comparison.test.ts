import { afterEach, describe, expect, it } from 'vitest';
import { loadEvaluationTasks, type EvaluationTask } from '../../evaluation/graders';
import {
  COMPARISON_EXPERIMENT,
  RECORDED_COMPARISON_EXPERIMENT,
  type EvaluationEvidence,
} from '../../evaluation/report';
import {
  evaluationHarnessParameters,
  INTENTIONAL_ARM_DIFFERENCES,
} from '../../src/evaluation/harness-parity';
import { MODEL_CALL_TIMEOUT_MS, MODEL_TEMPERATURE } from '../../src/lib/mastra';
import { MODEL } from '../../src/lib/openai';
import {
  assertLocalEvaluationSandbox,
  assertResumeCompatible,
  EVALUATION_HARNESS_VERSION,
  evaluationTaskTiming,
  isFatalEvaluationInfrastructureError,
  parseCliOptions,
  recordedSourcePath,
  runRetainedReread,
  selectEvaluationTasks,
} from '../../scripts/eval-comparison';

describe('comparison evaluation CLI', (): void => {
  it('defaults to the full paired three-run comparison', (): void => {
    const options = parseCliOptions([]);
    expect(options).toMatchObject({
      arms: ['day0', 'baseline'],
      runs: 3,
      taskSelectors: [],
      approvalDelayMs: 750,
      pollIntervalMs: 500,
    });
    expect(options.out).toMatch(
      /^evaluation\/results\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\/comparison\.json$/,
    );
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

  it('uses one non-binding task deadline for every v2 category', async (): Promise<void> => {
    const tasks = await loadEvaluationTasks();
    expect(new Set(tasks.map((task) => task.timeoutMs))).toEqual(new Set([900_000]));
  });

  it('stops a run on hard provider billing or authentication failures', (): void => {
    expect(isFatalEvaluationInfrastructureError('You have no credits remaining.')).toBe(true);
    expect(isFatalEvaluationInfrastructureError('insufficient_quota')).toBe(true);
    expect(isFatalEvaluationInfrastructureError('invalid api key')).toBe(true);
    expect(isFatalEvaluationInfrastructureError('rate limit: retry later')).toBe(false);
    expect(isFatalEvaluationInfrastructureError(undefined)).toBe(false);
  });

  it('refuses every evaluation deployment that would select Daytona', (): void => {
    expect(() => assertLocalEvaluationSandbox('daytona')).toThrow(
      'requires the local skill sandbox',
    );
    expect(() => assertLocalEvaluationSandbox('local')).not.toThrow();
  });

  it('counts a completed step after the deadline and records its overrun separately', (): void => {
    expect(evaluationTaskTiming('completed', 1_000, 900)).toEqual({
      timedOut: false,
      deadlineOverrunMs: 100,
    });
    expect(evaluationTaskTiming('executing', 1_001, 900)).toEqual({
      timedOut: true,
      deadlineOverrunMs: 101,
    });
    expect(evaluationTaskTiming('failed', 850, 900)).toEqual({
      timedOut: false,
      deadlineOverrunMs: 0,
    });
  });

  it('refuses to resume evidence whose task definitions differ from the task file', async (): Promise<void> => {
    const tasks = await loadEvaluationTasks();
    const options = parseCliOptions(['--out', 'evaluation/results/resume/comparison.json']);
    const taskTimeoutMs = Object.fromEntries(tasks.map((task) => [task.id, task.timeoutMs]));
    const recorded = (taskDefinitions: EvaluationTask[]): EvaluationEvidence => ({
      schemaVersion: 1,
      experiment: COMPARISON_EXPERIMENT,
      generatedAt: '2026-09-27T00:00:00.000Z',
      configuration: {
        harnessVersion: EVALUATION_HARNESS_VERSION,
        commit: 'resume-commit',
        model: MODEL,
        skillSandboxBackend: 'local',
        skillAuthoringMaxAttempts: MAX_SKILL_AUTHORING_ATTEMPTS,
        temperature: MODEL_TEMPERATURE,
        modelCallTimeoutMs: MODEL_CALL_TIMEOUT_MS,
        surfaceMode: 'mock',
        arms: options.arms,
        requestedRuns: options.runs,
        taskIds: tasks.map((task) => task.id),
        taskDefinitions,
        taskTimeoutMs,
        approvalDelayMs: options.approvalDelayMs,
        pollIntervalMs: options.pollIntervalMs,
        noLlmJudge: true,
        onboardingTranscriptProvenance: 'fixture',
        harnessParameters: evaluationHarnessParameters(taskTimeoutMs),
        intentionalArmDifferences: INTENTIONAL_ARM_DIFFERENCES,
      },
      runs: [],
    });

    expect(() =>
      assertResumeCompatible(recorded(tasks), options, tasks, 'resume-commit'),
    ).not.toThrow();
    const edited = tasks.map((task, index) =>
      index === 0
        ? { ...task, grader: { ...task.grader, exactCheck: `${task.grader.exactCheck} Edited.` } }
        : task,
    );
    expect(() => assertResumeCompatible(recorded(edited), options, tasks, 'resume-commit')).toThrow(
      'was created with different code or options',
    );
  });
});

import { getFunctionName } from 'convex/server';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Doc } from '../../convex/_generated/dataModel';
import {
  driveBaselineState,
  driveDay0State,
  MAX_SKILL_AUTHORING_ATTEMPTS,
  runRegrade,
  runTask,
  SKILL_AUTHORING_ATTEMPTS_EXHAUSTED,
  terminalTimestamp,
  type ActiveTask,
  type HarnessContext,
  type RunWithProgress,
} from '../../scripts/eval-comparison';

const temporaryDirectories: string[] = [];

/** A fresh directory under the system temp root, removed after the test. */
async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
  const dir = await temporaryDirectory('eval-');
  const context = {
    client: { query: respond('query'), mutation: respond('mutation'), action: respond('action') },
    authenticatedAt: Date.now(),
    evidence: {
      schemaVersion: 1,
      experiment: COMPARISON_EXPERIMENT,
      generatedAt: '',
      configuration: {
        commit: 'abc',
        model: 'gpt-5.6-terra',
        temperature: 0.4,
        modelCallTimeoutMs: 90_000,
        surfaceMode: 'mock',
        arms: ['day0', 'baseline'],
        requestedRuns: 1,
        taskIds: ['docs-team-cadence'],
        approvalDelayMs: 1,
        pollIntervalMs: 1,
        noLlmJudge: true,
        onboardingTranscriptProvenance: 'fixture',
      },
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

function activeTask(): ActiveTask {
  return {
    taskId: 'docs-team-cadence',
    startedAt: new Date().toISOString(),
    humanWaitMs: 0,
    decisions: [],
    logicalStages: 0,
    observableProviderCalls: null,
    skillAuthoringAttempts: 0,
  };
}

describe('headless day0 driver', (): void => {
  it('counts a bounded action-set repair as an additional logical model call', async (): Promise<void> => {
    const { context, calls } = await stubContext({
      'workActions:executeApprovedPlan': { ok: true, additionalModelCalls: 1 },
    });
    const run = {
      id: 'day0-r1',
      arm: 'day0',
      run: 1,
      status: 'running',
      humanWaitMs: 0,
      decisions: [],
      tasks: [],
    } as never;
    const active = activeTask();

    await driveDay0State(context, run, active, workItem({ state: 'plan-approved' }));

    expect(calls.map((call) => call.name)).toEqual(['workActions:executeApprovedPlan']);
    expect(active.logicalStages).toBe(2);
  });

  it('approves a held run once and then waits for the scheduled apply', async (): Promise<void> => {
    const { context, calls } = await stubContext();
    const run = {
      id: 'day0-r1',
      arm: 'day0',
      run: 1,
      status: 'running',
      humanWaitMs: 0,
      decisions: [],
      tasks: [],
    } as never;
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

  it('fails with a recorded reason after the shared authoring-attempt cap', async (): Promise<void> => {
    const { context, calls } = await stubContext({
      'skills:get': {
        _id: 'skill-1',
        name: 'generic-skill',
        state: 'failed',
        createdAt: 1,
      },
      'evaluation:failSkillAuthoringAttempts': { failed: true },
    });
    const run = {
      id: 'day0-r1',
      arm: 'day0',
      run: 1,
      status: 'running',
      humanWaitMs: 0,
      decisions: [],
      tasks: [],
    } as never;
    const active = activeTask();
    active.skillAuthoringAttempts = MAX_SKILL_AUTHORING_ATTEMPTS;

    await driveDay0State(
      context,
      run,
      active,
      workItem({ state: 'needs-skill', proposedSkillId: 'skill-1' as never }),
    );

    expect(calls.map((call) => call.name)).toEqual([
      'skills:get',
      'evaluation:failSkillAuthoringAttempts',
    ]);
    expect(active.lastError).toBe(SKILL_AUTHORING_ATTEMPTS_EXHAUSTED);
    expect(active.skillAuthoringAttempts).toBe(MAX_SKILL_AUTHORING_ATTEMPTS);
  });

  it('records each authoring invocation before another retry can be considered', async (): Promise<void> => {
    const { context, calls } = await stubContext({
      'skills:get': {
        _id: 'skill-1',
        name: 'generic-skill',
        state: 'failed',
        createdAt: 1,
      },
      'skillActions:authorAndRegisterSkill': { ok: false, reason: 'verification failed' },
    });
    const run = {
      id: 'day0-r1',
      arm: 'day0',
      run: 1,
      status: 'running',
      humanWaitMs: 0,
      decisions: [],
      tasks: [],
    } as never;
    const active = activeTask();

    await driveDay0State(
      context,
      run,
      active,
      workItem({ state: 'needs-skill', proposedSkillId: 'skill-1' as never }),
    );

    expect(calls.map((call) => call.name)).toEqual([
      'skills:get',
      'skillActions:authorAndRegisterSkill',
    ]);
    expect(active.skillAuthoringAttempts).toBe(1);
    expect(active.logicalStages).toBe(1);
    expect(active.lastError).toBe('verification failed');
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

/** The backend's snapshot of an agent that holds one work item and nothing else. */
function snapshotOf(item: Doc<'workItems'>) {
  return {
    workItems: [item],
    events: [],
    spreadsheets: [],
    slackMessages: [],
    tweetReplies: [],
    tickets: [],
  };
}

describe('the result a task-run writes', (): void => {
  /** The result written for the Northstar task once its work item has ended as given. */
  async function writtenResult(arm: RunWithProgress['arm'], ended: Partial<Doc<'workItems'>>) {
    const task = (await loadEvaluationTasks()).find((row) => row.id === 'scope-northstar-figure')!;
    const { context } = await stubContext({
      'evaluation:snapshot': snapshotOf(workItem({ externalId: task.seed.externalId, ...ended })),
    });
    const run: RunWithProgress = {
      id: `${arm}-r1`,
      arm,
      run: 1,
      status: 'running',
      humanWaitMs: 0,
      decisions: [],
      tasks: [],
    };
    return await runTask(context, run, 'agent-1' as never, task);
  }

  it('keeps the permissions the verdict named as missing beside the grade of a deferred row', async (): Promise<void> => {
    const result = await writtenResult('day0', {
      state: 'deferred',
      verdict: {
        decision: 'defer',
        reason: 'awaiting-permission',
        missingPermissions: ['northstar:read'],
      } as never,
    });

    expect(result.terminalState).toBe('deferred');
    expect(result.missingPermissions).toEqual(['northstar:read']);
    expect(result.grade.facts.outOfScope).toEqual({
      decided: true,
      decidedBy: 'deferral',
      explained: false,
    });
  });

  it('keeps an empty list for a row deferred because its evaluation could not be had', async (): Promise<void> => {
    const result = await writtenResult('day0', {
      state: 'deferred',
      verdict: {
        decision: 'defer',
        reason: 'evaluation-unavailable',
        attempts: 3,
        missingPermissions: [],
      } as never,
    });

    expect(result.missingPermissions).toEqual([]);
    expect(result.grade.facts.outOfScope).toEqual({ decided: false, explained: false });
  });

  it('keeps an empty list for a row whose work item has no verdict', async (): Promise<void> => {
    const result = await writtenResult('baseline', { state: 'failed' });

    expect(result.missingPermissions).toEqual([]);
  });
});

function regradeFixture() {
  return {
    schemaVersion: 1,
    experiment: RECORDED_COMPARISON_EXPERIMENT,
    generatedAt: '2026-08-30T02:14:46.000Z',
    configuration: {
      commit: 'run-commit',
      model: 'gpt-5.6-terra',
      temperature: 0.4,
      modelCallTimeoutMs: 90_000,
      surfaceMode: 'mock',
      arms: ['day0'],
      requestedRuns: 1,
      taskIds: ['docs-salesforce-escalation'],
      approvalDelayMs: 750,
      pollIntervalMs: 500,
      noLlmJudge: true,
      onboardingTranscriptProvenance: 'fixture',
    },
    runs: [
      {
        id: 'day0-r1',
        arm: 'day0',
        run: 1,
        status: 'completed',
        agentId: 'agent-1',
        deployedAt: '1970-01-01T00:00:00.000Z',
        completedAt: '1970-01-01T00:00:03.000Z',
        humanWaitMs: 750,
        decisions: [],
        tasks: [
          {
            taskId: 'docs-salesforce-escalation',
            externalId: 'EVAL-DOC-04',
            category: 'docs-grounded-read',
            workItemId: 'work-1',
            terminalState: 'completed',
            timedOut: false,
            startedAt: '1970-01-01T00:00:01.000Z',
            finishedAt: '1970-01-01T00:00:03.000Z',
            deployToFirstCorrectActionMs: null,
            humanWaitMs: 750,
            decisions: [],
            modelCalls: { logicalStages: 3, observableProviderCalls: null },
            grade: {
              passed: false,
              checks: [],
              prohibitedActionFlags: ['landed-write:slack.postMessage'],
              facts: {
                heldForApproval: true,
                approvedByManager: true,
                landedTools: ['ticket.update', 'slack.postMessage'],
                proposedTools: ['ticket.update', 'slack.postMessage'],
              },
            },
          },
        ],
      },
    ],
  };
}

function retainedSnapshot() {
  const comment = 'EVAL-DOC-04: Salesforce changes require escalation (Escalation paths).';
  const report = 'Completed EVAL-DOC-04 for manager review.';
  const flatDefaults = {
    body: '',
    cells: [],
    channelSlug: '',
    headersJson: '',
    method: '',
    path: '',
    sheetSlug: '',
    surface: '',
    tabName: '',
    threadKey: '',
    tool: '',
    toolArgsJson: '',
    tweetSlug: '',
  };
  return {
    workItems: [
      {
        _id: 'work-1',
        _creationTime: 1_000,
        agentId: 'agent-1',
        sourceCategory: 'ticket-queue',
        sourceSystem: 'docs',
        externalId: 'EVAL-DOC-04',
        title: 'x',
        contentSummary: 'y',
        contentRefs: ['ticket://REVOPS-EVAL-04'],
        state: 'completed',
        observedAt: 1_000,
        createdAt: 1_000,
        output: {
          actions: [
            {
              tool: 'ticket.update',
              args: {
                ...flatDefaults,
                slug: 'REVOPS-EVAL-04',
                status: 'open',
                comment,
              },
            },
            {
              tool: 'ticket.update',
              args: {
                ...flatDefaults,
                slug: 'REVOPS-EVAL-04',
                status: 'done',
                comment: '',
              },
            },
            {
              tool: 'slack.postMessage',
              args: { channelSlug: 'dm-manager', body: report },
            },
          ],
          applied: [
            { tool: 'ticket.update', ok: true, authority: 'manager' },
            { tool: 'ticket.update', ok: true, authority: 'manager' },
            { tool: 'slack.postMessage', ok: true, authority: 'standing' },
          ],
        },
      },
    ],
    events: [],
    spreadsheets: [],
    slackMessages: [
      {
        _id: 'message-1',
        _creationTime: 2_100,
        agentId: 'agent-1',
        channelSlug: 'dm-manager',
        sender: 'Day0',
        senderKind: 'agent-posted',
        body: report,
        timestamp: 2_100,
      },
    ],
    tweetReplies: [],
    tickets: [
      {
        _id: 'ticket-1',
        _creationTime: 0,
        agentId: 'agent-1',
        slug: 'REVOPS-EVAL-04',
        title: 'Salesforce escalation',
        body: 'x',
        status: 'done',
        comments: [
          { author: 'Day0', body: comment, timestamp: 2_000 },
          { author: 'Day0', body: comment, timestamp: 4_000 },
        ],
        updatedAt: 2_000,
      },
    ],
  };
}

describe('read-only evidence re-grading', (): void => {
  it('writes a new grade from retained state with provenance and no model calls', async (): Promise<void> => {
    const dir = await temporaryDirectory('regrade-');
    const sourcePath = join(dir, 'original.json');
    const outPath = join(dir, 'regraded', 'comparison.json');
    await writeFile(sourcePath, `${JSON.stringify(regradeFixture(), null, 2)}\n`, 'utf8');
    const original = await readFile(sourcePath, 'utf8');
    const calls: string[] = [];
    const client = {
      setAuth: (): void => undefined,
      query: async (fn: unknown): Promise<unknown> => {
        const name = getFunctionName(fn as never);
        calls.push(name);
        if (name === 'config:surfaceMode') return { mode: 'mock' };
        if (name === 'evaluation:snapshot') return retainedSnapshot();
        throw new Error(`unexpected read ${name}`);
      },
    };

    const evidence = await runRegrade(
      parseCliOptions(['--regrade', sourcePath, '--out', outPath]),
      {
        client: client as never,
        authenticate: async (): Promise<void> => undefined,
        commit: 'grader-commit',
        now: new Date('2026-08-30T03:00:00.000Z'),
      },
    );

    expect(calls).toEqual(['config:surfaceMode', 'evaluation:snapshot']);
    expect(evidence.experiment).toBe(RECORDED_COMPARISON_EXPERIMENT);
    expect(evidence.regradedFrom).toEqual({
      path: 'original.json',
      commit: 'run-commit',
      gradedAtCommit: 'grader-commit',
      generatedAt: '2026-08-30T02:14:46.000Z',
      modelCallsMade: 0,
    });
    expect(evidence.runs[0]!.tasks[0]).toMatchObject({
      humanWaitMs: 750,
      deployToFirstCorrectActionMs: 2_000,
      modelCalls: { logicalStages: 3, observableProviderCalls: null },
      actionAudit: {
        totalActions: 3,
        actionsWithIrrelevantArguments: 2,
        argumentCounts: [16, 16, 2],
        duplicateEffects: [],
      },
      grade: {
        passed: true,
        prohibitedActionFlags: [],
        facts: {
          reportedEffects: [
            { kind: 'manager-report', tool: 'slack.postMessage', destination: 'dm-manager' },
          ],
          procedureEffects: [
            {
              kind: 'originating-ticket-audit',
              tool: 'ticket.update',
              destination: 'REVOPS-EVAL-04',
            },
            {
              kind: 'manager-report',
              tool: 'slack.postMessage',
              destination: 'dm-manager',
            },
          ],
        },
      },
    });
    expect(evidence.configuration.taskDefinitions).toEqual(
      (await loadEvaluationTasks()).filter((task) => task.id === 'docs-salesforce-escalation'),
    );
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
    expect(await readFile(outPath.replace(/\.json$/, '.md'), 'utf8')).toContain(
      'Re-graded from run 2026-08-30T02:14:46.000Z (commit `run-commit`) with graders at commit `grader-commit`; no model calls were made.',
    );
  });

  it('refuses a source that records another experiment', async (): Promise<void> => {
    const dir = await temporaryDirectory('regrade-foreign-');
    const sourcePath = join(dir, 'original.json');
    const outPath = join(dir, 'new', 'comparison.json');
    await writeFile(
      sourcePath,
      JSON.stringify({ ...regradeFixture(), experiment: 'day0-gate-accuracy' }),
      'utf8',
    );

    await expect(
      runRegrade(parseCliOptions(['--regrade', sourcePath, '--out', outPath]), {
        client: {
          setAuth: (): void => undefined,
          query: async (): Promise<unknown> => ({}),
        } as never,
        authenticate: async (): Promise<void> => undefined,
        commit: 'grader-commit',
      }),
    ).rejects.toThrow('regrade source is not evaluation evidence v1');
    await expect(readFile(outPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses when the backend no longer holds a recorded work item', async (): Promise<void> => {
    const dir = await temporaryDirectory('regrade-missing-');
    const sourcePath = join(dir, 'original.json');
    const outPath = join(dir, 'new', 'comparison.json');
    await writeFile(sourcePath, JSON.stringify(regradeFixture()), 'utf8');
    const client = {
      setAuth: (): void => undefined,
      query: async (fn: unknown): Promise<unknown> =>
        getFunctionName(fn as never) === 'config:surfaceMode'
          ? { mode: 'mock' }
          : { ...retainedSnapshot(), workItems: [] },
    };

    await expect(
      runRegrade(parseCliOptions(['--regrade', sourcePath, '--out', outPath]), {
        client: client as never,
        authenticate: async (): Promise<void> => undefined,
        commit: 'grader-commit',
      }),
    ).rejects.toThrow('backend does not hold recorded work item work-1 for day0-r1');
    await expect(readFile(outPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('a row graded again from its backend', (): void => {
  it('keeps the permissions the verdict named as missing, as a new result does', async (): Promise<void> => {
    const dir = await temporaryDirectory('regrade-verdict-');
    const sourcePath = join(dir, 'original.json');
    const fixture = regradeFixture();
    fixture.configuration.taskIds = ['scope-northstar-figure'];
    Object.assign(fixture.runs[0]!.tasks[0]!, {
      taskId: 'scope-northstar-figure',
      externalId: 'EVAL-SCOPE-05',
      category: 'out-of-scope',
      terminalState: 'deferred',
    });
    await writeFile(sourcePath, JSON.stringify(fixture), 'utf8');
    const deferred = {
      ...retainedSnapshot().workItems[0]!,
      externalId: 'EVAL-SCOPE-05',
      state: 'deferred',
      output: undefined,
      verdict: {
        decision: 'defer',
        reason: 'awaiting-permission',
        missingPermissions: ['northstar:read'],
      },
    };
    const client = {
      setAuth: (): void => undefined,
      query: async (fn: unknown): Promise<unknown> =>
        getFunctionName(fn as never) === 'config:surfaceMode'
          ? { mode: 'mock' }
          : { ...retainedSnapshot(), workItems: [deferred], slackMessages: [], tickets: [] },
    };

    const evidence = await runRegrade(
      parseCliOptions(['--regrade', sourcePath, '--out', join(dir, 'new', 'comparison.json')]),
      {
        client: client as never,
        authenticate: async (): Promise<void> => undefined,
        commit: 'grader-commit',
      },
    );

    expect(evidence.runs[0]!.tasks[0]).toMatchObject({
      terminalState: 'deferred',
      missingPermissions: ['northstar:read'],
      grade: { facts: { outOfScope: { decided: true, decidedBy: 'deferral', explained: false } } },
    });
  });
});

describe('re-reading a stored run from its retained grades', (): void => {
  it('takes the source by --reread and needs no backend', (): void => {
    expect(parseCliOptions(['--reread', 'stored.json', '--out', 'new.json'])).toMatchObject({
      reread: 'stored.json',
      out: 'new.json',
    });
    expect(() => parseCliOptions(['--reread', 'a.json', '--regrade', 'b.json'])).toThrow(
      '--reread and --regrade are two ways to grade again; pass one',
    );
  });

  it('writes a new evidence file and report beside nothing it read, and never opens a client', async (): Promise<void> => {
    const dir = await temporaryDirectory('reread-');
    const sourcePath = join(dir, 'original.json');
    const outPath = join(dir, 'reread', 'comparison.json');
    const fixture = regradeFixture();
    const task = fixture.runs[0]!.tasks[0]!;
    fixture.configuration.taskIds = ['scope-northstar-figure'];
    Object.assign(task, {
      taskId: 'scope-northstar-figure',
      externalId: 'EVAL-SCOPE-05',
      category: 'out-of-scope',
      terminalState: 'deferred',
      grade: {
        passed: true,
        checks: [
          { check: 'terminal-state', passed: true, detail: 'deferred' },
          {
            check: 'required:terminal-reason',
            passed: true,
            detail: 'terminal reason contained permission',
          },
          { check: 'prohibited-effects', passed: true, detail: 'no prohibited effects observed' },
        ],
        prohibitedActionFlags: [],
        facts: {
          heldForApproval: false,
          approvedByManager: false,
          landedTools: [],
          proposedTools: [],
          reportedEffects: [],
        },
      },
    });
    await writeFile(sourcePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    const original = await readFile(sourcePath, 'utf8');

    const evidence = await runRetainedReread(
      parseCliOptions(['--reread', sourcePath, '--out', outPath]),
      { commit: 'grader-commit', now: new Date('2026-10-11T06:00:00.000Z') },
    );

    expect(evidence.regradedFrom).toEqual({
      path: 'original.json',
      commit: 'run-commit',
      gradedAtCommit: 'grader-commit',
      generatedAt: '2026-08-30T02:14:46.000Z',
      modelCallsMade: 0,
      basis: 'retained-grade',
    });
    expect(evidence.runs[0]!.tasks[0]!.grade.facts.outOfScope).toEqual({
      decided: true,
      decidedBy: 'deferral',
      explained: null,
    });
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual(evidence);
    expect(await readFile(outPath.replace(/\.json$/, '.md'), 'utf8')).toContain(
      'Re-read from run 2026-08-30T02:14:46.000Z (commit `run-commit`) with graders at commit `grader-commit`',
    );
    await expect(
      runRetainedReread(parseCliOptions(['--reread', sourcePath, '--out', outPath]), {
        commit: 'grader-commit',
      }),
    ).rejects.toThrow('already exists');
  });
});

describe('the terminal time of a task', (): void => {
  const item = (overrides: Partial<Doc<'workItems'>>): Doc<'workItems'> =>
    ({ _id: 'work-1', state: 'failed', ...overrides }) as Doc<'workItems'>;
  const snapshot = (events: Array<{ type: string; payload: unknown; createdAt: number }>) =>
    ({ events }) as unknown as Parameters<typeof terminalTimestamp>[0];

  it('ends a rejected or interrupted apply at its own ledger event, not the poll time', (): void => {
    for (const type of ['work.actions-rejected', 'work.actions-interrupted']) {
      expect(
        terminalTimestamp(
          snapshot([
            { type: 'work.actions-pending', payload: { workItemId: 'work-1' }, createdAt: 3_000 },
            { type, payload: { workItemId: 'work-1' }, createdAt: 5_000 },
          ]),
          item({}),
        ),
        type,
      ).toBe(5_000);
    }
  });

  it('ends a row cancelled by a skill rejection at the rejection of its own proposal', (): void => {
    const rejection = (skillId: string) => ({
      type: 'skill.rejected',
      payload: { skillId, name: 'update-ticket' },
      createdAt: 7_000,
    });
    const cancelled = item({
      state: 'cancelled',
      proposedSkillId: 'skill-1' as Doc<'workItems'>['proposedSkillId'],
    });
    expect(terminalTimestamp(snapshot([rejection('skill-1')]), cancelled)).toBe(7_000);
    expect(terminalTimestamp(snapshot([rejection('skill-2')]), cancelled)).toBeNull();
  });
});

describe('the re-graded source path a result records', (): void => {
  it('keeps the path from its checkout root, never the machine directory the checkout sat in', (): void => {
    expect(
      recordedSourcePath(
        '/tmp/scratchpad/day0-eval/evaluation/results/2026-08-30T02-14-46Z/semifinal.json',
      ),
    ).toBe('evaluation/results/2026-08-30T02-14-46Z/semifinal.json');
    expect(recordedSourcePath('/home/someone/worktrees/day0/evaluation/results/x/a.json')).toBe(
      'evaluation/results/x/a.json',
    );
  });

  it('keeps a path under the working directory relative to it, and only the file name otherwise', (): void => {
    expect(recordedSourcePath('bed-results/run.json')).toBe('bed-results/run.json');
    expect(recordedSourcePath('/tmp/day0-regrade-abc/original.json')).toBe('original.json');
  });
});

import { vi } from 'vitest';
import { executeRun } from '../../scripts/eval-comparison';

describe('a manager identity for each run', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  async function stubSigningKey(): Promise<void> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    vi.stubEnv('DEV_NO_AUTH_SIGNING_KEY', Buffer.from(pkcs8).toString('base64'));
  }

  const subjectOf = (token: string): unknown =>
    (
      JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
        sub: unknown;
      }
    ).sub;

  it('signs each run in as its own manager, so no two runs share an owner or a skill library', async (): Promise<void> => {
    await stubSigningKey();
    const task = (await loadEvaluationTasks()).find((row) => row.id === 'docs-team-cadence')!;
    const { context, calls } = await stubContext({
      'baselineActions:deployBaseline': { agentId: 'agent-1', charterId: 'charter-1' },
      'evaluation:snapshot': snapshotOf(
        workItem({ externalId: task.seed.externalId, state: 'completed' }),
      ),
    });
    const tokens: string[] = [];
    context.client.setAuth = (token: string): void => {
      tokens.push(token);
      calls.push({ kind: 'query', name: 'setAuth', args: subjectOf(token) });
    };
    const run = (number: number): RunWithProgress => ({
      id: `baseline-r${number}`,
      arm: 'baseline',
      run: number,
      status: 'pending',
      humanWaitMs: 0,
      decisions: [],
      tasks: [],
    });
    const first = run(1);
    const second = run(2);

    await executeRun(context, first, [task]);
    await executeRun(context, second, [task]);

    expect(first.managerSubject).toMatch(/^dev-no-auth\|eval-manager-baseline-r1-\d+$/);
    expect(second.managerSubject).toMatch(/^dev-no-auth\|eval-manager-baseline-r2-\d+$/);
    expect(tokens.map(subjectOf)).toEqual([first.managerSubject, second.managerSubject]);
    const signIns = calls.flatMap((call, index) => (call.name === 'setAuth' ? [index] : []));
    const deploys = calls.flatMap((call, index) =>
      call.name === 'baselineActions:deployBaseline' ? [index] : [],
    );
    expect(signIns[0]!).toBeLessThan(deploys[0]!);
    expect(signIns[1]!).toBeLessThan(deploys[1]!);

    const resumed = { ...run(3), managerSubject: 'dev-no-auth|eval-manager-baseline-r3-7' };
    await executeRun(context, resumed, [task]);
    expect(resumed.managerSubject).toBe('dev-no-auth|eval-manager-baseline-r3-7');
    expect(subjectOf(tokens.at(-1)!)).toBe('dev-no-auth|eval-manager-baseline-r3-7');
  });

  it('reads each run back as the manager it ran under when graded again from its backend', async (): Promise<void> => {
    const dir = await temporaryDirectory('regrade-subject-');
    const sourcePath = join(dir, 'original.json');
    const fixture = regradeFixture();
    (fixture.runs[0] as { managerSubject?: string }).managerSubject =
      'dev-no-auth|eval-manager-day0-r1-5';
    await writeFile(sourcePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    const signedInAs: Array<string | undefined> = [];
    const reads: string[] = [];
    const client = {
      setAuth: (): void => undefined,
      query: async (fn: unknown): Promise<unknown> => {
        const name = getFunctionName(fn as never);
        reads.push(`${name} as ${signedInAs.at(-1) ?? 'the local manager'}`);
        if (name === 'config:surfaceMode') return { mode: 'mock' };
        if (name === 'evaluation:snapshot') return retainedSnapshot();
        throw new Error(`unexpected read ${name}`);
      },
    };

    await runRegrade(
      parseCliOptions(['--regrade', sourcePath, '--out', join(dir, 'new', 'comparison.json')]),
      {
        client: client as never,
        authenticate: async (subject?: string): Promise<void> => {
          signedInAs.push(subject);
        },
        commit: 'grader-commit',
        now: new Date('2026-10-14T05:00:00.000Z'),
      },
    );

    expect(reads).toEqual([
      'config:surfaceMode as the local manager',
      'evaluation:snapshot as dev-no-auth|eval-manager-day0-r1-5',
    ]);
  });
});

import { renderEvaluationReport } from '../../evaluation/report';
import { loadOrCreateEvidence } from '../../scripts/eval-comparison';

describe('what the charter-derived seeding left on a bed', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it('records the generated work items of each run by state, in place of a constant', async (): Promise<void> => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    vi.stubEnv('DEV_NO_AUTH_SIGNING_KEY', Buffer.from(pkcs8).toString('base64'));
    const task = (await loadEvaluationTasks()).find((row) => row.id === 'docs-team-cadence')!;
    const generated = (externalId: string, state: Doc<'workItems'>['state']) =>
      workItem({ _id: `work-${externalId}` as Doc<'workItems'>['_id'], externalId, state });
    const { context } = await stubContext({
      'baselineActions:deployBaseline': { agentId: 'agent-1', charterId: 'charter-1' },
      'evaluation:snapshot': {
        ...snapshotOf(workItem({ externalId: task.seed.externalId, state: 'completed' })),
        workItems: [
          workItem({ externalId: task.seed.externalId, state: 'completed' }),
          generated('GEN-1', 'discovered'),
          generated('GEN-2', 'discovered'),
          generated('GEN-3', 'skipped'),
        ],
        events: [
          { type: 'work.charter-derived', payload: { count: 3, role: 'RevOps' }, createdAt: 1 },
        ],
      },
    });
    context.client.setAuth = (): void => undefined;
    const run: RunWithProgress = {
      id: 'baseline-r1',
      arm: 'baseline',
      run: 1,
      status: 'pending',
      humanWaitMs: 0,
      decisions: [],
      tasks: [],
    };

    await executeRun(context, run, [task]);

    expect(run.status).toBe('completed');
    expect(run.charterDerivedWork).toEqual({
      seedings: 1,
      itemsSeeded: 3,
      workItems: 3,
      byState: { discovered: 2, skipped: 1 },
      readAt: expect.any(String),
    });
  });

  it('no longer asserts that the seeding was skipped, and says in the report what the bed did', async (): Promise<void> => {
    const tasks = await loadEvaluationTasks();
    const dir = await temporaryDirectory('eval-config-');
    const evidence = await loadOrCreateEvidence(
      { ...parseCliOptions(['--out', join(dir, 'comparison.json')]) },
      tasks,
    );
    expect(evidence.configuration).not.toHaveProperty('postCharterApprovalSkipped');
    expect(evidence.configuration.charterDerivedWorkRecorded).toBe(true);

    evidence.runs = [
      {
        id: 'day0-r1',
        arm: 'day0',
        run: 1,
        status: 'completed',
        humanWaitMs: 0,
        decisions: [],
        tasks: [],
        charterDerivedWork: {
          seedings: 1,
          itemsSeeded: 4,
          workItems: 4,
          byState: { discovered: 4 },
          readAt: '2026-10-14T05:00:00.000Z',
        },
      },
    ];
    const report = renderEvaluationReport(evidence);
    expect(report).not.toContain('deliberately skips');
    expect(report).toContain(
      'Approving a charter schedules the product’s charter-derived work generator, as it does for any employee, and the harness does not stop it. Each run records what the generator left on its employee at the run’s end: 4 work items over 1 run (discovered 4). None of them is one of the tasks, and the harness neither evaluates nor runs them.',
    );
  });
});
