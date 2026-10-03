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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
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
import { discoverAuthorisation, type OauthFetch } from '../src/surfaces/mcp-oauth';
import { adminTarget, deploymentAdmin, type DeploymentAdmin } from './lib/convex-admin';
import { readEnvValues, writeEnvValues } from './lib/env-file';
import {
  defaultInstallRecordDirectory,
  installRecordMarkdown,
  installRecordName,
  installRecordRunMarkdown,
  type InstallRecord,
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
  /**
   * With `printManifest` for Linear, the employee whose own app's form to print (per-employee mode):
   * its name, `<employee> (Day0)`, and no client credentials (R41V-R5).
   */
  readonly employee?: string;
  /**
   * Correct the redirect and the scopes one system's connection records to what Day0 returns to
   * and the kit's list, and stop (the wave 11 review's M12 e): a kit system's key or an MCP
   * server's https address.
   */
  readonly correct?: string;
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
  /** The network seam an MCP server's metadata is read through at install; the global one by default. */
  readonly vendorFetch?: OauthFetch;
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
  /**
   * Where several MCP servers are connected in one run, the host part of this one's stdin names
   * (`MCP_<HOST>_CLIENT_ID`), so one server's answers never stand for another's.
   */
  readonly stdinHost?: string;
}

/** An MCP server's host as its stdin names carry it: `mcp:mcp.acme.com` is `MCP_ACME_COM`. */
function stdinHostOf(system: string): string {
  return system
    .replace(/^mcp:/, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
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
    name:
      planned.stdinHost === undefined
        ? ask.stdinName
        : ask.stdinName.replace(/^MCP_/, `MCP_${planned.stdinHost}_`),
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
      `${PUBLIC_URL_VAR} must be https: Day0 has every vendor send its codes and tokens back to an https address only.`,
    );
  }
  return url.origin;
}

/** Print one system's manifest: the Slack template the issuer builds from, or Linear's app and its link. */
function printManifest(
  system: string,
  employee: string | undefined,
  values: Readonly<Record<string, string>>,
  io: AccessIo,
): number {
  if (system === 'slack') {
    if (employee !== undefined) {
      io.log(
        "Day0 creates each employee's Slack app itself through the organisation's connection; " +
          '--print-manifest slack alone prints the template it fills in.',
      );
      return 1;
    }
    io.log(slackKitManifestTemplate());
    return 0;
  }
  if (system === 'linear') {
    if (employee !== undefined && employee.trim() === '') {
      io.log("--employee needs the employee's name, as the card shows it.");
      return 1;
    }
    try {
      const manifest = linearKitManifest(
        employee === undefined
          ? { appName: 'Day0', publicUrl: values[PUBLIC_URL_VAR] ?? '', mode: 'shared' }
          : {
              appName: `${employee.trim()} (Day0)`,
              publicUrl: values[PUBLIC_URL_VAR] ?? '',
              mode: 'per-employee',
            },
      );
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

/** What a connection records that a correction compares, as `occupyingFor` answers it. */
interface RecordedRegistration {
  readonly displayName?: string;
  readonly mode?: OrganisationConnectionMode;
  readonly redirectUrl?: string;
  readonly scopes?: readonly string[];
  readonly clientCredentialsScopes?: readonly string[];
}

/**
 * Correct what one system's connection records of IT's registration (the wave 11 review's M12 e):
 * the redirect Day0 returns to now (`${DAY0_PUBLIC_URL}` and the recipe's path), and the kit's
 * scopes for the connection's mode where the kit names any. `check:access` compares exactly these,
 * so a redirect IT registered again at the vendor, or scopes it granted there, pass once recorded.
 * No secret changes and no card ends.
 *
 * @param raw - The system: `slack`, `linear`, `mcp:<host>` or an MCP server's https address.
 * @param values - The installation's env file.
 * @param io - The setup's io.
 * @returns The exit status.
 */
async function correctConnection(
  raw: string,
  values: Readonly<Record<string, string>>,
  io: AccessIo,
): Promise<number> {
  const target = adminTarget(values);
  if ('gap' in target) {
    io.log(target.gap);
    return 1;
  }
  const admin = deploymentAdmin({
    ...target,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  });
  try {
    const listed = namedByFlag(raw);
    if (listed.length > 1) {
      throw new AccessRefused('The kit corrects one system at a time: name one.');
    }
    const [named] = listed;
    const recipe = named === undefined ? undefined : recipeForSystem(named.system);
    if (named === undefined || recipe === undefined) {
      throw new AccessRefused(`The kit corrects slack, linear or an MCP server, not "${raw}".`);
    }
    const name = recipe.system === 'mcp' ? named.system : recipe.displayName;
    const row = await admin.run<RecordedRegistration | null>(
      'query',
      'organisationConnections:occupyingFor',
      { system: named.system },
    );
    if (row === null) {
      throw new AccessRefused(
        `${name} is not connected for the organisation: land it with ./setup.sh access first.`,
      );
    }
    const redirectUrl = `${originOf(values)}${recipe.redirectPath}`;
    const mode = recipe.modes.find((candidate) => candidate.mode === row.mode);
    const scopes = mode !== undefined && mode.scopes.length > 0 ? [...mode.scopes] : undefined;
    await admin.run('mutation', 'organisationCorrections:correctFromSetup', {
      system: named.system,
      redirectUrl,
      ...(scopes !== undefined ? { scopes } : {}),
    });
    const was = row.redirectUrl === undefined ? 'none was recorded' : `it was ${row.redirectUrl}`;
    io.log(`${name}: the recorded redirect is now ${redirectUrl} (${was}).`);
    if (scopes !== undefined) {
      io.log(`${name}: the recorded scopes are now ${scopes.join(', ')}.`);
    }
    const lacking = (mode?.clientCredentialsScopes ?? []).filter(
      (scope) => !(row.clientCredentialsScopes ?? []).includes(scope),
    );
    if (lacking.length === 0) {
      io.log('No secret changed and no card ended. Run pnpm check:access to see it pass.');
      return 0;
    }
    // A fixed client-credentials set is not IT's registration: a token requested with another set
    // revokes every token of the app (L2), so no correction reaches it (the round review's m6).
    io.log(
      `${name}: the shared app token's set was landed as ` +
        `${row.clientCredentialsScopes?.join(', ') || 'no scope'}, without ${lacking.join(', ')}, ` +
        `and a correction cannot change it, since ${name} revokes every token of the app when one ` +
        'is requested with another set: revoke the connection on the organisation page, then ' +
        'land it again with ./setup.sh access. pnpm check:access reports the gap until then.',
    );
    io.log('No secret changed and no card ended.');
    return 0;
  } catch (err) {
    io.log(`Nothing was corrected: ${errorMessage(err)}`);
    return 1;
  }
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
    const mode = await chooseMode(from, recipe, one.system, modes);
    if (!mode.landsAtInstall) {
      // The mode is the customer's choice and is recorded; there is nothing to land for it yet.
      skipped.push({
        system: one.system,
        reason: `${modeWords(mode.mode)}, not landed at install: ${mode.summary.replace(/\.$/, '')} (${recipe.guide})`,
      });
      continue;
    }
    planned.push({
      system: one.system,
      recipe,
      mode,
      ...(one.address === undefined || recipe.system !== 'mcp' ? {} : { address: one.address }),
    });
  }
  const servers = planned.filter((one) => one.recipe.system === 'mcp').length;
  return {
    administrators,
    named,
    planned:
      servers > 1
        ? planned.map((one) =>
            one.recipe.system === 'mcp' ? { ...one, stdinHost: stdinHostOf(one.system) } : one,
          )
        : planned,
    skipped,
  };
}

/** A skipped system as the list names it: a kit system by its display name, any other by its key. */
function skippedName(system: string): string {
  return recipeForSystem(system)?.displayName ?? system;
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
    ...resolved.skipped.map(
      (one) => `  ${skippedName(one.system)}${where(one.system)}: ${one.reason}.`,
    ),
  ];
}

/** Which planned systems the deployment already holds a connection for. */
async function alreadyConnected(
  admin: DeploymentAdmin,
  planned: readonly Planned[],
): Promise<Map<string, Landing>> {
  const occupied = new Map<string, Landing>();
  for (const one of planned) {
    const row = await admin.run<unknown>('query', 'organisationConnections:occupyingFor', {
      system: one.system,
    });
    if (typeof row === 'object' && row !== null) {
      occupied.set(one.system, {
        ...(row as Readonly<Record<string, unknown>>),
        system: one.system,
      });
    }
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

/**
 * An MCP landing with the issuer of its authorisation server: IT's, or, for a public client IT left
 * it blank for, the one the server's own resource metadata names, read now with IT beside the verb
 * and said, so the connection records IT's choice and never a manager's first authorisation (the
 * wave 11 review's m4). A confidential client's issuer is never read from the server. Any other
 * landing is returned as it is.
 *
 * @throws Error naming the server when a confidential client has no issuer, or when the metadata
 *   names no authorisation server Day0 can read.
 */
async function withIssuer(landing: Landing, io: AccessIo): Promise<Landing> {
  const given = typeof landing.issuer === 'string' ? landing.issuer.trim() : '';
  if (!landing.system.startsWith('mcp:') || given !== '') return landing;
  const server = String(landing.resource);
  // A client secret goes to the server IT registered the client with, never to whichever one
  // the resource names (M12 f): only a public client's issuer is read from the server.
  if (landing.secret !== undefined) {
    throw new Error(
      `${server} has a client secret and no issuer: give the issuer of the authorisation server ` +
        "IT registered the client with (the prompt's issuer, or MCP_ISSUER on stdin); Day0 sends " +
        'the secret to that server alone.',
    );
  }
  let issuer: string;
  try {
    const target = await discoverAuthorisation(io.vendorFetch ?? fetch, new URL(server));
    issuer = target.server.issuer;
  } catch (err) {
    throw new Error(
      `${server} names no authorisation server Day0 could read (${errorMessage(err)}). ` +
        "Give its issuer: the prompt's issuer, or MCP_ISSUER on stdin.",
    );
  }
  io.log(
    `  The server names ${issuer} as its authorisation server; the connection records it as the issuer.`,
  );
  return { ...landing, issuer };
}

/** A landed (or kept) connection as the record names it. */
function recordedConnection(
  landing: Landing,
  planned: Planned,
  outcome: RecordedConnection['outcome'],
): RecordedConnection {
  const text = (name: string): string | undefined =>
    typeof landing[name] === 'string' ? (landing[name] as string) : undefined;
  const list = (name: string): readonly string[] | undefined => {
    const value = landing[name];
    return Array.isArray(value) && value.every((one) => typeof one === 'string')
      ? value
      : undefined;
  };
  const stored = landing.mode;
  const mode: OrganisationConnectionMode =
    stored === 'shared' || stored === 'per-employee' ? stored : planned.mode.mode;
  const clientCredentialsScopes =
    list('clientCredentialsScopes') ?? planned.mode.clientCredentialsScopes;
  return {
    displayName: text('displayName') ?? planned.recipe.displayName,
    system: landing.system,
    mode: modeWords(mode),
    kind: text('kind') ?? planned.mode.kind,
    scopes: list('scopes') ?? [...planned.mode.scopes],
    ...(clientCredentialsScopes === undefined ? {} : { clientCredentialsScopes }),
    ...(text('clientId') === undefined ? {} : { clientId: text('clientId') }),
    ...(text('redirectUrl') === undefined ? {} : { redirectUrl: text('redirectUrl') }),
    ...(text('issuer') === undefined ? {} : { issuer: text('issuer') }),
    secretLifetime: planned.mode.secretLifetime.words,
    outcome,
    guide: planned.recipe.guide,
  };
}

/** The secret values a landing carries, which no refusal may repeat. */
function secretsOf(landing: Landing): string[] {
  return ['secret', 'refreshToken']
    .map((name: string): unknown => landing[name])
    .filter((value: unknown): value is string => typeof value === 'string');
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
  if (options.access.employee !== undefined && options.access.printManifest === undefined) {
    io.log('--employee names whose own app --print-manifest linear prints; it takes nothing else.');
    return 1;
  }
  if (options.access.printManifest !== undefined) {
    return printManifest(options.access.printManifest, options.access.employee, values, io);
  }
  if (options.access.correct !== undefined) {
    return await correctConnection(options.access.correct, values, io);
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

  let occupied: Map<string, Landing>;
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
      const landing = landingOf(one, await answersFor(from, one), origin);
      landings.push({ landing: await withIssuer(landing, io), planned: one });
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
      return recordedConnection(
        occupied.get(one.system) ?? { system: one.system },
        one,
        'already connected',
      );
    });
  for (const { landing, planned } of landings) {
    try {
      await admin.run<string>('action', 'organisationConnections:landFromSetup', landing, {
        secrets: secretsOf(landing),
      });
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
  const home = (io.environment.HOME ?? '').trim();
  if (options.access.record === undefined && !isAbsolute(home)) {
    io.log(
      '\nHOME is unset, so the install record has no default place and was not written: run ' +
        'again with --record <dir> to keep it.',
    );
    return;
  }
  const directory =
    options.access.record !== undefined
      ? resolve(io.cwd, options.access.record)
      : defaultInstallRecordDirectory(home, project);
  const at = new Date(io.now?.() ?? Date.now());
  const signIn = recordedSignIn(values, origin);
  const record: InstallRecord = {
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
  };
  try {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, installRecordName(at));
    // A later run the same day is added to the day's record, never in place of it (R41V-12).
    if (existsSync(path)) {
      appendFileSync(path, `\n${installRecordRunMarkdown(record)}`, { encoding: 'utf8' });
    } else {
      writeFileSync(path, installRecordMarkdown(record), { encoding: 'utf8', mode: 0o600 });
    }
    io.log(`\nThe install record for the customer's IT: ${path}`);
  } catch (err) {
    io.log(`The install record could not be written to ${directory}: ${errorMessage(err)}`);
  }
}
