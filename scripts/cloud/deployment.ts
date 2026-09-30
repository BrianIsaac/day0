/**
 * The Convex half of the cloud verbs: the dry run that proves the target,
 * the env read, the push with `convex/_generated` put back, the migrations
 * and the stamp read back, and the export with its checksum and row counts.
 * Every command names the deployment itself, so a read or a write can only
 * reach the target the dry run proved.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CRONS_PAUSED_FLAG } from '../../src/lib/crons-pause';
import { errorMessage } from '../../src/lib/errors';
import { writePrivateEnv } from '../private-env';
import {
  migrationLines,
  MIGRATIONS_ARGUMENTS,
  parseMigrationReport,
  parseReleaseStamp,
  RELEASE_STAMP_ARGUMENTS,
  releaseStampArguments,
} from '../releases';
import { insideCheckout, type RunOptions, type RunResult } from '../setup';
import {
  firstLine,
  tail,
  type CheckoutState,
  type CloudIo,
  type CloudTarget,
  type Failure,
} from './checkout';
import {
  countsText,
  deploymentEnv,
  deploymentUrl,
  exportLayout,
  plainText,
  pushTarget,
  rowCount,
  type ExportCounts,
} from './outputs';

/**
 * Run `npx` with the deployment named on the command, never through an env
 * file, so a read can only reach the target.
 *
 * @param io - The machine.
 * @param target - The deployment.
 * @param args - The Convex CLI arguments.
 * @param options - How to run it.
 */
export function convexOn(
  io: CloudIo,
  target: CloudTarget,
  args: readonly string[],
  options: RunOptions = {},
): RunResult {
  return io.run('npx', [...args, '--deployment', target.deployment], {
    timeoutMs: 180_000,
    ...options,
  });
}

/** How much of the dry run a verb needs to pass. */
export type TargetProof =
  /** The whole dry run: the push the verb is about to make would be accepted. */
  | 'push'
  /**
   * Only the deployment it resolves to. A first setup's deployment has no
   * identity setting yet, so its auth config refuses any push, the dry run's
   * included; the setup proves the push itself once the env is set.
   */
  | 'target';

/**
 * The dry run that proves the target file reaches the named production
 * deployment. `npx convex deploy` goes to the project's default production
 * deployment, and a file naming any other asks for a confirmation it cannot
 * get here, so the CLI prints "Deploying to <that deployment>" only once the
 * target is the one the file names; the push request follows that line, dry
 * run or not, and is judged by the deployment. It writes nothing, which git
 * status, the same before and after it, confirms.
 *
 * @param io - The machine.
 * @param target - The deployment.
 * @param proof - Whether the push must be accepted too, or only the target resolved.
 */
export function proveTarget(
  io: CloudIo,
  target: CloudTarget,
  proof: TargetProof,
): Failure | undefined {
  const before = io.run('git', ['status', '--porcelain'], { timeoutMs: 30_000 }).stdout;
  const dry = io.run(
    'npx',
    ['convex', 'deploy', '--dry-run', '--typecheck', 'enable', '--env-file', target.file],
    { timeoutMs: 600_000 },
  );
  const named = pushTarget(`${dry.stdout}\n${dry.stderr}`, 'dry-run');
  if (named !== target.deployment) {
    return {
      failure:
        `the dry run of the push did not name ${target.deployment} as the deployment it would ` +
        `reach (${named === undefined ? `exit ${dry.status ?? 'unknown'}` : `it named ${named}`}): ` +
        `${lastErrorLine(dry)}. Only the project's default production deployment is pushed to; ` +
        'the Convex dashboard names it.',
    };
  }
  if (dry.status !== 0 && proof === 'push') {
    return {
      failure: `the dry run reached ${target.deployment} and the deployment refused the push (exit ${dry.status ?? 'unknown'}): ${lastErrorLine(dry)}.`,
    };
  }
  const after = io.run('git', ['status', '--porcelain'], { timeoutMs: 30_000 }).stdout;
  return after === before
    ? undefined
    : { failure: `the dry run changed the checkout (${firstLine(after) || 'a change undone'}).` };
}

/** A stack frame the CLI prints after the server's cause: never the explanation. */
const STACK_FRAME = /^at\s/;

/**
 * A line that names an error: the CLI's cross or a leading `Error`, a word
 * ending in `Error` or `Exception` before a colon, or an exception code such
 * as `AuthConfigMissingEnvironmentVariable:`.
 */
const NAMES_ERROR =
  /^(?:\u2716|Error\b)|\b[A-Za-z]*(?:Error|Exception):|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+:/;

/**
 * The line a failed CLI run explains itself with: the last that names an
 * error, where the CLI prints the most specific cause, or else the last that
 * is not a stack frame. The server's frames follow its cause, so the very last
 * line is often `at <anonymous> (../convex/auth.config.ts:60:15)`.
 *
 * @param result - The run.
 */
function lastErrorLine(result: RunResult): string {
  const lines = plainText(`${result.stdout}\n${result.stderr}`)
    .split('\n')
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const explanations = lines.filter((line) => !STACK_FRAME.test(line));
  const line =
    explanations.findLast((candidate) => NAMES_ERROR.test(candidate)) ??
    explanations.at(-1) ??
    lines.at(-1);
  return (line ?? 'no output').replace(/\.$/, '');
}

/**
 * The deployment's env, read whole and kept in memory: only names, and the
 * two values the verbs decide on (the mode and the pause), are ever used.
 *
 * @param io - The machine.
 * @param target - The deployment.
 */
export function readDeploymentEnv(io: CloudIo, target: CloudTarget): Map<string, string> | Failure {
  const listed = convexOn(io, target, ['convex', 'env', 'list']);
  if (listed.status !== 0) {
    return {
      failure: `the deployment's env could not be read (exit ${listed.status ?? 'unknown'}: ${firstLine(listed.stderr)})`,
    };
  }
  return deploymentEnv(listed.stdout);
}

/**
 * Push the functions, confirm where they went, and put back the generated
 * code the push's codegen rewrote, so the app is built from the tag.
 *
 * @param io - The machine.
 * @param target - The deployment.
 * @param message - What the deployment's history records for this push.
 */
export function pushFunctions(
  io: CloudIo,
  target: CloudTarget,
  message: string,
): Failure | undefined {
  io.log(
    `Pushing the functions to ${target.deployment} (a few minutes; the output follows on a failure).`,
  );
  const pushed = io.run(
    'npx',
    ['convex', 'deploy', '--typecheck', 'enable', '--env-file', target.file, '--message', message],
    { timeoutMs: 900_000 },
  );
  const reached = pushTarget(`${pushed.stdout}\n${pushed.stderr}`, 'push');
  const restored = io.run('git', ['checkout', '--', 'convex/_generated'], { timeoutMs: 30_000 });
  if (pushed.status !== 0 || reached !== target.deployment) {
    return {
      failure: [
        `the push did not report deploying to ${target.deployment} (exit ${pushed.status ?? 'unknown'}${reached !== undefined ? `, it named ${reached}` : ''}); its last lines:`,
        ...tail(pushed),
      ].join('\n'),
    };
  }
  const status = io.run('git', ['status', '--porcelain'], { timeoutMs: 30_000 });
  if (restored.status !== 0 || status.stdout.trim() !== '') {
    return {
      failure: `the push left the checkout changed (${firstLine(status.stdout) || firstLine(restored.stderr)}); the app is not built from a changed tree.`,
    };
  }
  io.log(
    `Pushed to ${deploymentUrl(target.deployment)}; convex/_generated put back as the tag has it.`,
  );
  return undefined;
}

/** The most `migrations:runPending` calls one run makes; each resumes where the last stopped. */
const MIGRATION_CALLS = 12;

/**
 * Run every pending migration, then stamp the release and read the stamp back.
 *
 * @param io - The machine.
 * @param target - The deployment.
 * @param checkout - The release and commit to stamp.
 */
export function migrateAndStamp(
  io: CloudIo,
  target: CloudTarget,
  checkout: CheckoutState,
): { readonly changed: readonly string[] } | Failure {
  const changed: string[] = [];
  let pending: readonly string[] = ['(not yet read)'];
  for (let call = 1; call <= MIGRATION_CALLS && pending.length > 0; call += 1) {
    const ran = convexOn(io, target, MIGRATIONS_ARGUMENTS, { timeoutMs: 900_000 });
    if (ran.status !== 0) {
      return {
        failure: `migrations:runPending failed (exit ${ran.status ?? 'unknown'}: ${firstLine(ran.stderr)})`,
      };
    }
    try {
      const report = parseMigrationReport(ran.stdout);
      for (const line of migrationLines(report)) {
        io.log(`  ${line}`);
        changed.push(line);
      }
      pending = report.pending;
    } catch (error) {
      return { failure: `migrations:runPending printed no report: ${errorMessage(error)}` };
    }
  }
  if (pending.length > 0) {
    return {
      failure: `migrations still pending after ${MIGRATION_CALLS} calls (${pending.join(', ')}); run the verb again, which resumes them`,
    };
  }
  const stamped = convexOn(io, target, releaseStampArguments(checkout.release, checkout.commit), {
    timeoutMs: 180_000,
  });
  if (stamped.status !== 0) {
    return {
      failure: `migrations:recordRelease refused (${firstLine(stamped.stderr) || firstLine(stamped.stdout)})`,
    };
  }
  const read = convexOn(io, target, RELEASE_STAMP_ARGUMENTS);
  let stamp: ReturnType<typeof parseReleaseStamp>;
  try {
    stamp = read.status === 0 ? parseReleaseStamp(read.stdout) : undefined;
  } catch (error) {
    return { failure: `the stamp could not be read back: ${errorMessage(error)}` };
  }
  if (stamp?.release !== checkout.release || stamp.commit !== checkout.commit) {
    return {
      failure: `the stamp reads ${stamp ? `${stamp.release} / ${stamp.commit ?? 'no commit'}` : 'nothing'} after stamping ${checkout.release} / ${checkout.commit}`,
    };
  }
  io.log(
    `Migrations done; the deployment is stamped ${checkout.release} / ${checkout.commit} (read back).`,
  );
  return { changed };
}

/**
 * The reason a pause carries, and whether the deployment holds one.
 *
 * @param env - The deployment's env.
 */
export function pauseReason(env: ReadonlyMap<string, string>): string | undefined {
  const reason = env.get(CRONS_PAUSED_FLAG)?.trim();
  return reason ? reason : undefined;
}

/** What a backup wrote. */
export interface Backup {
  readonly file: string;
  readonly sha256: string;
  readonly counts: ExportCounts;
}

/**
 * The row counts of an export, read member by member with `unzip`: the rows
 * stay in memory and never become files.
 *
 * @param io - The machine.
 * @param file - The export.
 */
function exportCounts(io: CloudIo, file: string): ExportCounts | Failure {
  const listing = io.run('unzip', ['-Z1', file], { timeoutMs: 120_000 });
  if (listing.status !== 0) return { failure: `unzip could not list ${file}` };
  const layout = exportLayout(listing.stdout);
  const count = (table: string): number | undefined => {
    const read = io.run('unzip', ['-p', file, `${table}/documents.jsonl`], { timeoutMs: 600_000 });
    return read.status === 0 ? rowCount(read.stdout) : undefined;
  };
  const tables: (readonly [string, number])[] = [];
  for (const table of layout.tables) {
    const rows = count(table);
    if (rows === undefined) return { failure: `unzip could not read ${table} in ${file}` };
    tables.push([table, rows]);
  }
  const storedFiles = layout.storage ? count('_storage') : 0;
  if (storedFiles === undefined) return { failure: `unzip could not read _storage in ${file}` };
  return { tables, storedFiles };
}

/**
 * A timestamp for a file name, sortable, to the second.
 *
 * @param at - Milliseconds since the epoch.
 */
export function fileStamp(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Export the deployment with its file storage, owner-readable only, with its
 * checksum and row counts beside it.
 *
 * @param io - The machine.
 * @param target - The deployment.
 * @param directory - Where it goes, outside the checkout.
 * @param stem - The file name without `.zip`.
 */
export function takeBackup(
  io: CloudIo,
  target: CloudTarget,
  directory: string,
  stem: string,
): Backup | Failure {
  const file = join(directory, `${stem}.zip`);
  if (existsSync(file))
    return { failure: `${file} exists already; nothing is written over a backup.` };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Written into a directory only this user can enter, then moved beside the
  // others, so the export is never readable by anyone else, whatever the umask.
  const staging = mkdtempSync(join(directory, '.export-'));
  const staged = join(staging, basename(file));
  io.log(`Exporting ${target.deployment} with its file storage to ${file}.`);
  const exported = convexOn(
    io,
    target,
    ['convex', 'export', '--include-file-storage', '--path', staged],
    { timeoutMs: 1_800_000 },
  );
  if (exported.status !== 0 || !existsSync(staged)) {
    rmSync(staging, { recursive: true, force: true });
    return {
      failure: `the export failed (exit ${exported.status ?? 'unknown'}: ${firstLine(exported.stderr)})`,
    };
  }
  chmodSync(staged, 0o600);
  renameSync(staged, file);
  rmdirSync(staging);
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  writePrivateEnv(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
  const counts = exportCounts(io, file);
  if ('failure' in counts) {
    return {
      failure: `${file} was written (sha256 ${sha256}) and its rows could not be counted: ${counts.failure}`,
    };
  }
  writePrivateEnv(`${file.replace(/\.zip$/, '')}.counts.txt`, countsText(counts));
  const rows = counts.tables.reduce((sum, [, n]) => sum + n, 0);
  io.log(
    `Wrote ${file}, sha256 ${sha256}: ${rows} rows in ${counts.tables.length} tables, ${counts.storedFiles} stored files; mode 600, with .sha256 and .counts.txt beside it.`,
  );
  if ((statSync(directory).mode & 0o077) !== 0) {
    io.log(`  note: ${directory} is readable by others; the export itself is not.`);
  }
  return { file, sha256, counts };
}

/**
 * The earliest export an upgrade to a release took in a directory, with its
 * checksum: after an attempt that stopped part way, it is the one that holds
 * the rows from before the upgrade, which a later attempt's export does not.
 *
 * @param directory - Where the upgrade's exports go.
 * @param release - The release upgraded to.
 */
export function earliestUpgradeExport(
  directory: string,
  release: string,
): { readonly file: string; readonly sha256: string } | undefined {
  if (!existsSync(directory)) return undefined;
  const pattern = new RegExp(`^before-v${release.replace(/\./g, '\\.')}-\\d{8}T\\d{6}Z\\.zip$`);
  const first = readdirSync(directory)
    .filter((name) => pattern.test(name) && existsSync(join(directory, `${name}.sha256`)))
    .sort()[0];
  if (first === undefined) return undefined;
  const file = join(directory, first);
  const sha256 = readFileSync(`${file}.sha256`, 'utf8').trim().split(/\s+/)[0] ?? '';
  return /^[0-9a-f]{64}$/.test(sha256) ? { file, sha256 } : undefined;
}

/**
 * Where an export goes, or why it may not go there.
 *
 * @param named - `--to`, when given.
 * @param io - The machine.
 * @param target - The target, whose directory is the default.
 */
export function backupDirectory(
  named: string | undefined,
  io: CloudIo,
  target: CloudTarget,
): { readonly directory: string } | Failure {
  const directory = named === undefined ? dirname(target.file) : resolve(io.cwd, named);
  if (insideCheckout(directory, io.cwd)) {
    return {
      failure: `${directory} is inside this checkout; an export goes where the checkout cannot take it with it (--to <dir>).`,
    };
  }
  return { directory };
}
