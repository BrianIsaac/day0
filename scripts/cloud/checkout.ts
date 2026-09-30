/**
 * What every cloud verb reads before it touches anything: the checkout it
 * runs from, the target file naming the production deployment, and the tools
 * it needs. Each read returns the thing or a `Failure` whose reason is the
 * verb's refusal, in the verb's own words.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { errorMessage } from '../../src/lib/errors';
import { checkoutRefusal, checkoutReleases, type CheckoutReleases } from '../releases';
import { insideCheckout, type RunResult, type SetupIo } from '../setup';
import { parsePrivateEnv } from './env-file';
import { DEPLOYMENT_NAME_PATTERN } from './outputs';

/** The flags that name the target, as the command line gives them. */
export interface TargetFlags {
  /** The target file, outside the checkout. */
  readonly target?: string;
  /** The app's production address, over the file's `DAY0_APP_URL`. */
  readonly appUrl?: string;
  /** The Vercel team, over the file's `VERCEL_SCOPE`. */
  readonly scope?: string;
}

/** What the cloud verbs need of the machine: the setup's own seam, less its ports. */
export type CloudIo = Pick<
  SetupIo,
  'cwd' | 'environment' | 'run' | 'ask' | 'log' | 'now' | 'newestMigrationRelease'
>;

/** What a step reports when it could not do its work. */
export interface Failure {
  readonly failure: string;
}

/** The names a target file may hold. Anything else is refused: the file is not for secrets. */
export const TARGET_KEYS: readonly string[] = ['CONVEX_DEPLOYMENT', 'DAY0_APP_URL', 'VERCEL_SCOPE'];

/** The deployment and app a verb acts on, as the target file and the flags name them. */
export interface CloudTarget {
  /** The target file, absolute. */
  readonly file: string;
  /** The production deployment's name. */
  readonly deployment: string;
  /** The app's production address, when known. */
  readonly appUrl?: string;
  /** The Vercel team, when named. */
  readonly scope?: string;
}

/**
 * The target a verb acts on, or why there is none.
 *
 * @param flags - The command line's target flags.
 * @param io - The machine.
 */
export function readTarget(flags: TargetFlags, io: CloudIo): CloudTarget | Failure {
  if (flags.target === undefined) {
    return {
      failure:
        'the target file is not named: --target <file>, a file outside this checkout holding ' +
        'CONVEX_DEPLOYMENT=prod:<name>.',
    };
  }
  const file = resolve(io.cwd, flags.target);
  if (insideCheckout(file, io.cwd)) {
    return {
      failure: `${file} is inside this checkout; the target file lives outside it, so no checkout carries a push target.`,
    };
  }
  if (!existsSync(file)) {
    return {
      failure:
        `${file} does not exist. Write it once, naming the production deployment the Convex ` +
        `dashboard shows: mkdir -p -m 700 ${dirname(file)} && printf 'CONVEX_DEPLOYMENT=prod:<name>\\n' ` +
        `> ${file} && chmod 600 ${file}`,
    };
  }
  let values: Map<string, string>;
  try {
    values = parsePrivateEnv(readFileSync(file, 'utf8'));
  } catch (error) {
    return { failure: `${file} cannot be read: ${errorMessage(error)}.` };
  }
  const unknown = [...values.keys()].filter((key) => !TARGET_KEYS.includes(key));
  if (unknown.length > 0) {
    return {
      failure: `${file} holds ${unknown.join(', ')}; a target file holds only ${TARGET_KEYS.join(', ')}.`,
    };
  }
  const selector = values.get('CONVEX_DEPLOYMENT') ?? '';
  const [kind, name] = selector.split(':', 2) as [string, string | undefined];
  if (kind === 'dev') {
    return {
      failure:
        `${file} names a development deployment (${selector}). The cloud verbs push only to a ` +
        'production deployment; a development one is pushed with `npx convex dev`.',
    };
  }
  if (kind !== 'prod' || name === undefined || !DEPLOYMENT_NAME_PATTERN.test(name)) {
    return {
      failure: `${file} does not name a production deployment as CONVEX_DEPLOYMENT=prod:<name>.`,
    };
  }
  const appUrl = (flags.appUrl ?? values.get('DAY0_APP_URL'))?.replace(/\/+$/, '');
  if (appUrl !== undefined && !/^https:\/\/[^\s/]+$/.test(appUrl)) {
    return { failure: `the app address ${appUrl} is not an https origin.` };
  }
  const scope = flags.scope ?? values.get('VERCEL_SCOPE');
  return {
    file,
    deployment: name,
    ...(appUrl !== undefined ? { appUrl } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

/** Names in the shell that would point the Convex CLI somewhere the target file does not. */
export const INHERITED_SELECTORS: readonly string[] = [
  'CONVEX_DEPLOYMENT',
  'CONVEX_DEPLOY_KEY',
  'CONVEX_SELF_HOSTED_URL',
  'CONVEX_SELF_HOSTED_ADMIN_KEY',
];

/** The release this checkout is, its commit, and the releases it knows. */
export interface CheckoutState extends CheckoutReleases {
  /** The commit, twelve characters, as the stamps carry it. */
  readonly commit: string;
}

/**
 * Why this checkout may not act on a cloud deployment, or what it is. A verb
 * that pushes needs a clean checkout of this release's tag; every verb needs
 * the repository root, no `.env.local` and nothing in the shell selecting a
 * deployment.
 *
 * @param io - The machine.
 * @param pushes - Whether the verb pushes functions.
 */
export function readCheckout(io: CloudIo, pushes: boolean): CheckoutState | Failure {
  if (!existsSync(join(io.cwd, 'package.json')) || !existsSync(join(io.cwd, 'convex'))) {
    return { failure: `run this from the repository root; ${io.cwd} is not a Day0 checkout.` };
  }
  if (existsSync(join(io.cwd, '.env.local'))) {
    return {
      failure:
        'this checkout has a .env.local, and the Convex CLI reads it beside the target file. Work ' +
        'from a clean checkout of the tag with none: git worktree add --detach <dir> v<release>.',
    };
  }
  const inherited = INHERITED_SELECTORS.filter((name) => (io.environment[name] ?? '') !== '');
  if (inherited.length > 0) {
    return {
      failure: `${inherited.join(' and ')} ${inherited.length === 1 ? 'is' : 'are'} set in this shell and would choose the deployment instead of the target file; unset ${inherited.length === 1 ? 'it' : 'them'}.`,
    };
  }
  const releases = checkoutReleases(io.cwd, io.newestMigrationRelease);
  if ('reason' in releases)
    return { failure: `this checkout's release cannot be read: ${releases.reason}.` };
  const head = io.run('git', ['rev-parse', '--short=12', 'HEAD'], { timeoutMs: 30_000 });
  if (head.status !== 0 || head.stdout.trim() === '') {
    return { failure: 'git cannot say which commit this checkout is.' };
  }
  const state = { ...releases, commit: head.stdout.trim() };
  if (!pushes) return state;
  const refusal = checkoutRefusal(releases);
  if (refusal !== undefined) return { failure: refusal };
  const status = io.run('git', ['status', '--porcelain'], { timeoutMs: 30_000 });
  if (status.status !== 0) return { failure: 'git cannot say whether this checkout is clean.' };
  if (status.stdout.trim() !== '') {
    return {
      failure:
        'this checkout has changes git has not committed, so what would be pushed is not a ' +
        `release: ${firstLine(status.stdout)}. Push from a clean checkout of the tag.`,
    };
  }
  const tag = io.run('git', ['describe', '--tags', '--exact-match', 'HEAD'], { timeoutMs: 30_000 });
  const expected = `v${releases.release}`;
  if (tag.status !== 0 || tag.stdout.trim() !== expected) {
    return {
      failure:
        `this checkout is not the ${expected} tag (package.json says ${releases.release}), and ` +
        `only a tagged release goes to production: git worktree add --detach <dir> ${expected}.`,
    };
  }
  return state;
}

/** The first non-empty line of some output. */
export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

/** The last lines of a tool's output, for a failure the reader has to diagnose. */
export function tail(result: RunResult, lines = 15): string[] {
  return `${result.stdout}\n${result.stderr}`
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-lines)
    .map((line) => `  | ${line}`);
}

/** A tool a verb needs, with the check that it answers and the words for its absence. */
export function toolRefusal(io: CloudIo, tool: 'vercel' | 'unzip' | 'curl'): Failure | undefined {
  const probe = tool === 'unzip' ? ['-v'] : ['--version'];
  const answered = io.run(tool, probe, { timeoutMs: 60_000 });
  if (answered.status === 0) return undefined;
  const install: Readonly<Record<typeof tool, string>> = {
    vercel: 'npm install --global vercel, then vercel login',
    unzip: 'the unzip package',
    curl: 'the curl package',
  };
  return { failure: `\`${tool}\` does not answer on this machine; install it (${install[tool]}).` };
}

/**
 * The app half's refusals: the Vercel CLI answers and the checkout is linked.
 *
 * @param io - The machine.
 */
export function vercelRefusal(io: CloudIo): Failure | undefined {
  const tool = toolRefusal(io, 'vercel');
  if (tool !== undefined) return tool;
  if (!existsSync(join(io.cwd, '.vercel', 'project.json'))) {
    return {
      failure:
        'this checkout is not linked to a Vercel project (.vercel/project.json); run `vercel link` ' +
        'here, or copy .vercel/project.json from a linked checkout.',
    };
  }
  return undefined;
}
