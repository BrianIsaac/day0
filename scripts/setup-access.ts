/// <reference types="node" />
/**
 * `./setup.sh access`: the access half of the install kit (the access plan, section 4.8; B8, B13,
 * D3 with B11, A12), run with the customer's IT on an installation the setup made and, at a
 * customer, the sign-in verb configured.
 *
 * It names the administrators who manage the organisation's connections (`DAY0_ADMINISTRATORS`,
 * pushed with `pnpm run sync:env`), lists the systems the documentation names by the cards' own
 * rule, and for each system the kit connects (`src/surfaces/access-kit/`) shows its recipe, takes
 * the mode (per employee or shared, recorded on the connection), asks for what the recipe
 * produces, secrets in a hidden prompt or on stdin (`--secrets-stdin`, `NAME=value` lines) and
 * never on the command line, and lands it as the organisation's connection through the
 * deployment's admin key. Then it runs `pnpm run check:access` and writes the install record for
 * the customer's IT, and exits with the check's status, so `./setup.sh install` composes it.
 *
 * Everything is asked and checked before anything is written: a missing answer stops the verb
 * with nothing changed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ADMINISTRATORS_VAR, parseAdministrators } from '../src/lib/administrators';
import {
  CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR,
  CUSTOMER_OIDC_AUDIENCE_VAR,
  CUSTOMER_OIDC_ISSUER_VAR,
  PUBLIC_URL_VAR,
} from '../src/lib/customer-oidc';
import { redirectUriOf, signedOutUriOf } from '../src/lib/customer-sign-in-settings';
import { errorMessage } from '../src/lib/errors';
import type { OrganisationConnectionMode } from '../src/surfaces/access-identity';
import {
  ACCESS_KIT,
  KNOWN_WITHOUT_ISSUER,
  documentedSystems,
  mcpConnectionSystem,
  recipeForSystem,
  type AccessRecipe,
  type DocumentationPage,
  type RecipeAsk,
  type RecipeField,
  type RecipeMode,
} from '../src/surfaces/access-kit';
import { linearKitManifest, linearManifestUrl } from '../src/surfaces/access-kit/linear';
import { slackKitManifestTemplate } from '../src/surfaces/access-kit/slack';
import { adminTarget, deploymentAdmin, type DeploymentAdmin } from './lib/convex-admin';
import { readEnvValues, writeEnvValues } from './lib/env-file';
import {
  defaultInstallRecordDirectory,
  installRecordMarkdown,
  installRecordName,
  type RecordedConnection,
  type RecordedSignIn,
  type RecordedSkip,
} from './lib/install-record';
import { isLoopback } from './setup-route';

/** The env file the verb reads and writes, beside the setup's own. */
const ENV_FILE = '.env.local';

/** The most documentation pages the scan reads: a handbook, not a drive. */
const DOCUMENTATION_PAGE_LIMIT = 5_000;

/** The verb's flags; anything absent is asked for, or read from stdin. */
export interface AccessFlags {
  /** The administrators' addresses, comma-separated (B8). */
  readonly administrators?: string;
  /** The systems to connect, comma-separated: `slack`, `linear`, or an MCP server's https address. */
  readonly systems?: string;
  /** Each system's mode, as `slack=per-employee,linear=shared`. */
  readonly connectModes?: string;
  /** Read every answer, secrets included, from stdin as `NAME=value` lines. */
  readonly secretsStdin?: boolean;
  /** The directory the install record is written into; `~/day0-install/<project>` by default. */
  readonly record?: string;
  /** Print one system's manifest and stop. */
  readonly printManifest?: string;
}

/** What the verb is told: its flags, the plan-only switch, and answers a composing verb already read. */
export interface AccessOptions {
  readonly access: AccessFlags;
  readonly dryRun: boolean;
  /** Answers read from stdin by `./setup.sh install`, which reads it once for both halves. */
  readonly answers?: ReadonlyMap<string, string>;
}

/** A child process's status and output, as the setup's runner returns it. */
interface StepResult {
  readonly status: number | null;
  readonly stderr: string;
}

/** What the verb needs of the machine: the setup's own `SetupIo` provides it. */
export interface AccessIo {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly interactive?: boolean;
  run(command: string, args: readonly string[], options?: { inherit?: boolean }): StepResult;
  ask(question: string, options?: { hidden?: boolean }): Promise<string>;
  log(line: string): void;
  /** The network seam the deployment's function API is called through; the global one by default. */
  readonly fetch?: typeof fetch;
  /** All of stdin, for `--secrets-stdin`. */
  readStdin?(): Promise<string>;
  /** The clock the install record is dated by. */
  now?(): number;
}

/** The verb could not go on; the message says why and what to do. */
export class AccessRefused extends Error {}

/**
 * The answers on stdin: one `NAME=value` per line, the value taken whole after the first `=`.
 *
 * @param text - Everything stdin held.
 */
export function parseAnswers(text: string): Map<string, string> {
  const answers = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(name) && value !== '') answers.set(name, value);
  }
  return answers;
}

/** Where the verb's answers come from: stdin's lines, else the terminal. */
interface Answerer {
  readonly io: AccessIo;
  readonly answers?: ReadonlyMap<string, string>;
}

/** One question: its stdin name, its words, whether it is hidden, and what stands for an empty answer. */
interface Question {
  readonly name: string;
  readonly text: string;
  readonly hidden: boolean;
  readonly optional: boolean;
  readonly fallback?: string;
}

/** Ask a question, or read its line from stdin; refuse where nobody can answer it. */
async function answer(from: Answerer, question: Question): Promise<string | undefined> {
  if (from.answers !== undefined) {
    const given = from.answers.get(question.name);
    if (given !== undefined) return given;
    if (question.fallback !== undefined) return question.fallback;
    if (question.optional) return undefined;
    throw new AccessRefused(`${question.name} is needed on stdin: ${question.text}.`);
  }
  if (from.io.interactive === false) {
    if (question.fallback !== undefined) return question.fallback;
    if (question.optional) return undefined;
    throw new AccessRefused(
      `${question.name} is needed: nothing can be asked without a terminal. Give it on stdin with --secrets-stdin.`,
    );
  }
  const shown =
    question.fallback !== undefined && !question.hidden ? ` [${question.fallback}]` : '';
  const said = (
    await from.io.ask(`${question.text}${shown}: `, { hidden: question.hidden })
  ).trim();
  if (said !== '') return said;
  if (question.fallback !== undefined) return question.fallback;
  if (question.optional) return undefined;
  throw new AccessRefused(`${question.name} is needed.`);
}

/** The markdown pages of the documentation folder, as the scan reads them. */
export function documentationPages(root: string): DocumentationPage[] {
  if (!existsSync(root)) return [];
  const pages: DocumentationPage[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (pages.length >= DOCUMENTATION_PAGE_LIMIT || entry.startsWith('.')) continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.(md|markdown)$/i.test(entry)) {
        pages.push({ path: relative(root, path), markdown: readFileSync(path, 'utf8') });
      }
    }
  };
  visit(root);
  return pages;
}

/** One system the run connects: its key, its recipe and mode, and the address it was named at. */
interface Planned {
  readonly system: string;
  readonly recipe: AccessRecipe;
  readonly mode: RecipeMode;
  /** An MCP server's address, from the flag or the documentation. */
  readonly address?: string;
}

/** The mode words a person reads. */
function modeWords(mode: OrganisationConnectionMode): string {
  return mode === 'per-employee' ? 'per employee' : 'shared';
}

/** The `--connect-mode` flag as a map of system to mode. */
function parseModes(raw: string | undefined): Map<string, OrganisationConnectionMode> {
  const modes = new Map<string, OrganisationConnectionMode>();
  for (const entry of (raw ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean)) {
    const [system, mode] = entry.split('=').map((part) => part.trim());
    if (mode !== 'per-employee' && mode !== 'shared') {
      throw new AccessRefused(
        `--connect-mode takes system=per-employee or system=shared, not "${entry}".`,
      );
    }
    modes.set(system, mode);
  }
  return modes;
}

/** A system named on the command line or by the documentation, as its key and address. */
interface Named {
  readonly system: string;
  readonly address?: string;
  readonly pages: readonly string[];
}

/** The systems the flag names: a kit system's key, `mcp:<host>`, or an MCP server's https address. */
function namedByFlag(raw: string): Named[] {
  return raw
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean)
    .map((entry) =>
      entry.startsWith('https://')
        ? { system: mcpConnectionSystem(entry), address: entry, pages: [] }
        : { system: entry.toLowerCase(), pages: [] },
    );
}

/** The mode a system is connected in: the flag's, else the recipe's only one, else asked. */
async function chooseMode(
  from: Answerer,
  recipe: AccessRecipe,
  system: string,
  modes: ReadonlyMap<string, OrganisationConnectionMode>,
): Promise<RecipeMode> {
  const named = modes.get(system) ?? modes.get(recipe.system);
  const landable = recipe.modes.filter((mode) => mode.landsAtInstall);
  let chosen: RecipeMode | undefined;
  if (named !== undefined) {
    chosen = recipe.modes.find((mode) => mode.mode === named);
    if (chosen === undefined) {
      throw new AccessRefused(`${recipe.displayName} is not connected ${modeWords(named)}.`);
    }
  } else if (landable.length === 1) {
    chosen = landable[0];
  } else {
    const menu = landable.map(
      (mode, index) => `  ${index + 1}  ${modeWords(mode.mode)}: ${mode.summary}`,
    );
    const said = await answer(from, {
      name: `${recipe.system.toUpperCase()}_MODE`,
      text: `How is ${recipe.displayName} connected?\n${menu.join('\n')}\nNumber`,
      hidden: false,
      optional: false,
      fallback: '1',
    });
    chosen = landable[Number(said) - 1];
    if (chosen === undefined) throw new AccessRefused(`"${said}" is not one of the modes offered.`);
  }
  if (!chosen.landsAtInstall) {
    throw new AccessRefused(
      `${recipe.displayName} ${modeWords(chosen.mode)} is not landed at install: ${chosen.summary} ` +
        `(${recipe.guide}).`,
    );
  }
  return chosen;
}

/** What one system's landing carries, before it is sent. */
type Landing = Readonly<Record<string, unknown>> & { readonly system: string };

/** Read one recipe's answers, as named by its asks. */
async function answersFor(
  from: Answerer,
  planned: Planned,
): Promise<Partial<Record<RecipeField, string>>> {
  const said: Partial<Record<RecipeField, string>> = {};
  for (const ask of planned.mode.asks) {
    const value = await answer(from, questionOf(ask, planned));
    if (value !== undefined) said[ask.field] = value;
  }
  return said;
}

/** One recipe question, with the documented address standing for an MCP server's. */
function questionOf(ask: RecipeAsk, planned: Planned): Question {
  return {
    name: ask.stdinName,
    text: ask.label,
    hidden: ask.secret,
    optional: ask.optional,
    ...(ask.field === 'serverUrl' && planned.address !== undefined
      ? { fallback: planned.address }
      : {}),
  };
}

/** The landing for one system: the registration from the recipe and the answers given. */
function landingOf(
  planned: Planned,
  said: Partial<Record<RecipeField, string>>,
  origin: string,
): Landing {
  const { recipe, mode } = planned;
  const redirectUrl = `${origin}${recipe.redirectPath}`;
  const secrets = {
    ...(said.secret === undefined ? {} : { secret: said.secret }),
    ...(said.refreshToken === undefined ? {} : { refreshToken: said.refreshToken }),
  };
  if (recipe.system === 'mcp') {
    const serverUrl = said.serverUrl ?? planned.address ?? '';
    const system = mcpConnectionSystem(serverUrl);
    const scopes = (said.scopes ?? '').split(/[\s,]+/).filter(Boolean);
    return {
      system,
      displayName: new URL(serverUrl).hostname,
      kind: mode.kind,
      mode: mode.mode,
      scopes,
      clientId: said.clientId,
      clientRegistration: 'pre-registered',
      resource: serverUrl,
      ...(said.issuer === undefined ? {} : { issuer: said.issuer }),
      redirectUrl,
      ...secrets,
    };
  }
  return {
    system: recipe.system,
    displayName: recipe.displayName,
    kind: mode.kind,
    mode: mode.mode,
    scopes: [...mode.scopes],
    ...(mode.clientCredentialsScopes === undefined
      ? {}
      : { clientCredentialsScopes: [...mode.clientCredentialsScopes] }),
    ...(said.clientId === undefined ? {} : { clientId: said.clientId }),
    ...(said.appId === undefined ? {} : { appId: said.appId }),
    redirectUrl,
    ...secrets,
  };
}

/** Day0's public origin as the redirects need it: https, or this machine for a bed. */
function originOf(values: Readonly<Record<string, string>>): string {
  const raw = (values[PUBLIC_URL_VAR] ?? '').trim();
  if (raw === '') {
    throw new AccessRefused(
      `${PUBLIC_URL_VAR} is unset, so no redirect can be registered: \`./setup.sh sign-in\` writes it.`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AccessRefused(`${PUBLIC_URL_VAR} is not a URL.`);
  }
  if (url.protocol !== 'https:' && !isLoopback(url.origin)) {
    throw new AccessRefused(
      `${PUBLIC_URL_VAR} must be https: every vendor refuses a plain-http redirect.`,
    );
  }
  return url.origin;
}

/** Print one system's manifest: the Slack template the issuer builds from, or Linear's app and its link. */
function printManifest(
  system: string,
  values: Readonly<Record<string, string>>,
  io: AccessIo,
): number {
  if (system === 'slack') {
    io.log(slackKitManifestTemplate());
    return 0;
  }
  if (system === 'linear') {
    try {
      const manifest = linearKitManifest({
        appName: 'Day0',
        publicUrl: values[PUBLIC_URL_VAR] ?? '',
        mode: 'shared',
      });
      io.log(JSON.stringify(manifest, null, 2));
      io.log(
        `\nCreate it in Linear from this link (an administrator, signed in):\n${linearManifestUrl(manifest)}`,
      );
      return 0;
    } catch (err) {
      io.log(errorMessage(err));
      return 1;
    }
  }
  io.log(`The kit prints a manifest for slack or linear, not "${system}".`);
  return 1;
}

/** Everything the run resolved before it changes anything. */
interface Resolved {
  readonly administrators: readonly string[];
  /** The systems named, by the flag or the documentation, with the pages that name them. */
  readonly named: readonly Named[];
  readonly planned: readonly Planned[];
  readonly skipped: readonly RecordedSkip[];
}

/** Name the administrators and the systems, and choose each system's mode. */
async function resolvePlan(
  from: Answerer,
  flags: AccessFlags,
  values: Readonly<Record<string, string>>,
): Promise<Resolved> {
  const given =
    flags.administrators ??
    (await answer(from, {
      name: ADMINISTRATORS_VAR,
      text: 'Administrators who manage the organisation’s connections, by the address they sign in with, comma-separated',
      hidden: false,
      optional: false,
      ...(values[ADMINISTRATORS_VAR] ? { fallback: values[ADMINISTRATORS_VAR] } : {}),
    }));
  let administrators: readonly string[];
  try {
    administrators = parseAdministrators(given);
  } catch (err) {
    throw new AccessRefused(errorMessage(err));
  }
  if (administrators.length === 0) throw new AccessRefused('Name at least one administrator.');

  const docsRoot = resolve(from.io.cwd, values.DAY0_DOCS_HOST_DIR?.trim() || './docs-local');
  const named: readonly Named[] =
    flags.systems !== undefined
      ? namedByFlag(flags.systems)
      : documentedSystems(documentationPages(docsRoot));
  const modes = parseModes(flags.connectModes);
  const planned: Planned[] = [];
  const skipped: RecordedSkip[] = [];
  for (const one of named) {
    const recipe = recipeForSystem(one.system);
    if (recipe === undefined) {
      skipped.push({
        system: one.system,
        reason: KNOWN_WITHOUT_ISSUER.includes(one.system)
          ? 'keeps the pasted key until Day0 has an issuer for it'
          : 'the access kit has no recipe for it',
      });
      continue;
    }
    planned.push({
      system: one.system,
      recipe,
      mode: await chooseMode(from, recipe, one.system, modes),
      ...(one.address === undefined || recipe.system !== 'mcp' ? {} : { address: one.address }),
    });
  }
  return { administrators, named, planned, skipped };
}

/** The systems found, as the verb lists them before it asks. */
function listLines(resolved: Resolved): string[] {
  const where = (system: string): string => {
    const pages = resolved.named.find((one) => one.system === system)?.pages ?? [];
    return pages.length > 0 ? ` (${pages.join(', ')})` : '';
  };
  return [
    ...resolved.planned.map(
      (one) =>
        `  ${one.recipe.system === 'mcp' ? one.system : one.recipe.displayName}${where(one.system)}: ` +
        `connect ${modeWords(one.mode.mode)}. ${one.mode.summary} Recipe: ${one.recipe.guide}`,
    ),
    ...resolved.skipped.map((one) => `  ${one.system}${where(one.system)}: ${one.reason}.`),
  ];
}

/** Which planned systems the deployment already holds a connection for. */
async function alreadyConnected(
  admin: DeploymentAdmin,
  planned: readonly Planned[],
): Promise<Set<string>> {
  const occupied = new Set<string>();
  for (const one of planned) {
    const row = await admin.run<unknown>('query', 'organisationConnections:occupyingFor', {
      system: one.system,
    });
    if (row !== null) occupied.add(one.system);
  }
  return occupied;
}

/** The sign-in half of the install record, when the company sign-in is configured. */
function recordedSignIn(
  values: Readonly<Record<string, string>>,
  origin: string,
): RecordedSignIn | undefined {
  const issuer = values[CUSTOMER_OIDC_ISSUER_VAR]?.trim();
  if (!issuer) return undefined;
  return {
    issuer,
    clientId: values[CUSTOMER_OIDC_AUDIENCE_VAR]?.trim() ?? '',
    allowedDomains: values[CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR]?.trim() ?? '',
    redirectUri: redirectUriOf(origin),
    signedOutUri: signedOutUriOf(origin),
  };
}

/** A landed (or kept) connection as the record names it. */
function recordedConnection(
  landing: Landing,
  planned: Planned,
  outcome: RecordedConnection['outcome'],
): RecordedConnection {
  const text = (name: string): string | undefined =>
    typeof landing[name] === 'string' ? (landing[name] as string) : undefined;
  return {
    displayName: text('displayName') ?? planned.recipe.displayName,
    system: landing.system,
    mode: modeWords(planned.mode.mode),
    kind: planned.mode.kind,
    scopes: Array.isArray(landing.scopes) ? (landing.scopes as string[]) : [...planned.mode.scopes],
    ...(planned.mode.clientCredentialsScopes === undefined
      ? {}
      : { clientCredentialsScopes: planned.mode.clientCredentialsScopes }),
    ...(text('clientId') === undefined ? {} : { clientId: text('clientId') }),
    ...(text('redirectUrl') === undefined ? {} : { redirectUrl: text('redirectUrl') }),
    ...(text('issuer') === undefined ? {} : { issuer: text('issuer') }),
    secretLifetime: planned.mode.secretLifetime.words,
    outcome,
    guide: planned.recipe.guide,
  };
}

/** The step that checks what was landed, whose status the verb exits with. */
const CHECK_ACCESS = ['pnpm', 'run', 'check:access'] as const;

/**
 * Run the access verb.
 *
 * @param options - The flags, the plan-only switch and any answers already read.
 * @param io - The machine, as the setup reaches it.
 * @returns The check's exit status; 1 when the verb itself refused or a step failed.
 */
export async function runAccess(options: AccessOptions, io: AccessIo): Promise<number> {
  const envPath = join(io.cwd, ENV_FILE);
  const values = readEnvValues(envPath);
  if (options.access.printManifest !== undefined) {
    return printManifest(options.access.printManifest, values, io);
  }
  if (!existsSync(envPath)) {
    io.log(
      `There is no ${ENV_FILE} here, so there is no installation to connect systems to. ` +
        'Set Day0 up first: `./setup.sh --route <featherless|key|endpoint|local>`.',
    );
    return 1;
  }
  const target = adminTarget(values);
  if ('gap' in target) {
    io.log(target.gap);
    return 1;
  }
  const admin = deploymentAdmin({
    ...target,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  });

  let from: Answerer;
  let resolved: Resolved;
  let origin: string;
  try {
    origin = originOf(values);
    const answers =
      options.answers ??
      (options.access.secretsStdin === true
        ? parseAnswers((await io.readStdin?.()) ?? '')
        : undefined);
    from = { io, ...(answers === undefined ? {} : { answers }) };
    resolved = await resolvePlan(from, options.access, values);
  } catch (err) {
    io.log(`Nothing was written: ${errorMessage(err)}`);
    return 1;
  }

  io.log(
    resolved.named.length === 0
      ? 'The documentation names no system the kit knows; name them with --systems.'
      : options.access.systems === undefined
        ? 'Systems the documentation names:'
        : 'Systems to connect:',
  );
  for (const line of listLines(resolved)) io.log(line);

  let occupied: Set<string>;
  try {
    occupied = await alreadyConnected(admin, resolved.planned);
  } catch (err) {
    io.log(`Nothing was written: ${errorMessage(err)}`);
    return 1;
  }

  if (options.dryRun) {
    io.log(
      `Dry run. ${ENV_FILE} would get ${ADMINISTRATORS_VAR}=${resolved.administrators.join(',')}.`,
    );
    io.log('Then, in order:');
    io.log('  pnpm run sync:env    (push the administrators to the deployment)');
    for (const one of resolved.planned) {
      io.log(
        occupied.has(one.system)
          ? `  ${one.system}: already connected, left as it is`
          : `  land ${one.system} ${modeWords(one.mode.mode)} through the deployment's admin key`,
      );
    }
    io.log(`  ${CHECK_ACCESS.join(' ')}    (check every connection)`);
    io.log('Nothing was written and nothing was landed.');
    return 0;
  }

  const landings: Array<{ readonly landing: Landing; readonly planned: Planned }> = [];
  try {
    for (const one of resolved.planned) {
      if (occupied.has(one.system)) continue;
      io.log(
        `\n${one.recipe.system === 'mcp' ? 'An MCP server' : one.recipe.displayName}: ${one.mode.summary}`,
      );
      io.log(`  The recipe: ${one.recipe.guide}. ${one.mode.secretLifetime.words}`);
      landings.push({ landing: landingOf(one, await answersFor(from, one), origin), planned: one });
    }
  } catch (err) {
    io.log(`Nothing was written: ${errorMessage(err)}`);
    return 1;
  }

  writeEnvValues(envPath, { [ADMINISTRATORS_VAR]: resolved.administrators.join(',') });
  io.log(`\nWrote ${ADMINISTRATORS_VAR}=${resolved.administrators.join(',')} to ${ENV_FILE}.`);
  io.log('\npnpm run sync:env    (push the administrators to the deployment)');
  const synced = io.run('pnpm', ['run', 'sync:env'], { inherit: true });
  if (synced.status !== 0) {
    io.log(`That step failed, so the verb stops here: ${synced.stderr.trim() || 'no message'}`);
    return synced.status ?? 1;
  }

  const recorded: RecordedConnection[] = resolved.planned
    .filter((one) => occupied.has(one.system))
    .map((one) => {
      io.log(
        `${one.recipe.system === 'mcp' ? one.system : one.recipe.displayName} is already connected ` +
          'for the organisation: left as it is. ' +
          'An administrator rotates or revokes it on the organisation page.',
      );
      return recordedConnection({ system: one.system }, one, 'already connected');
    });
  for (const { landing, planned } of landings) {
    try {
      await admin.run<string>('action', 'organisationConnections:landFromSetup', landing);
    } catch (err) {
      io.log(`Landing ${landing.system} failed, so the verb stops here: ${errorMessage(err)}`);
      writeRecord(io, options, values, origin, resolved, recorded, undefined);
      return 1;
    }
    io.log(`Landed ${landing.system}, ${modeWords(planned.mode.mode)}.`);
    recorded.push(recordedConnection(landing, planned, 'landed'));
  }

  io.log(`\n${CHECK_ACCESS.join(' ')}    (check every connection)`);
  const [command, ...args] = CHECK_ACCESS;
  const checked = io.run(command, args, { inherit: true });
  const status = checked.status ?? 1;
  writeRecord(io, options, values, origin, resolved, recorded, status);
  return status;
}

/** Write the install record and say where. */
function writeRecord(
  io: AccessIo,
  options: AccessOptions,
  values: Readonly<Record<string, string>>,
  origin: string,
  resolved: Resolved,
  connections: readonly RecordedConnection[],
  checkStatus: number | undefined,
): void {
  const project = values.COMPOSE_PROJECT_NAME?.trim() || 'day0';
  const home = io.environment.HOME ?? '';
  const directory =
    options.access.record !== undefined
      ? resolve(io.cwd, options.access.record)
      : defaultInstallRecordDirectory(home, project);
  const at = new Date(io.now?.() ?? Date.now());
  const signIn = recordedSignIn(values, origin);
  const markdown = installRecordMarkdown({
    project,
    recordedAt: at,
    publicUrl: origin,
    administrators: resolved.administrators,
    ...(signIn === undefined ? {} : { signIn }),
    connections,
    skipped: resolved.skipped,
    ...(checkStatus === undefined
      ? {}
      : { check: { command: CHECK_ACCESS.join(' '), status: checkStatus } }),
  });
  try {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, installRecordName(at));
    writeFileSync(path, markdown, { encoding: 'utf8', mode: 0o600 });
    io.log(`\nThe install record for the customer's IT: ${path}`);
  } catch (err) {
    io.log(`The install record could not be written to ${directory}: ${errorMessage(err)}`);
  }
}

/** The systems the kit connects, for the help text. */
export const ACCESS_KIT_SYSTEM_NAMES: readonly string[] = Object.keys(ACCESS_KIT);
