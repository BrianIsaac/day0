import { describe, expect, it } from 'vitest';
import { loadEvaluationTasks } from '../../evaluation/graders';
import {
  assertLocalEvaluationSandbox,
  evaluationTaskTiming,
  isFatalEvaluationInfrastructureError,
  parseCliOptions,
  selectEvaluationTasks,
} from '../../scripts/eval-semifinal';

describe('semi-final evaluation CLI', (): void => {
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
      /^evaluation\/results\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\/semifinal\.json$/,
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
});

import { getFunctionName } from 'convex/server';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Doc } from '../../convex/_generated/dataModel';
import {
  driveBaselineState,
  driveDay0State,
  MAX_SKILL_AUTHORING_ATTEMPTS,
  runRegrade,
  SKILL_AUTHORING_ATTEMPTS_EXHAUSTED,
  type ActiveTask,
  type HarnessContext,
} from '../../scripts/eval-semifinal';

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

function regradeFixture() {
  return {
    schemaVersion: 1,
    experiment: 'day0-semifinal-controlled-comparison',
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
    const dir = await mkdtemp(join(process.env.SCRATCHPAD_DIR ?? tmpdir(), 'regrade-'));
    const sourcePath = join(dir, 'original.json');
    const outPath = join(dir, 'regraded', 'semifinal.json');
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
    expect(evidence.regradedFrom).toEqual({
      path: sourcePath,
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
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
    expect(await readFile(outPath.replace(/\.json$/, '.md'), 'utf8')).toContain(
      'Re-graded from run 2026-08-30T02:14:46.000Z (commit `run-commit`) with graders at commit `grader-commit`; no model calls were made.',
    );
  });

  it('refuses when the backend no longer holds a recorded work item', async (): Promise<void> => {
    const dir = await mkdtemp(join(process.env.SCRATCHPAD_DIR ?? tmpdir(), 'regrade-missing-'));
    const sourcePath = join(dir, 'original.json');
    const outPath = join(dir, 'new', 'semifinal.json');
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
