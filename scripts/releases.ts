/**
 * Which release a deployment's rows are at, which one this checkout is, and
 * whether the upgrade may go from one to the other (decision N10: sequential
 * upgrades only, a version row the upgrade compares, a refusal to jump more
 * than one release).
 *
 * The releases are the `## vX.Y.Z` headings of `CHANGELOG.md`, which every
 * release writes, so there is no second list to keep; the checkout's own
 * release is `package.json`'s version. The row is `deploymentVersions`
 * (`convex/migrations.ts`), read with the Convex CLI's `data` command before
 * anything is pushed, because the functions that could answer are the ones
 * about to be replaced.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The release a deployment that holds rows but no stamp is taken to be at:
 * the last release before the stamp existed.
 */
export const LAST_UNVERSIONED_RELEASE = '0.3.0';

/** The table the stamp lives in. */
export const RELEASE_TABLE = 'deploymentVersions';

/** The release stamp as the deployment holds it. */
export interface ReleaseStamp {
  readonly release: string;
  readonly commit?: string;
}

/** Whether the upgrade may push this checkout over the deployment's rows, and what to say. */
export type UpgradeVerdict =
  | { readonly allowed: true; readonly from: string | undefined; readonly note: string }
  | { readonly allowed: false; readonly reason: string };

/**
 * Every release `CHANGELOG.md` records, oldest first.
 *
 * @param changelog - The file's text.
 */
export function changelogReleases(changelog: string): string[] {
  const newestFirst = [...changelog.matchAll(/^## v(\d+\.\d+\.\d+)\b/gm)].map((match) => match[1]);
  return [...new Set(newestFirst)].reverse();
}

/** The checkout's own release and the releases its CHANGELOG records, or why they cannot be read. */
export function checkoutReleases(
  cwd: string,
): { release: string; releases: string[] } | { reason: string } {
  const changelogPath = join(cwd, 'CHANGELOG.md');
  let release: unknown;
  try {
    release = (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { version?: unknown })
      .version;
  } catch (error) {
    return { reason: `package.json could not be read (${String(error)})` };
  }
  if (typeof release !== 'string' || release === '') {
    return { reason: 'package.json names no version' };
  }
  if (!existsSync(changelogPath)) return { reason: 'there is no CHANGELOG.md in this checkout' };
  return { release, releases: changelogReleases(readFileSync(changelogPath, 'utf8')) };
}

/** The Convex CLI arguments that list the deployment's tables. */
export const TABLE_LISTING_ARGUMENTS: readonly string[] = ['convex', 'data'];

/** The Convex CLI arguments that print the newest release stamp as one JSON line. */
export const RELEASE_STAMP_ARGUMENTS: readonly string[] = [
  'convex',
  'data',
  RELEASE_TABLE,
  '--limit',
  '1',
  '--format',
  'jsonl',
];

/**
 * Whether the table listing the CLI printed names the stamp's table. A
 * deployment with no tables prints nothing on stdout.
 */
export function listsReleaseTable(stdout: string): boolean {
  return stdout.split('\n').some((line) => line.trim() === RELEASE_TABLE);
}

/**
 * The stamp out of the CLI's one-line JSON, or undefined when the table has
 * no row (the CLI then prints nothing on stdout).
 *
 * @throws Error when the line is not a stamp.
 */
export function parseReleaseStamp(stdout: string): ReleaseStamp | undefined {
  const line = stdout.split('\n').find((candidate) => candidate.trim().startsWith('{'));
  if (line === undefined) return undefined;
  const row = JSON.parse(line) as { release?: unknown; commit?: unknown };
  if (typeof row.release !== 'string') {
    throw new Error(`the ${RELEASE_TABLE} row carries no release: ${line.trim()}`);
  }
  return {
    release: row.release,
    ...(typeof row.commit === 'string' ? { commit: row.commit } : {}),
  };
}

/**
 * Whether the upgrade may take a deployment from its stamped release to the
 * checkout's.
 *
 * A fresh volume has no rows, so any release starts it. A volume with rows
 * and no stamp is at `LAST_UNVERSIONED_RELEASE`. The same release again is a
 * re-run; the next release is an upgrade; anything else is refused before a
 * function is pushed: a skipped release would never run its migrations, and
 * older functions over rows a newer release migrated would refuse the push or
 * misread the rows.
 *
 * @param input.stored - The stamped release, or undefined when there is none.
 * @param input.fresh - Whether the data volume is new.
 * @param input.checkout - This checkout's release.
 * @param input.releases - Every release, oldest first.
 */
export function upgradeVerdict(input: {
  stored: string | undefined;
  fresh: boolean;
  checkout: string;
  releases: readonly string[];
}): UpgradeVerdict {
  const { checkout, releases } = input;
  const at = releases.indexOf(checkout);
  if (at < 0) {
    return {
      allowed: false,
      reason:
        `this checkout's release (${checkout}, from package.json) has no heading in CHANGELOG.md, so ` +
        'the upgrade cannot tell which release comes before it.',
    };
  }
  if (input.fresh)
    return { allowed: true, from: undefined, note: `a new volume, starting at ${checkout}` };
  const stored = input.stored ?? LAST_UNVERSIONED_RELEASE;
  const unstamped = input.stored === undefined ? ' (taken from its unstamped rows)' : '';
  const from = releases.indexOf(stored);
  if (from < 0) {
    return {
      allowed: false,
      reason:
        `the deployment's rows are at ${stored}, a release this checkout's CHANGELOG.md does not ` +
        'record. Check out the release that follows it and upgrade from there.',
    };
  }
  if (from === at) {
    return { allowed: true, from: stored, note: `already at ${checkout}${unstamped}` };
  }
  if (from === at - 1) {
    return { allowed: true, from: stored, note: `${stored}${unstamped} to ${checkout}` };
  }
  if (from > at) {
    return {
      allowed: false,
      reason:
        `the deployment's rows are at ${stored}, newer than this checkout's ${checkout}. Older ` +
        `functions are never pushed over rows a newer release has migrated: check out v${stored} ` +
        'or later, or restore the backup taken before that upgrade.',
    };
  }
  const skipped = releases.slice(from + 1, at);
  return {
    allowed: false,
    reason:
      `the deployment's rows are at ${stored}${unstamped}, and ${checkout} skips ` +
      `${skipped.join(', ')}. Releases are upgraded one at a time so each runs its own ` +
      `migrations: check out v${skipped[0]}, upgrade, then come back to this checkout.`,
  };
}

/** The table the upgrade's migrations keep their progress in. */
export const MIGRATIONS_TABLE = 'migrations';

/**
 * The declarations this checkout's schema no longer carries, each with the
 * migration that cleared it from every row (decision N10: a
 * widen-migrate-narrow cycle ships as two releases). Convex checks every
 * stored row against the schema at a push, so a row still carrying one of
 * these would refuse the push halfway; the upgrade refuses before anything is
 * pushed instead, until the release that shipped the migration has run it.
 */
export const RETIRED_DECLARATIONS: ReadonlyArray<{
  readonly declaration: string;
  readonly migration: string;
  readonly release: string;
}> = [
  { declaration: 'agents.docSourceIds', migration: 'agents-inclusion-list', release: '0.4.0' },
  { declaration: 'agents.posture', migration: 'agents-posture', release: '0.4.0' },
  { declaration: 'skills.daytonaSandboxId', migration: 'skills-sandbox-id', release: '0.4.0' },
  {
    declaration: 'skills.supervisedRunsCompleted',
    migration: 'skills-supervised-runs',
    release: '0.4.0',
  },
  { declaration: 'surfaces.credentialRef', migration: 'surfaces-credential-ref', release: '0.4.0' },
];

/** The most migration rows the check reads; one per migration any release shipped. */
const MIGRATION_ROWS_READ = 1_000;

/** The Convex CLI arguments that print every migration's row as JSON lines. */
export const MIGRATION_ROWS_ARGUMENTS: readonly string[] = [
  'convex',
  'data',
  MIGRATIONS_TABLE,
  '--limit',
  String(MIGRATION_ROWS_READ),
  '--format',
  'jsonl',
];

/**
 * The retired declarations whose clearing migration the deployment has not
 * finished, from the migration rows the CLI printed.
 *
 * @param stdout - The rows as JSON lines, or nothing when the table is absent.
 * @param candidates - The declarations to check, all of them by default.
 * @returns The declarations a row may still carry.
 * @throws Error when a line is not a migration row.
 */
export function unclearedDeclarations(
  stdout: string,
  candidates: typeof RETIRED_DECLARATIONS = RETIRED_DECLARATIONS,
): typeof RETIRED_DECLARATIONS {
  const finished = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let row: { name?: unknown; completedAt?: unknown };
    try {
      row = JSON.parse(line) as { name?: unknown; completedAt?: unknown };
    } catch {
      throw new Error(`a migrations row is not JSON: ${line.trim().slice(0, 80)}`);
    }
    if (typeof row.name === 'string' && typeof row.completedAt === 'number') finished.add(row.name);
  }
  return candidates.filter((retired) => !finished.has(retired.migration));
}

/**
 * The retired declarations a deployment's rows may still carry by their
 * stamp: those whose clearing release is after the stamp, or unknown to this
 * checkout, or every one on a volume with no stamp. A stamp at or after the
 * clearing release means the release check of that release saw its
 * migrations finish, or the volume was created then and never held the field.
 *
 * @param stored - The stamped release, or undefined when there is none.
 * @param releases - Every release, oldest first.
 */
function declarationsToCheck(
  stored: string | undefined,
  releases: readonly string[],
): typeof RETIRED_DECLARATIONS {
  if (stored === undefined) return RETIRED_DECLARATIONS;
  const at = releases.indexOf(stored);
  return RETIRED_DECLARATIONS.filter((retired) => {
    const cleared = releases.indexOf(retired.release);
    return at < 0 || cleared < 0 || at < cleared;
  });
}

/** The Convex CLI arguments that run every migration still pending (`convex/migrations.ts`). */
export const MIGRATIONS_ARGUMENTS: readonly string[] = ['convex', 'run', 'migrations:runPending'];

/**
 * The Convex CLI arguments that stamp the release once the upgrade is done.
 *
 * @param release - The checkout's release.
 * @param commit - The commit the functions were pushed from, when known.
 *
 * @returns Arguments for `npx`.
 */
export function releaseStampArguments(release: string, commit?: string): string[] {
  return [
    'convex',
    'run',
    'migrations:recordRelease',
    JSON.stringify({ release, ...(commit !== undefined ? { commit } : {}) }),
  ];
}

/** What one `migrations:runPending` call reports. */
export interface MigrationReport {
  migrations: { name: string; read: number; changed: number }[];
  pending: string[];
}

/**
 * The report `npx convex run migrations:runPending` printed.
 *
 * @param stdout - The CLI's output: the function's return value as JSON.
 *
 * @returns The report.
 *
 * @throws When the output holds no report.
 */
export function parseMigrationReport(stdout: string): MigrationReport {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('migrations:runPending printed no report');
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as Partial<MigrationReport>;
  if (!Array.isArray(parsed.migrations) || !Array.isArray(parsed.pending)) {
    throw new Error('migrations:runPending printed something other than its report');
  }
  return { migrations: parsed.migrations, pending: parsed.pending };
}

/**
 * The lines the setup prints for a migration report: what each migration
 * changed, and the ownerless agents it could not give to anyone.
 *
 * @param report - One call's report.
 *
 * @returns Lines to print, none when nothing changed.
 */
export function migrationLines(report: MigrationReport): string[] {
  const lines = report.migrations
    .filter((migration) => migration.changed > 0)
    .map((migration) => `migrated ${migration.name}: ${migration.changed} row(s) changed`);
  const owners = report.migrations.find((migration) => migration.name === 'agents-owner');
  if (owners !== undefined && owners.read > owners.changed) {
    lines.push(
      `${owners.read - owners.changed} agent(s) with no owner were left as they are: this ` +
        'deployment has more than one owner, so none is theirs by default',
    );
  }
  return lines;
}

/** What a Convex CLI call returned, as the release read needs it. */
export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Read the deployment's release stamp through the Convex CLI and decide
 * whether this checkout may be pushed over its rows. A deployment with no
 * tables has had nothing pushed, so it is new whatever its volume; one that
 * cannot be read is refused.
 *
 * @param npx - Runs `npx` with the given arguments against the deployment.
 * @param checkout - This checkout's release and the releases it records.
 */
export function readReleaseVerdict(
  npx: (args: readonly string[]) => CliResult,
  checkout: { release: string; releases: readonly string[] },
): UpgradeVerdict {
  const refused = (what: string, result: CliResult): UpgradeVerdict => ({
    allowed: false,
    reason: `${what}: ${firstLineOf(result.stderr) || firstLineOf(result.stdout) || `exit ${result.status ?? 'unknown'}`}`,
  });
  const tables = npx(TABLE_LISTING_ARGUMENTS);
  if (tables.status !== 0) return refused("the deployment's tables could not be listed", tables);
  const fresh = tables.stdout.trim() === '';
  let stored: string | undefined;
  if (listsReleaseTable(tables.stdout)) {
    const read = npx(RELEASE_STAMP_ARGUMENTS);
    if (read.status !== 0) return refused('the release stamp could not be read', read);
    try {
      stored = parseReleaseStamp(read.stdout)?.release;
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const verdict = upgradeVerdict({
    stored,
    fresh,
    checkout: checkout.release,
    releases: checkout.releases,
  });
  if (!verdict.allowed || fresh) return verdict;
  const candidates = declarationsToCheck(stored, checkout.releases);
  if (candidates.length === 0) return verdict;
  // A volume with rows but no migrations table never ran a migration.
  let rows = '';
  if (tables.stdout.split('\n').some((line) => line.trim() === MIGRATIONS_TABLE)) {
    const read = npx(MIGRATION_ROWS_ARGUMENTS);
    if (read.status !== 0) return refused("the deployment's migrations could not be read", read);
    rows = read.stdout;
  }
  let uncleared: typeof RETIRED_DECLARATIONS;
  try {
    uncleared = unclearedDeclarations(rows, candidates);
  } catch (error) {
    return {
      allowed: false,
      reason: `the deployment's migrations could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (uncleared.length === 0) return verdict;
  return {
    allowed: false,
    reason:
      `rows may still carry ${uncleared.map((retired) => retired.declaration).join(', ')}, which ` +
      `this checkout no longer declares: the migrations that clear them ` +
      `(${uncleared.map((retired) => retired.migration).join(', ')}) have not finished here. ` +
      `Check out v${uncleared[0].release} or a later release that still declares them, run the ` +
      'upgrade to its end, then come back to this checkout.',
  };
}

/** The first non-empty line of some output. */
function firstLineOf(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}
