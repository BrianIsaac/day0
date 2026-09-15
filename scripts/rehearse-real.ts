/// <reference types="node" />
/**
 * A repeatable real-mode rehearsal against the operator's own workspaces.
 *
 *   pnpm rehearse:real --secrets <file> [--dry-run] [--warm-from <project>] [...]
 *
 * From a clean clone of this checkout it brings real mode up on its own
 * compose project and ports, links the primary's documentation folder,
 * deploys an agent, holds the Day-1 1:1 in chat, approves the charter, lands
 * the cards, and (past the dry-run boundary) assigns REVOPS-7 to the manager
 * in Linear and drives the five checks, recording each with a screenshot and
 * the ledger rows. Afterwards it puts the workspaces back and tears the bed
 * down. The record lands under the primary checkout's
 * docs/plans/progress/real-mode-rehearsals/<stamp>/ and is never committed.
 *
 * `--help` prints the options; scripts/rehearsal/run.ts is the phase list.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { composeDown, type Bed } from './rehearsal/bed';
import { connectBackend } from './rehearsal/backend';
import { UndoLedger } from './rehearsal/cleanup';
import { parseLines } from './rehearsal/docker';
import { PlaywrightDashboard } from './rehearsal/driver';
import { parseEnvText, parseSecrets } from './rehearsal/env';
import { LinearClient } from './rehearsal/linear';
import { parseComposeProjects, parseRehearsalArguments, rehearsalProjectName, USAGE } from './rehearsal/options';
import { RunDirectory, runDirectory } from './rehearsal/output';
import { portIsFree } from './rehearsal/ports';
import { runCommand, startServer } from './rehearsal/process';
import { runStamp, type RunRecord } from './rehearsal/report';
import { runPhases, type RehearsalContext } from './rehearsal/run';
import { SlackClient } from './rehearsal/slack';

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

/** The main worktree of this repository, where the operator's files live. */
function defaultPrimary(): string {
  const result = runCommand('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (result.status !== 0) fail('not inside a git repository; pass --primary.');
  return dirname(result.stdout.trim());
}

/** A file that must exist and be readable only by its owner. */
function readPrivateFile(path: string, what: string): string {
  if (!existsSync(path)) fail(`${what} ${path} does not exist.`);
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) fail(`${what} ${path} is mode ${mode.toString(8)}; it must be 0600.`);
  return readFileSync(path, 'utf8');
}

function dockerInventory(): { composeProjects: string[]; volumes: string[]; labelledContainers: string[] } {
  const projects = runCommand('docker', ['compose', 'ls', '-a', '--format', 'json'], { timeoutMs: 30_000 });
  const volumes = runCommand('docker', ['volume', 'ls', '--format', '{{.Name}}'], { timeoutMs: 30_000 });
  const containers = runCommand(
    'docker',
    ['ps', '-a', '--format', '{{.Label "com.docker.compose.project"}}'],
    { timeoutMs: 30_000 },
  );
  if (projects.status !== 0 || volumes.status !== 0 || containers.status !== 0) {
    fail(`docker is not answering:\n${projects.stderr}${volumes.stderr}${containers.stderr}`);
  }
  return {
    composeProjects: parseComposeProjects(projects.stdout),
    volumes: parseLines(volumes.stdout),
    labelledContainers: parseLines(containers.stdout),
  };
}

async function main(): Promise<number> {
  let options;
  try {
    options = parseRehearsalArguments(process.argv.slice(2));
  } catch (error) {
    fail((error as Error).message);
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!options.secrets) fail(`--secrets <file> is required.\n\n${USAGE}`);

  const primary = resolve(options.primary ?? defaultPrimary());
  const source = resolve(options.source ?? process.cwd());
  const envFrom = resolve(options.envFrom ?? resolve(primary, '.env.local'));
  const secrets = parseSecrets(readPrivateFile(options.secrets, 'the secrets file'));
  const sourceEnv = parseEnvText(readPrivateFile(envFrom, 'the env file'));
  const primaryEnvPath = resolve(primary, '.env.local');
  const primaryProject = existsSync(primaryEnvPath)
    ? (parseEnvText(readFileSync(primaryEnvPath, 'utf8')).COMPOSE_PROJECT_NAME ?? 'day0')
    : 'day0';

  const stamp = runStamp();
  const project = options.project ?? rehearsalProjectName(randomBytes(3).toString('hex'));
  const clone = options.clone ?? mkdtempSync(resolve(tmpdir(), `${project}-`));
  if (existsSync(clone) && statSync(clone).isDirectory() && readFileSync !== undefined) {
    const entries = runCommand('ls', ['-A', clone]).stdout.trim();
    if (entries) fail(`--clone ${clone} is not empty.`);
  }
  const out = new RunDirectory(options.out ?? runDirectory(primary, stamp));
  out.prepare();

  const record: RunRecord = {
    startedAt: new Date().toISOString(),
    commit: '',
    ref: options.ref,
    project,
    clone,
    ports: { backend: 0, site: 0, dashboard: 0, app: 0 },
    dryRun: options.dryRun,
    status: 'running',
    phases: [],
    checks: [],
    writes: [],
    cleanup: [],
    notes: [],
  };
  out.writeRecord(record);
  const log = (line: string): void => {
    const stamped = `${new Date().toISOString()} ${line}`;
    process.stdout.write(`${stamped}\n`);
    out.appendLog(stamped);
  };
  log(`rehearsal ${stamp}: project ${project}, clone ${clone}, record ${out.path}${options.dryRun ? ' (dry run)' : ''}`);

  const ctx: RehearsalContext = {
    options,
    secrets,
    primary,
    source,
    record,
    out,
    log,
    runner: runCommand,
    startServer,
    fetchImpl: fetch,
    now: Date.now,
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    linear: new LinearClient(secrets.linearApiKey ?? ''),
    slack: secrets.slackBotToken ? new SlackClient(secrets.slackBotToken) : undefined,
    ledger: new UndoLedger(),
    dockerInventory,
    portIsFree,
    openDashboard: (origin) => PlaywrightDashboard.open(origin, options.headed),
    connectBackend,
    primaryProject,
    sourceEnv,
    state: { shots: 0 },
  };

  const ceiling = setTimeout(() => {
    log(`the ${options.timeoutMinutes}-minute ceiling passed; stopping`);
    record.status = 'failed';
    record.stoppedAt = `the ${options.timeoutMinutes}-minute ceiling`;
    void finish(ctx, 1).then((code) => process.exit(code));
  }, options.timeoutMinutes * 60_000);
  ceiling.unref();

  try {
    await runPhases(ctx);
  } catch (error) {
    record.status = 'failed';
    record.stoppedAt = `outside a phase: ${(error as Error).message}`;
    log(record.stoppedAt);
  }
  clearTimeout(ceiling);
  return await finish(ctx, record.status === 'failed' ? 1 : 0);
}

/** Put the workspaces back, then take the bed down, whatever the run did. */
async function finish(ctx: RehearsalContext, code: number): Promise<number> {
  const { record, out, log, state, options } = ctx;
  log(`cleanup: ${ctx.ledger.pending().length} undo step(s)`);
  record.cleanup = await ctx.ledger.runAll();
  for (const step of record.cleanup) log(`  ${step.ok ? 'ok' : 'FAILED'} ${step.label}${step.error ? `: ${step.error}` : ''}`);
  out.writeRecord(record);

  if (state.dashboard) await state.dashboard.close().catch((error: Error) => log(`browser close: ${error.message}`));
  if (state.server) {
    await state.server.stop();
    out.appendLog(`--- next dev output ---\n${state.server.output()}`);
  }
  if (state.bed && !options.keep) {
    try {
      composeDown(ctx.runner, state.bed as Bed, true);
      log(`compose project ${state.bed.project} removed with its volumes`);
    } catch (error) {
      log(`teardown: ${(error as Error).message}`);
      record.notes.push(`Teardown failed; run: docker compose -p ${state.bed.project} down -v`);
    }
    rmSync(record.clone, { recursive: true, force: true });
  } else if (state.bed) {
    record.notes.push(`--keep: the stack ${state.bed.project} and the clone ${record.clone} are left up.`);
  }
  out.writeRecord(record);
  log(`${record.status}; record at ${out.path}/summary.md`);
  return record.cleanup.some((step) => !step.ok) ? 1 : code;
}

process.exit(await main());
