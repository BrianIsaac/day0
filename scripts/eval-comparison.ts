#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { z } from 'zod';
import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import {
  failForHarnessTimeout,
  firstCorrectEffectAt,
  gradeEvaluationTask,
  loadEvaluationTasks,
  verdictMissingPermissions,
  type EvaluationArm,
  type EvaluationSnapshot,
  type EvaluationTask,
  eventWorkItemId,
} from '../evaluation/graders';
import {
  COMPARISON_EXPERIMENT,
  isComparisonExperiment,
  renderEvaluationReport,
  type CharterDerivedWork,
  type EvaluationDecision,
  type EvaluationEvidence,
  type EvaluationRun,
  type EvaluationTaskResult,
} from '../evaluation/report';
import { rereadRetainedEvidence, rereadSecondReading } from '../evaluation/retained-reading';
import { mintDevNoAuthToken } from '../src/lib/dev-auth-token';
import { MODEL_CALL_TIMEOUT_MS, MODEL_TEMPERATURE } from '../src/lib/mastra';
import { MODEL } from '../src/lib/openai';
import { EVALUATION_SCOPES } from '../src/evaluation/scopes';
import {
  evaluationHarnessParameters,
  INTENTIONAL_ARM_DIFFERENCES,
} from '../src/evaluation/harness-parity';
import { isTerminalWorkState } from '../src/evaluation/states';
import { refuseUnlessBed } from '../src/evaluation/bed-flag';
import { auditActionArguments } from '../evaluation/action-audit';

/** Each invocation writes its own directory; pass `--out` with an earlier path to resume it. */
function defaultOutPath(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
  return `evaluation/results/${stamp}/comparison.json`;
}
const DEFAULT_APPROVAL_DELAY_MS = 750;
const DEFAULT_POLL_INTERVAL_MS = 500;
const TOKEN_REFRESH_MS = 45 * 60 * 1000;
/** The execution-harness revision every new evidence file records. */
export const EVALUATION_HARNESS_VERSION = 2;
/** Skill-authoring attempts one task-run may spend before it is terminalised. */
export const MAX_SKILL_AUTHORING_ATTEMPTS = 6;
/** The recorded error of a task-run that spent every authoring attempt. */
export const SKILL_AUTHORING_ATTEMPTS_EXHAUSTED = 'skill-authoring-attempts-exhausted';

const onboardingFixtureSchema = z.object({
  bossLabel: z.string().min(1),
  provenance: z.string().min(1),
  transcript: z.string().min(1),
});

/** One invocation's command-line settings. */
export interface CliOptions {
  arms: EvaluationArm[];
  runs: number;
  /** A count for each arm, when `--runs` names one; `runs` is then the largest. */
  runsByArm?: Partial<Record<EvaluationArm, number>>;
  taskSelectors: string[];
  out: string;
  regrade?: string;
  /** A stored run to read again from its retained grades, with no backend. */
  reread?: string;
  approvalDelayMs: number;
  pollIntervalMs: number;
  help: boolean;
}

/** The task a run is on, with the counters the harness keeps while it runs. */
export interface ActiveTask {
  taskId: string;
  startedAt: string;
  humanWaitMs: number;
  decisions: EvaluationDecision[];
  logicalStages: number;
  observableProviderCalls: number | null;
  skillAuthoringAttempts: number;
  lastError?: string;
}

type RawSnapshot = FunctionReturnType<typeof api.evaluation.snapshot>;

/** A run as the harness persists it between steps. */
export interface RunWithProgress extends EvaluationRun {
  activeTask?: ActiveTask;
}

interface EvidenceWithProgress extends EvaluationEvidence {
  runs: RunWithProgress[];
}

/** What one harness invocation carries: the client, the evidence and where it is written. */
export interface HarnessContext {
  client: Pick<ConvexHttpClient, 'query' | 'mutation' | 'action' | 'setAuth'>;
  authenticatedAt: number;
  /** The manager the client signs in as: the current run's, or the local manager before any run. */
  managerSubject?: string;
  /** The manager the client's token names. */
  authenticatedSubject?: string;
  evidence: EvidenceWithProgress;
  outPath: string;
  reportPath: string;
  options: CliOptions;
}

/** Whether a failure is a provider billing or authentication stop that no retry can clear. */
export function isFatalEvaluationInfrastructureError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return /no credits remaining|insufficient_quota|invalid api key|incorrect api key|billing.*(?:disabled|required)|account.*(?:deactivated|disabled)/i.test(
    message,
  );
}

/**
 * Refuse a deployment that would verify skills anywhere but the local sandbox.
 *
 * @throws when the deployment would select another backend.
 */
export function assertLocalEvaluationSandbox(backend: string): asserts backend is 'local' {
  if (backend === 'local') return;
  throw new Error(
    `evaluation harness v${EVALUATION_HARNESS_VERSION} requires the local skill sandbox; ` +
      `the deployment would select ${backend}. Remove DAYTONA_API_KEY from the deployment, ` +
      'restart it, and try again',
  );
}

/** Whether a task timed out, and how far past its deadline it finished. */
export function evaluationTaskTiming(
  stateAtDeadlineCheck: string,
  finishedAt: number,
  deadline: number,
): Pick<EvaluationTaskResult, 'timedOut' | 'deadlineOverrunMs'> {
  return {
    timedOut: !isTerminalWorkState(stateAtDeadlineCheck),
    deadlineOverrunMs: Math.max(0, finishedAt - deadline),
  };
}

function positiveInteger(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

/**
 * A count for each arm, from `day0=N,baseline=N` (either arm alone too).
 *
 * @throws when an entry names no arm, an arm twice, or a count that is not a positive integer.
 */
function runsByArm(value: string): Partial<Record<EvaluationArm, number>> {
  const counts: Partial<Record<EvaluationArm, number>> = {};
  for (const entry of value.split(',')) {
    const match = /^(day0|baseline)=(\d+)$/.exec(entry);
    const count = Number(match?.[2]);
    const arm = match?.[1] as EvaluationArm | undefined;
    if (!arm || counts[arm] !== undefined || !Number.isInteger(count) || count <= 0) {
      throw new Error('--runs must be a positive integer, or day0=N,baseline=N');
    }
    counts[arm] = count;
  }
  return counts;
}

/** The runs an arm is asked for: its own count when `--runs` named one, else the one count. */
export function runsForArm(
  options: Pick<CliOptions, 'runs' | 'runsByArm'>,
  arm: EvaluationArm,
): number {
  return options.runsByArm?.[arm] ?? options.runs;
}

/** The runs each arm of an invocation is asked for. */
function requestedRunsByArm(options: CliOptions): Partial<Record<EvaluationArm, number>> {
  return Object.fromEntries(options.arms.map((arm) => [arm, runsForArm(options, arm)]));
}

/**
 * Parse the command line into one invocation's settings.
 *
 * @throws on an unknown flag, a missing value or an invalid subset.
 */
export function parseCliOptions(argv: string[]): CliOptions {
  const result: CliOptions = {
    arms: ['day0', 'baseline'],
    runs: 3,
    taskSelectors: [],
    out: defaultOutPath(),
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
      if (/^\d+$/.test(value)) {
        result.runs = positiveInteger(flag, value);
        result.runsByArm = undefined;
      } else {
        result.runsByArm = runsByArm(value);
        result.runs = Math.max(...Object.values(result.runsByArm));
      }
    } else if (flag === '--tasks') {
      result.taskSelectors = value.split(',').filter(Boolean);
      if (result.taskSelectors.length === 0) throw new Error('--tasks cannot be empty');
    } else if (flag === '--out') {
      result.out = value;
    } else if (flag === '--regrade') {
      result.regrade = value;
    } else if (flag === '--reread') {
      result.reread = value;
    } else if (flag === '--approval-delay-ms') {
      result.approvalDelayMs = positiveInteger(flag, value);
    } else if (flag === '--poll-ms') {
      result.pollIntervalMs = positiveInteger(flag, value);
    } else {
      throw new Error(`unknown option ${flag}`);
    }
  }
  if (
    result.runsByArm &&
    !sameStrings(Object.keys(result.runsByArm).sort(), [...result.arms].sort())
  ) {
    throw new Error(
      `--runs must name a count for each arm it runs: ${result.arms.map((arm) => `${arm}=N`).join(',')}`,
    );
  }
  if (result.regrade && result.reread) {
    throw new Error('--reread and --regrade are two ways to grade again; pass one');
  }
  return result;
}

/**
 * The tasks a `--tasks` selection names, in the order given; all tasks when it names none.
 *
 * @throws on an unknown or repeated task.
 */
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
  return `Usage: pnpm eval:comparison -- [options]

  --arms day0,baseline     arms to run (default both)
  --runs N                 paired run count per arm (default 3); or a count for each arm,
                           day0=N,baseline=N, the arms alternating while both have runs left
  --tasks id,id            task ids or EVAL external ids (default all 15)
  --out path.json          raw evidence path (default evaluation/results/<timestamp>/comparison.json);
                           pass an earlier path to resume that run
  --regrade path.json      re-score a retained run into a new output; makes no model calls
  --reread path.json       read a stored run's out-of-scope rows again from its retained grades
                           into a new output: the two readings where it records neither, the
                           second reading where it records them; needs no backend and makes no
                           model calls
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
    isComparisonExperiment(row.experiment) && row.schemaVersion === 1 && Array.isArray(row.runs)
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

/**
 * Refuse to resume evidence recorded under different code, options or task definitions.
 *
 * @throws when any recorded setting differs from this invocation's.
 */
export function assertResumeCompatible(
  evidence: EvaluationEvidence,
  options: CliOptions,
  tasks: readonly EvaluationTask[],
  commit: string,
): void {
  const config = evidence.configuration;
  const taskTimeoutMs = Object.fromEntries(tasks.map((task) => [task.id, task.timeoutMs]));
  const harnessParameters = evaluationHarnessParameters(taskTimeoutMs);
  if (
    config.harnessVersion !== EVALUATION_HARNESS_VERSION ||
    config.commit !== commit ||
    config.model !== MODEL ||
    config.temperature !== MODEL_TEMPERATURE ||
    config.modelCallTimeoutMs !== MODEL_CALL_TIMEOUT_MS ||
    config.requestedRuns !== options.runs ||
    JSON.stringify(
      config.requestedRunsByArm ??
        Object.fromEntries(
          (config.arms ?? ['day0', 'baseline']).map((arm) => [arm, config.requestedRuns]),
        ),
    ) !== JSON.stringify(requestedRunsByArm(options)) ||
    config.approvalDelayMs !== options.approvalDelayMs ||
    config.pollIntervalMs !== options.pollIntervalMs ||
    config.skillAuthoringMaxAttempts !== MAX_SKILL_AUTHORING_ATTEMPTS ||
    config.skillSandboxBackend !== 'local' ||
    JSON.stringify(config.harnessParameters) !== JSON.stringify(harnessParameters) ||
    JSON.stringify(config.intentionalArmDifferences) !==
      JSON.stringify(INTENTIONAL_ARM_DIFFERENCES) ||
    !sameStrings(config.arms ?? ['day0', 'baseline'], options.arms) ||
    !sameStrings(
      config.taskIds,
      tasks.map((task) => task.id),
    ) ||
    JSON.stringify(config.taskDefinitions) !== JSON.stringify(tasks)
  ) {
    throw new Error(
      `the existing evidence at ${options.out} was created with different code or options; choose another --out`,
    );
  }
}

/**
 * The evidence an invocation writes into: the file at `--out` when it was
 * recorded under the same code and options, or a new one.
 *
 * @throws when the file exists and was recorded under other code or options.
 */
export async function loadOrCreateEvidence(
  options: CliOptions,
  tasks: EvaluationTask[],
): Promise<EvidenceWithProgress> {
  const commit = currentCommit();
  const taskTimeoutMs = Object.fromEntries(tasks.map((task) => [task.id, task.timeoutMs]));
  const harnessParameters = evaluationHarnessParameters(taskTimeoutMs);
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
    experiment: COMPARISON_EXPERIMENT,
    generatedAt: new Date().toISOString(),
    configuration: {
      harnessVersion: EVALUATION_HARNESS_VERSION,
      commit,
      model: MODEL,
      temperature: MODEL_TEMPERATURE,
      modelCallTimeoutMs: MODEL_CALL_TIMEOUT_MS,
      surfaceMode: 'mock',
      arms: options.arms,
      requestedRuns: options.runs,
      requestedRunsByArm: requestedRunsByArm(options),
      taskIds: tasks.map((task) => task.id),
      taskDefinitions: tasks,
      taskTimeoutMs,
      approvalDelayMs: options.approvalDelayMs,
      pollIntervalMs: options.pollIntervalMs,
      skillAuthoringMaxAttempts: MAX_SKILL_AUTHORING_ATTEMPTS,
      noLlmJudge: true,
      onboardingTranscriptProvenance: fixture.provenance,
      onboardingTranscriptPath: 'evaluation/onboarding/day0.json',
      charterDerivedWorkRecorded: true,
      harnessParameters,
      intentionalArmDifferences: INTENTIONAL_ARM_DIFFERENCES,
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

async function requireAbsent(path: string, purpose: string): Promise<void> {
  try {
    await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${purpose} already exists at ${path}; choose a new --out path`);
}

async function persist(context: HarnessContext): Promise<void> {
  context.evidence.generatedAt = new Date().toISOString();
  await atomicWrite(context.outPath, `${JSON.stringify(context.evidence, null, 2)}\n`);
  await atomicWrite(context.reportPath, renderEvaluationReport(context.evidence));
}

async function authenticate(context: HarnessContext): Promise<void> {
  if (
    Date.now() - context.authenticatedAt < TOKEN_REFRESH_MS &&
    context.authenticatedSubject === context.managerSubject
  ) {
    return;
  }
  context.client.setAuth(await managerToken(context.managerSubject));
  context.authenticatedAt = Date.now();
  context.authenticatedSubject = context.managerSubject;
}

/** A token for a run's manager, or for the local manager when no subject is given. */
async function managerToken(subject: string | undefined): Promise<string> {
  return await mintDevNoAuthToken(undefined, undefined, undefined, subject);
}

/**
 * The subject a run's manager signs in as: one of its own, so that no two runs
 * of a bed share an owner, and so a skill library, an adoption offer or a
 * re-check card.
 */
export function evaluationManagerSubject(runId: string, at: number): string {
  return `dev-no-auth|eval-manager-${runId}-${at}`;
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
      evaluationAddress: `eval-${run.id}-${deployedAt}@day0.local`,
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
    scopes: [...EVALUATION_SCOPES],
  });
  const agent = await context.client.query(api.agents.get, { agentId });
  if (agent === null) throw new Error(`agent ${agentId} is gone`);
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
    evaluationAddress: `eval-${run.id}-${deployedAt}@day0.local`,
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

function graderSnapshot(
  raw: RawSnapshot,
  item: Doc<'workItems'>,
  since: number,
  until?: number,
): EvaluationSnapshot {
  return {
    since,
    until,
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

/** Events that end a work item: its own terminal events and the two ways an apply ends it. */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'work.completed',
  'work.failed',
  'work.cancelled',
  'work.actions-rejected',
  'work.actions-interrupted',
]);

function endsWorkItem(event: RawSnapshot['events'][number], item: Doc<'workItems'>): boolean {
  if (eventWorkItemId(event) === item._id) {
    return (
      TERMINAL_EVENT_TYPES.has(event.type) ||
      ((item.state === 'skipped' || item.state === 'deferred') && event.type === 'work.evaluated')
    );
  }
  // A skill rejection cancels every row waiting on the proposal; its event names the skill only.
  const skillId = (event.payload as { skillId?: unknown } | undefined)?.skillId;
  return (
    item.state === 'cancelled' &&
    event.type === 'skill.rejected' &&
    item.proposedSkillId !== undefined &&
    skillId === item.proposedSkillId
  );
}

/**
 * When a terminal work item ended, from the ledger event that ended it.
 *
 * @returns The latest such event's time, or null when the item is not terminal
 *   or no event records its end, in which case the caller uses the poll time.
 * @remarks `skill.rejected` names the skill, not the rows it cancels, so a row
 *   cancelled as the proposal's `proposedFor` without a `proposedSkillId` still
 *   takes the poll time; the scripted manager never rejects, so no bed meets it.
 */
export function terminalTimestamp(raw: RawSnapshot, item: Doc<'workItems'>): number | null {
  if (!isTerminalWorkState(item.state)) return null;
  const candidates = raw.events
    .filter((event) => endsWorkItem(event, item))
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
  if (active.skillAuthoringAttempts >= MAX_SKILL_AUTHORING_ATTEMPTS) {
    active.lastError = SKILL_AUTHORING_ATTEMPTS_EXHAUSTED;
    await context.client.mutation(api.evaluation.failSkillAuthoringAttempts, {
      workItemId: item._id,
    });
    await persist(context);
    return;
  }
  active.skillAuthoringAttempts += 1;
  await incrementModelStage(context, active);
  const result = await context.client.action(api.skillActions.authorAndRegisterSkill, { skillId });
  if (!result.ok) {
    if (isFatalEvaluationInfrastructureError(result.reason)) throw new Error(result.reason);
    active.lastError = result.reason;
  }
  await persist(context);
}

/**
 * Advance one day0 work item by the single step its state calls for.
 *
 * Every branch performs at most one call and returns, so the caller's poll
 * loop re-reads the row between steps. A decided hold is left alone: the
 * manager's approval keeps the row at `actions-pending` until the scheduled
 * apply moves it, and a second approval would be refused by the backend.
 */
export async function driveDay0State(
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
    if (!result.ok) {
      if (isFatalEvaluationInfrastructureError(result.reason)) throw new Error(result.reason);
      active.lastError = result.reason;
    }
    return;
  }
  if (item.state === 'plan-pending') {
    await approveAfterDelay(
      context,
      run,
      active,
      'plan',
      item.decision?.requestedAt ?? Date.now(),
      async () =>
        await context.client.mutation(api.planApproval.approvePlan, { workItemId: item._id }),
    );
    return;
  }
  if (item.state === 'plan-approved') {
    await incrementModelStage(context, active);
    const result = await context.client.action(api.workActions.executeApprovedPlan, {
      workItemId: item._id,
    });
    active.logicalStages += result.additionalModelCalls ?? 0;
    if (!result.ok) {
      if (isFatalEvaluationInfrastructureError(result.reason)) throw new Error(result.reason);
      active.lastError = result.reason;
    }
    return;
  }
  if (item.state === 'actions-pending') {
    if (item.approvedIndexes !== undefined) {
      await sleep(context.options.pollIntervalMs);
      return;
    }
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

/**
 * Advance one baseline work item.
 *
 * Only a `discovered` row is executed; a row already claimed by a run that is
 * still going, or one left claimed by an interrupted harness, is waited on
 * until it settles or the task deadline terminalises it.
 */
export async function driveBaselineState(
  context: HarnessContext,
  active: ActiveTask,
  item: Doc<'workItems'>,
): Promise<void> {
  if (item.state !== 'discovered') {
    await sleep(context.options.pollIntervalMs);
    return;
  }
  const result = await context.client.action(api.baselineActions.executeTask, {
    workItemId: item._id,
  });
  active.logicalStages += result.modelCalls ?? 0;
  active.observableProviderCalls = result.modelCalls ?? null;
  if (!result.ok) {
    if (isFatalEvaluationInfrastructureError(result.reason)) throw new Error(result.reason);
    active.lastError = result.reason;
  }
  await persist(context);
}

/**
 * Drive one task of a run to its end and write its result: the terminal
 * state, the timing, the grade and what the result keeps beside it.
 *
 * A task the run already started keeps its start time and deadline; a work
 * item still open at the deadline is terminalised as a harness timeout.
 */
export async function runTask(
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
          skillAuthoringAttempts: 0,
        };
  run.activeTask = active;
  await persist(context);
  const deadline = new Date(active.startedAt).getTime() + task.timeoutMs;
  let raw = await context.client.query(api.evaluation.snapshot, { agentId });
  let item = workItemForTask(raw, task);

  while (!isTerminalWorkState(item.state) && Date.now() < deadline) {
    await authenticate(context);
    try {
      if (run.arm === 'baseline') {
        await driveBaselineState(context, active, item);
      } else {
        await driveDay0State(context, run, active, item);
      }
    } catch (error) {
      if (isFatalEvaluationInfrastructureError(error)) throw error;
      active.lastError = error instanceof Error ? error.message : String(error);
      await persist(context);
      await sleep(context.options.pollIntervalMs);
    }
    raw = await context.client.query(api.evaluation.snapshot, { agentId });
    item = workItemForTask(raw, task);
  }

  const stateAtDeadlineCheck = item.state;
  if (!isTerminalWorkState(stateAtDeadlineCheck) && Date.now() >= deadline) {
    await context.client.mutation(api.evaluation.timeoutTask, { workItemId: item._id });
  }

  raw = await context.client.query(api.evaluation.snapshot, { agentId });
  item = workItemForTask(raw, task);
  const observedAt = Date.now();
  const finishedAt = terminalTimestamp(raw, item) ?? observedAt;
  const snapshot = graderSnapshot(raw, item, new Date(active.startedAt).getTime(), finishedAt);
  const { timedOut, deadlineOverrunMs } = evaluationTaskTiming(
    stateAtDeadlineCheck,
    finishedAt,
    deadline,
  );
  const correctEffectAt = firstCorrectEffectAt(task, snapshot);
  const deployedAt = run.deployedAt ? new Date(run.deployedAt).getTime() : finishedAt;
  const grade = gradeEvaluationTask(task, run.arm, snapshot);
  if (timedOut) failForHarnessTimeout(grade, task);
  return {
    taskId: task.id,
    externalId: task.seed.externalId,
    category: task.category,
    workItemId: item._id,
    terminalState: item.state,
    timedOut,
    deadlineOverrunMs,
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
    skillAuthoringAttempts: active.skillAuthoringAttempts,
    actionAudit: auditActionArguments(item.output),
    grade,
    missingPermissions: verdictMissingPermissions(item.verdict),
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

/** The runs an invocation makes, in order: the arms alternate their order run by run, and an arm whose count is spent drops out. */
export function scheduledRuns(options: CliOptions): Array<{ arm: EvaluationArm; run: number }> {
  const rows: Array<{ arm: EvaluationArm; run: number }> = [];
  for (let run = 1; run <= options.runs; run += 1) {
    const arms = run % 2 === 0 ? [...options.arms].reverse() : options.arms;
    for (const arm of arms) {
      if (run <= runsForArm(options, arm)) rows.push({ arm, run });
    }
  }
  return rows;
}

/**
 * Run one arm's run over the tasks, or resume it, writing each result as it ends.
 *
 * @throws on a fatal provider failure, after marking the run failed.
 */
export async function executeRun(
  context: HarnessContext,
  run: RunWithProgress,
  tasks: EvaluationTask[],
): Promise<void> {
  if (run.status === 'completed') {
    console.log(`[eval] ${run.id}: already complete`);
    return;
  }
  run.managerSubject ??= evaluationManagerSubject(run.id, Date.now());
  context.managerSubject = run.managerSubject;
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
    run.charterDerivedWork = charterDerivedWorkOf(
      await context.client.query(api.evaluation.snapshot, { agentId }),
      tasks,
      new Date(),
    );
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

/**
 * What the product's charter-derived seeding left on a run's employee: the
 * generator's events and the work items that are none of the run's tasks, by
 * state. Approving the charter schedules the generator on the server, so the
 * harness records what it did and does not assert that it was skipped.
 */
export function charterDerivedWorkOf(
  raw: RawSnapshot,
  tasks: readonly EvaluationTask[],
  readAt: Date,
): CharterDerivedWork {
  const taskIds = new Set(tasks.map((task) => task.seed.externalId));
  const seedings = raw.events.filter((event) => event.type === 'work.charter-derived');
  const generated = raw.workItems.filter((item) => !taskIds.has(item.externalId));
  const byState: Record<string, number> = {};
  for (const item of generated) byState[item.state] = (byState[item.state] ?? 0) + 1;
  return {
    seedings: seedings.length,
    itemsSeeded: seedings.reduce((total, event) => {
      const count = (event.payload as { count?: unknown } | undefined)?.count;
      return total + (typeof count === 'number' ? count : 0);
    }, 0),
    workItems: generated.length,
    byState,
    readAt: readAt.toISOString(),
  };
}

/** The seams a regrade takes in place of the live backend, the clock and git. */
export interface RegradeDependencies {
  /** A query-only seam for fixtures; production constructs this from CONVEX_SELF_HOSTED_URL. */
  client?: Pick<ConvexHttpClient, 'query' | 'setAuth'>;
  /** Sign in as a run's manager, or as the local manager when no subject is given. */
  authenticate?: (subject?: string) => Promise<void>;
  commit?: string;
  now?: Date;
}

function regradeTask(
  recorded: EvaluationTaskResult,
  task: EvaluationTask,
  arm: EvaluationArm,
  raw: RawSnapshot,
  item: Doc<'workItems'>,
  deployedAt: string | undefined,
): EvaluationTaskResult {
  const startedAt = new Date(recorded.startedAt).getTime();
  const finishedAt = new Date(recorded.finishedAt).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
    throw new Error(`recorded task ${recorded.taskId} has invalid timestamps`);
  }
  const snapshot = graderSnapshot(raw, item, startedAt, finishedAt);
  const grade = gradeEvaluationTask(task, arm, snapshot);
  if (recorded.timedOut) failForHarnessTimeout(grade, task);

  let deployToFirstCorrectActionMs = recorded.deployToFirstCorrectActionMs;
  if (!recorded.grade.passed && grade.passed) {
    const correctEffectAt = firstCorrectEffectAt(task, snapshot);
    const deployedAtMs = deployedAt ? new Date(deployedAt).getTime() : Number.NaN;
    deployToFirstCorrectActionMs =
      correctEffectAt === null || !Number.isFinite(deployedAtMs)
        ? null
        : Math.max(0, correctEffectAt - deployedAtMs);
  }

  return {
    ...recorded,
    terminalState: item.state,
    deployToFirstCorrectActionMs,
    actionAudit: auditActionArguments(item.output),
    grade,
    missingPermissions: verdictMissingPermissions(item.verdict),
  };
}

/** Where a checkout keeps its evaluation evidence, relative to its root. */
const RESULTS_SEGMENT = 'evaluation/results/';

/**
 * The re-graded source's path as a result records it: from the checkout root
 * when the source sits under an `evaluation/results/` tree, relative to the
 * working directory when it sits under that, and the file name alone
 * otherwise. A tracked result never carries the machine directory a checkout
 * or a scratch clone happened to sit in (N15).
 */
export function recordedSourcePath(sourcePath: string): string {
  const absolute = resolve(sourcePath).split(sep).join('/');
  const segment = absolute.lastIndexOf(`/${RESULTS_SEGMENT}`);
  if (segment !== -1) return absolute.slice(segment + 1);
  const fromWorkingDirectory = relative(process.cwd(), resolve(sourcePath));
  const outside =
    fromWorkingDirectory === '..' ||
    fromWorkingDirectory.startsWith(`..${sep}`) ||
    isAbsolute(fromWorkingDirectory);
  if (!outside) {
    return fromWorkingDirectory.split(sep).join('/');
  }
  return basename(absolute);
}

/** Read a source to grade again, refusing an output that exists or a file that is not evidence. */
async function readRegradeSource(
  options: CliOptions,
  flag: 'regrade' | 'reread' = 'regrade',
): Promise<{ sourcePath: string; outPath: string; source: EvidenceWithProgress }> {
  const given = options[flag];
  if (!given) throw new Error(`--${flag} requires an existing evidence JSON path`);
  const sourcePath = resolve(given);
  const outPath = resolve(options.out);
  if (sourcePath === outPath) {
    throw new Error(`--${flag} output must differ from the original evidence path`);
  }
  await requireAbsent(outPath, 're-grade JSON');
  await requireAbsent(reportPathFor(outPath), 're-grade report');
  const source: unknown = JSON.parse(await readFile(sourcePath, 'utf8'));
  if (!isEvidence(source)) throw new Error('regrade source is not evaluation evidence v1');
  return { sourcePath, outPath, source };
}

/** A query-only client and the way it signs in as a run's manager. */
interface RegradeClient {
  client: Pick<ConvexHttpClient, 'query' | 'setAuth'>;
  signInAs: (subject?: string) => Promise<void>;
}

/** An authenticated, query-only client on a backend that reports mock mode. */
async function regradeClient(dependencies: RegradeDependencies): Promise<RegradeClient> {
  const modeUrl = process.env.CONVEX_SELF_HOSTED_URL;
  if (!dependencies.client && !modeUrl) throw new Error('CONVEX_SELF_HOSTED_URL is required');
  const convexClient =
    dependencies.client ??
    new ConvexHttpClient(modeUrl!, {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
    });
  const client: Pick<ConvexHttpClient, 'query' | 'setAuth'> = {
    query: convexClient.query.bind(convexClient),
    setAuth: convexClient.setAuth.bind(convexClient),
  };
  const signInAs =
    dependencies.authenticate ??
    (async (subject?: string): Promise<void> => client.setAuth(await managerToken(subject)));
  await signInAs();
  const mode = await client.query(api.config.surfaceMode, {});
  if (mode.mode !== 'mock') {
    throw new Error(`evaluation re-grade requires mock mode; backend reports ${mode.mode}`);
  }
  return { client, signInAs };
}

/**
 * Each recorded run's retained backend state, read as the manager the run ran
 * under, refusing a run whose work items are gone.
 */
async function retainedSnapshots(
  { client, signInAs }: RegradeClient,
  source: EvaluationEvidence,
): Promise<Map<string, RawSnapshot>> {
  const snapshots = new Map<string, RawSnapshot>();
  for (const run of source.runs) {
    if (run.tasks.length === 0) continue;
    if (!run.agentId) throw new Error(`recorded run ${run.id} has tasks but no agentId`);
    if (run.managerSubject) await signInAs(run.managerSubject);
    const raw = await client.query(api.evaluation.snapshot, {
      agentId: run.agentId as Id<'agents'>,
    });
    for (const recorded of run.tasks) {
      const item = raw.workItems.find((row) => row._id === recorded.workItemId);
      if (!item) {
        throw new Error(
          `backend does not hold recorded work item ${recorded.workItemId} for ${run.id}`,
        );
      }
      if (item.agentId !== run.agentId) {
        throw new Error(`recorded work item ${recorded.workItemId} belongs to another agent`);
      }
    }
    snapshots.set(run.id, raw);
  }
  return snapshots;
}

/**
 * Re-score retained backend state without invoking any mutation, action or model-bearing stage.
 *
 * The output carries the current task definitions it was graded against and
 * the source run's provenance; the source file is never touched.
 *
 * @throws when the output exists, the backend is not in mock mode, or a recorded task or work item is gone.
 */
export async function runRegrade(
  options: CliOptions,
  dependencies: RegradeDependencies = {},
): Promise<EvaluationEvidence> {
  const { sourcePath, outPath, source } = await readRegradeSource(options);
  const tasksById = new Map((await loadEvaluationTasks()).map((task) => [task.id, task]));
  for (const recorded of source.runs.flatMap((run) => run.tasks)) {
    if (!tasksById.has(recorded.taskId)) {
      throw new Error(`current task file does not contain recorded task ${recorded.taskId}`);
    }
  }
  const snapshots = await retainedSnapshots(await regradeClient(dependencies), source);

  const evidence = structuredClone(source);
  evidence.configuration.taskDefinitions = evidence.configuration.taskIds.flatMap(
    (taskId) => tasksById.get(taskId) ?? [],
  );
  for (const run of evidence.runs) {
    if (run.tasks.length === 0) continue;
    const raw = snapshots.get(run.id)!;
    run.tasks = run.tasks.map((recorded) => {
      const task = tasksById.get(recorded.taskId)!;
      const item = raw.workItems.find((row) => row._id === recorded.workItemId)!;
      return regradeTask(recorded, task, run.arm, raw, item, run.deployedAt);
    });
  }

  const modelCallsMade = 0;
  if (modelCallsMade !== 0) throw new Error('re-grade attempted a model call');
  evidence.generatedAt = (dependencies.now ?? new Date()).toISOString();
  evidence.regradedFrom = {
    path: recordedSourcePath(sourcePath),
    commit: source.configuration.commit,
    gradedAtCommit: dependencies.commit ?? currentCommit(),
    generatedAt: source.generatedAt,
    modelCallsMade,
  };
  await atomicWrite(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await atomicWrite(reportPathFor(outPath), renderEvaluationReport(evidence));
  return evidence;
}

/**
 * Read a stored run's out-of-scope rows again from its retained grades, for a
 * run whose backend is gone, and write the result as new evidence with its
 * report. A run that records neither reading gains the two; one that records
 * them, live or by an earlier re-read, gains the second reading alone. No
 * backend is opened and the source file is never touched.
 *
 * @throws when the output exists, or the source is not evidence, is itself a re-read for the
 *   second reading or already records it.
 */
export async function runRetainedReread(
  options: CliOptions,
  dependencies: Pick<RegradeDependencies, 'commit' | 'now'> = {},
): Promise<EvaluationEvidence> {
  const { sourcePath, outPath, source } = await readRegradeSource(options, 'reread');
  const provenance = {
    path: recordedSourcePath(sourcePath),
    gradedAtCommit: dependencies.commit ?? currentCommit(),
    now: dependencies.now ?? new Date(),
  };
  const recordsReadings = source.runs.some((run) =>
    run.tasks.some((task) => task.grade.facts.outOfScope !== undefined),
  );
  const evidence = recordsReadings
    ? rereadSecondReading(source, provenance)
    : rereadRetainedEvidence(source, provenance);
  await atomicWrite(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await atomicWrite(reportPathFor(outPath), renderEvaluationReport(evidence));
  return evidence;
}

/**
 * Run or resume a comparison against the mock backend and write its evidence and report.
 *
 * @throws when the backend is not in mock mode, names another model or would select another sandbox.
 */
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
  const backend = await context.client.query(api.config.modelSettings, {});
  refuseUnlessBed(backend.evaluationBed, 'pnpm eval:comparison');
  if (backend.model !== MODEL) {
    throw new Error(
      `the backend is configured for model ${backend.model} but this environment names ${MODEL}; ` +
        'run ./scripts/sync-convex-env.sh and restart the backend so both arms use one model',
    );
  }
  assertLocalEvaluationSandbox(backend.skillSandboxBackend);
  evidence.configuration.backendModel = backend.model;
  evidence.configuration.skillSandboxBackend = backend.skillSandboxBackend;
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
  if (options.reread) {
    const evidence = await runRetainedReread(options);
    const reread = evidence.runs
      .flatMap((run) => run.tasks)
      .filter((task) => task.grade.facts.outOfScope !== undefined).length;
    const what =
      evidence.regradedFrom?.basis === 'retained-grade-second-reading'
        ? 'for the second reading'
        : 'for the two readings';
    console.log(`[eval] re-read: ${reread} out-of-scope rows ${what} from their retained grades`);
    console.log(`[eval] JSON: ${resolve(options.out)}`);
    console.log(`[eval] report: ${reportPathFor(resolve(options.out))}`);
    return;
  }
  if (options.regrade) {
    const evidence = await runRegrade(options);
    console.log(`[eval] re-graded: ${evidence.runs.flatMap((run) => run.tasks).length} tasks`);
    console.log(`[eval] JSON: ${resolve(options.out)}`);
    console.log(`[eval] report: ${reportPathFor(resolve(options.out))}`);
    return;
  }
  const evidence = await runEvaluation(options);
  const completed = evidence.runs.filter((run) => run.status === 'completed').length;
  const requested = options.arms.reduce((total, arm) => total + runsForArm(options, arm), 0);
  console.log(`[eval] complete: ${completed}/${requested} runs`);
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
