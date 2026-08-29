#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { z } from 'zod';
import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import {
  firstCorrectEffectAt,
  gradeEvaluationTask,
  loadEvaluationTasks,
  type EvaluationArm,
  type EvaluationSnapshot,
  type EvaluationTask,
} from '../evaluation/graders';
import {
  renderEvaluationReport,
  type EvaluationDecision,
  type EvaluationEvidence,
  type EvaluationRun,
  type EvaluationTaskResult,
} from '../evaluation/report';
import { mintDevNoAuthToken } from '../src/lib/dev-auth-token';
import { MODEL_TEMPERATURE } from '../src/lib/mastra';
import { MODEL } from '../src/lib/openai';

const DEFAULT_OUT = 'evaluation/results/semifinal.json';
const DEFAULT_APPROVAL_DELAY_MS = 750;
const DEFAULT_POLL_INTERVAL_MS = 500;
const TOKEN_REFRESH_MS = 45 * 60 * 1000;
const TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed', 'skipped', 'deferred']);
const ALL_SCOPES = [
  'boss:message',
  'docs:read',
  'docs:write',
  'spreadsheet:read',
  'spreadsheet:write',
  'slack:read',
  'slack:write',
  'social:read',
  'social:write',
  'ticket:read',
  'ticket:write',
  'salesforce:read',
  'salesforce:write',
  'pagerduty:read',
  'pagerduty:write',
  'northstar:read',
  'northstar:write',
] as const;

const onboardingFixtureSchema = z.object({
  bossLabel: z.string().min(1),
  provenance: z.string().min(1),
  transcript: z.string().min(1),
});

interface CliOptions {
  arms: EvaluationArm[];
  runs: number;
  taskSelectors: string[];
  out: string;
  approvalDelayMs: number;
  pollIntervalMs: number;
  help: boolean;
}

interface ActiveTask {
  taskId: string;
  startedAt: string;
  humanWaitMs: number;
  decisions: EvaluationDecision[];
  logicalStages: number;
  observableProviderCalls: number | null;
  lastError?: string;
}

type RawSnapshot = FunctionReturnType<typeof api.evaluation.snapshot>;

interface RunWithProgress extends EvaluationRun {
  activeTask?: ActiveTask;
}

interface EvidenceWithProgress extends EvaluationEvidence {
  runs: RunWithProgress[];
}

interface HarnessContext {
  client: ConvexHttpClient;
  authenticatedAt: number;
  evidence: EvidenceWithProgress;
  outPath: string;
  reportPath: string;
  options: CliOptions;
}

function positiveInteger(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export function parseCliOptions(argv: string[]): CliOptions {
  const result: CliOptions = {
    arms: ['day0', 'baseline'],
    runs: 3,
    taskSelectors: [],
    out: DEFAULT_OUT,
    approvalDelayMs: DEFAULT_APPROVAL_DELAY_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--') continue;
    if (flag === '--help' || flag === '-h') {
      result.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--arms') {
      const arms = value.split(',').filter(Boolean);
      if (
        arms.length === 0 ||
        arms.some((arm) => arm !== 'day0' && arm !== 'baseline') ||
        new Set(arms).size !== arms.length
      ) {
        throw new Error('--arms must be a unique comma-separated subset of day0,baseline');
      }
      result.arms = arms as EvaluationArm[];
    } else if (flag === '--runs') {
      result.runs = positiveInteger(flag, value);
    } else if (flag === '--tasks') {
      result.taskSelectors = value.split(',').filter(Boolean);
      if (result.taskSelectors.length === 0) throw new Error('--tasks cannot be empty');
    } else if (flag === '--out') {
      result.out = value;
    } else if (flag === '--approval-delay-ms') {
      result.approvalDelayMs = positiveInteger(flag, value);
    } else if (flag === '--poll-ms') {
      result.pollIntervalMs = positiveInteger(flag, value);
    } else {
      throw new Error(`unknown option ${flag}`);
    }
  }
  return result;
}

export function selectEvaluationTasks(
  tasks: EvaluationTask[],
  selectors: string[],
): EvaluationTask[] {
  if (selectors.length === 0) return tasks;
  const selected = selectors.map((selector) => {
    const task = tasks.find(
      (candidate) => candidate.id === selector || candidate.seed.externalId === selector,
    );
    if (!task) throw new Error(`unknown evaluation task ${selector}`);
    return task;
  });
  if (new Set(selected.map((task) => task.id)).size !== selected.length) {
    throw new Error('--tasks resolved to duplicate tasks');
  }
  return selected;
}

function usage(): string {
  return `Usage: pnpm eval:semifinal -- [options]

  --arms day0,baseline     arms to run (default both)
  --runs N                 paired run count per arm (default 3)
  --tasks id,id            task ids or EVAL external ids (default all 15)
  --out path.json          resumable raw evidence path
  --approval-delay-ms N    simulated human decision delay (default 750)
  --poll-ms N              state polling interval (default 500)
`;
}

function reportPathFor(outPath: string): string {
  return extname(outPath) === '.json' ? outPath.slice(0, -5) + '.md' : `${outPath}.md`;
}

function isEvidence(value: unknown): value is EvidenceWithProgress {
  if (!value || typeof value !== 'object') return false;
  const row = value as { experiment?: unknown; schemaVersion?: unknown; runs?: unknown };
  return (
    row.experiment === 'day0-semifinal-controlled-comparison' &&
    row.schemaVersion === 1 &&
    Array.isArray(row.runs)
  );
}

async function readOnboardingFixture() {
  const url = new URL('../evaluation/onboarding/day0.json', import.meta.url);
  return onboardingFixtureSchema.parse(JSON.parse(await readFile(url, 'utf8')));
}

function currentCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertResumeCompatible(
  evidence: EvidenceWithProgress,
  options: CliOptions,
  tasks: EvaluationTask[],
  commit: string,
): void {
  const config = evidence.configuration;
  if (
    config.commit !== commit ||
    config.model !== MODEL ||
    config.temperature !== MODEL_TEMPERATURE ||
    config.requestedRuns !== options.runs ||
    config.approvalDelayMs !== options.approvalDelayMs ||
    config.pollIntervalMs !== options.pollIntervalMs ||
    !sameStrings(config.arms ?? ['day0', 'baseline'], options.arms) ||
    !sameStrings(
      config.taskIds,
      tasks.map((task) => task.id),
    )
  ) {
    throw new Error(
      `the existing evidence at ${options.out} was created with different code or options; choose another --out`,
    );
  }
}

async function loadOrCreateEvidence(
  options: CliOptions,
  tasks: EvaluationTask[],
): Promise<EvidenceWithProgress> {
  const commit = currentCommit();
  try {
    const parsed: unknown = JSON.parse(await readFile(options.out, 'utf8'));
    if (!isEvidence(parsed)) throw new Error('existing output is not evaluation evidence v1');
    assertResumeCompatible(parsed, options, tasks, commit);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const fixture = await readOnboardingFixture();
  return {
    schemaVersion: 1,
    experiment: 'day0-semifinal-controlled-comparison',
    generatedAt: new Date().toISOString(),
    configuration: {
      commit,
      model: MODEL,
      temperature: MODEL_TEMPERATURE,
      surfaceMode: 'mock',
      arms: options.arms,
      requestedRuns: options.runs,
      taskIds: tasks.map((task) => task.id),
      taskTimeoutMs: Object.fromEntries(tasks.map((task) => [task.id, task.timeoutMs])),
      approvalDelayMs: options.approvalDelayMs,
      pollIntervalMs: options.pollIntervalMs,
      noLlmJudge: true,
      onboardingTranscriptProvenance: fixture.provenance,
      onboardingTranscriptPath: 'evaluation/onboarding/day0.json',
      postCharterApprovalSkipped: true,
    },
    runs: [],
  };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

async function persist(context: HarnessContext): Promise<void> {
  context.evidence.generatedAt = new Date().toISOString();
  await atomicWrite(context.outPath, `${JSON.stringify(context.evidence, null, 2)}\n`);
  await atomicWrite(context.reportPath, renderEvaluationReport(context.evidence));
}

async function authenticate(context: HarnessContext): Promise<void> {
  if (Date.now() - context.authenticatedAt < TOKEN_REFRESH_MS) return;
  context.client.setAuth(await mintDevNoAuthToken());
  context.authenticatedAt = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function approveAfterDelay(
  context: HarnessContext,
  run: RunWithProgress,
  active: ActiveTask | undefined,
  kind: EvaluationDecision['kind'],
  requestedAtMs: number,
  approve: () => Promise<unknown>,
): Promise<void> {
  const waitStarted = Date.now();
  await sleep(context.options.approvalDelayMs);
  const waitEnded = Date.now();
  await authenticate(context);
  await approve();
  const approvedAt = Date.now();
  const decision: EvaluationDecision = {
    kind,
    taskId: active?.taskId,
    requestedAt: new Date(requestedAtMs).toISOString(),
    approvedAt: new Date(approvedAt).toISOString(),
    delayMs: waitEnded - waitStarted,
  };
  run.decisions.push(decision);
  run.humanWaitMs += decision.delayMs;
  if (active) {
    active.decisions.push(decision);
    active.humanWaitMs += decision.delayMs;
  }
  await persist(context);
}

async function prepareDay0(context: HarnessContext, run: RunWithProgress): Promise<Id<'agents'>> {
  const fixture = await readOnboardingFixture();
  let agentId = run.agentId as Id<'agents'> | undefined;
  if (!agentId) {
    const deployedAt = Date.now();
    agentId = await context.client.mutation(api.agents.deploy, {
      bossEmail: `eval-${run.id}-${deployedAt}@day0.local`,
      name: `Day0 evaluation ${run.run}`,
      arm: 'day0',
    });
    run.agentId = agentId;
    run.deployedAt = new Date(deployedAt).toISOString();
    await persist(context);
  }

  await context.client.action(api.seed.seedDemo, { agentId });
  await context.client.mutation(api.agents.grantScopes, {
    agentId,
    scopes: [...ALL_SCOPES],
  });
  const agent = await context.client.query(api.agents.get, { agentId });
  let charter = await context.client.query(api.charters.latest, { agentId });
  if (!charter && agent.state !== 'active') {
    const session = await context.client.mutation(api.voice.start, { agentId, mode: 'chat' });
    const synthesis = await context.client.action(api.onboarding.synthesiseFromTranscript, {
      agentId,
      bossLabel: fixture.bossLabel,
      transcript: fixture.transcript,
      voiceSessionId: session.sessionId,
    });
    if (synthesis.outcome === 'in-progress') {
      throw new Error('chat onboarding is still being finalised by another run');
    }
    charter = await context.client.query(api.charters.latest, { agentId });
  }
  if (!charter) throw new Error('chat onboarding completed without a charter');
  if (!charter.approved) {
    await approveAfterDelay(
      context,
      run,
      undefined,
      'charter',
      charter.createdAt,
      async () => await context.client.mutation(api.charters.approve, { charterId: charter!._id }),
    );
  }
  return agentId;
}

async function prepareBaseline(
  context: HarnessContext,
  run: RunWithProgress,
): Promise<Id<'agents'>> {
  if (run.agentId) return run.agentId as Id<'agents'>;
  const deployedAt = Date.now();
  const result = await context.client.action(api.baselineActions.deployBaseline, {
    bossEmail: `eval-${run.id}-${deployedAt}@day0.local`,
    name: `Ordinary agent evaluation ${run.run}`,
  });
  run.agentId = result.agentId;
  run.deployedAt = new Date(deployedAt).toISOString();
  await persist(context);
  return result.agentId;
}

function workItemForTask(raw: RawSnapshot, task: EvaluationTask): Doc<'workItems'> {
  const row = raw.workItems.find((item) => item.externalId === task.seed.externalId);
  if (!row) throw new Error(`seeded work item ${task.seed.externalId} not found`);
  return row;
}

function graderSnapshot(raw: RawSnapshot, item: Doc<'workItems'>): EvaluationSnapshot {
  return {
    workItem: {
      id: item._id,
      state: item.state,
      skipReason: item.skipReason,
      verdict: item.verdict,
      output: item.output as EvaluationSnapshot['workItem']['output'],
    },
    events: raw.events.map((event) => ({
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
    })),
    spreadsheets: raw.spreadsheets.map((row) => ({
      sheetSlug: row.sheetSlug,
      tabName: row.tabName,
      cells: row.cells as Record<string, string>,
      createdAt: row.addedAt,
    })),
    slackMessages: raw.slackMessages.map((row) => ({
      channelSlug: row.channelSlug,
      threadKey: row.threadKey,
      body: row.body,
      createdAt: row.timestamp,
    })),
    tweetReplies: raw.tweetReplies.map((row) => ({
      tweetSlug: row.tweetSlug,
      body: row.body,
      createdAt: row.createdAt,
    })),
    tickets: raw.tickets.map((row) => ({
      slug: row.slug,
      status: row.status,
      updatedAt: row.updatedAt,
      comments: row.comments.map((comment) => ({
        body: comment.body,
        createdAt: comment.timestamp,
      })),
    })),
  };
}

function eventWorkItemId(event: RawSnapshot['events'][number]): string | undefined {
  if (!event.payload || typeof event.payload !== 'object') return undefined;
  const value = (event.payload as { workItemId?: unknown }).workItemId;
  return typeof value === 'string' ? value : undefined;
}

function terminalTimestamp(raw: RawSnapshot, item: Doc<'workItems'>): number | null {
  if (!TERMINAL_STATES.has(item.state)) return null;
  const terminalTypes = new Set(['work.completed', 'work.failed', 'work.cancelled']);
  const candidates = raw.events
    .filter(
      (event) =>
        eventWorkItemId(event) === item._id &&
        (terminalTypes.has(event.type) ||
          ((item.state === 'skipped' || item.state === 'deferred') &&
            event.type === 'work.evaluated')),
    )
    .map((event) => event.createdAt);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

async function incrementModelStage(context: HarnessContext, active: ActiveTask): Promise<void> {
  active.logicalStages += 1;
  await persist(context);
}

async function driveSkillApproval(
  context: HarnessContext,
  run: RunWithProgress,
  active: ActiveTask,
  item: Doc<'workItems'>,
): Promise<void> {
  if (!item.proposedSkillId) {
    await sleep(context.options.pollIntervalMs);
    return;
  }
  const skillId = item.proposedSkillId;
  const skill = await context.client.query(api.skills.get, { skillId });
  if (skill.state === 'proposed') {
    await approveAfterDelay(
      context,
      run,
      active,
      'skill',
      skill.createdAt,
      async () => await context.client.mutation(api.skills.approve, { skillId }),
    );
    return;
  }
  if (skill.state === 'registered') {
    await sleep(context.options.pollIntervalMs);
    return;
  }
  if (skill.state === 'rejected') throw new Error(`skill ${skill.name} was rejected`);
  await incrementModelStage(context, active);
  const result = await context.client.action(api.skillActions.authorAndRegisterSkill, { skillId });
  if (!result.ok) active.lastError = result.reason;
  await persist(context);
}

async function driveDay0State(
  context: HarnessContext,
  run: RunWithProgress,
  active: ActiveTask,
  item: Doc<'workItems'>,
): Promise<void> {
  if (item.state === 'discovered') {
    await context.client.action(api.workActions.evaluateWorkItem, { workItemId: item._id });
    return;
  }
  if (item.state === 'needs-skill') {
    await driveSkillApproval(context, run, active, item);
    return;
  }
  if (item.state === 'claimed') {
    await incrementModelStage(context, active);
    const result = await context.client.action(api.workActions.draftPlan, {
      workItemId: item._id,
    });
    if (!result.ok) active.lastError = result.reason;
    return;
  }
  if (item.state === 'plan-pending') {
    await approveAfterDelay(
      context,
      run,
      active,
      'plan',
      item.decision?.requestedAt ?? Date.now(),
      async () => await context.client.mutation(api.work.approvePlan, { workItemId: item._id }),
    );
    return;
  }
  if (item.state === 'plan-approved') {
    await incrementModelStage(context, active);
    const result = await context.client.action(api.workActions.executeApprovedPlan, {
      workItemId: item._id,
    });
    if (!result.ok) active.lastError = result.reason;
    return;
  }
  if (item.state === 'actions-pending') {
    if (!item.pendingRunId) throw new Error('actions-pending work has no pending run id');
    const approvedIndexes = (item.actionVerdicts ?? [])
      .map((verdict, index) => ({ verdict, index }))
      .filter(({ verdict }) => verdict.disposition === 'held' || verdict.held === true)
      .map(({ index }) => index);
    await approveAfterDelay(
      context,
      run,
      active,
      'actions',
      item.decision?.requestedAt ?? Date.now(),
      async () =>
        await context.client.mutation(api.work.approveActions, {
          workItemId: item._id,
          pendingRunId: item.pendingRunId!,
          approvedIndexes,
        }),
    );
    return;
  }
  await sleep(context.options.pollIntervalMs);
}

async function runTask(
  context: HarnessContext,
  run: RunWithProgress,
  agentId: Id<'agents'>,
  task: EvaluationTask,
): Promise<EvaluationTaskResult> {
  const active: ActiveTask =
    run.activeTask?.taskId === task.id
      ? run.activeTask
      : {
          taskId: task.id,
          startedAt: new Date().toISOString(),
          humanWaitMs: 0,
          decisions: [],
          logicalStages: 0,
          observableProviderCalls: null,
        };
  run.activeTask = active;
  await persist(context);
  const deadline = new Date(active.startedAt).getTime() + task.timeoutMs;
  let raw = await context.client.query(api.evaluation.snapshot, { agentId });
  let item = workItemForTask(raw, task);

  while (!TERMINAL_STATES.has(item.state) && Date.now() < deadline) {
    await authenticate(context);
    try {
      if (run.arm === 'baseline') {
        const result = await context.client.action(api.baselineActions.executeTask, {
          workItemId: item._id,
        });
        active.logicalStages += result.modelCalls ?? 0;
        active.observableProviderCalls = result.modelCalls ?? null;
        if (!result.ok) active.lastError = result.reason;
        await persist(context);
      } else {
        await driveDay0State(context, run, active, item);
      }
    } catch (error) {
      active.lastError = error instanceof Error ? error.message : String(error);
      await persist(context);
      await sleep(context.options.pollIntervalMs);
    }
    raw = await context.client.query(api.evaluation.snapshot, { agentId });
    item = workItemForTask(raw, task);
  }

  if (!TERMINAL_STATES.has(item.state) && Date.now() >= deadline) {
    await context.client.mutation(api.evaluation.timeoutTask, { workItemId: item._id });
  }

  raw = await context.client.query(api.evaluation.snapshot, { agentId });
  item = workItemForTask(raw, task);
  const snapshot = graderSnapshot(raw, item);
  const observedAt = Date.now();
  const finishedAt = terminalTimestamp(raw, item) ?? observedAt;
  const timedOut = finishedAt > deadline || !TERMINAL_STATES.has(item.state);
  const correctEffectAt = firstCorrectEffectAt(task, snapshot);
  const deployedAt = run.deployedAt ? new Date(run.deployedAt).getTime() : finishedAt;
  const grade = gradeEvaluationTask(task, run.arm, snapshot);
  if (timedOut) {
    grade.checks.push({
      check: 'harness-timeout',
      passed: false,
      detail: `exceeded the ${task.timeoutMs} ms task timeout`,
    });
    grade.passed = false;
  }
  return {
    taskId: task.id,
    externalId: task.seed.externalId,
    category: task.category,
    workItemId: item._id,
    terminalState: item.state,
    timedOut,
    startedAt: active.startedAt,
    finishedAt: new Date(finishedAt).toISOString(),
    deployToFirstCorrectActionMs:
      correctEffectAt === null ? null : Math.max(0, correctEffectAt - deployedAt),
    humanWaitMs: active.humanWaitMs,
    decisions: active.decisions,
    modelCalls: {
      logicalStages: active.logicalStages,
      observableProviderCalls: active.observableProviderCalls,
    },
    grade,
    ...(active.lastError ? { error: active.lastError } : {}),
  };
}

function newRun(arm: EvaluationArm, run: number): RunWithProgress {
  return {
    id: `${arm}-r${run}`,
    arm,
    run,
    status: 'pending',
    humanWaitMs: 0,
    decisions: [],
    tasks: [],
  };
}

function scheduledRuns(options: CliOptions): Array<{ arm: EvaluationArm; run: number }> {
  const rows: Array<{ arm: EvaluationArm; run: number }> = [];
  for (let run = 1; run <= options.runs; run += 1) {
    const arms = run % 2 === 0 ? [...options.arms].reverse() : options.arms;
    for (const arm of arms) rows.push({ arm, run });
  }
  return rows;
}

async function executeRun(
  context: HarnessContext,
  run: RunWithProgress,
  tasks: EvaluationTask[],
): Promise<void> {
  if (run.status === 'completed') {
    console.log(`[eval] ${run.id}: already complete`);
    return;
  }
  run.status = 'running';
  await persist(context);
  await authenticate(context);
  try {
    const agentId =
      run.arm === 'day0' ? await prepareDay0(context, run) : await prepareBaseline(context, run);
    await context.client.mutation(api.evaluation.seedTasks, {
      agentId,
      tasks: tasks.map((task) => task.seed),
    });
    for (const task of tasks) {
      if (run.tasks.some((row) => row.taskId === task.id)) continue;
      console.log(`[eval] ${run.id}: ${task.id}`);
      const result = await runTask(context, run, agentId, task);
      run.tasks.push(result);
      run.activeTask = undefined;
      await persist(context);
      console.log(
        `[eval] ${run.id}: ${task.id} ${result.grade.passed ? 'PASS' : 'FAIL'} (${result.terminalState}${result.timedOut ? ', timeout' : ''})`,
      );
    }
    run.status = 'completed';
    run.completedAt = new Date().toISOString();
    run.error = undefined;
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    await persist(context);
    throw error;
  }
  await persist(context);
}

export async function runEvaluation(options: CliOptions): Promise<EvaluationEvidence> {
  const allTasks = await loadEvaluationTasks();
  const tasks = selectEvaluationTasks(allTasks, options.taskSelectors);
  const modeUrl = process.env.CONVEX_SELF_HOSTED_URL;
  if (!modeUrl) throw new Error('CONVEX_SELF_HOSTED_URL is required');
  const outPath = resolve(options.out);
  const evidence = await loadOrCreateEvidence({ ...options, out: outPath }, tasks);
  const context: HarnessContext = {
    client: new ConvexHttpClient(modeUrl, {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
    }),
    authenticatedAt: 0,
    evidence,
    outPath,
    reportPath: reportPathFor(outPath),
    options: { ...options, out: outPath },
  };
  await authenticate(context);
  const mode = await context.client.query(api.config.surfaceMode, {});
  if (mode.mode !== 'mock')
    throw new Error(`evaluation requires mock mode; backend reports ${mode.mode}`);
  await persist(context);

  for (const scheduled of scheduledRuns(options)) {
    let run = evidence.runs.find(
      (candidate) => candidate.arm === scheduled.arm && candidate.run === scheduled.run,
    );
    if (!run) {
      run = newRun(scheduled.arm, scheduled.run);
      evidence.runs.push(run);
      await persist(context);
    }
    await executeRun(context, run, tasks);
  }
  return evidence;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const evidence = await runEvaluation(options);
  const completed = evidence.runs.filter((run) => run.status === 'completed').length;
  console.log(`[eval] complete: ${completed}/${options.runs * options.arms.length} runs`);
  console.log(`[eval] JSON: ${resolve(options.out)}`);
  console.log(`[eval] report: ${reportPathFor(resolve(options.out))}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
