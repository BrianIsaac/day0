/// <reference types="node" />
/**
 * Run `docker compose` for this project with the components you chose.
 *
 *   pnpm convex:up                                          # day0 alone
 *   pnpm convex:up --profile docs-notion --profile browser  # + two components
 *   pnpm convex:down --profile docs-notion --profile browser
 *
 * Every service in `docker-compose.yml` sits behind a profile, and the profiles
 * are the components: `real` is day0's backend and each other profile adds one
 * optional adapter or fixture. `real` is added to every invocation, because
 * there is nothing to add a component to without it.
 *
 * Two things this does that a raw `docker compose` line does not. It refuses a
 * profile name that does not exist in the file - a mistyped `--profile browers`
 * is otherwise accepted in silence and simply starts nothing, which reads
 * exactly like a component that failed. And it prints the components it is
 * about to act on, so the answer to "what is running?" is on screen rather
 * than in a later `ps`.
 *
 * `--env-file .env.local` is always passed: the compose file reads
 * CONVEX_BIND_ADDR, the host ports and DAY0_DOCS_HOST_DIR from there, and a
 * plain `docker compose` silently takes different defaults.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ENV_FILE = '.env.local';

/** day0's own backend. Every invocation gets it; nothing runs without it. */
export const BASE_PROFILE = 'real';

/**
 * Every profile `docker-compose.yml` defines, with what it starts.
 *
 * Kept here rather than parsed out of the file so that a name the compose file
 * does not define is refused with a list, and so that `pnpm convex:up --help`
 * is the same list an enterprise reads in docs/running/components.md.
 */
export const PROFILES: Readonly<Record<string, string>> = {
  real: "day0's backend (always started)",
  'docs-notion': 'read documentation out of Notion (docs-notion-mcp)',
  browser: 'reach a system that has a web UI and no API (playwright-mcp)',
  demo: 'the synthetic Looker tile the browser component is shown against',
  test: 'the fake Slack provider used by tests and review panes',
  dev: 'the Convex dashboard',
  model: 'a bundled OpenAI-compatible model server',
  sandbox: 'the local sandbox that verifies an authored skill',
};

export interface ComposeInvocation {
  /** Selected profiles, `real` first, in the order given and deduplicated. */
  profiles: string[];
  /** Everything else, in the order given: the compose command and its flags. */
  rest: string[];
}

/**
 * Split a command line into selected profiles and the compose command.
 *
 * Args:
 *   argv: Arguments after the script name.
 *
 * Returns:
 *   The selected profiles and the remaining compose arguments.
 *
 * Raises:
 *   Error: If `--profile` has no value, or names a profile the compose file
 *     does not define.
 */
export function parseComposeArguments(argv: readonly string[]): ComposeInvocation {
  const profiles: string[] = [BASE_PROFILE];
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let value: string | undefined;
    if (argument === '--profile') {
      value = argv[index + 1];
      index += 1;
      if (value === undefined) throw new Error('--profile needs a profile name.');
    } else if (argument.startsWith('--profile=')) {
      value = argument.slice('--profile='.length);
    } else {
      rest.push(argument);
      continue;
    }
    const name = value.trim();
    if (!(name in PROFILES)) {
      throw new Error(
        `Unknown profile "${name}". This compose file defines: ${Object.keys(PROFILES).join(', ')}.`,
      );
    }
    if (!profiles.includes(name)) profiles.push(name);
  }
  return { profiles, rest };
}

/**
 * Build the full `docker compose` argument list for one invocation.
 *
 * Args:
 *   argv: Arguments after the script name.
 *   envFile: Environment file compose reads its host-side values from.
 *
 * Returns:
 *   Arguments to pass to `docker`.
 */
export function composeArguments(argv: readonly string[], envFile: string = ENV_FILE): string[] {
  const { profiles, rest } = parseComposeArguments(argv);
  return [
    'compose',
    '--env-file',
    envFile,
    ...profiles.flatMap((profile: string): string[] => ['--profile', profile]),
    ...rest,
  ];
}

/** One line naming the components this invocation acts on. */
export function componentSummary(profiles: readonly string[]): string {
  return profiles
    .map((profile: string): string => `${profile} (${PROFILES[profile] ?? 'unknown'})`)
    .join('\n  ');
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: pnpm convex:up [--profile <name>]... [compose arguments]\n');
    console.log('Profiles:');
    for (const [name, description] of Object.entries(PROFILES)) {
      console.log(`  ${name.padEnd(12)} ${description}`);
    }
    console.log('\nWhat each component is for: docs/running/components.md');
    return;
  }
  let invocation: ComposeInvocation;
  try {
    invocation = parseComposeArguments(argv);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  }
  console.log(`Components:\n  ${componentSummary(invocation.profiles)}\n`);
  const result = spawnSync('docker', composeArguments(argv), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
