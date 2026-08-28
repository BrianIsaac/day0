/// <reference types="node" />
/**
 * Reports whether this machine is set up to run Day0 locally, one decision at
 * a time.
 *
 *   pnpm check:setup
 *
 * It answers the question a reader actually has after following the README -
 * "did I set this up correctly?" - and the honest answer is not one boolean.
 * Day0 has five independent setups (backend, auth, model, sandbox, voice), each
 * of which can be complete, deliberately skipped, or half-done, and the failure
 * that costs an afternoon is always the half-done one that looks finished. So
 * each is reported separately and only the states that are *wrong* fail the
 * command.
 *
 * Two things this does not do. It never calls a provider: no key here is spent
 * establishing that it exists. And it cannot see the ElevenLabs dashboard, so
 * the dynamic variables an agent must declare are printed to check by eye
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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserComponent } from '../src/surfaces/browser';

const ENV_FILE = process.argv[2] ?? '.env.local';

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
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CONVEX_OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'DAYTONA_API_KEY',
  'SKILL_SANDBOX_SOCKET',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID',
  'ELEVENLABS_WEBHOOK_SECRET',
  'DAY0_SURFACE_MODE',
  'DAY0_DOCS_ROOT',
  'DAY0_CREDENTIAL_KEY',
  'DAY0_BROWSER_MCP_URL',
  'DAY0_PUBLIC_URL',
  'COMPOSE_PROJECT_NAME',
] as const;

type Status = 'ok' | 'warn' | 'gap';

interface Section {
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

/** Loopback from the host is nothing at all from inside a container. */
function isLoopback(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
}

function main(): void {
  if (!existsSync(ENV_FILE)) {
    console.error(`error: ${ENV_FILE} not found. Copy .env.example to ${ENV_FILE} first.`);
    process.exit(1);
  }

  const v = resolve(ENV_FILE);
  const selfHosted = !!v.CONVEX_SELF_HOSTED_URL;
  const projectName = v.COMPOSE_PROJECT_NAME || 'day0';
  // Asked once and shared: every section that cares about a container reads the
  // same answer, and asking Docker is the slowest thing here.
  const services = composeRunningServices(projectName);

  const sections: Section[] = [
    backendSection(v),
    authSection(v),
    surfacesSection(v, services),
    componentsSection(v, projectName, services),
    modelSection(v, selfHosted),
    sandboxSection(v, projectName),
    voiceSection(v),
    finalisationSection(v),
  ];

  console.log(`Day0 local setup, read from ${ENV_FILE}`);
  console.log('(process environment wins wherever it declares a variable, empty included)\n');
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
    process.exit(1);
  }
  console.log('Nothing here is half-done.');
}

/**
 * Name the handbook pages whose committed fixture no longer matches the page.
 *
 * The pages under `docs/submission/notion-pages/` are what the operator pastes
 * into Notion; the twins under `tests/fixtures/` are what the orientation tests
 * read. They have to be byte-identical or the suite proves things about a page
 * that is not the one published - which happened once while this check was
 * being written. `docs/` is gitignored, so this cannot be a test; it is checked
 * here, where the directory exists, and silently skipped where it does not.
 *
 * Returns:
 *   The stems of pages that differ, or that exist on only one side.
 */
function driftedHandbookTwins(): string[] {
  const pagesDir = 'docs/submission/notion-pages';
  const fixtureDir = 'tests/fixtures/notion-pages';
  if (!existsSync(pagesDir) || !existsSync(fixtureDir)) return [];
  const drifted: string[] = [];
  for (const file of readdirSync(fixtureDir)) {
    if (!file.endsWith('.md')) continue;
    const page = join(pagesDir, file);
    if (!existsSync(page)) {
      drifted.push(`${file.replace(/\.md$/, '')} (no published page)`);
      continue;
    }
    if (readFileSync(page, 'utf8') !== readFileSync(join(fixtureDir, file), 'utf8')) {
      drifted.push(file.replace(/\.md$/, ''));
    }
  }
  return drifted;
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
  const drifted = driftedHandbookTwins();
  if (drifted.length > 0) {
    lines.push(
      `Handbook page twins differ from their fixtures: ${drifted.join(', ')}. ` +
        'Copy docs/submission/notion-pages/<page>.md over tests/fixtures/notion-pages/<page>.md; ' +
        'the tests read the fixture, so a stale twin tests a page nobody publishes.',
    );
  }
  if (
    !backendRunning ||
    !docsReadable ||
    !keyPresent ||
    count === undefined ||
    drifted.length > 0
  ) {
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
 * None of this can fail the command. An enterprise whose systems all have APIs
 * never starts the browser component, and an enterprise that keeps its
 * documentation in a folder never starts the Notion one; both are complete
 * installations. What is worth saying out loud is a half-state - a component
 * running that day0 was never told about, or one day0 was told about that is
 * not there - because that is the shape that looks finished and is not.
 *
 * Args:
 *   values: Resolved deployment environment.
 *   projectName: Explicit Compose project name.
 *   services: Running service names, or undefined when Docker could not be asked.
 *
 * Returns:
 *   One informational section.
 */
function componentsSection(
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
      status = 'warn';
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

/** No-auth mode and Clerk are alternatives, and a half of either is worse than neither. */
function authSection(v: Values): Section {
  const noAuth = v.NEXT_PUBLIC_DEV_NO_AUTH === 'true';
  const clerkKeys = ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'].filter((k) => !v[k]);
  const hasClerk = clerkKeys.length === 0;

  if (noAuth) {
    const missing = ['DEV_NO_AUTH_SECRET', 'DEV_NO_AUTH_SIGNING_KEY', 'DEV_NO_AUTH_JWKS'].filter(
      (k) => !v[k],
    );
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
      `Missing ${clerkKeys.join(' and ')}, and NEXT_PUBLIC_DEV_NO_AUTH is not true.`,
      'Pick one: Clerk keys for per-user auth, or no-auth dev mode for the',
      'account-free path. Without either, nobody can sign in and nothing loads.',
    ],
  };
}

/**
 * The model layer takes any OpenAI-compatible endpoint, so "no key" is a
 * complete setup rather than a missing one - but only if a base URL says so.
 * The self-hosted trap gets its own check: charter synthesis runs as a Convex
 * Node action, inside the backend container, where a loopback address is the
 * container itself and never the model server on your desk.
 */
function modelSection(v: Values, selfHosted: boolean): Section {
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
      `Next calls ${v.OPENAI_BASE_URL}${v.OPENAI_API_KEY ? ' with a key' : ' with no key'}, model ${v.OPENAI_MODEL || 'gpt-5.5 (default)'}.`,
    );
  } else {
    lines.push(
      `Next calls api.openai.com with OPENAI_API_KEY, model ${v.OPENAI_MODEL || 'gpt-5.5 (default)'}.`,
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
      'http://host.docker.internal:11434/v1 for a server on this host.',
    );
  } else if (selfHosted && v.CONVEX_OPENAI_BASE_URL) {
    lines.push(`The backend container calls ${v.CONVEX_OPENAI_BASE_URL} for the same endpoint.`);
  } else if (selfHosted && !backendUrl) {
    lines.push(
      'The backend container calls api.openai.com as well - one address that means',
      'the same thing on both sides, so there is no second one to get wrong.',
    );
  }

  return { title: titleFor(status, 'Model'), status, lines };
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
