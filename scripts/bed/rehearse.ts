/// <reference types="node" />
/**
 * A repeatable real-mode rehearsal against the operator's own workspaces:
 * internal tooling for the maintainers, beside the company bed, and the one
 * deliberate second deployment on a workspace (decision N4).
 *
 *   pnpm exec tsx scripts/bed/rehearse.ts --secrets <file> [--dry-run] [--warm-from <project>] [...]
 *
 * From a clean clone of this checkout it brings real mode up on its own
 * compose project and ports, links the primary's documentation folder,
 * deploys an agent, holds the Day-1 1:1 in chat, approves the charter, lands
 * the cards, and (past the dry-run boundary) assigns REVOPS-7 to the manager
 * in Linear and drives the five checks, recording each with a screenshot and
 * the ledger rows. Afterwards it puts the workspaces back and tears the bed
 * down. The record lands under the primary checkout's
 * .demo-bed/rehearsals/<stamp>/ and is never committed.
 *
 * `--help` prints the options; scripts/bed/rehearsal/run.ts is the phase list.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectBackend } from './rehearsal/backend';
import { UndoLedger } from '../lib/cleanup';
import { parseLines } from './rehearsal/docker';
import { PlaywrightDashboard } from './rehearsal/driver';
import { parseEnvText, parseSecrets } from './rehearsal/env';
import { finish, sleepUntilCeiling } from './rehearsal/finish';
import { LinearClient } from '../lib/linear';
import {
  parseComposeProjects,
  parseRehearsalArguments,
  rehearsalProjectName,
  USAGE,
} from './rehearsal/options';
import { RunDirectory, runDirectory } from './rehearsal/output';
import { portIsFree } from './rehearsal/ports';
import { runCommand, startServer } from './rehearsal/process';
import { runStamp, type RunRecord } from './rehearsal/report';
import { runPhases, type RehearsalContext } from './rehearsal/run';
import { SlackClient } from '../lib/slack';

/** How long past the ceiling a phase that never reaches a wait is given before the clean-up runs anyway. */
const CEILING_GRACE_MINUTES = 5;

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

function dockerInventory(): {
  composeProjects: string[];
  volumes: string[];
  labelledContainers: string[];
} {
  const projects = runCommand('docker', ['compose', 'ls', '-a', '--format', 'json'], {
    timeoutMs: 30_000,
  });
  const volumes = runCommand('docker', ['volume', 'ls', '--format', '{{.Name}}'], {
    timeoutMs: 30_000,
  });
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
  log(
    `rehearsal ${stamp}: project ${project}, clone ${clone}, record ${out.path}${options.dryRun ? ' (dry run)' : ''}`,
  );

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
    sleep: sleepUntilCeiling(
      (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
      Date.now,
      Date.now() + options.timeoutMinutes * 60_000,
      options.timeoutMinutes,
    ),
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

  // The ceiling ends the run at its next wait (the context's sleep). A phase
  // stuck on a call with no timeout of its own never reaches one, so past a
  // grace the clean-up runs beside it: the lesser harm than leaving the
  // workspaces written and the bed polling them.
  const backstop = setTimeout(
    () => {
      log(`no wait was reached ${CEILING_GRACE_MINUTES} minutes past the ceiling; cleaning up now`);
      record.status = 'failed';
      record.stoppedAt = `${CEILING_GRACE_MINUTES} minutes past the ${options.timeoutMinutes}-minute ceiling`;
      void finish(ctx, 1).then(
        (code) => process.exit(code),
        (error: unknown) => {
          log(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        },
      ); // Both outcomes end the process here; nothing awaits the stuck phase.
    },
    (options.timeoutMinutes + CEILING_GRACE_MINUTES) * 60_000,
  );
  backstop.unref();

  try {
    await runPhases(ctx);
  } catch (error) {
    record.status = 'failed';
    record.stoppedAt = `outside a phase: ${(error as Error).message}`;
    log(record.stoppedAt);
  }
  clearTimeout(backstop);
  return await finish(ctx, record.status === 'failed' ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
