/// <reference types="node" />
/**
 * The local key no-auth dev mode runs on.
 *
 *   pnpm dev:no-auth-key          generate it (and rotate it with --force)
 *   pnpm dev:no-auth-key url      print the unlock URL, which `pnpm dev` does
 *
 * No-auth mode serves every request as one fixed user who owns every row, so the
 * only thing standing between that user and anyone who can reach the ports is
 * this key. It is three values, written to `.env.local`:
 *
 *   DEV_NO_AUTH_SECRET       unlocks the app. Travels once on the URL printed
 *                            below, then lives in an httpOnly cookie.
 *   DEV_NO_AUTH_SIGNING_KEY  signs the token Convex accepts. Never leaves this
 *                            machine.
 *   DEV_NO_AUTH_JWKS         the public half of that key, pushed to the Convex
 *                            deployment by ./scripts/sync-convex-env.sh so it
 *                            can verify the signature without being able to
 *                            produce one.
 *
 * Rotating them invalidates every unlocked browser and requires a re-sync, which
 * is why an existing key is left alone unless --force says otherwise.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Run key initialisation or print the local unlock URL. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.find((arg) => !arg.startsWith('--')) ?? 'init';

  if (mode === 'url') {
    ensureRealSurfaceKeys(false);
    return printUnlockUrl();
  }
  if (mode === 'init') return init(args.includes('--force'));

  fail(`unknown mode "${mode}" - expected "init" or "url"`);
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
    const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(ENV_FILE, lines.join('\n'), 'utf8');
}

/**
 * Ensure the no-auth signing material and credential key exist.
 *
 * Args:
 *   force: Rotate every generated value when true.
 */
async function init(force: boolean): Promise<void> {
  const existing = readEnvFile();
  const authComplete =
    !!existing[SECRET_VAR] && !!existing[SIGNING_KEY_VAR] && !!existing[JWKS_VAR];
  const credentialComplete = !!existing[CREDENTIAL_KEY_VAR];
  const notionAuthComplete = !!existing[NOTION_MCP_AUTH_TOKEN_VAR];
  if (authComplete && credentialComplete && notionAuthComplete && !force) {
    console.log(`${ENV_FILE} already carries a no-auth key. Pass --force to rotate it.\n`);
    return printUnlockUrl();
  }

  const updates: Record<string, string> = {};
  if (!authComplete || force) {
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
    updates[SECRET_VAR] = randomBytes(32).toString('base64url');
    updates[SIGNING_KEY_VAR] = Buffer.from(pkcs8).toString('base64');
    updates[JWKS_VAR] =
      `data:text/plain;charset=utf-8;base64,${Buffer.from(JSON.stringify(jwks)).toString('base64')}`;
  }
  if (!credentialComplete || force) {
    updates[CREDENTIAL_KEY_VAR] = randomBytes(32).toString('base64');
  }
  if (!notionAuthComplete || force) {
    updates[NOTION_MCP_AUTH_TOKEN_VAR] = randomBytes(32).toString('base64url');
  }
  upsertEnvFile(updates);

  console.log(`Wrote ${Object.keys(updates).join(', ')} to ${ENV_FILE}.`);
  console.log('Next: ./scripts/sync-convex-env.sh, then push your functions.\n');
  printUnlockUrl();
}

/**
 * Ensure ordinary `pnpm dev` creates stable real-surface secrets once.
 *
 * Args:
 *   force: Rotate the key when true.
 */
function ensureRealSurfaceKeys(force: boolean): void {
  const existing = readEnvFile();
  const updates: Record<string, string> = {};
  if (!existing[CREDENTIAL_KEY_VAR] || force) {
    updates[CREDENTIAL_KEY_VAR] = randomBytes(32).toString('base64');
  }
  if (!existing[NOTION_MCP_AUTH_TOKEN_VAR] || force) {
    updates[NOTION_MCP_AUTH_TOKEN_VAR] = randomBytes(32).toString('base64url');
  }
  if (Object.keys(updates).length === 0) return;
  upsertEnvFile(updates);
  console.log(`Wrote ${Object.keys(updates).join(', ')} to ${ENV_FILE}.`);
}

/** Print the no-auth unlock URL when that local mode is enabled. */
function printUnlockUrl(): void {
  const values = readEnvFile();
  if (values[FLAG_VAR] !== 'true') return;

  const missing = [SECRET_VAR, SIGNING_KEY_VAR, JWKS_VAR].filter((key) => !values[key]);
  if (missing.length > 0) {
    fail(
      `${FLAG_VAR}=true serves every request as one fixed user, and ${ENV_FILE} is ` +
        `missing ${missing.join(', ')}. Run \`pnpm dev:no-auth-key\`.`,
    );
  }

  const port = process.env.PORT ?? '3000';
  console.log('No-auth dev mode. Open this once per browser to unlock it:\n');
  console.log(`  http://localhost:${port}/?${UNLOCK_PARAM}=${values[SECRET_VAR]}\n`);
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
