/// <reference types="node" />
/**
 * Day0 on Convex cloud and Vercel, in one command per task.
 *
 *   ./setup.sh cloud setup   --target <file>   the first push to a production deployment,
 *                                              and the app deployed onto it
 *   ./setup.sh cloud upgrade --target <file>   a backup, then this checkout's release
 *                                              pushed, migrated, stamped and deployed
 *   ./setup.sh cloud backup  --target <file>   an export with its checksum and row counts
 *   ./setup.sh cloud pause | unpause --target <file>
 *                                              hold a real-mode deployment's scheduled jobs
 *
 * The target file lives outside the checkout and names the deployment in the
 * form the Convex CLI's `--env-file` reads, `CONVEX_DEPLOYMENT=prod:<name>`,
 * optionally with `DAY0_APP_URL` (the app's production address, read back
 * after every deploy) and `VERCEL_SCOPE`. It is the only place the target is
 * written down, so no `.env.local` in a checkout can point a push anywhere.
 *
 * These are the hand-typed commands the hosted demo was moved and redeployed
 * with (30 September 2026), with the rules those runs learned built in: every
 * step that changes something is preceded by the read that proves its target
 * and followed by the read that proves its result; the checkout is a clean
 * tag with no `.env.local`, and nothing in the shell selects a deployment; a
 * secret reaches a child on stdin, never on its command line, and is never
 * printed; `npx convex deploy` rewrites `convex/_generated`, which is put
 * back before the app is built; `vercel env` takes `--yes` and is read back;
 * the functions and the app are deployed in one run; and a real-mode
 * deployment's scheduled jobs are paused across its push.
 *
 * It is the production deployment or nothing: a development deployment is
 * refused by name, and a target the dry run does not confirm is refused
 * before anything is written. The rollback is a runbook each run prints with
 * the values it read, not a verb: undoing a production push is a decision.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CRONS_PAUSED_FLAG } from '../src/lib/crons-pause';
import { errorMessage } from '../src/lib/errors';
import {
  appConvexValues,
  appTalksTo,
  CLERK_APP_KEYS,
  deployApp,
  inspectApp,
  otherHostLines,
  projectRefusal,
  readAppBack,
  readAppEnv,
  setAppValues,
} from './cloud/app';
import {
  firstLine,
  readCheckout,
  readTarget,
  toolRefusal,
  vercelRefusal,
  type CheckoutState,
  type CloudIo,
  type CloudTarget,
  type Failure,
} from './cloud/checkout';
import {
  backupDirectory,
  convexOn,
  earliestUpgradeExport,
  fileStamp,
  migrateAndStamp,
  pauseReason,
  proveTarget,
  pushFunctions,
  readDeploymentEnv,
  takeBackup,
} from './cloud/deployment';
import {
  cloudEnvNames,
  cloudEnvRefusal,
  dotenvLine,
  parsePrivateEnv,
  PROMPTED_SETTINGS,
  withPinnedMode,
} from './cloud/env-file';
import { deploymentUrl, listedTables, type VercelDeployment } from './cloud/outputs';
import { rollbackLines, type RollbackFacts } from './cloud/rollback';
import { syncScriptKeys, upsertEnvText } from './demo-bed';
import { writePrivateEnv } from './private-env';
import {
  MIGRATIONS_TABLE,
  parseReleaseStamp,
  readReleaseVerdict,
  RELEASE_STAMP_ARGUMENTS,
  RELEASE_TABLE,
  TABLE_LISTING_ARGUMENTS,
} from './releases';
import {
  closeConsoleInput,
  consoleIo,
  insideCheckout,
  isUpgradePause,
  SetupCancelled,
  upgradePauseReason,
} from './setup';

export type { CloudIo } from './cloud/checkout';

/** The cloud verbs, as `./setup.sh cloud <verb>` spells them. */
export type CloudVerb = 'setup' | 'upgrade' | 'backup' | 'pause' | 'unpause';

const CLOUD_VERBS: readonly CloudVerb[] = ['setup', 'upgrade', 'backup', 'pause', 'unpause'];

/** Where the app half runs: Vercel, driven by its CLI, or a host the reader deploys to. */
export type AppHost = 'vercel' | 'none';

/** Every flag and verb the cloud command takes. */
export interface CloudOptions {
  readonly verb?: CloudVerb;
  /** The target file, outside the checkout. */
  readonly target?: string;
  /** `setup`: the private file holding the deployment's settings. */
  readonly envFile?: string;
  readonly app: AppHost;
  /** The app's production address, read back after a deploy. */
  readonly appUrl?: string;
  /** The Vercel team the project belongs to, when the link does not say. */
  readonly scope?: string;
  /** `backup` and `upgrade`: where the export goes; the target file's directory by default. */
  readonly backupTo?: string;
  /** `backup`: the export's file name, without `.zip`. */
  readonly name?: string;
  readonly dryRun: boolean;
  readonly assumeYes: boolean;
  readonly help: boolean;
}

const USAGE = `Usage: ./setup.sh cloud <setup|upgrade|backup|pause|unpause> --target <file> [options]

Day0 on Convex cloud and Vercel. Run it from a clean checkout of a release tag
with no .env.local (git worktree add --detach <dir> v<release>), linked to the
Vercel project (.vercel/project.json). The target file sits outside the
checkout and holds CONVEX_DEPLOYMENT=prod:<name>, the production deployment,
and optionally DAY0_APP_URL=<the app's production address> and VERCEL_SCOPE.

  setup     the first push to an empty production deployment: its settings from
            --env-file <private file> (or asked for, secrets hidden), the
            functions, the migrations, the release stamp, the app's three
            Convex values on Vercel and the app, then both read back
  upgrade   after the next release is tagged: an export first, the release
            check (one release at a time), the push, the migrations, the stamp
            and the app, then both read back; a real-mode deployment's
            scheduled jobs are paused across it
  backup    an export with file storage, its sha256 and its row counts, mode
            600, beside the target file (--to <dir>, --name <file stem>)
  pause     hold a real-mode deployment's scheduled jobs, pushing the stamped
            release again so every module reads it
  unpause   lift the pause, the same way

Options:
  --target <file>     the target file (required)
  --env-file <file>   setup: the deployment's settings, outside the checkout, mode 600
  --app <vercel|none> vercel (default) deploys the app with the Vercel CLI; none
                      prints the three values and the step for another host
  --app-url <url>     the app's production address (or DAY0_APP_URL in the target file)
  --scope <team>      the Vercel team, when the project link does not say
  --to <dir>          backup and upgrade: where the export goes
  --name <stem>       backup: the export's file name, without .zip
  --dry-run           run every read, print what would change, change nothing
  --yes               do not ask before the first write
  --help              print this

Every run ends with the rollback runbook, filled in with what it read.`;

/** The options a flag's value is read into. */
type ValuedOption = 'target' | 'envFile' | 'appUrl' | 'scope' | 'backupTo' | 'name';

/**
 * Read the cloud command line: the verb, then its flags.
 *
 * @param argv - Arguments after `cloud`.
 *
 * @throws Error when a flag is unknown or its value is not one this command has.
 */
export function parseCloudArguments(argv: readonly string[]): CloudOptions {
  let verb: CloudVerb | undefined;
  const values: { -readonly [Key in ValuedOption]?: string } = {};
  let app: AppHost = 'vercel';
  let dryRun = false;
  let assumeYes = false;
  let help = false;
  const valued: Readonly<Record<string, ValuedOption>> = {
    '--target': 'target',
    '--env-file': 'envFile',
    '--app-url': 'appUrl',
    '--scope': 'scope',
    '--to': 'backupTo',
    '--name': 'name',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const take = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`${argument} needs a value.`);
      index += 1;
      return value;
    };
    if (argument === '--help' || argument === '-h') help = true;
    else if (argument === '--dry-run') dryRun = true;
    else if (argument === '--yes' || argument === '-y') assumeYes = true;
    else if (argument === '--app') {
      const value = take();
      if (value !== 'vercel' && value !== 'none') {
        throw new Error(`--app "${value}" is not one of: vercel, none.`);
      }
      app = value;
    } else if (Object.hasOwn(valued, argument)) values[valued[argument]!] = take();
    else if ((CLOUD_VERBS as readonly string[]).includes(argument)) {
      if (verb !== undefined && verb !== argument) {
        throw new Error(`"${verb}" and "${argument}" are two verbs; give one.`);
      }
      verb = argument as CloudVerb;
    } else {
      throw new Error(`Unknown option "${argument}". Run \`./setup.sh cloud --help\`.`);
    }
  }
  return {
    ...(verb !== undefined ? { verb } : {}),
    ...values,
    app,
    dryRun,
    assumeYes,
    help,
  };
}

/**
 * Ask before the first write, unless told not to.
 *
 * @param io - The machine.
 * @param options - The command line.
 * @param question - The question, ending with its answer hint.
 *
 * @throws SetupCancelled when the answer is not yes.
 */
async function confirm(io: CloudIo, options: CloudOptions, question: string): Promise<void> {
  if (options.assumeYes) return;
  const answer = await io.ask(question);
  if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
    throw new SetupCancelled('declined at the confirmation');
  }
}

/**
 * The deployment's settings for a first setup, from the private file or the
 * prompts, pinned and judged; values never leave this process except on
 * `env set`'s stdin.
 *
 * @param options - The command line.
 * @param io - The machine.
 * @param held - What the deployment holds already, judged with the settings.
 */
async function firstSettings(
  options: CloudOptions,
  io: CloudIo,
  held: ReadonlyMap<string, string>,
): Promise<Map<string, string> | Failure> {
  const allowed = cloudEnvNames(
    syncScriptKeys(readFileSync(join(io.cwd, 'scripts', 'sync-convex-env.sh'), 'utf8')),
  );
  let values: Map<string, string>;
  if (options.envFile !== undefined) {
    const file = resolve(io.cwd, options.envFile);
    if (insideCheckout(file, io.cwd)) {
      return { failure: `${file} is inside this checkout; a file of secrets lives outside it.` };
    }
    if (!existsSync(file)) return { failure: `${file} does not exist.` };
    if ((statSync(file).mode & 0o077) !== 0) {
      return {
        failure: `${file} is readable by others; chmod 600 ${file} first, since it holds keys.`,
      };
    }
    try {
      values = parsePrivateEnv(readFileSync(file, 'utf8'));
    } catch (error) {
      return { failure: `${file} cannot be read: ${errorMessage(error)}.` };
    }
  } else if (options.dryRun) {
    // Nothing is asked on a dry run, so there is nothing yet to judge: the
    // plan lists what would be asked.
    io.log(
      `Would ask for ${PROMPTED_SETTINGS.map((setting) => setting.name).join(', ')}, the keys hidden.`,
    );
    return new Map(PROMPTED_SETTINGS.map((setting) => [setting.name, '']));
  } else {
    values = new Map();
    for (const setting of PROMPTED_SETTINGS) {
      const answer = (
        await io.ask(`${setting.name} (${setting.hint}): `, { hidden: setting.secret })
      ).trim();
      if (answer === '' && setting.required) {
        return { failure: `${setting.name} is needed and was left empty.` };
      }
      if (answer !== '') values.set(setting.name, answer);
    }
  }
  const pinned = withPinnedMode(values);
  const refusal = cloudEnvRefusal(pinned, allowed, held);
  return refusal === undefined ? pinned : { failure: refusal };
}

/** Where a deployment stands for a first setup: empty, or a first setup that stopped part way. */
type FirstPushState =
  | { readonly state: 'empty' }
  | { readonly state: 'unstamped' | 'stamped'; readonly note: string };

/**
 * Whether the first setup may push to this deployment: it is empty, or an
 * earlier first setup stopped part way, after its push and before its stamp
 * (tables, the migrations table among them, and no stamp), or after its stamp
 * and before the app was read back (stamped at this very release). Running
 * the setup again finishes either; anything else is the upgrade's.
 *
 * @param io - The machine.
 * @param target - The deployment.
 * @param release - This checkout's release.
 */
function firstPushState(
  io: CloudIo,
  target: CloudTarget,
  release: string,
): FirstPushState | Failure {
  const tables = convexOn(io, target, TABLE_LISTING_ARGUMENTS);
  if (tables.status !== 0) {
    return {
      failure: `the deployment's tables could not be listed (${firstLine(tables.stderr)}).`,
    };
  }
  const listed = listedTables(tables.stdout);
  if (listed.length === 0) return { state: 'empty' };
  let stamp: string | undefined;
  if (listed.includes(RELEASE_TABLE)) {
    const read = convexOn(io, target, RELEASE_STAMP_ARGUMENTS);
    if (read.status !== 0) {
      return { failure: `the release stamp could not be read (${firstLine(read.stderr)}).` };
    }
    try {
      stamp = parseReleaseStamp(read.stdout)?.release;
    } catch (error) {
      return { failure: `the release stamp could not be read: ${errorMessage(error)}.` };
    }
  }
  if (stamp === release) {
    return {
      state: 'stamped',
      note: `${target.deployment} is stamped v${release} already: finishing a first setup that stopped after its stamp.`,
    };
  }
  if (stamp === undefined && listed.includes(MIGRATIONS_TABLE)) {
    return {
      state: 'unstamped',
      note: `${target.deployment} holds a first setup's tables and no stamp: finishing a first setup that stopped after its push.`,
    };
  }
  return {
    failure:
      `${target.deployment} already holds tables${stamp === undefined ? '' : ` at v${stamp}`}, so this ` +
      `is not its first push: \`./setup.sh cloud upgrade --target ${target.file}\` moves it to this release.`,
  };
}

/** What the first setup read before its first write. */
interface SetupReads {
  readonly checkout: CheckoutState;
  readonly target: CloudTarget;
  /** The settings to give the deployment, judged and pinned. */
  readonly settings: ReadonlyMap<string, string>;
  /** The names the deployment lacks, which the setup sets. */
  readonly toSet: readonly string[];
  /** The names the deployment holds already, which the setup leaves as they are. */
  readonly kept: readonly string[];
  /** When each Vercel production name was last written, before. */
  readonly appBefore: ReadonlyMap<string, number>;
  /** The build serving the app's address before, when the address is known. */
  readonly previous: VercelDeployment | undefined;
}

/**
 * Every refusal and every read the first setup makes before it writes: the
 * checkout, the target and its proof, an empty deployment, the settings, and
 * the Vercel project's names.
 *
 * @param options - The command line.
 * @param io - The machine.
 */
async function readSetup(options: CloudOptions, io: CloudIo): Promise<SetupReads | Failure> {
  const checkout = readCheckout(io, true);
  if ('failure' in checkout) return checkout;
  const target = readTarget(options, io);
  if ('failure' in target) return target;
  if (options.app === 'vercel') {
    const refusal = vercelRefusal(io) ?? toolRefusal(io, 'curl');
    if (refusal !== undefined) return refusal;
  }
  // The push itself is proved once the env is set: an empty deployment's auth
  // config refuses every push, the dry run's included, until it has an identity.
  const proven = proveTarget(io, target, 'target');
  if (proven !== undefined) return proven;
  io.log(
    `The target is ${target.deployment}, the project's default production deployment (dry run).`,
  );
  const resumed = firstPushState(io, target, checkout.release);
  if ('failure' in resumed) return resumed;
  if (resumed.state !== 'empty') io.log(resumed.note);
  const held = readDeploymentEnv(io, target);
  if ('failure' in held) return { failure: `${held.failure}.` };
  const settings = await firstSettings(options, io, held);
  if ('failure' in settings) return settings;
  const toSet = [...settings.keys()].filter((name) => !held.has(name));
  const kept = [...settings.keys()].filter((name) => held.has(name));
  if (options.app === 'none') {
    return { checkout, target, settings, toSet, kept, appBefore: new Map(), previous: undefined };
  }
  const appBefore = readAppEnv(io, target);
  if ('failure' in appBefore) return { failure: `${appBefore.failure}.` };
  const clerk = settings.has('CLERK_JWT_ISSUER_DOMAIN') || held.has('CLERK_JWT_ISSUER_DOMAIN');
  const missing = clerk ? CLERK_APP_KEYS.filter((name) => !appBefore.has(name)) : [];
  if (missing.length > 0) {
    return {
      failure:
        `Vercel production has no ${missing.join(' or ')}, so the app could not sign anyone in: ` +
        `${missing.map((name) => `vercel env add ${name} production --sensitive`).join('; ')} (Vercel asks for each value).`,
    };
  }
  let previous: VercelDeployment | undefined;
  if (target.appUrl !== undefined) {
    const served = inspectApp(io, target, target.appUrl);
    if ('failure' in served) return { failure: `${served.failure}.` };
    const elsewhere = projectRefusal(io, served, target.appUrl);
    if (elsewhere !== undefined) return elsewhere;
    previous = served;
  }
  return { checkout, target, settings, toSet, kept, appBefore, previous };
}

/**
 * The first push to an empty production deployment, and the app deployed onto it.
 *
 * @param options - The command line.
 * @param io - The machine.
 *
 * @returns 0 once both halves are read back, 130 when declined, 1 otherwise.
 */
export async function runCloudSetup(options: CloudOptions, io: CloudIo): Promise<number> {
  const reads = await readSetup(options, io);
  if ('failure' in reads) {
    io.log(`error: nothing was set, pushed or deployed, because ${reads.failure}`);
    return 1;
  }
  const { checkout, target, settings, toSet, kept, appBefore, previous } = reads;
  io.log('');
  io.log(`Plan for ${target.deployment}, release ${checkout.release} (${checkout.commit}):`);
  io.log(
    `  set on the deployment: ${toSet.join(', ') || 'nothing'}${kept.length > 0 ? `; kept as it holds them: ${kept.join(', ')}` : ''}`,
  );
  io.log(`  npx convex deploy --typecheck enable --env-file ${target.file}`);
  io.log('  migrations:runPending until none is pending, then migrations:recordRelease');
  if (options.app === 'vercel') {
    io.log(
      '  vercel env add|update NEXT_PUBLIC_CONVEX_URL, NEXT_PUBLIC_CONVEX_SITE_URL, CONVEX_DEPLOYMENT production --yes',
    );
    io.log(`  vercel --prod --yes${previous ? ` (replacing ${previous.id})` : ''}`);
  }
  if (options.dryRun) {
    io.log('');
    io.log('Dry run: every read above ran; nothing was set, pushed or deployed.');
    return 0;
  }
  // Built before the question, so a value no dotenv line holds is refused
  // before anything is written.
  const stream = toSet.map((name) => `${dotenvLine(name, settings.get(name)!)}\n`).join('');
  try {
    await confirm(
      io,
      options,
      `Push v${checkout.release} to ${target.deployment} and deploy the app? [y/N] `,
    );
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    io.log('Cancelled. Nothing was set, pushed or deployed.');
    return 130;
  }

  const facts: RollbackFacts = {
    target,
    ...(previous !== undefined ? { previousApp: previous.id } : {}),
    appValuesChanged: options.app === 'vercel',
  };
  const stop = (what: string): number => {
    io.log(`error: ${what}`);
    for (const line of rollbackLines(facts)) io.log(line);
    return 1;
  };
  if (toSet.length > 0) {
    const set = convexOn(io, target, ['convex', 'env', 'set'], { input: stream });
    if (set.status !== 0) {
      return stop(
        `the deployment's env was not set (exit ${set.status ?? 'unknown'}); nothing was pushed.`,
      );
    }
  }
  const after = readDeploymentEnv(io, target);
  if ('failure' in after) return stop(`${after.failure}; nothing was pushed.`);
  // The values just set are compared too, so a quoting the CLI read otherwise shows here.
  const absent = [...settings.keys()].filter(
    (name) => !after.has(name) || (toSet.includes(name) && after.get(name) !== settings.get(name)),
  );
  if (absent.length > 0) {
    return stop(
      `the deployment's env does not hold ${absent.join(', ')} as set; nothing was pushed.`,
    );
  }
  io.log(`Set on ${target.deployment} and read back: ${toSet.join(', ') || 'nothing new'}.`);
  const accepted = proveTarget(io, target, 'push');
  if (accepted !== undefined) return stop(`${accepted.failure} Nothing was pushed.`);

  const pushed = pushFunctions(io, target, `v${checkout.release} ${checkout.commit} cloud setup`);
  if (pushed !== undefined) return stop(pushed.failure);
  const stamped = migrateAndStamp(io, target, checkout);
  if ('failure' in stamped) return stop(`${stamped.failure}.`);

  if (options.app === 'none') {
    otherHostLines(io, target);
    for (const line of rollbackLines({ ...facts, appValuesChanged: false })) io.log(line);
    return 0;
  }
  const values = setAppValues(io, target, appBefore);
  if (values !== undefined) return stop(`${values.failure}.`);
  const deployed = deployApp(io, target);
  if ('failure' in deployed) return stop(deployed.failure);
  const deployedAs = inspectApp(io, target, deployed.url);
  if ('failure' in deployedAs) return stop(`${deployedAs.failure}.`);
  const appUrl = target.appUrl ?? deployedAs.aliases[0] ?? deployed.url;
  const read = readAppBack(io, target, appUrl, previous, checkout.release);
  if ('failure' in read)
    return stop(`the app was deployed and did not read back: ${read.failure}.`);
  if (target.appUrl === undefined) {
    writePrivateEnv(
      target.file,
      upsertEnvText(readFileSync(target.file, 'utf8'), { DAY0_APP_URL: appUrl }),
    );
    io.log(
      `Wrote DAY0_APP_URL=${appUrl} into ${target.file}, so an upgrade reads the same address back.`,
    );
  }
  io.log('');
  io.log(`Done: ${target.deployment} is at v${checkout.release} and ${appUrl} serves it.`);
  for (const line of rollbackLines(facts)) io.log(line);
  return 0;
}

/** What the upgrade read before its first write. */
interface UpgradeReads {
  readonly checkout: CheckoutState;
  readonly target: CloudTarget;
  /** Where the export goes. */
  readonly directory: string;
  /** The release the deployment is stamped at now. */
  readonly from: string;
  /** What the release check said. */
  readonly note: string;
  /** Whether the deployment runs in real mode, whose jobs are paused across the push. */
  readonly realMode: boolean;
  /** The pause the deployment holds now, if any. */
  readonly held: string | undefined;
  /** The build serving the app's address now. */
  readonly previous: VercelDeployment | undefined;
}

/**
 * Every refusal and every read the upgrade makes before it writes: the
 * checkout, the target and its proof, the release check, the deployment's
 * mode and pause, and the app that serves it now.
 *
 * @param options - The command line.
 * @param io - The machine.
 */
function readUpgrade(options: CloudOptions, io: CloudIo): UpgradeReads | Failure {
  const checkout = readCheckout(io, true);
  if ('failure' in checkout) return checkout;
  const target = readTarget(options, io);
  if ('failure' in target) return target;
  if (options.app === 'vercel' && target.appUrl === undefined) {
    return {
      failure:
        "the app's production address is not named: --app-url https://<host>, or DAY0_APP_URL in the target file (the first setup writes it).",
    };
  }
  const refusal =
    toolRefusal(io, 'unzip') ??
    (options.app === 'vercel' ? (toolRefusal(io, 'curl') ?? vercelRefusal(io)) : undefined);
  if (refusal !== undefined) return refusal;
  const place = backupDirectory(options.backupTo, io, target);
  if ('failure' in place) return place;
  const proven = proveTarget(io, target, 'push');
  if (proven !== undefined) return proven;
  io.log(
    `The target is ${target.deployment}, the project's default production deployment (dry run).`,
  );
  const verdict = readReleaseVerdict((args) => convexOn(io, target, args), checkout);
  if (!verdict.allowed) return { failure: verdict.reason };
  if (verdict.from === undefined) {
    return {
      failure: `nothing was ever pushed to ${target.deployment}: its first push is \`./setup.sh cloud setup --target ${target.file}\`.`,
    };
  }
  io.log(`Release check: ${verdict.note}.`);
  const env = readDeploymentEnv(io, target);
  if ('failure' in env) return { failure: `${env.failure}.` };
  const reads = {
    checkout,
    target,
    directory: place.directory,
    from: verdict.from,
    note: verdict.note,
    realMode: env.get('DAY0_SURFACE_MODE') === 'real',
    held: pauseReason(env),
  };
  if (options.app === 'none' || target.appUrl === undefined) {
    return { ...reads, previous: undefined };
  }
  const served = readServingApp(io, target, target.appUrl);
  return 'failure' in served ? served : { ...reads, previous: served };
}

/**
 * The build serving the app's address, refused unless the app already talks
 * to the deployment through the three names setup sets.
 *
 * @param io - The machine.
 * @param target - The target.
 * @param appUrl - The app's production address.
 */
function readServingApp(
  io: CloudIo,
  target: CloudTarget,
  appUrl: string,
): VercelDeployment | Failure {
  const appEnv = readAppEnv(io, target);
  if ('failure' in appEnv) return { failure: `${appEnv.failure}.` };
  const missing = [...appConvexValues(target.deployment).keys()].filter(
    (name) => !appEnv.has(name),
  );
  if (missing.length > 0) {
    return {
      failure: `Vercel production has no ${missing.join(', ')}; an app is moved onto a deployment by \`./setup.sh cloud setup\`.`,
    };
  }
  const served = inspectApp(io, target, appUrl);
  if ('failure' in served) return { failure: `${served.failure}.` };
  const elsewhere = projectRefusal(io, served, appUrl);
  if (elsewhere !== undefined) return elsewhere;
  const talks = appTalksTo(io, appUrl, target.deployment);
  if ('failure' in talks) return { failure: `${talks.failure}.` };
  if (!talks.talks) {
    return {
      failure: `the app at ${appUrl} does not talk to ${target.deployment} now (no client chunk names ${deploymentUrl(target.deployment)}), so this is a move, not an upgrade.`,
    };
  }
  io.log(`The app at ${appUrl} is ${served.id} and talks to ${target.deployment}.`);
  return served;
}

/**
 * Print what the upgrade will do, read by read.
 *
 * @param io - The machine.
 * @param options - The command line.
 * @param reads - What the upgrade read.
 * @param steps - The export's path and the pause's reason this run would use.
 */
function printUpgradePlan(
  io: CloudIo,
  options: CloudOptions,
  reads: UpgradeReads,
  steps: { readonly exportFile: string; readonly reason: string },
): void {
  const { target, checkout, held, previous } = reads;
  io.log('');
  io.log(`Plan for ${target.deployment}, ${reads.note} (${checkout.commit}):`);
  io.log(
    `  npx convex export --include-file-storage --path ${steps.exportFile} --deployment ${target.deployment}`,
  );
  if (reads.realMode && held === undefined) {
    io.log(
      `  npx convex env set ${CRONS_PAUSED_FLAG} "${steps.reason}" --deployment ${target.deployment}`,
    );
  } else if (held !== undefined) {
    io.log(
      `  the scheduled jobs are paused already (${held}); ${isUpgradePause(held) ? 'this upgrade lifts it when it completes' : 'the upgrade leaves a pause set by hand'}`,
    );
  }
  io.log(`  npx convex deploy --typecheck enable --env-file ${target.file}`);
  io.log('  migrations:runPending until none is pending, then migrations:recordRelease');
  if (options.app === 'vercel') {
    io.log(`  vercel --prod --yes (replacing ${previous?.id ?? 'nothing'})`);
  }
}

/**
 * Move to this checkout's release: an export first, the release check, a
 * pause of a real-mode deployment's scheduled jobs, the push, the
 * migrations, the stamp, the app, and every one read back.
 *
 * @param options - The command line.
 * @param io - The machine.
 *
 * @returns 0 once both halves are read back, 130 when declined, 1 otherwise.
 */
export async function runCloudUpgrade(options: CloudOptions, io: CloudIo): Promise<number> {
  const reads = readUpgrade(options, io);
  if ('failure' in reads) {
    io.log(`error: nothing was backed up, pushed or deployed, because ${reads.failure}`);
    return 1;
  }
  const { checkout, target, held, previous } = reads;
  const now = io.now?.() ?? Date.now();
  const stem = `before-v${checkout.release}-${fileStamp(now)}`;
  const reason = upgradePauseReason(checkout.release, now);
  printUpgradePlan(io, options, reads, {
    exportFile: join(reads.directory, `${stem}.zip`),
    reason,
  });
  if (options.dryRun) {
    io.log('');
    io.log('Dry run: every read above ran; nothing was exported, set, pushed or deployed.');
    return 0;
  }
  try {
    await confirm(
      io,
      options,
      `Upgrade ${target.deployment} to v${checkout.release} and deploy the app? [y/N] `,
    );
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    io.log('Cancelled. Nothing was exported, set, pushed or deployed.');
    return 130;
  }

  // Read before this run's export, which is later by its name.
  const earlier = earliestUpgradeExport(reads.directory, checkout.release);
  const backup = takeBackup(io, target, reads.directory, stem);
  if ('failure' in backup) {
    io.log(
      `error: nothing was pushed or deployed, because the export did not finish: ${backup.failure}`,
    );
    return 1;
  }
  const facts: RollbackFacts = {
    target,
    ...(previous !== undefined ? { previousApp: previous.id } : {}),
    upgrade: {
      to: checkout.release,
      from: reads.from === checkout.release ? undefined : reads.from,
      backup:
        earlier === undefined
          ? { file: backup.file, sha256: backup.sha256, earlier: false }
          : { ...earlier, earlier: true },
    },
  };
  let paused = held !== undefined && isUpgradePause(held);
  // Whether this run's functions reached the deployment: before that, the
  // deployment runs the release it had, and this run's own pause is taken off
  // again; after it, only the upgrade run again from this checkout may lift it.
  let pushedHere = false;
  let pausedHere = false;
  const stop = (what: string): number => {
    io.log(`error: ${what}`);
    if (paused && pausedHere && !pushedHere) {
      const lifted = convexOn(io, target, ['convex', 'env', 'remove', CRONS_PAUSED_FLAG]);
      const read = readDeploymentEnv(io, target);
      paused = lifted.status !== 0 || 'failure' in read || pauseReason(read) !== undefined;
      if (!paused) {
        io.log(
          `Nothing was pushed, so the pause this run set on the scheduled jobs is lifted again (${CRONS_PAUSED_FLAG} removed and read back).`,
        );
      }
    }
    if (paused) {
      io.log(
        `The scheduled jobs stay paused (${CRONS_PAUSED_FLAG}). Run \`./setup.sh cloud upgrade --target ${target.file}\` again from this checkout: it resumes the migrations and lifts the pause when it completes.`,
      );
    }
    for (const line of rollbackLines(facts)) io.log(line);
    return 1;
  };
  if (reads.realMode && held === undefined) {
    const set = convexOn(io, target, ['convex', 'env', 'set', CRONS_PAUSED_FLAG, reason]);
    const read = readDeploymentEnv(io, target);
    if (set.status !== 0 || 'failure' in read || pauseReason(read) !== reason) {
      return stop('the scheduled jobs could not be paused; nothing was pushed.');
    }
    paused = true;
    pausedHere = true;
    io.log(
      `Paused the scheduled jobs (${CRONS_PAUSED_FLAG}=${reason}); the push makes every module read it.`,
    );
  }

  const message = `v${checkout.release} ${checkout.commit} cloud upgrade`;
  const pushed = pushFunctions(io, target, message);
  if (pushed !== undefined) return stop(pushed.failure);
  pushedHere = true;
  const stamped = migrateAndStamp(io, target, checkout);
  if ('failure' in stamped) return stop(`${stamped.failure}.`);

  if (options.app === 'vercel' && target.appUrl !== undefined) {
    const deployed = deployApp(io, target);
    if ('failure' in deployed) return stop(deployed.failure);
    const read = readAppBack(io, target, target.appUrl, previous, checkout.release);
    if ('failure' in read) {
      return stop(`the app was deployed and did not read back: ${read.failure}.`);
    }
  } else {
    otherHostLines(io, target);
  }

  if (paused) {
    const lifted = convexOn(io, target, ['convex', 'env', 'remove', CRONS_PAUSED_FLAG]);
    const read = readDeploymentEnv(io, target);
    if (lifted.status !== 0 || 'failure' in read || pauseReason(read) !== undefined) {
      return stop('the upgrade is done, and its pause on the scheduled jobs was not lifted.');
    }
    paused = false;
    const again = pushFunctions(io, target, `${message}, pause lifted`);
    if (again !== undefined) {
      return stop(
        `the pause is lifted on the deployment, and the push that makes every module read it failed: ${again.failure}`,
      );
    }
    io.log('Lifted the pause on the scheduled jobs and pushed again so every module reads it.');
  }
  io.log('');
  io.log(
    reads.from === checkout.release
      ? `Done: ${target.deployment} is at v${checkout.release}, pushed again.`
      : `Done: ${target.deployment} moved from v${reads.from} to v${checkout.release}.`,
  );
  for (const line of rollbackLines(facts)) io.log(line);
  return 0;
}

/**
 * Export the deployment with its checksum and row counts.
 *
 * @param options - The command line.
 * @param io - The machine.
 *
 * @returns 0 once written, 1 otherwise.
 */
export async function runCloudBackup(options: CloudOptions, io: CloudIo): Promise<number> {
  const refuse = (reason: string): number => {
    io.log(`error: nothing was exported, because ${reason}`);
    return 1;
  };
  const checkout = readCheckout(io, false);
  if ('failure' in checkout) return refuse(checkout.failure);
  const target = readTarget(options, io);
  if ('failure' in target) return refuse(target.failure);
  const unzip = toolRefusal(io, 'unzip');
  if (unzip !== undefined) return refuse(unzip.failure);
  const place = backupDirectory(options.backupTo, io, target);
  if ('failure' in place) return refuse(place.failure);
  if (options.name !== undefined && !/^[A-Za-z0-9._-]+$/.test(options.name)) {
    return refuse(`--name ${options.name} is not a plain file name.`);
  }
  const stem = (
    options.name ?? `${target.deployment}-${fileStamp(io.now?.() ?? Date.now())}`
  ).replace(/\.zip$/, '');
  const file = join(place.directory, `${stem}.zip`);
  if (existsSync(file)) return refuse(`${file} exists already; nothing is written over a backup.`);
  if (options.dryRun) {
    io.log('Would run:');
    io.log(
      `  npx convex export --include-file-storage --path ${file} --deployment ${target.deployment}`,
    );
    io.log('  then its sha256 and its row counts beside it, all mode 600.');
    io.log('Nothing was exported.');
    return 0;
  }
  const backup = takeBackup(io, target, place.directory, stem);
  if ('failure' in backup) return refuse(backup.failure);
  return 0;
}

/**
 * The release an upgrade's pause names, or undefined for a pause set by hand.
 *
 * @param reason - The pause's reason, as the deployment holds it.
 */
export function upgradePauseRelease(reason: string): string | undefined {
  return isUpgradePause(reason) ? /^upgrade to (\S+) at /.exec(reason)?.[1] : undefined;
}

/**
 * Pause or lift a cloud deployment's scheduled jobs, then push the stamped
 * release again so every module reads the change: a module keeps the env it
 * was first evaluated with.
 *
 * @param options - The command line.
 * @param io - The machine.
 * @param verb - `pause` or `unpause`.
 *
 * @returns 0 when the jobs are as asked, 1 otherwise.
 */
export async function runCloudPause(
  options: CloudOptions,
  io: CloudIo,
  verb: 'pause' | 'unpause',
): Promise<number> {
  const refuse = (reason: string): number => {
    io.log(`error: nothing was changed, because ${reason}`);
    return 1;
  };
  const checkout = readCheckout(io, true);
  if ('failure' in checkout) return refuse(checkout.failure);
  const target = readTarget(options, io);
  if ('failure' in target) return refuse(target.failure);
  const proven = proveTarget(io, target, 'push');
  if (proven !== undefined) return refuse(proven.failure);
  const stampRead = convexOn(io, target, RELEASE_STAMP_ARGUMENTS);
  let stamped: string | undefined;
  try {
    stamped = stampRead.status === 0 ? parseReleaseStamp(stampRead.stdout)?.release : undefined;
  } catch (error) {
    return refuse(`the stamp could not be read: ${errorMessage(error)}.`);
  }
  if (stamped !== checkout.release) {
    return refuse(
      `${target.deployment} is at ${stamped === undefined ? 'no stamped release' : `v${stamped}`} and this checkout is v${checkout.release}; the ${verb} pushes the functions again, which only a checkout of the stamped release may do.`,
    );
  }
  const env = readDeploymentEnv(io, target);
  if ('failure' in env) return refuse(`${env.failure}.`);
  const current = pauseReason(env);
  const unfinished = current === undefined ? undefined : upgradePauseRelease(current);
  if (unfinished !== undefined && unfinished !== checkout.release) {
    return refuse(
      `an upgrade to v${unfinished} did not finish (${current}); its pause is lifted by running that upgrade again from a clean checkout of v${unfinished}, never by pushing this release over rows it may have migrated.`,
    );
  }
  const byHand = `paused by hand at ${new Date(io.now?.() ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
  if (verb === 'pause' && current !== undefined && !isUpgradePause(current)) {
    io.log(
      `${target.deployment}'s scheduled jobs are already paused (${current}); nothing was changed.`,
    );
    return 0;
  }
  if (verb === 'unpause' && current === undefined) {
    io.log(`${target.deployment}'s scheduled jobs are not paused; nothing was changed.`);
    return 0;
  }
  const change =
    verb === 'pause'
      ? ['convex', 'env', 'set', CRONS_PAUSED_FLAG, byHand]
      : ['convex', 'env', 'remove', CRONS_PAUSED_FLAG];
  if (options.dryRun) {
    io.log('Would run:');
    io.log(`  npx ${change.join(' ')} --deployment ${target.deployment}`);
    io.log(`  npx convex deploy --typecheck enable --env-file ${target.file}`);
    io.log('Nothing was changed.');
    return 0;
  }
  const changed = convexOn(io, target, change);
  const read = readDeploymentEnv(io, target);
  const now = 'failure' in read ? undefined : pauseReason(read);
  if (
    changed.status !== 0 ||
    'failure' in read ||
    (verb === 'pause' ? now !== byHand : now !== undefined)
  ) {
    return refuse(
      `\`npx ${change.slice(0, 3).join(' ')} ${CRONS_PAUSED_FLAG}\` did not read back.`,
    );
  }
  const pushed = pushFunctions(io, target, `v${checkout.release} ${checkout.commit} ${verb}`);
  if (pushed !== undefined) {
    io.log(
      `error: the value is ${verb === 'pause' ? 'set' : 'removed'} on the deployment, and the push that makes every module read it failed: ${pushed.failure}`,
    );
    return 1;
  }
  io.log(
    verb === 'pause'
      ? `Paused ${target.deployment}'s scheduled jobs (${byHand}); an upgrade leaves this pause until \`./setup.sh cloud unpause\`.`
      : `Lifted the pause on ${target.deployment}'s scheduled jobs; each runs again at its next turn.`,
  );
  return 0;
}

/**
 * Run the verb the command line named.
 *
 * @param options - The command line.
 * @param io - The machine.
 *
 * @returns The exit status.
 */
export async function runCloudCommand(options: CloudOptions, io: CloudIo): Promise<number> {
  try {
    switch (options.verb) {
      case 'setup':
        return await runCloudSetup(options, io);
      case 'upgrade':
        return await runCloudUpgrade(options, io);
      case 'backup':
        return await runCloudBackup(options, io);
      case 'pause':
      case 'unpause':
        return await runCloudPause(options, io, options.verb);
      case undefined:
        io.log('error: name a verb: ./setup.sh cloud <setup|upgrade|backup|pause|unpause>.');
        return 2;
    }
  } catch (error) {
    if (error instanceof SetupCancelled) {
      io.log('Cancelled.');
      return 130;
    }
    io.log(`error: ${errorMessage(error)}`);
    return 1;
  }
}

/** Run the cloud command from the command line. */
async function main(): Promise<number> {
  let options: CloudOptions;
  try {
    options = parseCloudArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${errorMessage(error)}\n`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    return await runCloudCommand(options, consoleIo());
  } finally {
    closeConsoleInput();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Handed back rather than passed to process.exit so a piped stdout drains.
  process.exitCode = await main();
}
