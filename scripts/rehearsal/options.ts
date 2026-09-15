/**
 * The command line of `pnpm rehearse:real` and the refusals that decide
 * whether a compose project may be used for a bed.
 */
import { PROTECTED_PROJECTS, PROTECTED_VOLUMES } from '../demo-bed';

export interface RehearsalOptions {
  /** Env-format file holding `LINEAR_API_KEY` and optionally `SLACK_BOT_TOKEN`. */
  secrets?: string;
  /** Env file the application values are copied from, read-only. */
  envFrom?: string;
  /** The primary checkout: its `docs-local` is linked and its docs tree takes the output. */
  primary?: string;
  /** Compose project the bed runs as. */
  project?: string;
  /** Where the clean clone is made. */
  clone?: string;
  /** Git ref of this checkout the clone is taken at. */
  ref: string;
  /** Repository the clone is taken from. */
  source?: string;
  /** Output directory for the run record. */
  out?: string;
  /** A project whose redactor volumes are copied into the bed's. */
  warmFrom?: string;
  /** First of the four consecutive host ports; picked free when absent. */
  portBase?: number;
  timeoutMinutes: number;
  /** Stop before the first provider write. */
  dryRun: boolean;
  /** Leave the clone and the stack up after the run. */
  keep: boolean;
  /** Launch a visible browser so the operator can watch the script drive the dashboard. */
  headed: boolean;
  help: boolean;
}

export const USAGE = `Usage: pnpm rehearse:real --secrets <file> [options]

Brings real mode up from a clean clone on its own compose project and ports,
links the primary checkout's documentation folder, deploys an agent, holds the
Day-1 1:1 in chat with the tickets' own words, approves the charter, lands the
Linear, Looker tile and Slack cards, assigns REVOPS-7 to the manager in Linear,
then drives the five checks with a screenshot and the ledger rows for each:
a plan without an ownership gate, the browser batch held whole, a wrong-key read
repaired once when it occurs, the closing comment quoting the read-back, and
completion. Afterwards it puts the workspaces back and tears the bed down.

Options:
  --secrets <file>         env file with LINEAR_API_KEY and SLACK_BOT_TOKEN (0600; required)
  --env-from <file>        application values to copy (default: <primary>/.env.local, read-only)
  --primary <dir>          the primary checkout (default: this repository's main worktree)
  --project <name>         compose project (default: day0-rehearsal-<6 hex>; never an existing one)
  --clone <dir>            where to clone (default: a fresh directory under the system temp dir)
  --ref <ref>              git ref to clone at (default: HEAD)
  --source <path>          repository to clone from (default: this checkout)
  --out <dir>              run record (default: <primary>/docs/plans/progress/real-mode-rehearsals/<stamp>)
  --warm-from <project>    copy that project's redactor wheel and model volumes into the bed
  --port-base <n>          backend, site, dashboard and app ports from n (default: picked free)
  --timeout-minutes <n>    ceiling for the whole run (default 40)
  --dry-run                stop before the first provider write; print the writes it would make
  --keep                   leave the clone and the stack up afterwards (workspaces are still reset)
  --headed                 show the browser the script drives, so the run can be watched
  --help                   print this
`;

/**
 * Read the command line.
 *
 * Args:
 *   argv: Arguments after the script name.
 *
 * Returns:
 *   The parsed options; every field the caller did not choose is undefined.
 *
 * Raises:
 *   Error: On an unknown flag, a flag without its value, or a bad number.
 */
export function parseRehearsalArguments(argv: readonly string[]): RehearsalOptions {
  const words = argv.filter((argument: string): boolean => argument !== '--');
  const options: RehearsalOptions = {
    ref: 'HEAD',
    timeoutMinutes: 40,
    dryRun: false,
    keep: false,
    headed: false,
    help: false,
  };
  const valueOf = (index: number, flag: string): string => {
    const value = words[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return value;
  };
  const numberOf = (index: number, flag: string): number => {
    const parsed = Number.parseInt(valueOf(index, flag), 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${flag} needs a positive whole number.`);
    }
    return parsed;
  };
  for (let index = 0; index < words.length; index += 1) {
    const flag = words[index];
    switch (flag) {
      case '--secrets':
        options.secrets = valueOf(index, flag);
        index += 1;
        break;
      case '--env-from':
        options.envFrom = valueOf(index, flag);
        index += 1;
        break;
      case '--primary':
        options.primary = valueOf(index, flag);
        index += 1;
        break;
      case '--project':
        options.project = valueOf(index, flag);
        index += 1;
        break;
      case '--clone':
        options.clone = valueOf(index, flag);
        index += 1;
        break;
      case '--ref':
        options.ref = valueOf(index, flag);
        index += 1;
        break;
      case '--source':
        options.source = valueOf(index, flag);
        index += 1;
        break;
      case '--out':
        options.out = valueOf(index, flag);
        index += 1;
        break;
      case '--warm-from':
        options.warmFrom = valueOf(index, flag);
        index += 1;
        break;
      case '--port-base':
        options.portBase = numberOf(index, flag);
        index += 1;
        break;
      case '--timeout-minutes':
        options.timeoutMinutes = numberOf(index, flag);
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--headed':
        options.headed = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option "${flag}".\n\n${USAGE}`);
    }
  }
  return options;
}

/**
 * The compose project a bed runs as when none is named.
 *
 * Args:
 *   hex: Six hex characters unique to this run.
 *
 * Returns:
 *   `day0-rehearsal-<hex>`.
 */
export function rehearsalProjectName(hex: string): string {
  return `day0-rehearsal-${hex}`;
}

/**
 * Project names out of `docker compose ls -a --format json`.
 *
 * Args:
 *   stdout: The command's output.
 *
 * Returns:
 *   Every project name listed, running or exited; nothing when the output is not JSON.
 */
export function parseComposeProjects(stdout: string): string[] {
  if (!stdout.trim()) return [];
  try {
    const rows = JSON.parse(stdout) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row: unknown): string[] =>
      typeof (row as { Name?: unknown }).Name === 'string' ? [(row as { Name: string }).Name] : [],
    );
  } catch {
    return [];
  }
}

export interface ProjectRefusalInput {
  project: string;
  /** The primary checkout's own `COMPOSE_PROJECT_NAME`. */
  primaryProject: string;
  /** Projects `docker compose ls -a` lists. */
  composeProjects: readonly string[];
  /** Every volume Docker has. */
  volumes: readonly string[];
  /** Project labels on every container Docker has. */
  labelledContainers: readonly string[];
}

/**
 * Why a compose project may not be used for a bed, if it may not.
 *
 * Args:
 *   input: The name and what Docker and the primary checkout already claim.
 *
 * Returns:
 *   The refusal, or undefined when the name is free to use.
 */
export function projectRefusal(input: ProjectRefusalInput): string | undefined {
  const { project } = input;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) {
    return `"${project}" is not a compose project name: lowercase letters, digits, "-" and "_" only.`;
  }
  if (PROTECTED_PROJECTS.includes(project) || PROTECTED_VOLUMES.includes(`${project}_convex_data`)) {
    return `"${project}" is protected: it holds a real run and this rehearsal never starts or removes it.`;
  }
  if (project === input.primaryProject.trim()) {
    return `"${project}" is the primary checkout's own project; a rehearsal never runs as it.`;
  }
  if (input.composeProjects.includes(project)) {
    return `compose project "${project}" already exists (docker compose ls -a); pick another --project.`;
  }
  const volume = input.volumes.find((name: string): boolean => name.startsWith(`${project}_`));
  if (volume) return `volume ${volume} already exists, so "${project}" is not a fresh project.`;
  if (input.labelledContainers.includes(project)) {
    return `a container already carries the compose label for "${project}"; pick another --project.`;
  }
  return undefined;
}
