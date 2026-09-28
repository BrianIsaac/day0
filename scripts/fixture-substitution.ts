/**
 * The one substitution rule every recorded fixture under `tests/` carries
 * (decision N15): the manager's Slack DM channel id and the operator's name
 * are replaced by placeholders, everywhere, by this script and never by
 * hand. The Slack, Linear and Notion identifiers stay as recorded and are
 * stated once in `tests/fixtures/README.md`.
 *
 * `pnpm fixtures:substitute` rewrites the files in place; `--check` changes
 * nothing and exits 1 naming any file the rule would still change, which is
 * what the mirrored test runs over the tracked tree.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeRegExp } from '../src/lib/regex';

/** One replacement, applied in order to every covered file's text. */
export interface Substitution {
  /** What the rule replaces, for the check's report. */
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
  /** A rule that runs under `tests/fixtures/` only, because its word is an English one elsewhere. */
  readonly fixturesOnly?: boolean;
}

/** The manager DM channel id every recording carries in place of the real one. */
export const MANAGER_DM_PLACEHOLDER = 'D0MANAGER';

/** The manager's and requester's name in every recording, in place of the operator's. */
export const MANAGER_NAME_PLACEHOLDER = 'Sam';

/** The placeholder's full name and handle, where a recording carried the operator's. */
const MANAGER_FULL_NAME_PLACEHOLDER = 'Sam Ortiz';
const MANAGER_HANDLE_PLACEHOLDER = 'sam.ortiz';

/** The git branch prefix a recording carries in place of the operator's. */
export const MANAGER_BRANCH_PREFIX_PLACEHOLDER = 'sam/';

/**
 * The branch prefix Linear builds from the operator's account name, which a
 * `list_issues` effect carries in every issue's `gitBranchName`.
 */
export const OPERATOR_LINEAR_BRANCH_PREFIX = 'isaacbikjk/';

/**
 * The rules, most specific first so a full name is replaced whole before the
 * first name alone is. `Brain` and `brain` are the misspellings one recorded
 * charter carried and its tests quote.
 */
export const SUBSTITUTIONS: readonly Substitution[] = [
  { name: 'manager DM channel id', pattern: /D0BS5SXMXPZ/g, replacement: MANAGER_DM_PLACEHOLDER },
  {
    name: 'manager full name',
    pattern: /\bBrian Isaac\b/g,
    replacement: MANAGER_FULL_NAME_PLACEHOLDER,
  },
  { name: 'manager handle', pattern: /\bbrian\.isaac\b/g, replacement: MANAGER_HANDLE_PLACEHOLDER },
  {
    name: "manager's Linear branch prefix",
    pattern: new RegExp(`\\b${escapeRegExp(OPERATOR_LINEAR_BRANCH_PREFIX)}`, 'g'),
    replacement: MANAGER_BRANCH_PREFIX_PLACEHOLDER,
  },
  {
    name: 'manager branch prefix',
    pattern: /\bbrian\//g,
    replacement: MANAGER_BRANCH_PREFIX_PLACEHOLDER,
  },
  { name: 'manager initialled name', pattern: /\bBrian I\b/g, replacement: 'Sam O' },
  { name: 'manager first name', pattern: /\bBrian\b/g, replacement: MANAGER_NAME_PLACEHOLDER },
  {
    name: 'manager first name, misspelt',
    pattern: /\bBrain\b/g,
    replacement: MANAGER_NAME_PLACEHOLDER,
  },
  {
    name: 'manager first name, lower case',
    pattern: /\b(?:brian|brain)\b/g,
    replacement: 'sam',
    fixturesOnly: true,
  },
];

/**
 * Files the rule never touches, relative to the repository root: the
 * redaction corpus and its recorded spans, which the span model's recording
 * keys by character offset, so a substitution there would invalidate a
 * recording nothing in the gate can retake; and this rule's own test, which
 * carries the pre-images by design.
 */
export const EXCLUDED_PATHS: readonly string[] = [
  'tests/fixtures/redaction/',
  'tests/scripts/fixture-substitution.test.ts',
];

/** The directory the rule covers, relative to the repository root. */
export const FIXTURE_ROOT = 'tests';

/** The extensions the rule reads as text; anything else under `tests/` is left alone. */
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.json', '.md', '.txt', '.jsonl', '.csv', '.mts']);

/** Apply every rule to one text; a fixtures-only rule runs when the path is under the fixtures. */
export function substitute(text: string, relativePath = 'tests/fixtures/'): string {
  const inFixtures = relativePath.split(sep).join('/').startsWith('tests/fixtures/');
  return SUBSTITUTIONS.reduce(
    (current, rule) =>
      rule.fixturesOnly && !inFixtures ? current : current.replace(rule.pattern, rule.replacement),
    text,
  );
}

/** Whether a path, relative to the root, is one the rule never touches. */
export function isExcluded(relativePath: string): boolean {
  const posix = relativePath.split(sep).join('/');
  return EXCLUDED_PATHS.some((excluded) =>
    excluded.endsWith('/') ? posix.startsWith(excluded) : posix === excluded,
  );
}

/** Every file under the fixture root the rule covers, relative to the repository root. */
export function coveredFiles(repositoryRoot: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const relativePath = relative(repositoryRoot, path);
      const extension = entry.slice(entry.lastIndexOf('.'));
      if (!isExcluded(relativePath) && TEXT_EXTENSIONS.has(extension)) found.push(relativePath);
    }
  };
  walk(join(repositoryRoot, FIXTURE_ROOT));
  return found;
}

/** What one run of the rule did, or would do under `check`. */
export interface SubstitutionRun {
  /** Files the rule changed, or would change, relative to the repository root. */
  readonly changed: readonly string[];
}

/**
 * Run the rule over every covered file. Under `check` no file is written.
 */
export function applySubstitutions(
  repositoryRoot: string,
  options: { readonly check: boolean },
): SubstitutionRun {
  const changed: string[] = [];
  for (const relativePath of coveredFiles(repositoryRoot)) {
    const path = join(repositoryRoot, relativePath);
    const before = readFileSync(path, 'utf8');
    const after = substitute(before, relativePath);
    if (after === before) continue;
    changed.push(relativePath);
    if (!options.check) writeFileSync(path, after);
  }
  return { changed };
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const run = applySubstitutions(root, { check });
  if (run.changed.length === 0) {
    console.log('Every fixture already carries the placeholders.');
    return 0;
  }
  const verb = check ? 'would change' : 'rewrote';
  console.log(`The substitution rule ${verb} ${run.changed.length} file(s):`);
  for (const path of run.changed) console.log(`  ${path}`);
  return check ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
