/// <reference types="node" />
/**
 * The local keys no-auth dev mode and real mode run on.
 *
 *   pnpm dev:no-auth-key                  generate what is missing
 *   pnpm dev:no-auth-key --rotate-unlock  rotate the unlock secret alone
 *   pnpm dev:no-auth-key --force          regenerate every value, the credential key included
 *   tsx scripts/dev-no-auth-key.ts url           print the unlock URL, which `pnpm dev` does
 *   tsx scripts/dev-no-auth-key.ts surface-keys  the two real-mode values only, for a profile
 *                                                that signs in some other way
 *
 * No-auth mode serves every request as one fixed user who owns every row, so the
 * only thing standing between that user and anyone who can reach the ports is
 * the no-auth key. It is three values, written to `.env.local`:
 *
 *   DEV_NO_AUTH_SECRET       unlocks the app. Travels once on the URL printed
 *                            below; the browser then keeps a session bound to it,
 *                            never the secret itself.
 *   DEV_NO_AUTH_SIGNING_KEY  signs the token Convex accepts. Never leaves this
 *                            machine.
 *   DEV_NO_AUTH_JWKS         the public half of that key, pushed to the Convex
 *                            deployment by ./scripts/sync-convex-env.sh so it
 *                            can verify the signature without being able to
 *                            produce one.
 *
 * Real mode needs two more, whichever way callers sign in:
 *
 *   DAY0_CREDENTIAL_KEY          encrypts every stored credential.
 *   DAY0_NOTION_MCP_AUTH_TOKEN   authenticates the private hop to the Notion component.
 *
 * Both live on the deployment as well, and the deployment's copy is the one its
 * stored credentials were sealed under. So a missing value is adopted from the
 * deployment before a new one is minted, and a deployment this file points at
 * but that cannot be read stops the script rather than risking a new key over
 * a live one.
 *
 * Rotating the unlock secret signs every browser out and needs no re-sync.
 * `--force` regenerates everything, which also makes every credential the
 * deployment stores unreadable once synced; it says so when it runs.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writePrivateEnv } from './private-env';
import { DEV_NO_AUTH_KEY_ID } from '../convex/devAuth';
import type { DEV_NO_AUTH_UNLOCK_PARAM as UnlockParam } from '../src/lib/dev-auth-server';

// This runs under bare `tsx`, outside Next's bundler, so it cannot *import*
// `src/lib/dev-auth-server.ts`: that module pulls in `@clerk/nextjs/server`,
// which resolves to a build Node's ESM loader refuses (`does not provide an
// export named 'auth'`). `pnpm dev` runs this script first, so an ordinary
// import here takes down every mode, Clerk's included. The value is restated
// instead, and the type-only import above makes `pnpm typecheck` fail if the
// two ever drift apart.
const UNLOCK_PARAM: typeof UnlockParam = 'day0_key';

const ENV_FILE = '.env.local';
const SECRET_VAR = 'DEV_NO_AUTH_SECRET';
const SIGNING_KEY_VAR = 'DEV_NO_AUTH_SIGNING_KEY';
const JWKS_VAR = 'DEV_NO_AUTH_JWKS';
const FLAG_VAR = 'NEXT_PUBLIC_DEV_NO_AUTH';
const CREDENTIAL_KEY_VAR = 'DAY0_CREDENTIAL_KEY';
const NOTION_MCP_AUTH_TOKEN_VAR = 'DAY0_NOTION_MCP_AUTH_TOKEN';
const APP_PORT_VAR = 'DAY0_APP_PORT';
const APP_HOST_VAR = 'DAY0_APP_HOST';
const CONVEX_DEPLOYMENT_VAR = 'CONVEX_DEPLOYMENT';
const SELF_HOSTED_URL_VAR = 'CONVEX_SELF_HOSTED_URL';
const SELF_HOSTED_ADMIN_KEY_VAR = 'CONVEX_SELF_HOSTED_ADMIN_KEY';
const DEPLOYMENT_READ_TIMEOUT_MS = 60_000;

/** The real-mode values the deployment holds a copy of, and how each is minted. */
const SURFACE_KEYS = [
  { name: CREDENTIAL_KEY_VAR, mint: (): string => randomBytes(32).toString('base64') },
  { name: NOTION_MCP_AUTH_TOKEN_VAR, mint: (): string => randomBytes(32).toString('base64url') },
] as const;

/** What the Convex deployment this file points at holds, as far as it could be read. */
type DeploymentEnv =
  | { kind: 'none' }
  | { kind: 'unreadable'; detail: string }
  | { kind: 'read'; values: Readonly<Record<string, string>> };

/** Run key initialisation, print the local unlock URL, or write the real-mode keys alone. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.find((arg: string): boolean => !arg.startsWith('--')) ?? 'init';

  if (mode === 'url') {
    ensureRealSurfaceKeys(false);
    return printUnlockUrl();
  }
  if (mode === 'surface-keys') {
    ensureRealSurfaceKeys(args.includes('--force'));
    return;
  }
  if (mode === 'init') {
    if (args.includes('--rotate-unlock')) return rotateUnlockSecret();
    return init(args.includes('--force'));
  }

  fail(`unknown mode "${mode}" - expected "init", "url" or "surface-keys"`);
}

/** Everything `.env.local` declares, with the real environment taking precedence. */
function readEnvFile(): Record<string, string> {
  const values: Record<string, string> = {};
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (match) values[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
    }
  }
  for (const key of [
    FLAG_VAR,
    SECRET_VAR,
    SIGNING_KEY_VAR,
    JWKS_VAR,
    CREDENTIAL_KEY_VAR,
    NOTION_MCP_AUTH_TOKEN_VAR,
    APP_PORT_VAR,
    APP_HOST_VAR,
    CONVEX_DEPLOYMENT_VAR,
    SELF_HOSTED_URL_VAR,
    SELF_HOSTED_ADMIN_KEY_VAR,
  ]) {
    const fromEnvironment = process.env[key];
    if (fromEnvironment) values[key] = fromEnvironment;
  }
  return values;
}

/**
 * Persist generated values without disturbing unrelated local settings.
 *
 * Args:
 *   updates: Environment names and values to replace or append.
 */
function upsertEnvFile(updates: Record<string, string>): void {
  if (!existsSync(ENV_FILE)) {
    fail(`${ENV_FILE} not found. Copy .env.example to ${ENV_FILE} first.`);
  }
  const lines = readFileSync(ENV_FILE, 'utf8').split('\n');
  for (const [key, value] of Object.entries(updates)) {
    const index = lines.findIndex((line: string): boolean =>
      new RegExp(`^\\s*${key}\\s*=`).test(line),
    );
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writePrivateEnv(ENV_FILE, lines.join('\n'));
}

/**
 * Read the env of the deployment `.env.local` points at, through the Convex CLI.
 *
 * A file with neither a self-hosted URL and admin key nor a cloud deployment
 * points at nothing yet, which is the first run: there is nothing to adopt.
 *
 * Args:
 *   values: The env file with the process environment layered on.
 */
function readDeploymentEnv(values: Readonly<Record<string, string>>): DeploymentEnv {
  const selfHosted = !!values[SELF_HOSTED_URL_VAR] && !!values[SELF_HOSTED_ADMIN_KEY_VAR];
  if (!selfHosted && !values[CONVEX_DEPLOYMENT_VAR]) return { kind: 'none' };
  const result = spawnSync('npx', ['convex', 'env', 'list'], {
    encoding: 'utf8',
    timeout: DEPLOYMENT_READ_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.error ? result.error.message : ''}`.trim();
    return { kind: 'unreadable', detail: detail.split('\n').slice(-3).join(' ') };
  }
  const read: Record<string, string> = {};
  for (const line of (result.stdout ?? '').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) read[match[1]] = match[2];
  }
  return { kind: 'read', values: read };
}

/**
 * Decide the real-mode values to write: the deployment's copy where it has one,
 * a new value where it has none, nothing where the file already has one.
 *
 * Args:
 *   existing: The env file with the process environment layered on.
 *   force: Regenerate every value, adopting nothing.
 *
 * Returns:
 *   The values to write and which of them were adopted rather than minted.
 */
function surfaceKeyUpdates(
  existing: Readonly<Record<string, string>>,
  force: boolean,
): { updates: Record<string, string>; adopted: string[] } {
  const missing = SURFACE_KEYS.filter((key): boolean => force || !existing[key.name]);
  if (missing.length === 0) return { updates: {}, adopted: [] };
  if (force) {
    return {
      updates: Object.fromEntries(missing.map((key): [string, string] => [key.name, key.mint()])),
      adopted: [],
    };
  }

  const deployment = readDeploymentEnv(existing);
  if (deployment.kind === 'unreadable') {
    fail(
      `${ENV_FILE} has no ${missing.map((key) => key.name).join(' or ')}, and this script could not read the ` +
        'deployment it points at to adopt its copy. A new credential key over a deployment that already ' +
        'holds one leaves every stored credential unreadable, so none is minted. Start the backend ' +
        '(`pnpm convex:up`) or check the Convex values in .env.local, then re-run. To start over with new ' +
        `keys on purpose, pass --force.${deployment.detail ? `\n  (${deployment.detail})` : ''}`,
    );
  }
  const held = deployment.kind === 'read' ? deployment.values : {};
  const updates: Record<string, string> = {};
  const adopted: string[] = [];
  for (const key of missing) {
    const fromDeployment = held[key.name] ?? '';
    if (fromDeployment !== '') adopted.push(key.name);
    updates[key.name] = fromDeployment !== '' ? fromDeployment : key.mint();
  }
  return { updates, adopted };
}

/** Report what a write adopted and what it generated, naming values only. */
function reportWrite(updates: Readonly<Record<string, string>>, adopted: readonly string[]): void {
  if (adopted.length > 0) {
    console.log(
      `Adopted ${adopted.join(', ')} from the deployment into ${ENV_FILE}: what it stores stays readable.`,
    );
  }
  const minted = Object.keys(updates).filter((key: string): boolean => !adopted.includes(key));
  if (minted.length > 0) console.log(`Wrote ${minted.join(', ')} to ${ENV_FILE}.`);
}

/**
 * Ensure the no-auth signing material and the real-mode keys exist.
 *
 * Args:
 *   force: Regenerate every value when true, the credential key included.
 */
async function init(force: boolean): Promise<void> {
  const existing = readEnvFile();
  const authComplete =
    !!existing[SECRET_VAR] && !!existing[SIGNING_KEY_VAR] && !!existing[JWKS_VAR];
  const { updates: surfaceUpdates, adopted } = surfaceKeyUpdates(existing, force);
  if (authComplete && Object.keys(surfaceUpdates).length === 0 && !force) {
    console.log(
      `${ENV_FILE} already carries a no-auth key. Pass --rotate-unlock to sign every browser ` +
        'out, or --force to regenerate every value, the credential key included.\n',
    );
    return printUnlockUrl();
  }

  const updates: Record<string, string> = {};
  if (!authComplete || force) Object.assign(updates, await noAuthKey());
  Object.assign(updates, surfaceUpdates);
  upsertEnvFile(updates);

  reportWrite(updates, adopted);
  if (force && existing[CREDENTIAL_KEY_VAR]) {
    console.log(
      `--force regenerated ${CREDENTIAL_KEY_VAR}. Once synced, every credential the deployment ` +
        'stores can no longer be decrypted and must be entered again.',
    );
  }
  console.log('Next: ./scripts/sync-convex-env.sh, then push your functions.\n');
  printUnlockUrl();
}

/** A fresh unlock secret and ES256 signing pair, as the three no-auth values. */
async function noAuthKey(): Promise<Record<string, string>> {
  const { privateKey, publicKey } = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  const jwks = {
    keys: [
      {
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x,
        y: jwk.y,
        alg: 'ES256',
        use: 'sig',
        kid: DEV_NO_AUTH_KEY_ID,
      },
    ],
  };
  return {
    [SECRET_VAR]: randomBytes(32).toString('base64url'),
    [SIGNING_KEY_VAR]: Buffer.from(pkcs8).toString('base64'),
    [JWKS_VAR]: `data:text/plain;charset=utf-8;base64,${Buffer.from(JSON.stringify(jwks)).toString('base64')}`,
  };
}

/**
 * Replace the unlock secret and nothing else.
 *
 * Every browser session is bound to the secret, so each one stops being
 * accepted the moment the server reads the new value. The signing key, the
 * credential key and the Notion token are untouched, so nothing needs pushing.
 */
function rotateUnlockSecret(): void {
  upsertEnvFile({ [SECRET_VAR]: randomBytes(32).toString('base64url') });
  console.log(
    `Rotated ${SECRET_VAR}: every unlocked browser is signed out. The signing key, ` +
      `${CREDENTIAL_KEY_VAR} and ${NOTION_MCP_AUTH_TOKEN_VAR} are unchanged, so no sync is needed. ` +
      'Restart `pnpm dev` if it is running, then open the new URL.\n',
  );
  printUnlockUrl();
}

/**
 * Ensure the real-mode secrets exist once, adopting the deployment's copies.
 *
 * Without `.env.local` there is nothing to write into and nothing that would
 * read the key, so `pnpm dev` starts as it always did rather than failing.
 *
 * Args:
 *   force: Regenerate both values when true.
 */
function ensureRealSurfaceKeys(force: boolean): void {
  if (!existsSync(ENV_FILE)) return;
  const { updates, adopted } = surfaceKeyUpdates(readEnvFile(), force);
  if (Object.keys(updates).length === 0) return;
  upsertEnvFile(updates);
  reportWrite(updates, adopted);
}

/** Print the no-auth unlock URL when that local mode is enabled. */
function printUnlockUrl(): void {
  const values = readEnvFile();
  if (values[FLAG_VAR] !== 'true') return;

  const missing = [SECRET_VAR, SIGNING_KEY_VAR, JWKS_VAR].filter(
    (key: string): boolean => !values[key],
  );
  if (missing.length > 0) {
    fail(
      `${FLAG_VAR}=true serves every request as one fixed user, and ${ENV_FILE} is ` +
        `missing ${missing.join(', ')}. Run \`pnpm dev:no-auth-key\`.`,
    );
  }

  const port = appPort(values);
  const bound = (values[APP_HOST_VAR] ?? '').trim();
  const host = unlockHost(bound);
  console.log('No-auth dev mode. Open this once per browser to unlock it:\n');
  console.log(`  http://${host}:${port}/?${UNLOCK_PARAM}=${values[SECRET_VAR]}\n`);
  if (bound !== '' && loopbackHost(bound) === undefined) {
    console.log(
      `${APP_HOST_VAR}=${bound} is not a loopback address, and no-auth mode refuses every ` +
        'request that does not name this machine, so no other machine is served. Open the URL ' +
        'here, or through a forward to this machine.\n',
    );
  }
}

/**
 * A loopback name or address as a URL host, or undefined for any other host.
 *
 * Args:
 *   host: A host name or address, IPv6 with or without brackets.
 */
function loopbackHost(host: string): string | undefined {
  const bare = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) return bare;
  if (bare === '::1') return '[::1]';
  return undefined;
}

/**
 * The host the unlock URL names: the one `pnpm dev` binds (scripts/dev.ts reads
 * the same `DAY0_APP_HOST`) when that is loopback, else `localhost`, which a
 * server bound to every interface answers on too.
 *
 * Args:
 *   bound: `DAY0_APP_HOST` from the shell or the file, empty when unset.
 */
function unlockHost(bound: string): string {
  return loopbackHost(bound) ?? 'localhost';
}

/**
 * The port the app serves on: `PORT` from the shell, else `DAY0_APP_PORT` from
 * the file, else 3000. `pnpm dev` (scripts/dev.ts) resolves the same three so
 * the URL printed here is the one the server answers on. Not exported: this
 * module runs `main` at import time.
 *
 * Args:
 *   values: The env file with the process environment layered on.
 *
 * Returns:
 *   The port as a string.
 */
function appPort(values: Record<string, string>): string {
  const fromShell = (process.env.PORT ?? '').trim();
  if (fromShell !== '') return fromShell;
  const fromFile = (values[APP_PORT_VAR] ?? '').trim();
  return fromFile !== '' ? fromFile : '3000';
}

/**
 * Stop key setup with a concise diagnostic.
 *
 * Args:
 *   message: Failure detail safe to print.
 */
function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

await main();
