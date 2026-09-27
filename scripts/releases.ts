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
