/// <reference types="node" />
/**
 * Reports whether this machine is set up to run Day0 locally, one decision at
 * a time.
 *
 *   pnpm check:setup
 *   pnpm --silent check:setup --report > day0-setup-report.json
 *
 * `--report` prints one JSON document instead, the support bundle remote
 * support works from (A12): tool versions, the pinned images and whether each
 * runs, the digests of the redactor's locks and model manifest, every outbound
 * host the configuration names, and each section's status. No key and no
 * line a section explains itself with goes into it; the model, Daytona and
 * Clerk addresses appear as hostnames only, since an egress list is made of
 * them.
 *
 * It answers the question a reader actually has after following the README -
 * "did I set this up correctly?" - and the honest answer is not one boolean.
 * Day0 has five independent setups (backend, auth, model, sandbox, voice), each
 * of which can be complete, deliberately skipped, or half-done, and the failure
 * that costs an afternoon is always the half-done one that looks finished. So
 * each is reported separately and only the states that are *wrong* fail the
 * command.
 *
 * Two things this does not do. It never calls a provider with a key: no key
 * here is spent establishing that it exists. The one address it dials is the
 * model's, from inside the backend container and with no key, because an
 * address this machine reaches may still be one the container cannot, and
 * only the container can say so. And it cannot see the ElevenLabs dashboard,
 * so the dynamic variables an agent must declare are printed to check by eye
 * rather than guessed at.
 *
 * It does ask Docker one question, because one of the five is not a variable.
 * Whether skill verification works locally depends on whether the bundled
 * sandbox service is running, and `.env.local` cannot say - the reader would
 * otherwise find out by watching a skill fail.
 *
 * Values are read from `.env.local`, then overridden by the *process*
 * environment wherever a variable is present there - including when it is
 * present and empty. That last part is the whole point of the precedence rule:
 * Next keeps an already-set process variable rather than taking the file's, and
 * routes read `process.env` directly and treat an empty string as missing. A
 * checker that only applied non-empty overrides would report a secret as
 * configured while the running route answered 503 to every delivery.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { customerOidcIssuer, type CustomerOidcIssuer } from '../src/lib/customer-oidc';
import { PRIVATE_HOSTS_VAR, privateHostAllowlist } from '../src/lib/private-hosts';
import { DEPLOYMENT_PROFILES } from '../src/lib/surface-mode';
import { wayOfSetup } from '../src/setup/quickstart';
import { browserComponent } from '../src/surfaces/browser';
import {
  containerDialArguments,
  readContainerDial,
  unreachableFix,
  type ModelDial,
} from './model-reach';
import { isLoopback, setupRoute } from './setup-route';

export { setupRoute, type ReportedRoute, type RouteReport } from './setup-route';

/** The env file named on the command line, the first argument that is not a flag. */
const ENV_FILE =
  process.argv.slice(2).find((argument: string): boolean => !argument.startsWith('--')) ??
  '.env.local';

/** The compose service that verifies authored skills without an account. */
const SANDBOX_SERVICE = 'sandbox';

/**
 * The optional components, in the order the running instructions introduce
 * them: the compose service, the profile that starts it, and what it is for.
 */
const COMPONENTS = [
  {
    service: 'docs-notion-mcp',
    profile: 'docs-notion',
    purpose: 'read documentation out of Notion',
  },
  {
    service: 'playwright-mcp',
    profile: 'browser',
    purpose: 'reach a system that has a web UI and no API',
  },
  { service: 'looker-tile', profile: 'demo', purpose: 'the synthetic web-UI system' },
  { service: 'fake-slack', profile: 'test', purpose: 'the Slack provider double' },
  {
    service: 'redactor',
    profile: 'redactor',
    purpose: 'the span model documentation sync and the ledger redact with',
  },
  { service: 'dashboard', profile: 'dev', purpose: 'the Convex dashboard' },
] as const;

const WEBHOOK_PATH = '/api/voice/elevenlabs/webhook';

/** Sent by `startSession({ dynamicVariables })` and read back off the webhook payload. */
const DYNAMIC_VARIABLES = ['internal_agent_id', 'internal_session_token', 'boss_label'] as const;

/**
 * Every variable whose value changes what this reports. Listed explicitly
 * because the override rule is "present in the environment wins", and a bare
 * sweep of `process.env` would let unrelated shell variables through.
 */
const WATCHED = [
  'CONVEX_DEPLOYMENT',
  'NEXT_PUBLIC_CONVEX_URL',
  'CONVEX_SELF_HOSTED_URL',
  'CONVEX_SELF_HOSTED_ADMIN_KEY',
  'NEXT_PUBLIC_DEV_NO_AUTH',
  'DEV_NO_AUTH_SECRET',
  'DEV_NO_AUTH_SIGNING_KEY',
  'DEV_NO_AUTH_JWKS',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'CLERK_SECRET_KEY',
  'CLERK_JWT_ISSUER_DOMAIN',
  'DAY0_PROFILE',
  'DAY0_OIDC_ISSUER',
  'DAY0_OIDC_AUDIENCE',
  'DAY0_PRIVATE_HOSTS',
  'CONVEX_BIND_ADDR',
  'CONVEX_DASHBOARD_BIND_ADDR',
  'MODEL_BIND_ADDR',
  'FAKE_SLACK_BIND_ADDR',
  'DAY0_APP_HOST',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CONVEX_OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'DAYTONA_API_KEY',
  'DAYTONA_API_URL',
  'SKILL_SANDBOX_SOCKET',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID',
  'ELEVENLABS_WEBHOOK_SECRET',
  'DAY0_SURFACE_MODE',
  'DAY0_DOCS_ROOT',
  'DAY0_CREDENTIAL_KEY',
  'DAY0_BROWSER_MCP_URL',
  'DAY0_REDACTOR_URL',
  'DAY0_PUBLIC_URL',
  'COMPOSE_PROJECT_NAME',
] as const;

/** How a section reads: complete, worth saying out loud, or half-done. */
export type Status = 'ok' | 'warn' | 'gap';

/** One decision the report makes, with the lines that explain it. */
export interface Section {
  title: string;
  status: Status;
  lines: string[];
}

type Values = Record<string, string>;

function readEnvFile(path: string): Values {
  const values: Values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return values;
}

/** File values, then the process environment wherever it declares one at all. */
function resolve(path: string): Values {
  const values = readEnvFile(path);
  for (const key of WATCHED) {
    if (key in process.env) values[key] = process.env[key] ?? '';
  }
  return values;
}

/**
 * The one line naming the mode, the route and the way to run it, printed first
 * and last: "Local, cloud model" or "Local, local model" in real mode, and in
 * mock mode the reminder that this is the harness's and the hosted demo's
 * office rather than one of the ways.
 */
export function modeAndRouteLine(values: Values): string {
  const mode = values.DAY0_SURFACE_MODE || 'mock';
  const { route, detail } = setupRoute(values);
  const way = wayOfSetup(mode, route);
  return `Mode ${mode}, route ${route} (${detail})${way === undefined ? '' : `: ${way}`}.`;
}

/**
 * Print the setup report and say whether anything is half-done.
 *
 * The status is handed back rather than passed to `process.exit`: on a pipe
 * Node writes stdout asynchronously, and exiting straight after a burst of
 * `console.log` drops whatever has not drained yet, which showed as a report
 * missing its last sections when piped right after a backend restart.
 *
 * Args:
 *   envFile: Path of the env file to read; defaults to the CLI argument or `.env.local`.
 *
 * Returns:
 *   The process exit status: 1 when the file is missing or a section is a gap, else 0.
 */
export function main(envFile: string = ENV_FILE, options: { report?: boolean } = {}): number {
  if (!existsSync(envFile)) {
    if (options.report) {
      console.log(
        JSON.stringify(
          { kind: 'day0-setup-report', version: 1, error: `${envFile} not found` },
          null,
          2,
        ),
      );
    }
    console.error(`error: ${envFile} not found. Copy .env.example to ${envFile} first.`);
    process.exitCode = 1;
    return 1;
  }

  const v = resolve(envFile);
  const selfHosted = !!v.CONVEX_SELF_HOSTED_URL;
  const projectName = v.COMPOSE_PROJECT_NAME || 'day0';
  // Asked once and shared: every section that cares about a container reads the
  // same answer, and asking Docker is the slowest thing here.
  const services = composeRunningServices(projectName);
  const backendUrl = v.CONVEX_OPENAI_BASE_URL || v.OPENAI_BASE_URL;
  const modelDial =
    selfHosted && backendUrl && !isLoopback(backendUrl) && services?.includes('backend')
      ? dialFromBackend(projectName, backendUrl)
      : undefined;

  const migrations =
    selfHosted && services?.includes('backend')
      ? migrationsSection(readMigrationStatus(v))
      : undefined;
  const settings = settingsSection(v);
  const sections: Section[] = [
    backendSection(v),
    ...(migrations ? [migrations] : []),
    authSection(v),
    ...(settings ? [settings] : []),
    surfacesSection(v, services),
    componentsSection(v, projectName, services),
    modelSection(v, selfHosted, modelDial),
    sandboxSection(v, projectName),
    voiceSection(v),
    finalisationSection(v),
  ];

  if (options.report) {
    console.log(
      JSON.stringify(
        setupReport({
          values: v,
          sections,
          versions: toolVersions(),
          images: composeImages(readFileSync('docker-compose.yml', 'utf8')).map((row) => ({
            ...row,
            running: services?.includes(row.service) ?? false,
          })),
          digests: fileDigests(REPORTED_FILES),
          commit: checkoutCommit(),
          generatedAt: new Date().toISOString(),
        }),
        null,
        2,
      ),
    );
    const failed = sections.some((section) => section.status === 'gap');
    process.exitCode = failed ? 1 : 0;
    return failed ? 1 : 0;
  }

  console.log(`Day0 local setup, read from ${envFile}`);
  console.log('(process environment wins wherever it declares a variable, empty included)');
  console.log(`${modeAndRouteLine(v)}\n`);
  for (const section of sections) {
    console.log(`${marker(section.status)} ${section.title}`);
    for (const line of section.lines) console.log(`    ${line}`);
    console.log('');
  }

  if (voiceConfigured(v)) {
    console.log('  Declare these dynamic variables on the ElevenLabs agent - the browser sends');
    console.log('  them on every call and the webhook reads two of them back:');
    for (const name of DYNAMIC_VARIABLES) console.log(`    ${name}`);
    console.log('  Only the dashboard knows whether they are declared, so check that by eye.\n');
  }

  const gaps = sections.filter((s) => s.status === 'gap');
  if (gaps.length > 0) {
    console.log(
      `${gaps.length} thing${gaps.length === 1 ? '' : 's'} to fix: ${gaps
        .map((s) => s.title)
        .join('; ')}`,
    );
    process.exitCode = 1;
    return 1;
  }
  console.log(`Nothing here is half-done. ${modeAndRouteLine(v)}`);
  return 0;
}

/**
 * Ask Docker which Compose services are running in the shared Day0 project.
 *
 * Reading container labels avoids parsing every optional profile. Enabling the
 * Notion profile merely to run `compose ps` would require its transport token,
 * so a valid folder-only installation could otherwise make service discovery
 * fail before Docker was asked anything.
 *
 * Args:
 *   projectName: Explicit Compose project name.
 *
 * Returns:
 *   Running service names, or undefined when Docker cannot be queried.
 */
export type DockerServiceProbe = (
  command: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number },
) => { status: number | null; stdout?: string | null };

const systemDockerServiceProbe: DockerServiceProbe = (command, args, options) => {
  const result = spawnSync(command, args, options);
  return { status: result.status, stdout: result.stdout };
};

export function composeRunningServices(
  projectName: string,
  run: DockerServiceProbe = systemDockerServiceProbe,
): string[] | undefined {
  const probe = run(
    'docker',
    [
      'ps',
      '--filter',
      `label=com.docker.compose.project=${projectName}`,
      '--format',
      '{{.Label "com.docker.compose.service"}}',
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  if (probe.status !== 0) return undefined;
  return (probe.stdout ?? '')
    .split('\n')
    .map((service: string): string => service.trim())
    .filter(Boolean);
}

/**
 * Check the documentation mount from the backend runtime that reads it.
 *
 * Args:
 *   projectName: Explicit Compose project name.
 *   docsRoot: Container path configured for folder readers.
 *
 * Returns:
 *   True when the backend can read the directory.
 */
function backendCanReadDocs(projectName: string, docsRoot: string): boolean {
  const probe = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      projectName,
      '--env-file',
      ENV_FILE,
      'exec',
      '-T',
      'backend',
      'test',
      '-r',
      docsRoot,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  return probe.status === 0;
}

/**
 * Count active encrypted credentials through an administrator-only query.
 *
 * Args:
 *   values: Resolved deployment environment.
 *
 * Returns:
 *   Stored active credential count, or undefined when the backend cannot answer.
 */
function storedCredentialCount(values: Values): number | undefined {
  if (!values.CONVEX_SELF_HOSTED_URL || !values.CONVEX_SELF_HOSTED_ADMIN_KEY) return undefined;
  const probe = spawnSync(
    'npx',
    [
      'convex',
      'run',
      '--typecheck',
      'disable',
      '--codegen',
      'disable',
      'credentials:countStored',
      '{}',
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...values },
    },
  );
  if (probe.status !== 0) return undefined;
  const count = Number.parseInt((probe.stdout || '').trim(), 10);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/** What `migrations:status` says, as far as the checker reports it. */
export interface MigrationStatusRead {
  /** The release the rows are stamped at, or undefined before the first stamp. */
  readonly release?: string;
  /** Each migration that has changed rows, and how many: the legacy rows it converted. */
  readonly converted: ReadonlyArray<{ readonly name: string; readonly changed: number }>;
  /** The migrations that have not finished. */
  readonly pending: readonly string[];
}

/**
 * Read the JSON `npx convex run migrations:status` prints.
 *
 * @param stdout - The command's output.
 * @throws Error when the output is not the status the function returns.
 */
export function parseMigrationStatus(stdout: string): MigrationStatusRead {
  const parsed = JSON.parse(stdout) as {
    release?: { release?: unknown } | null;
    migrations?: unknown;
    pending?: unknown;
  } | null;
  if (!Array.isArray(parsed?.migrations) || !Array.isArray(parsed.pending)) {
    throw new Error('migrations:status printed no migrations and pending lists');
  }
  const release = parsed.release?.release;
  return {
    ...(typeof release === 'string' ? { release } : {}),
    converted: (parsed.migrations as Array<{ name?: unknown; changed?: unknown }>).flatMap((row) =>
      typeof row.name === 'string' && typeof row.changed === 'number' && row.changed > 0
        ? [{ name: row.name, changed: row.changed }]
        : [],
    ),
    pending: parsed.pending.filter((name): name is string => typeof name === 'string'),
  };
}

/**
 * Ask the backend, in one call, where its migrations are.
 *
 * @param values - Resolved deployment environment.
 * @returns The status, why it could not be read, or undefined with no admin key to ask with.
 */
function readMigrationStatus(values: Values): MigrationStatusRead | { error: string } | undefined {
  if (!values.CONVEX_SELF_HOSTED_URL || !values.CONVEX_SELF_HOSTED_ADMIN_KEY) return undefined;
  const probe = spawnSync(
    'npx',
    ['convex', 'run', '--typecheck', 'disable', '--codegen', 'disable', 'migrations:status', '{}'],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...values } },
  );
  const firstLine = (text: string | null | undefined): string =>
    (text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '';
  if (probe.status !== 0) {
    return { error: firstLine(probe.stderr) || firstLine(probe.stdout) || `exit ${probe.status}` };
  }
  try {
    return parseMigrationStatus(probe.stdout ?? '');
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Report the upgrade's migrations: the legacy rows each converted, and any
 * still pending, which the release stamp waits for.
 *
 * @param read - What `migrations:status` answered, or undefined when it was not asked.
 */
export function migrationsSection(
  read: MigrationStatusRead | { error: string } | undefined,
): Section | undefined {
  if (read === undefined) return undefined;
  if ('error' in read) {
    return {
      title: 'Migrations: could not be read',
      status: 'warn',
      lines: [
        `\`npx convex run migrations:status\` failed: ${read.error}`,
        'A deployment whose functions were never pushed has none to read yet.',
      ],
    };
  }
  const converted =
    read.converted.length === 0
      ? 'No migration needed to change a row.'
      : `Rows each migration changed: ${read.converted.map((row) => `${row.name} ${row.changed}`).join(', ')}.`;
  if (read.pending.length > 0) {
    return {
      title: `Migrations: ${read.pending.length} pending`,
      status: 'warn',
      lines: [
        `Still to run: ${read.pending.join(', ')}. The release is not stamped until they finish.`,
        converted,
        'Run `npx convex run migrations:runPending` until nothing is pending, then the setup',
        'again, which stamps the release.',
      ],
    };
  }
  return {
    title: 'Migrations: every one has run',
    status: 'ok',
    lines: [
      read.release === undefined
        ? 'The rows carry no release stamp yet; the setup writes one after the migrations.'
        : `The rows are at ${read.release}.`,
      converted,
    ],
  };
}

/** The host variables that publish a port, each loopback unless set, and what it publishes. */
const BIND_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  ['CONVEX_BIND_ADDR', "the backend's API"],
  ['CONVEX_DASHBOARD_BIND_ADDR', 'the Convex dashboard'],
  ['MODEL_BIND_ADDR', "the bundled model's API, which asks for no key"],
  ['FAKE_SLACK_BIND_ADDR', 'the Slack double'],
  ['DAY0_APP_HOST', 'the app'],
];

/**
 * Settings that start but deserve a second look: a profile that names none, a
 * port published on every interface, and a private-host list the backend
 * refuses. Warned, never refused (review D9): each can be meant.
 *
 * @param v - Resolved values.
 * @returns The section, or undefined when there is nothing to say.
 */
export function settingsSection(v: Values): Section | undefined {
  const lines: string[] = [];
  const profile = (v.DAY0_PROFILE ?? '').trim();
  if (profile !== '' && !DEPLOYMENT_PROFILES.some((known) => known === profile)) {
    lines.push(
      `DAY0_PROFILE=${profile} names no profile, so every module that reads it throws at import,`,
      `the app's and the backend's. Set it to ${DEPLOYMENT_PROFILES.join(' or ')}, or leave it empty.`,
    );
  }
  for (const [name, what] of BIND_VARIABLES) {
    const value = (v[name] ?? '').trim();
    if (value === '0.0.0.0' || value === '::' || value === '[::]') {
      lines.push(
        `${name}=${value} publishes ${what} on every interface, so anyone on this network`,
        'can reach it. Leave it empty or 127.0.0.1 unless another machine must.',
      );
    }
  }
  try {
    privateHostAllowlist(v[PRIVATE_HOSTS_VAR]);
  } catch (error) {
    lines.push(
      `${PRIVATE_HOSTS_VAR} is refused as it stands, and with it every credentialed MCP client`,
      `and every git source, GitHub and GitLab included: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return lines.length === 0
    ? undefined
    : { title: 'Settings worth a second look', status: 'warn', lines };
}

/**
 * Report the selected surface mode, documentation seam and encrypted store.
 *
 * Args:
 *   values: Resolved environment contract.
 *   services: Running service names, or undefined when Docker could not be asked.
 *
 * Returns:
 *   One setup section without exposing any provider value.
 */
function surfacesSection(values: Values, services: string[] | undefined): Section {
  const mode = values.DAY0_SURFACE_MODE || 'mock';
  if (mode !== 'mock' && mode !== 'real') {
    return {
      title: 'Surfaces: invalid mode - needs fixing',
      status: 'gap',
      lines: [`DAY0_SURFACE_MODE must be mock or real, not ${mode}.`],
    };
  }
  if (mode === 'mock') {
    const count = storedCredentialCount(values);
    return {
      title: 'Surfaces: mock',
      status: 'ok',
      lines: [
        'The seeded five-surface environment is active; no provider credentials are read.',
        'This is the setting the evaluation harness and the hosted demo run on. The two ways to',
        'run Day0 on your own documentation and systems are real mode: `./setup.sh --route',
        'featherless` (Local, cloud model) or `./setup.sh --route local` (Local, local model).',
        `Credential key ${values.DAY0_CREDENTIAL_KEY ? 'present' : 'absent'}; stored credentials ${count ?? 'unavailable'}.`,
      ],
    };
  }

  const projectName = values.COMPOSE_PROJECT_NAME || 'day0';
  const docsRoot = values.DAY0_DOCS_ROOT || '/docs';
  // `real` is day0 itself, so the question is whether the backend is up. Every
  // other service is an optional component and gets its own section.
  const backendRunning = services?.includes('backend') ?? false;
  const docsReadable = backendCanReadDocs(projectName, docsRoot);
  const count = storedCredentialCount(values);
  const keyPresent = Boolean(values.DAY0_CREDENTIAL_KEY);
  const lines = [
    `Compose project ${projectName}; the real profile (day0's backend) is ${backendRunning ? 'running' : 'not running'}.`,
    `Backend documentation root ${docsRoot} is ${docsReadable ? 'readable' : 'not readable'}.`,
    `Credential key ${keyPresent ? 'present' : 'absent'}; stored credentials ${count ?? 'unavailable'}.`,
    `Install redirect: ${values.DAY0_PUBLIC_URL ? `${values.DAY0_PUBLIC_URL}/api/oauth/slack` : 'DAY0_PUBLIC_URL is unset, so no dedicated app can be provisioned'}.`,
  ];
  if (!backendRunning || !docsReadable || !keyPresent || count === undefined) {
    return { title: 'Surfaces: real (local) - needs fixing', status: 'gap', lines };
  }
  return {
    title: 'Surfaces: real (local)',
    status: 'ok',
    lines,
  };
}

/**
 * Read the linked documentation sources by kind through an owner-free query.
 *
 * Args:
 *   values: Resolved deployment environment.
 *
 * Returns:
 *   Counts by source kind, or undefined when the backend cannot answer.
 */
function linkedDocSourceKinds(
  values: Values,
): Array<{ kind: string; serverKind?: string; component?: string; count: number }> | undefined {
  if (!values.CONVEX_SELF_HOSTED_URL || !values.CONVEX_SELF_HOSTED_ADMIN_KEY) return undefined;
  const probe = spawnSync(
    'npx',
    [
      'convex',
      'run',
      '--typecheck',
      'disable',
      '--codegen',
      'disable',
      'docSources:linkedKinds',
      '{}',
    ],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...values } },
  );
  if (probe.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse((probe.stdout || '').trim());
    return Array.isArray(parsed)
      ? (parsed as Array<{
          kind: string;
          serverKind?: string;
          component?: string;
          count: number;
        }>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Describe one documentation source kind in terms of what it needs running.
 *
 * Args:
 *   row: One kind, its MCP server kind, and how many are linked.
 *
 * Returns:
 *   A line naming the component the kind depends on, or that it needs none.
 */
export function docSourceDependency(row: {
  kind: string;
  serverKind?: string;
  component?: string;
  count: number;
}): string {
  const label = row.serverKind ? `${row.kind}/${row.serverKind}` : row.kind;
  const plural = row.count === 1 ? 'source' : 'sources';
  if (row.kind !== 'mcp') {
    return `${row.count} ${label} ${plural} - read by the backend itself; no component needed.`;
  }
  if (row.component === 'docs-notion-mcp') {
    return `${row.count} ${label} ${plural} - needs day0's Notion component (--profile docs-notion).`;
  }
  return `${row.count} ${label} ${plural} - points at an MCP server you already run; no day0 component needed.`;
}

/** Interpret the browser switch with the same parser used at provider boundaries. */
export function browserSetupConfiguration(configured: string | undefined): {
  present: boolean;
  invalidReason?: string;
} {
  try {
    return { present: browserComponent(configured).present };
  } catch (error) {
    return {
      present: false,
      invalidReason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Report which optional components are running and which are merely configured.
 *
 * One thing here fails the command: the redactor in real mode, missing or not
 * running, because every documentation sync then refuses to persist and the
 * installation reads nothing while it looks finished. The rest cannot fail it.
 * An enterprise whose systems all have APIs never starts the browser
 * component, and an enterprise that keeps its documentation in a folder never
 * starts the Notion one; both are complete installations. What is worth
 * saying out loud is a half-state - a component running that day0 was never
 * told about, or one day0 was told about that is not there - because that is
 * the shape that looks finished and is not.
 *
 * Args:
 *   values: Resolved deployment environment.
 *   projectName: Explicit Compose project name.
 *   services: Running service names, or undefined when Docker could not be asked.
 *
 * Returns:
 *   One informational section.
 */
export function componentsSection(
  values: Values,
  projectName: string,
  services: string[] | undefined,
): Section {
  const lines: string[] = [];
  let status: Status = 'ok';
  if (services === undefined) {
    return {
      title: 'Components: Docker could not be asked',
      status: 'warn',
      lines: [
        `\`docker ps\` could not inspect Compose project ${projectName}, so which optional`,
        'components are running is unknown. Everything else above still applies.',
      ],
    };
  }
  for (const component of COMPONENTS) {
    const running = services.includes(component.service);
    lines.push(
      `${component.service} (--profile ${component.profile}): ${running ? 'running' : 'not running'} - ${component.purpose}.`,
    );
  }
  const browserRunning = services.includes('playwright-mcp');
  const browserConfiguration = browserSetupConfiguration(values.DAY0_BROWSER_MCP_URL);
  const browserConfigured = browserConfiguration.present;
  if (browserConfiguration.invalidReason) {
    status = 'warn';
    lines.push(
      `DAY0_BROWSER_MCP_URL is unusable: ${browserConfiguration.invalidReason}`,
      'Every browser-driven surface will refuse. Correct the address and re-run `pnpm sync:env`,',
      'or clear the variable to run without the component.',
    );
  } else if (browserConfigured && !browserRunning) {
    status = 'warn';
    lines.push(
      `DAY0_BROWSER_MCP_URL names ${values.DAY0_BROWSER_MCP_URL} and nothing is running there.`,
      'Every browser-driven surface will refuse with BROWSER_DRIVER_ABSENT. Start it with',
      '`pnpm convex:up --profile browser`, or clear the variable to run without the component.',
    );
  } else if (!browserConfigured && browserRunning) {
    status = 'warn';
    lines.push(
      'playwright-mcp is running and DAY0_BROWSER_MCP_URL is unset, so day0 will not use it.',
      `Set DAY0_BROWSER_MCP_URL=http://playwright-mcp:8931/mcp in ${ENV_FILE} and re-run`,
      '`pnpm sync:env`, or stop the component.',
    );
  } else if (!browserConfigured) {
    lines.push(
      'No browser component. A system whose documentation records a web UI and no API is',
      'still proposed and still shows its evidence; its card says the component is not',
      'running and holds approval. That is a complete installation if none of your systems',
      'need a browser.',
    );
  }
  const redactorRunning = services.includes('redactor');
  const redactorConfigured = Boolean(values.DAY0_REDACTOR_URL);
  const realMode = values.DAY0_SURFACE_MODE === 'real';
  if (redactorConfigured && !redactorRunning) {
    status = realMode ? 'gap' : 'warn';
    lines.push(
      `DAY0_REDACTOR_URL names ${values.DAY0_REDACTOR_URL} and nothing is running there.`,
      'Every documentation sync will refuse to persist and every provider outcome will be',
      'recorded as structural-only. Start it with `pnpm redactor:up`, or clear the variable.',
    );
  } else if (!redactorConfigured && redactorRunning) {
    status = 'warn';
    lines.push(
      'redactor is running and DAY0_REDACTOR_URL is unset, so day0 will not use it.',
      `Set DAY0_REDACTOR_URL=http://redactor:8000 in ${ENV_FILE} and re-run \`pnpm sync:env\`,`,
      'or stop the component.',
    );
  } else if (!redactorConfigured && realMode) {
    status = 'gap';
    lines.push(
      'No redaction component. Documentation sync refuses to persist a page without one, and',
      'provider outcomes record that only the exact-value and structural layers ran.',
      'Start it with `pnpm redactor:up` and set DAY0_REDACTOR_URL=http://redactor:8000.',
    );
  }
  const kinds = linkedDocSourceKinds(values);
  if (kinds === undefined) {
    lines.push('Linked documentation sources: unavailable (the backend could not be asked).');
  } else if (kinds.length === 0) {
    lines.push('Linked documentation sources: none yet. Link one on /documentation.');
  } else {
    lines.push('Linked documentation sources:');
    for (const row of kinds) lines.push(`  ${docSourceDependency(row)}`);
    const needsNotion = kinds.some((row): boolean => row.component === 'docs-notion-mcp');
    if (needsNotion && !services.includes('docs-notion-mcp')) {
      if (status !== 'gap') status = 'warn';
      lines.push(
        'A Notion source is linked and docs-notion-mcp is not running, so its next sync will',
        'fail. Start it with `pnpm convex:up --profile docs-notion`.',
      );
    }
  }
  return { title: titleFor(status, 'Components'), status, lines };
}

/** Which backend the app and the Convex CLI will talk to, and whether they agree. */
function backendSection(v: Values): Section {
  if (!v.CONVEX_SELF_HOSTED_URL && !v.CONVEX_DEPLOYMENT) {
    return {
      title: 'No Convex backend is configured',
      status: 'gap',
      lines: [
        'Neither CONVEX_SELF_HOSTED_URL nor CONVEX_DEPLOYMENT is set, so there is',
        'nowhere to push functions or store data. Run `pnpm convex:dev` for a cloud',
        'deployment, or `pnpm convex:up` for the self-hosted backend in Docker.',
      ],
    };
  }

  if (v.CONVEX_SELF_HOSTED_URL) {
    const lines = [`Self-hosted at ${v.CONVEX_SELF_HOSTED_URL}, so no Convex account is involved.`];
    let status: Status = 'ok';
    if (!v.CONVEX_SELF_HOSTED_ADMIN_KEY) {
      status = 'gap';
      lines.push(
        'CONVEX_SELF_HOSTED_ADMIN_KEY is unset, so no function push will authenticate.',
        'Run `pnpm convex:admin-key` and paste the key it prints.',
      );
    }
    if (!v.NEXT_PUBLIC_CONVEX_URL) {
      status = 'gap';
      lines.push('NEXT_PUBLIC_CONVEX_URL is unset, so the browser has no backend to open.');
    } else if (v.NEXT_PUBLIC_CONVEX_URL !== v.CONVEX_SELF_HOSTED_URL) {
      lines.push(
        `The browser is pointed at ${v.NEXT_PUBLIC_CONVEX_URL} and the CLI at`,
        `${v.CONVEX_SELF_HOSTED_URL}. That is right only if the two genuinely reach`,
        'the same backend by different names.',
      );
    }
    if (v.CONVEX_DEPLOYMENT) {
      lines.push(
        'CONVEX_DEPLOYMENT is also set. The two are mutually exclusive; clear it',
        'unless you meant to use Convex cloud.',
      );
      status = status === 'gap' ? 'gap' : 'warn';
    }
    return { title: titleFor(status, 'Backend: self-hosted'), status, lines };
  }

  // `pnpm convex:dev` will make an anonymous deployment - a local backend the
  // CLI runs for you, with no Convex account behind it - so a CONVEX_DEPLOYMENT
  // is not by itself evidence of a cloud one.
  const anonymous = v.CONVEX_DEPLOYMENT.startsWith('anonymous:');
  return {
    title: anonymous ? 'Backend: anonymous local deployment' : 'Backend: Convex cloud',
    status: v.NEXT_PUBLIC_CONVEX_URL ? 'ok' : 'gap',
    lines: v.NEXT_PUBLIC_CONVEX_URL
      ? [
          `Deployment ${v.CONVEX_DEPLOYMENT}, reached at ${v.NEXT_PUBLIC_CONVEX_URL}.`,
          ...(anonymous
            ? [
                'Run by the Convex CLI on this machine with no account behind it, and',
                'not persistent the way the self-hosted backend is. `npx convex login`',
                'links it to an account if you later want one.',
              ]
            : []),
        ]
      : ['CONVEX_DEPLOYMENT is set but NEXT_PUBLIC_CONVEX_URL is not. Re-run `pnpm convex:dev`.'],
  };
}

/**
 * The customer issuer's section, or undefined when neither an issuer nor the
 * customer-local profile is configured.
 *
 * Validated by the same reader the backend's auth config uses, so a value this
 * reports as fine is one the push accepts. The issuer is printed only once it
 * has been accepted, since a refused one may carry a password.
 */
function customerIssuerSection(v: Values): Section | undefined {
  const customerLocal = (v.DAY0_PROFILE ?? '').trim() === 'customer-local';
  if (!customerLocal && !(v.DAY0_OIDC_ISSUER ?? '').trim()) return undefined;
  let issuer: CustomerOidcIssuer | undefined;
  try {
    issuer = customerOidcIssuer((name: string): string | undefined => v[name]);
  } catch (error) {
    return {
      title: 'Auth: the customer issuer is misconfigured',
      status: 'gap',
      lines: [
        error instanceof Error ? error.message : String(error),
        'The backend refuses to push its functions until this is fixed.',
      ],
    };
  }
  if (!issuer) {
    return {
      title: 'Auth: customer-local profile with no issuer',
      status: 'gap',
      lines: [
        "DAY0_PROFILE=customer-local signs people in through the customer's OIDC issuer,",
        'and DAY0_OIDC_ISSUER is unset, so real mode refuses to start. Set it to the',
        "issuer's URL as its tokens carry it in `iss`, and DAY0_OIDC_AUDIENCE to the",
        'client id they carry in `aud`.',
      ],
    };
  }
  const noAuth = v.NEXT_PUBLIC_DEV_NO_AUTH === 'true';
  // A warning until the app's own sign-in uses the issuer (review M12): the
  // backend accepts its tokens, and no browser can get one yet.
  return {
    title: noAuth ? 'Auth: customer OIDC issuer and the local key' : 'Auth: customer OIDC issuer',
    status: 'warn',
    lines: [
      `Issuer ${issuer.issuer}, audience ${issuer.audience}.`,
      noAuth
        ? "The backend accepts this issuer's tokens and this machine's local key side by side."
        : "The backend accepts this issuer's tokens; Clerk keys, if any, are ignored beside it.",
      'Both values must be on the deployment as well, where the auth config reads them at',
      'push: `pnpm sync:env` puts them there, the audience before the issuer.',
      noAuth
        ? 'The local key runs only under `next dev`; `next start` refuses to start with it on.'
        : customerLocal
          ? 'DAY0_PROFILE=customer-local: real mode is for the people it signs in, under `next start`.'
          : 'DAY0_PROFILE is not customer-local, so real mode still needs the local key under `next dev`.',
      "The app's own sign-in does not use this issuer yet, so until it does nobody signs in",
      noAuth
        ? 'through the browser with it; the local key is the way in meanwhile.'
        : 'through the browser, and with the local key off there is no other way in.',
    ],
  };
}

/**
 * Report who can sign in: the customer's OIDC issuer (beside the local key or
 * alone), the local key, or Clerk. A half of any of them is worse than none.
 *
 * @param v - The env file with the process environment layered on.
 */
export function authSection(v: Values): Section {
  const noAuth = v.NEXT_PUBLIC_DEV_NO_AUTH === 'true';
  const clerkKeys = ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'].filter((k) => !v[k]);
  const hasClerk = clerkKeys.length === 0;
  const missing = ['DEV_NO_AUTH_SECRET', 'DEV_NO_AUTH_SIGNING_KEY', 'DEV_NO_AUTH_JWKS'].filter(
    (k) => !v[k],
  );
  // A keyless local issuer is a gap whatever else is configured beside it.
  if (!noAuth || missing.length === 0) {
    const customer = customerIssuerSection(v);
    if (customer) return customer;
  }

  if (noAuth) {
    if (missing.length > 0) {
      return {
        title: 'Auth: no-auth mode is on but has no key',
        status: 'gap',
        lines: [
          `NEXT_PUBLIC_DEV_NO_AUTH=true with ${missing.join(', ')} unset.`,
          'The mode serves every request as one fixed user, and this key is the only',
          'thing standing between that user and anyone who can reach the port.',
          'Run `pnpm dev:no-auth-key`, then re-run ./scripts/sync-convex-env.sh.',
        ],
      };
    }
    return {
      title: 'Auth: no-auth dev mode',
      status: 'ok',
      lines: [
        'One fixed local user owns every row, and only a caller holding this',
        "machine's key may be it. `pnpm dev` prints the URL that unlocks a browser.",
        hasClerk
          ? 'Clerk keys are present too and will be ignored while this flag is true.'
          : 'No Clerk account is involved.',
        '`pnpm build` refuses while this flag is in the environment - unset it to build.',
      ],
    };
  }

  if (hasClerk) {
    return {
      title: 'Auth: Clerk',
      status: v.CLERK_JWT_ISSUER_DOMAIN ? 'ok' : 'gap',
      lines: v.CLERK_JWT_ISSUER_DOMAIN
        ? [
            'Publishable key, secret key and JWT issuer are all set. The issuer must also',
            'be on the deployment - ./scripts/sync-convex-env.sh pushes it.',
          ]
        : [
            'Clerk keys are set but CLERK_JWT_ISSUER_DOMAIN is not, so Convex cannot verify',
            'a Clerk token and every signed-in call is refused. Create a JWT template named',
            '"convex" in the Clerk dashboard and copy its Issuer URL here.',
          ],
    };
  }

  return {
    title: 'Auth: nothing configured',
    status: 'gap',
    lines: [
      `Missing ${clerkKeys.join(' and ')}, NEXT_PUBLIC_DEV_NO_AUTH is not true, and`,
      'DAY0_OIDC_ISSUER is unset. Pick one: no-auth dev mode for the account-free path,',
      "the customer's issuer (DAY0_OIDC_ISSUER and DAY0_OIDC_AUDIENCE) for a",
      'customer-local install, or Clerk keys for the hosted demo. Without one, nobody',
      'can sign in and the backend refuses to push its functions.',
    ],
  };
}

/**
 * Report the model layer: which address each side calls, and whether the
 * backend container can reach its own.
 *
 * The model layer takes any OpenAI-compatible endpoint, so "no key" is a
 * complete setup rather than a missing one - but only if a base URL says so.
 * The self-hosted trap gets its own check: charter synthesis runs as a Convex
 * Node action, inside the backend container, where a loopback address is the
 * container itself and never the model server on your desk, and where an
 * address on another Docker bridge answers the host and not the container.
 * The second is only visible by dialling from inside the container, so the
 * caller does that and hands the answer in.
 *
 * Args:
 *   v: Resolved values.
 *   selfHosted: Whether the backend is the self-hosted container.
 *   dial: What dialling the backend's address from inside it found; undefined
 *     when the backend was not running, or Docker could not be asked.
 *
 * Returns:
 *   The section.
 */
export function modelSection(v: Values, selfHosted: boolean, dial?: ModelDial): Section {
  const backendUrl = v.CONVEX_OPENAI_BASE_URL || v.OPENAI_BASE_URL;
  const lines: string[] = [];
  let status: Status = 'ok';

  if (!v.OPENAI_API_KEY && !v.OPENAI_BASE_URL) {
    return {
      title: 'Model: nothing configured',
      status: 'gap',
      lines: [
        'Neither OPENAI_API_KEY nor OPENAI_BASE_URL is set. The charter, the plans,',
        'the executor and the skill author are all model calls, so none of them run.',
        'Set a key, or point OPENAI_BASE_URL at any OpenAI-compatible endpoint -',
        'a local runtime needs no account and no key. `pnpm probe:model` checks one.',
      ],
    };
  }

  if (v.OPENAI_BASE_URL) {
    lines.push(
      `Next calls ${v.OPENAI_BASE_URL}${v.OPENAI_API_KEY ? ' with a key' : ' with no key'}, model ${v.OPENAI_MODEL || 'gpt-5.6-terra (default)'}.`,
    );
  } else {
    lines.push(
      `Next calls api.openai.com with OPENAI_API_KEY, model ${v.OPENAI_MODEL || 'gpt-5.6-terra (default)'}.`,
    );
  }

  if (selfHosted && backendUrl && isLoopback(backendUrl)) {
    status = 'gap';
    lines.push(
      `The backend would call ${backendUrl}, which inside its container means the`,
      'container itself. Charter synthesis is a Convex Node action and runs there,',
      'so it will fail while the browser-side chat works - the confusing half.',
      'Set CONVEX_OPENAI_BASE_URL to an address that resolves inside the container:',
      'http://model:11434/v1 for the bundled model service (`pnpm model:up`), or',
      `${onDockerHost(backendUrl)} for a server on this host.`,
    );
  } else if (selfHosted && backendUrl) {
    if (v.CONVEX_OPENAI_BASE_URL) {
      lines.push(`The backend container calls ${v.CONVEX_OPENAI_BASE_URL} for the same endpoint.`);
    }
    if (dial === undefined) {
      status = 'warn';
      lines.push(
        `${backendUrl} was not dialled from inside the backend container: it is not running, or Docker could not be asked.`,
        'Run this again once it is up: an address this machine reaches may still be one the container cannot.',
      );
    } else if (dial.reach === 'reached') {
      lines.push(`The backend container reached ${backendUrl} (${dial.detail}).`);
    } else if (dial.reach === 'unreachable') {
      status = 'gap';
      lines.push(
        `The backend container could not reach ${backendUrl}: ${dial.detail}.`,
        'The 1:1 runs from this machine and the charter, synthesised inside the container, never arrives.',
        ...unreachableFix(backendUrl, v.COMPOSE_PROJECT_NAME || 'day0'),
        'Then re-run `pnpm sync:env` and `pnpm convex:restart`.',
      );
    } else {
      status = 'warn';
      lines.push(
        `${backendUrl} could not be dialled from inside the backend container: ${dial.detail}.`,
      );
    }
  } else if (selfHosted && !backendUrl) {
    lines.push(
      'The backend container calls api.openai.com as well - one address that means',
      'the same thing on both sides, so there is no second one to get wrong.',
    );
  }

  return { title: titleFor(status, 'Model'), status, lines };
}

/** The same port and path on the host, as a container reaches it. */
function onDockerHost(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port === '' ? '' : `:${parsed.port}`;
    return `${parsed.protocol}//host.docker.internal${port}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return 'http://host.docker.internal:<port>/v1';
  }
}

/**
 * Dial the backend's model address from inside the running backend container.
 *
 * Args:
 *   projectName: Explicit Compose project name.
 *   baseUrl: The address the backend calls.
 *
 * Returns:
 *   What the dial found.
 */
function dialFromBackend(projectName: string, baseUrl: string): ModelDial {
  const probe = spawnSync(
    'docker',
    ['compose', '-p', projectName, '--env-file', ENV_FILE, ...containerDialArguments(baseUrl)],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return readContainerDial({
    status: probe.status,
    stdout: probe.stdout ?? '',
    stderr: probe.stderr ?? '',
  });
}

/** What Docker says about the bundled sandbox service, or that it could not be asked. */
type SandboxState = 'healthy' | 'unhealthy' | 'stopped' | 'unknown';

/**
 * Ask compose whether the sandbox container is up and answering.
 *
 * `pnpm sandbox:up` gives the service a healthcheck that dials its own socket,
 * so "healthy" here means a smoke test would actually run rather than merely
 * that a container exists. Anything Docker cannot answer - not installed,
 * daemon down, a different compose project - is reported as not knowing rather
 * than as an absence.
 */
function sandboxState(projectName: string): SandboxState {
  const probe = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      projectName,
      '--env-file',
      ENV_FILE,
      '--profile',
      SANDBOX_SERVICE,
      'ps',
      '--format',
      'json',
      SANDBOX_SERVICE,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  if (probe.status !== 0) return 'unknown';
  const line = (probe.stdout ?? '')
    .split('\n')
    .find((candidate) => candidate.trim().startsWith('{'));
  if (!line) return 'stopped';
  try {
    const row = JSON.parse(line) as { State?: string; Health?: string };
    if (row.State !== 'running') return 'stopped';
    // A service with a healthcheck reports `starting` for its first few
    // seconds, which is not yet a working sandbox and not a broken one either.
    return row.Health === 'healthy' ? 'healthy' : 'unhealthy';
  } catch {
    return 'unknown';
  }
}

/**
 * Which sandbox will verify an authored skill, or that none will.
 *
 * The distinction this section exists to make visible: a skill no sandbox ran
 * is not a verified skill, so it stops at `authoring` and stays uncallable.
 * That is a complete setup if you meant to skip verification, and a surprise
 * if you did not - and until this section existed the only way to find out was
 * to watch a skill fail.
 */
function sandboxSection(v: Values, projectName: string): Section {
  const daytona = !!v.DAYTONA_API_KEY;
  const local = daytona ? 'stopped' : sandboxState(projectName);
  const socketNote = v.SKILL_SANDBOX_SOCKET
    ? [`The deployment looks for the socket at ${v.SKILL_SANDBOX_SOCKET}.`]
    : [];

  if (daytona) {
    return {
      title: 'Sandbox: Daytona',
      status: 'ok',
      lines: [
        'DAYTONA_API_KEY is set, so authored skills are verified in a hosted',
        'sandbox. Daytona is preferred whenever its key is present; clear the key',
        'to use the bundled local sandbox (`pnpm sandbox:up`) instead.',
      ],
    };
  }

  if (local === 'healthy') {
    return {
      title: 'Sandbox: local',
      status: 'ok',
      lines: [
        'The bundled sandbox service is running and answering, so authored skills',
        'are verified here and no account is involved. It is an isolation boundary',
        'for verification - a container with no network, a read-only root and an',
        'unprivileged user - not a defence against hostile code.',
        ...socketNote,
      ],
    };
  }

  if (local === 'unhealthy') {
    return {
      title: 'Sandbox: local sandbox is running but not answering - needs fixing',
      status: 'gap',
      lines: [
        'The container is up and its healthcheck is not passing, so every skill',
        'would stop at `authoring` while the service looks started. Check',
        '`docker compose logs sandbox`, or restart it with `pnpm sandbox:up`.',
        ...socketNote,
      ],
    };
  }

  return {
    title: 'Sandbox: nothing verifies skills',
    status: 'warn',
    lines: [
      local === 'unknown'
        ? 'No DAYTONA_API_KEY, and Docker could not be asked about the bundled sandbox.'
        : 'No DAYTONA_API_KEY and the bundled sandbox service is not running.',
      'The agent still proposes and authors a skill; nothing runs its smoke test,',
      'so the skill stops at `authoring`, stays visibly uncallable, and the work',
      'item that asked for it stays at `needs-skill`. Everything else runs.',
      'Fix either way: `pnpm sandbox:up` for the account-free sandbox, or a',
      'DAYTONA_API_KEY for the hosted one.',
      ...socketNote,
    ],
  };
}

function voiceConfigured(v: Values): boolean {
  return !!v.ELEVENLABS_API_KEY && !!v.ELEVENLABS_AGENT_ID;
}

function voiceSection(v: Values): Section {
  const gaps = ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID'].filter((key) => !v[key]);
  if (gaps.length === 0) {
    return {
      title: 'Voice connects',
      status: 'ok',
      lines: ['ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are set.'],
    };
  }
  return {
    title: 'Voice does not connect',
    status: 'warn',
    lines: [
      `Missing ${gaps.join(' and ')}.`,
      'The mode picker greys voice out and chat runs the identical Day-1 1:1,',
      'so this is a complete setup if you meant to skip voice.',
    ],
  };
}

function finalisationSection(v: Values): Section {
  const hasSecret = !!v.ELEVENLABS_WEBHOOK_SECRET;
  if (hasSecret) {
    return {
      title: 'Post-call finalisation is configured',
      status: 'ok',
      lines: [
        'ELEVENLABS_WEBHOOK_SECRET is set, so a signed delivery is accepted and a',
        `call whose tab died still lands a charter. The agent's post-call webhook`,
        `must point at this deployment's ${WEBHOOK_PATH}.`,
      ],
    };
  }
  if (!voiceConfigured(v)) {
    return {
      title: 'Post-call finalisation is not configured',
      status: 'warn',
      lines: ['ELEVENLABS_WEBHOOK_SECRET is unset. Nothing to fix while voice is off.'],
    };
  }
  // The one voice state worth failing on is the one that looks finished: voice
  // connects, the demo works, and every post-call delivery is refused.
  return {
    title: 'Post-call finalisation is NOT configured',
    status: 'gap',
    lines: [
      'ELEVENLABS_WEBHOOK_SECRET is unset, so the route cannot tell a real',
      'ElevenLabs delivery from a forged one and answers 503 to all of them.',
      'Voice still works and the browser still posts the transcript when the',
      'call ends normally; a call whose tab dies mid-way is lost silently.',
      'Fix: ElevenLabs dashboard -> Developers -> Webhooks -> Create webhook',
      `pointed at https://<your-host>${WEBHOOK_PATH}, copy the shared`,
      `secret it shows once into ${ENV_FILE}, restart \`pnpm dev\`.`,
    ],
  };
}

function titleFor(status: Status, base: string): string {
  return status === 'gap' ? `${base} - needs fixing` : base;
}

function marker(status: Status): string {
  return status === 'ok' ? 'ok  ' : status === 'warn' ? 'note' : 'GAP ';
}

/** The files whose digests say which redactor wheels and model a machine runs. */
const REPORTED_FILES = [
  'redactor/requirements.txt',
  'redactor/requirements-cuda.txt',
  'redactor/models.sha256',
  'docker-compose.yml',
] as const;

/** One outbound host this installation may dial, and when. */
export interface EgressHost {
  host: string;
  purpose: string;
}

/** A compose service and the image it runs, as the compose file pins it. */
export interface ComposeImage {
  service: string;
  image: string;
}

/** The support bundle A12 describes: versions, digests, egress and health, no content. */
export interface SetupReport {
  kind: 'day0-setup-report';
  version: 1;
  generatedAt: string;
  commit?: string;
  mode: string;
  route: string;
  versions: Record<string, string | undefined>;
  images: Array<ComposeImage & { running: boolean }>;
  digests: Record<string, string>;
  egress: EgressHost[];
  sections: Array<{ title: string; status: Status }>;
}

/** The host of an address that leaves this machine, or undefined for one that stays. */
function outboundHost(url: string | undefined): string | undefined {
  if (!url?.trim() || isLoopback(url)) return undefined;
  try {
    const host = new URL(url).hostname;
    // A bare name is a compose service, and host.docker.internal is this host.
    if (!host.includes('.') || host === 'host.docker.internal') return undefined;
    return host;
  } catch {
    return undefined;
  }
}

/**
 * Every outbound host this configuration names, and when each is dialled.
 *
 * The model addresses are read from the file; the rest are the fixed hosts the
 * code dials in real mode, the ones a component fetches on its first start,
 * and the registries the images and models are pulled from. The systems an
 * approved card reaches are the ones the documentation names, so they are
 * said once, not listed.
 *
 * Args:
 *   values: Resolved values.
 *
 * Returns:
 *   One row per host, first seen first.
 */
export function egressHosts(values: Readonly<Record<string, string>>): EgressHost[] {
  const rows: EgressHost[] = [];
  const add = (host: string | undefined, purpose: string): void => {
    if (host && !rows.some((row) => row.host === host)) rows.push({ host, purpose });
  };
  const appModel = values.OPENAI_BASE_URL?.trim()
    ? values.OPENAI_BASE_URL
    : values.OPENAI_API_KEY
      ? 'https://api.openai.com/v1'
      : undefined;
  add(outboundHost(appModel), 'the model the app calls for the 1:1');
  add(
    outboundHost(values.CONVEX_OPENAI_BASE_URL?.trim() ? values.CONVEX_OPENAI_BASE_URL : appModel),
    'the model the backend calls for the charter, plans and skills',
  );
  if (values.DAY0_SURFACE_MODE === 'real') {
    add('registry.modelcontextprotocol.io', "orientation, looking up a system's MCP server");
    add('mcp.linear.app', 'Linear intake and writes, once a Linear card is approved');
    add('slack.com', 'Slack intake and posts, once a Slack card is approved');
    add('github.com', 'a git documentation source on GitHub, when one is linked');
    add('gitlab.com', 'a git documentation source on GitLab, when one is linked');
    add('api.notion.com', 'the Notion documentation component, when a Notion source is linked');
    add('huggingface.co', "the redactor's model snapshot, on its first start");
    add('pypi.org', "the redactor's wheels, on its first start");
    add('files.pythonhosted.org', "the redactor's wheels, on its first start");
    add('download.pytorch.org', "the redactor's CPU build of torch, on its first start");
    add('registry.npmjs.org', "the Notion component's pinned package, on its first start");
  }
  if (
    outboundHost(values.OPENAI_BASE_URL) === undefined &&
    values.CONVEX_OPENAI_BASE_URL?.includes('//model:')
  ) {
    add('registry.ollama.ai', 'model pulls for the bundled model service');
  }
  if (values.DAYTONA_API_KEY) {
    add(
      outboundHost(values.DAYTONA_API_URL || 'https://app.daytona.io/api'),
      'Daytona, verifying authored skills',
    );
  }
  if (values.ELEVENLABS_API_KEY) add('api.elevenlabs.io', 'the voice 1:1');
  add(outboundHost(values.CLERK_JWT_ISSUER_DOMAIN), 'Clerk, signing users in');
  add('registry-1.docker.io', 'image pulls at setup (ollama, python, node)');
  add('ghcr.io', 'image pulls at setup (the Convex backend and dashboard)');
  add('mcr.microsoft.com', 'image pulls at setup (the browser component)');
  return rows;
}

/**
 * The image each compose service runs, as the compose file pins it.
 *
 * Args:
 *   compose: The compose file's text.
 *
 * Returns:
 *   One row per service that names an image.
 */
export function composeImages(compose: string): ComposeImage[] {
  const parsed: unknown = parseYaml(compose);
  const services =
    parsed && typeof parsed === 'object' ? (parsed as { services?: unknown }).services : undefined;
  if (!services || typeof services !== 'object') return [];
  return Object.entries(services as Record<string, unknown>).flatMap(
    ([service, definition]): ComposeImage[] => {
      const image =
        definition && typeof definition === 'object'
          ? (definition as { image?: unknown }).image
          : undefined;
      return typeof image === 'string' ? [{ service, image }] : [];
    },
  );
}

/**
 * Assemble the support report from what the checks found. Each section keeps
 * its title and status and drops its lines, which quote addresses and names
 * from the env file; the only thing the file contributes is the hostnames in
 * the egress list, never a key, a path or a whole address.
 *
 * Args:
 *   inputs: The resolved values, the sections, and what the machine reported.
 *
 * Returns:
 *   The report, ready to serialise.
 */
export function setupReport(inputs: {
  values: Readonly<Record<string, string>>;
  sections: readonly Section[];
  versions: Record<string, string | undefined>;
  images: ReadonlyArray<ComposeImage & { running: boolean }>;
  digests: Record<string, string>;
  commit?: string;
  generatedAt: string;
}): SetupReport {
  return {
    kind: 'day0-setup-report',
    version: 1,
    generatedAt: inputs.generatedAt,
    ...(inputs.commit === undefined ? {} : { commit: inputs.commit }),
    mode: inputs.values.DAY0_SURFACE_MODE || 'mock',
    route: setupRoute(inputs.values).route,
    versions: inputs.versions,
    images: [...inputs.images],
    digests: inputs.digests,
    egress: egressHosts(inputs.values),
    sections: inputs.sections.map(({ title, status }) => ({ title, status })),
  };
}

/** The first line a command printed, or undefined when it failed. */
function firstOutputLine(command: string, args: readonly string[]): string | undefined {
  const probe = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 });
  if (probe.status !== 0) return undefined;
  return (probe.stdout ?? '').split('\n')[0]?.trim() || undefined;
}

/** The versions support asks for first. */
function toolVersions(): Record<string, string | undefined> {
  return {
    node: process.version,
    pnpm: firstOutputLine('pnpm', ['--version']),
    docker: firstOutputLine('docker', ['info', '--format', '{{.ServerVersion}} {{.Architecture}}']),
    compose: firstOutputLine('docker', ['compose', 'version', '--short']),
  };
}

/** The sha256 of each file that exists, keyed by its path. */
function fileDigests(paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    paths
      .filter((path: string): boolean => existsSync(path))
      .map((path: string): [string, string] => [
        path,
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ]),
  );
}

/** The checkout's commit, marked when the tree has changes, or undefined outside git. */
function checkoutCommit(): string | undefined {
  const commit = firstOutputLine('git', ['rev-parse', '--short=12', 'HEAD']);
  if (commit === undefined) return undefined;
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return status.status === 0 && (status.stdout ?? '').trim() !== '' ? `${commit}-dirty` : commit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(ENV_FILE, { report: process.argv.includes('--report') });
}
