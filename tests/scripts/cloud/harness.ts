/**
 * A recorded cloud for the cloud verbs: a disposable checkout of a tagged
 * release, a private directory holding the target file, and fake `git`,
 * `npx convex`, `vercel`, `unzip` and `curl` that keep one Convex production
 * deployment and one Vercel project in memory, answer as the real tools
 * printed on 30 September 2026, and record every call with its stdin.
 * Nothing here reaches a network, a deployment or a Vercel project.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudIo } from '../../../scripts/cloud/checkout';
import type { CloudOptions } from '../../../scripts/setup-cloud';
import type { RunOptions, RunResult } from '../../../scripts/setup';
import { RETIRED_DECLARATIONS } from '../../../scripts/releases';

/** The dotenv parser the Convex CLI reads `env set`'s stdin with. */
const cliDotenv = createRequire(createRequire(import.meta.url).resolve('convex/package.json'))(
  'dotenv',
) as { parse(text: string): Record<string, string> };

/** The production deployment the fake project holds. */
export const DEPLOYMENT = 'brisk-heron-417';
/** Another deployment of the same project: the development one. */
export const DEV_DEPLOYMENT = 'quiet-lynx-456';
/** The app's production address. */
export const APP_URL = 'https://day0-example.vercel.app';
/** The commit the checkout is at, as the stamps carry it. */
export const COMMIT = '0123456789ab';
/** A key that must never be printed or put on a command line. */
export const SECRET = 'sk-synthetic-provider-key';

const REPOSITORY = new URL('../../../', import.meta.url);

/**
 * The releases the disposable checkout records. It is at 0.4.0, past the
 * release unstamped rows are taken to be at (0.3.0), so a deployment with
 * rows and no stamp reads as older than the checkout, as a real one would.
 */
const CHANGELOG = ['# Changelog', '', '## v0.4.0', '', '## v0.3.0', '', '## v0.2.0', ''].join('\n');
const ALL = RETIRED_DECLARATIONS.map(({ migration }) => migration);
const directories: string[] = [];

/** One recorded call: the program, its arguments and what it read on stdin. */
export interface CloudCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly input?: string;
}

/** What the fake cloud starts as. */
export interface CloudState {
  /** Whether the checkout has uncommitted changes. */
  dirty: boolean;
  /** The tag at HEAD, or undefined for none. */
  tag: string | undefined;
  /** The project's default production deployment, which `npx convex deploy` reaches. */
  defaultProd: string;
  /** The deployment's tables; none until its first push. */
  tables: string[];
  /** The deployment's env. */
  env: Map<string, string>;
  /** The deployment's release stamp. */
  stamp: { release: string; commit: string } | undefined;
  /** Migrations `runPending` still has to run. */
  pendingMigrations: string[];
  /** Vercel production names, each with when it was last written. */
  vercelEnv: Map<string, number>;
  /** The values set on Vercel production by this run, by name. */
  vercelValues: Map<string, string>;
  /** The build serving the app's address, the deployment it talks to and the release /setup states. */
  served: { id: string; talksTo: string; release: string | undefined } | undefined;
  /** Whether `env set` stores each value with a stray quote, as a misquoted stream would. */
  envSetMangles: boolean;
  /** Whether the dry run leaves the checkout changed, which a real one never should. */
  dryRunWrites: boolean;
  /** The Vercel project the served build belongs to. */
  servedProject: string;
  /** The linked project's framework preset, as `vercel project inspect` names it. */
  framework: string;
  /** Rows per table in an export. */
  rows: Record<string, number>;
  /** Tools that do not answer. */
  missing: string[];
  /** Calls that fail: a substring of the joined command and what it returns. */
  failing: { match: string; status: number; stderr: string; stdout?: string }[];
  /** Answers to prompts, in order. */
  answers: string[];
  /** The deployment env at each push, in order: what each push made the modules read. */
  pushedWithEnv: Map<string, string>[];
}

/** A fake cloud and what it recorded. */
export interface Cloud {
  readonly io: CloudIo;
  readonly state: CloudState;
  readonly calls: CloudCall[];
  readonly output: string[];
  /** The disposable checkout. */
  readonly checkout: string;
  /** The private directory beside the target file. */
  readonly privateDir: string;
  /** The target file. */
  readonly target: string;
}

/**
 * The tables a push of the fake schema leaves on a deployment.
 */
const SCHEMA_TABLES = ['agents', 'deploymentVersions', 'migrations'];

/**
 * A fake cloud: a tagged checkout of 0.4.0, a production deployment and a
 * Vercel project, each overridable.
 *
 * @param overrides - What differs from a deployment at 0.3.0 serving an app at 0.3.0.
 * @param options.targetText - The target file's text; undefined writes none.
 * @param options.linked - Whether the checkout carries `.vercel/project.json`.
 * @param options.staleDependencies - Whether the installed lockfile differs from the checkout's.
 */
export function cloud(
  overrides: Partial<CloudState> = {},
  options: { targetText?: string | null; linked?: boolean; staleDependencies?: boolean } = {},
): Cloud {
  const checkout = mkdtempSync(join(tmpdir(), 'day0-cloud-checkout-'));
  const privateDir = mkdtempSync(join(tmpdir(), 'day0-cloud-private-'));
  directories.push(checkout, privateDir);
  mkdirSync(join(checkout, 'convex'));
  mkdirSync(join(checkout, 'scripts'));
  writeFileSync(join(checkout, 'package.json'), '{"name":"day0","version":"0.4.0"}\n', 'utf8');
  writeFileSync(join(checkout, 'CHANGELOG.md'), CHANGELOG, 'utf8');
  writeFileSync(join(checkout, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8');
  mkdirSync(join(checkout, 'node_modules', '.pnpm'), { recursive: true });
  writeFileSync(
    join(checkout, 'node_modules', '.pnpm', 'lock.yaml'),
    options.staleDependencies ? "lockfileVersion: '6.0'\n" : "lockfileVersion: '9.0'\n",
    'utf8',
  );
  copyFileSync(
    new URL('scripts/sync-convex-env.sh', REPOSITORY),
    join(checkout, 'scripts', 'sync-convex-env.sh'),
  );
  if (options.linked !== false) {
    mkdirSync(join(checkout, '.vercel'));
    writeFileSync(
      join(checkout, '.vercel', 'project.json'),
      `${JSON.stringify({ projectId: 'prj_x', orgId: 'team_x', projectName: 'day0' })}\n`,
      'utf8',
    );
  }
  const target = join(privateDir, 'prod-target.env');
  const targetText =
    options.targetText === undefined
      ? `CONVEX_DEPLOYMENT=prod:${DEPLOYMENT}\nDAY0_APP_URL=${APP_URL}\n`
      : options.targetText;
  if (targetText !== null) writeFileSync(target, targetText, { encoding: 'utf8', mode: 0o600 });

  const state: CloudState = {
    dirty: false,
    tag: 'v0.4.0',
    defaultProd: DEPLOYMENT,
    tables: [...SCHEMA_TABLES],
    env: new Map([
      ['CLERK_JWT_ISSUER_DOMAIN', 'https://example.clerk.accounts.dev'],
      ['OPENAI_API_KEY', SECRET],
      ['DAY0_SURFACE_MODE', 'mock'],
    ]),
    stamp: { release: '0.3.0', commit: 'aaaaaaaaaaaa' },
    pendingMigrations: [],
    vercelEnv: new Map([
      ['NEXT_PUBLIC_CONVEX_URL', 1],
      ['NEXT_PUBLIC_CONVEX_SITE_URL', 1],
      ['CONVEX_DEPLOYMENT', 1],
      ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 1],
      ['CLERK_SECRET_KEY', 1],
    ]),
    vercelValues: new Map(),
    served: { id: 'dpl_Before1', talksTo: DEPLOYMENT, release: '0.3.0' },
    envSetMangles: false,
    dryRunWrites: false,
    servedProject: 'day0',
    framework: 'Next.js',
    rows: { agents: 2, deploymentVersions: 1, migrations: 19 },
    missing: [],
    failing: [],
    answers: [],
    pushedWithEnv: [],
    ...overrides,
  };
  const calls: CloudCall[] = [];
  const output: string[] = [];
  let generatedDirty = false;
  let clock = 100;
  let builds = 0;

  const ok = (stdout = '', stderr = ''): RunResult => ({ status: 0, stdout, stderr });
  const fail = (stderr: string, status = 1): RunResult => ({ status, stdout: '', stderr });
  const deploymentOf = (args: readonly string[]): string | undefined => {
    const at = args.indexOf('--deployment');
    return at < 0 ? undefined : args[at + 1];
  };

  const convex = (args: readonly string[], input: string | undefined): RunResult => {
    const [, verb, ...rest] = args;
    if (verb === 'deploy') {
      const file = args[args.indexOf('--env-file') + 1]!;
      const named = /CONVEX_DEPLOYMENT=prod:(\S+)/.exec(readFileSync(file, 'utf8'))?.[1];
      if (named !== state.defaultProd) {
        return fail('✖ Cannot prompt for input in non-interactive terminals.');
      }
      // The CLI names the deployment before the push request, and the dry run
      // sends that request too: the deployment's auth config is judged either way.
      const deploying = `- Deploying to https://${named}.convex.cloud...${args.includes('--dry-run') ? ' [dry run]' : ''}\n`;
      const identity =
        state.env.has('CLERK_JWT_ISSUER_DOMAIN') || state.env.has('DAY0_OIDC_ISSUER');
      if (!identity) {
        return {
          status: 1,
          stdout: '',
          // The CLI prints the server's stack frames after the cause, as it did
          // against a real empty production deployment on 1 October.
          stderr:
            `${deploying}✖ Error: Unable to start push to https://${named}.convex.cloud\n` +
            'AuthConfigMissingEnvironmentVariable: no identity provider is configured\n' +
            '    at identityProviders (../convex/auth.config.ts:49:11)\n' +
            '    at <anonymous> (../convex/auth.config.ts:60:15)\n',
        };
      }
      if (args.includes('--dry-run')) {
        if (state.dryRunWrites) generatedDirty = true;
        return ok('', `${deploying}\u001b[32m✔\u001b[39m No indexes are deleted by this push\n`);
      }
      generatedDirty = true;
      for (const table of SCHEMA_TABLES)
        if (!state.tables.includes(table)) state.tables.push(table);
      state.pushedWithEnv.push(new Map(state.env));
      return ok('', `✔ Deployed Convex functions to https://${named}.convex.cloud\n`);
    }
    const on = deploymentOf(args);
    if (on !== DEPLOYMENT) return fail(`✖ Deployment "${on ?? 'none'}" not found`);
    if (verb === 'data' && rest[0] === '--deployment') {
      return ok(state.tables.map((table) => `${table}\n`).join(''));
    }
    if (verb === 'data' && rest[0] === 'deploymentVersions') {
      return ok(
        state.stamp === undefined
          ? ''
          : `${JSON.stringify({ _id: 'k1', _creationTime: 1, ...state.stamp, recordedAt: 1 })}\n`,
      );
    }
    if (verb === 'data' && rest[0] === 'migrations') {
      return ok(ALL.map((name) => `${JSON.stringify({ name, completedAt: 2 })}\n`).join(''));
    }
    if (verb === 'env' && rest[0] === 'list') {
      return ok([...state.env].map(([name, value]) => `${name}=${value}\n`).join(''));
    }
    if (verb === 'env' && rest[0] === 'set' && rest[1] === '--deployment') {
      for (const [name, value] of Object.entries(cliDotenv.parse(input ?? ''))) {
        state.env.set(name, state.envSetMangles ? `'${value}` : value);
      }
      return ok('', '✔ Successfully set variables from stdin\n');
    }
    if (verb === 'env' && rest[0] === 'set') {
      state.env.set(rest[1]!, rest[2]!);
      return ok();
    }
    if (verb === 'env' && rest[0] === 'remove') {
      state.env.delete(rest[1]!);
      return ok();
    }
    if (verb === 'run' && rest[0] === 'migrations:runPending') {
      const ran = state.pendingMigrations.splice(0, 1);
      return ok(
        `${JSON.stringify({
          migrations: ran.map((name) => ({ name, read: 3, changed: 3 })),
          pending: state.pendingMigrations,
        })}\n`,
      );
    }
    if (verb === 'run' && rest[0] === 'migrations:recordRelease') {
      const stamped = JSON.parse(rest[1]!) as { release: string; commit: string };
      const previous = state.stamp?.release ?? null;
      state.stamp = stamped;
      return ok(`${JSON.stringify({ previous, release: stamped.release })}\n`);
    }
    if (verb === 'export') {
      const path = args[args.indexOf('--path') + 1]!;
      writeFileSync(path, `export of ${DEPLOYMENT}`, 'utf8');
      return ok('', `✔ Downloaded snapshot export to ${path}\n`);
    }
    return fail(`unexpected npx ${args.join(' ')}`);
  };

  const vercel = (args: readonly string[], input: string | undefined): RunResult => {
    if (args[0] === '--version') return ok('50.22.1\n');
    if (args[0] === 'env' && args[1] === 'ls') {
      const envs = [...state.vercelEnv].map(([key, updatedAt]) => ({
        key,
        type: 'encrypted',
        target: ['production'],
        updatedAt,
      }));
      return ok(`${JSON.stringify({ envs }, null, 2)}\n`, 'Retrieving project…\n');
    }
    if (args[0] === 'env' && (args[1] === 'add' || args[1] === 'update')) {
      const name = args[2]!;
      if (args[1] === 'add' && state.vercelEnv.has(name)) return fail(`Error: ${name} exists`);
      if (args[1] === 'update' && !state.vercelEnv.has(name)) return fail(`Error: no ${name}`);
      if (!args.includes('--yes')) return fail('Error: confirmation required');
      clock += 1;
      state.vercelEnv.set(name, clock);
      state.vercelValues.set(name, input ?? '');
      return ok('', `Updated Environment Variable ${name}\n`);
    }
    if (args[0] === 'project' && args[1] === 'inspect') {
      if (args[2] !== 'day0') return fail(`Error: Project not found (${args[2] ?? 'no name'})`);
      return ok(
        '',
        [
          `> Found Project example-team/${args[2]} [312ms]`,
          '',
          '  General',
          '',
          '    ID\t\t\t\tprj_x',
          `    Name\t\t\t${args[2]}`,
          '',
          '  Framework Settings',
          '',
          `    Framework Preset\t\t${state.framework}`,
          '',
        ].join('\n'),
      );
    }
    if (args[0] === 'inspect') {
      if (state.served === undefined) return fail(`Error: Can't find the deployment "${args[1]}"`);
      return ok(
        '',
        [
          `Fetching deployment "${args[1]}"`,
          '  General',
          `    id\t\t${state.served.id}`,
          `    name\t${state.servedProject}`,
          '    target\tproduction',
          '    status\t● Ready',
          `    url\t\thttps://day0-${state.served.id.toLowerCase()}.vercel.app`,
          '',
          '  Aliases',
          `    ╶ ${APP_URL}`,
          '',
          '  Builds',
        ].join('\n'),
      );
    }
    if (args[0] === '--prod') {
      builds += 1;
      const url = state.vercelValues.get('NEXT_PUBLIC_CONVEX_URL');
      const talksTo =
        url === undefined
          ? (state.served?.talksTo ?? DEV_DEPLOYMENT)
          : /https:\/\/([a-z0-9-]+)\./.exec(url)![1]!;
      state.served = { id: `dpl_After${builds}`, talksTo, release: state.stamp?.release };
      return ok(
        `https://day0-after${builds}.vercel.app\n`,
        `✅  Production: https://day0-after${builds}.vercel.app [2m]\n`,
      );
    }
    return fail(`unexpected vercel ${args.join(' ')}`);
  };

  const curl = (args: readonly string[]): RunResult => {
    if (args[0] === '--version') return ok('curl 8.5.0\n');
    const url = args.at(-1)!;
    const page = (body: string): RunResult => ok(`${body}\n200`);
    if (state.served === undefined) return ok('\n404');
    if (url === `${APP_URL}/`) {
      return page(
        '<html><script src="/_next/static/chunks/a1.js"></script><script src="/_next/static/chunks/c2.js"></script></html>',
      );
    }
    if (url === `${APP_URL}/_next/static/chunks/a1.js`) return page('self.__next_f=[]');
    if (url === `${APP_URL}/_next/static/chunks/c2.js`) {
      return page(`new ConvexReactClient("https://${state.served.talksTo}.convex.cloud")`);
    }
    if (url === `${APP_URL}/setup`) {
      return page(
        state.served.release === undefined
          ? '<h1>Set up Day0</h1>'
          : `<p>The deployment behind this page has been at v${state.served.release} since 1 October 2026, Singapore time.</p>`,
      );
    }
    return ok('\n404');
  };

  const unzip = (args: readonly string[]): RunResult => {
    if (args[0] === '-v') return ok('UnZip 6.00\n');
    if (args[0] === '-Z1') {
      return ok(
        [
          'README.md',
          '_tables/documents.jsonl',
          '_storage/documents.jsonl',
          ...Object.keys(state.rows).map((table) => `${table}/documents.jsonl`),
        ].join('\n'),
      );
    }
    const table = args[2]!.split('/')[0]!;
    const rows = table === '_storage' ? 0 : (state.rows[table] ?? 0);
    return ok(Array.from({ length: rows }, (_, index) => `{"_id":"r${index}"}\n`).join(''));
  };

  const git = (args: readonly string[]): RunResult => {
    const joined = args.join(' ');
    if (joined === 'rev-parse --short=12 HEAD') return ok(`${COMMIT}\n`);
    if (joined === 'status --porcelain') {
      return ok(state.dirty || generatedDirty ? ' M convex/_generated/api.d.ts\n' : '');
    }
    if (joined === 'describe --tags --exact-match HEAD') {
      return state.tag === undefined
        ? fail('fatal: no tag exactly matches', 128)
        : ok(`${state.tag}\n`);
    }
    if (joined === 'checkout -- convex/_generated') {
      generatedDirty = false;
      return ok();
    }
    return fail(`unexpected git ${joined}`);
  };

  const run = (command: string, args: readonly string[], runOptions?: RunOptions): RunResult => {
    calls.push({
      command,
      args: [...args],
      ...(runOptions?.input !== undefined ? { input: runOptions.input } : {}),
    });
    const joined = [command, ...args].join(' ');
    if (state.missing.includes(command)) return fail(`${command}: command not found`, 127);
    for (const failure of state.failing) {
      if (joined.includes(failure.match)) {
        return { status: failure.status, stdout: failure.stdout ?? '', stderr: failure.stderr };
      }
    }
    switch (command) {
      case 'npx':
        return convex(args, runOptions?.input);
      case 'vercel':
        return vercel(args, runOptions?.input);
      case 'curl':
        return curl(args);
      case 'unzip':
        return unzip(args);
      case 'git':
        return git(args);
      default:
        return fail(`unexpected ${joined}`);
    }
  };

  const io: CloudIo = {
    cwd: checkout,
    environment: {},
    run,
    ask: async (question: string): Promise<string> => {
      output.push(question);
      const answer = state.answers.shift();
      if (answer === undefined) throw new Error(`no scripted answer for: ${question}`);
      return answer;
    },
    log: (line: string): void => {
      output.push(line);
    },
    now: (): number => Date.UTC(2026, 9, 1, 2, 3, 4),
    newestMigrationRelease: '0.4.0',
  };
  return { io, state, calls, output, checkout, privateDir, target };
}

/**
 * Options for a verb against the fake cloud's target.
 *
 * @param cloudUnderTest - The fake cloud.
 * @param overrides - Fields to replace.
 */
export function verb(cloudUnderTest: Cloud, overrides: Partial<CloudOptions>): CloudOptions {
  return {
    target: cloudUnderTest.target,
    app: 'vercel',
    dryRun: false,
    assumeYes: true,
    help: false,
    ...overrides,
  };
}

/** Every recorded call as one line, stdin left out. */
export function ran(cloudUnderTest: Cloud): string[] {
  return cloudUnderTest.calls.map((call) => [call.command, ...call.args].join(' '));
}

/** The calls that change something on the deployment or the Vercel project. */
export function writes(cloudUnderTest: Cloud): string[] {
  return ran(cloudUnderTest).filter(
    (line) =>
      /^npx convex (env set|env remove|run migrations:|export)/.test(line) ||
      (/^npx convex deploy/.test(line) && !line.includes('--dry-run')) ||
      /^vercel (env (add|update)|--prod)/.test(line),
  );
}

/** Remove every directory made so far; call it from `afterEach`. */
export function cleanupClouds(): void {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
