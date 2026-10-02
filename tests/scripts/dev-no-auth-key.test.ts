import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { temporaryDirectories } from '../setup/temporary-directories';

const temporary = temporaryDirectories();

const SCRIPT = resolve('scripts/dev-no-auth-key.ts');
const TSX = resolve('node_modules/.bin/tsx');

/** Keys the script reads from the shell; blanked so the host's own values never leak in. */
const SHELL_KEYS = [
  'NEXT_PUBLIC_DEV_NO_AUTH',
  'DEV_NO_AUTH_SECRET',
  'DEV_NO_AUTH_SIGNING_KEY',
  'DEV_NO_AUTH_JWKS',
  'DAY0_CREDENTIAL_KEY',
  'DAY0_NOTION_MCP_AUTH_TOKEN',
  'DAY0_NANGO_SECRET_KEY',
  'DAY0_NANGO_ENCRYPTION_KEY',
  'DAY0_NANGO_DB_PASSWORD',
  'CONVEX_DEPLOYMENT',
  'CONVEX_SELF_HOSTED_URL',
  'CONVEX_SELF_HOSTED_ADMIN_KEY',
  'PORT',
  'DAY0_APP_HOST',
] as const;

/** What the stand-in Convex CLI answers to `convex env list`. */
type Deployment = { listing: string } | { unreachable: true };

interface Run {
  status: number | null;
  output: string;
  /** Every argument list the stand-in `npx` was called with. */
  calls: string[];
}

/**
 * Put a stand-in `npx` first on PATH: the Convex CLI is the script's transport to
 * the deployment, and nothing in a test reaches a real one.
 */
function fakeNpx(cwd: string, deployment: Deployment): string {
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const log = join(cwd, 'npx-calls.log');
  const body =
    'unreachable' in deployment
      ? 'echo "Failed to connect to the deployment" >&2\nexit 1\n'
      : `cat <<'LISTING'\n${deployment.listing}\nLISTING\n`;
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "$*" >> "${log}"\n${body}`, 'utf8');
  chmodSync(join(bin, 'npx'), 0o755);
  return bin;
}

/**
 * Run the key script the way `pnpm dev` or `pnpm dev:no-auth-key` does.
 *
 * Args:
 *   cwd: Working directory holding, or lacking, `.env.local`.
 *   args: The mode and flags.
 *   deployment: What the stand-in Convex CLI reports, when one is on PATH.
 *
 * Returns:
 *   Exit status, combined output and the CLI calls made.
 */
function runScript(cwd: string, args: readonly string[], deployment?: Deployment): Run {
  const blanks = Object.fromEntries(SHELL_KEYS.map((key: string): [string, string] => [key, '']));
  const bin = deployment ? fakeNpx(cwd, deployment) : undefined;
  const result = spawnSync(TSX, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...blanks,
      ...(bin ? { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } : {}),
    },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(cwd, 'npx-calls.log'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    // No stand-in on PATH, or it was never called: no calls to report.
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls };
}

function envDirectory(contents: string): { cwd: string; envFile: string } {
  const cwd = temporary('day0-dev-key-');
  const envFile = join(cwd, '.env.local');
  writeFileSync(envFile, contents, 'utf8');
  return { cwd, envFile };
}

function valueOf(file: string, key: string): string | undefined {
  return new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'))?.[1];
}

const SELF_HOSTED =
  'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|0123\n';
const DEPLOYMENT_KEY = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU=';
const DEPLOYMENT_TOKEN = 'deployment-notion-token_0123456789abcdefghijklmn';

describe('dev-no-auth-key url mode', (): void => {
  it('starts pnpm dev without .env.local instead of failing on key generation', (): void => {
    const cwd = temporary('day0-dev-key-');
    const { status, output } = runScript(cwd, ['url']);
    expect(status).toBe(0);
    expect(output).not.toContain('not found');
  });

  it('generates the credential key and transport token once, without printing them', (): void => {
    const { cwd, envFile } = envDirectory('NEXT_PUBLIC_DEV_NO_AUTH=false\n');
    const first = runScript(cwd, ['url']);
    expect(first.status).toBe(0);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    const written = readFileSync(envFile, 'utf8');
    const key = valueOf(envFile, 'DAY0_CREDENTIAL_KEY');
    const token = valueOf(envFile, 'DAY0_NOTION_MCP_AUTH_TOKEN');
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.output).not.toContain(key);
    expect(first.output).not.toContain(token);
    const second = runScript(cwd, ['url']);
    expect(second.status).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toBe(written);
  });
});

describe('the unlock URL', (): void => {
  const unlocked =
    'NEXT_PUBLIC_DEV_NO_AUTH=true\nDEV_NO_AUTH_SECRET=the-secret\nDEV_NO_AUTH_SIGNING_KEY=k\n' +
    `DEV_NO_AUTH_JWKS=j\nDAY0_CREDENTIAL_KEY=${DEPLOYMENT_KEY}\nDAY0_NOTION_MCP_AUTH_TOKEN=${DEPLOYMENT_TOKEN}\n`;

  it('names localhost and the app port by default', (): void => {
    const { cwd } = envDirectory(`${unlocked}DAY0_APP_PORT=4100\n`);
    const run = runScript(cwd, ['url']);
    expect(run.output).toContain('http://localhost:4100/?day0_key=the-secret');
  });

  it('names the loopback address pnpm dev binds, so the URL and the server agree', (): void => {
    const { cwd } = envDirectory(`${unlocked}DAY0_APP_HOST=127.0.0.2\n`);
    const run = runScript(cwd, ['url']);
    expect(run.output).toContain('http://127.0.0.2:3000/?day0_key=the-secret');
  });

  it('says a non-loopback bind serves no other machine in no-auth mode', (): void => {
    const { cwd } = envDirectory(`${unlocked}DAY0_APP_HOST=0.0.0.0\n`);
    const run = runScript(cwd, ['url']);
    expect(run.status).toBe(0);
    expect(run.output).toContain('http://localhost:3000/?day0_key=the-secret');
    expect(run.output).toContain('DAY0_APP_HOST=0.0.0.0 is not a loopback address');
  });
});

describe('adopting the deployment key before minting one', (): void => {
  it("adopts the deployment's credential key and transport token when the file has none", (): void => {
    const { cwd, envFile } = envDirectory(`NEXT_PUBLIC_DEV_NO_AUTH=false\n${SELF_HOSTED}`);
    const run = runScript(cwd, ['url'], {
      listing: `DAY0_CREDENTIAL_KEY=${DEPLOYMENT_KEY}\nDAY0_NOTION_MCP_AUTH_TOKEN=${DEPLOYMENT_TOKEN}\nOPENAI_MODEL=x`,
    });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(['convex env list']);
    expect(valueOf(envFile, 'DAY0_CREDENTIAL_KEY')).toBe(DEPLOYMENT_KEY);
    expect(valueOf(envFile, 'DAY0_NOTION_MCP_AUTH_TOKEN')).toBe(DEPLOYMENT_TOKEN);
    expect(run.output).toContain('Adopted DAY0_CREDENTIAL_KEY, DAY0_NOTION_MCP_AUTH_TOKEN');
    expect(run.output).not.toContain(DEPLOYMENT_KEY);
  });

  it('mints only what the deployment does not already hold', (): void => {
    const { cwd, envFile } = envDirectory(`NEXT_PUBLIC_DEV_NO_AUTH=false\n${SELF_HOSTED}`);
    const run = runScript(cwd, ['url'], { listing: `DAY0_CREDENTIAL_KEY=${DEPLOYMENT_KEY}` });
    expect(run.status).toBe(0);
    expect(valueOf(envFile, 'DAY0_CREDENTIAL_KEY')).toBe(DEPLOYMENT_KEY);
    expect(valueOf(envFile, 'DAY0_NOTION_MCP_AUTH_TOKEN')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses to mint over a deployment it is configured for but cannot read', (): void => {
    const { cwd, envFile } = envDirectory(`NEXT_PUBLIC_DEV_NO_AUTH=false\n${SELF_HOSTED}`);
    const before = readFileSync(envFile, 'utf8');
    const run = runScript(cwd, ['url'], { unreachable: true });
    expect(run.status).toBe(1);
    expect(run.output).toContain('could not read the deployment');
    expect(run.output).toContain('pnpm convex:up');
    expect(readFileSync(envFile, 'utf8')).toBe(before);
  });

  it('does not ask a deployment when the file already carries both keys', (): void => {
    const { cwd } = envDirectory(
      `NEXT_PUBLIC_DEV_NO_AUTH=false\n${SELF_HOSTED}DAY0_CREDENTIAL_KEY=${DEPLOYMENT_KEY}\nDAY0_NOTION_MCP_AUTH_TOKEN=${DEPLOYMENT_TOKEN}\n`,
    );
    const run = runScript(cwd, ['url'], { unreachable: true });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([]);
  });

  it('adopts in init as well, so the first-run command cannot overwrite a live key', (): void => {
    const { cwd, envFile } = envDirectory(`NEXT_PUBLIC_DEV_NO_AUTH=true\n${SELF_HOSTED}`);
    const run = runScript(cwd, ['init'], { listing: `DAY0_CREDENTIAL_KEY=${DEPLOYMENT_KEY}` });
    expect(run.status).toBe(0);
    expect(valueOf(envFile, 'DAY0_CREDENTIAL_KEY')).toBe(DEPLOYMENT_KEY);
    expect(valueOf(envFile, 'DEV_NO_AUTH_SECRET')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('the real-mode keys on their own', (): void => {
  it('writes the credential key and transport token without the no-auth values', (): void => {
    const { cwd, envFile } = envDirectory('DAY0_SURFACE_MODE=real\n');
    const run = runScript(cwd, ['surface-keys']);
    expect(run.status).toBe(0);
    expect(valueOf(envFile, 'DAY0_CREDENTIAL_KEY')).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(valueOf(envFile, 'DAY0_NOTION_MCP_AUTH_TOKEN')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(valueOf(envFile, 'DEV_NO_AUTH_SECRET')).toBeUndefined();
    expect(valueOf(envFile, 'DEV_NO_AUTH_SIGNING_KEY')).toBeUndefined();
  });
});

describe("the token store's Nango keys (11-AT)", (): void => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('mints the three Nango keys once, in the shapes Nango takes, without printing them', (): void => {
    const { cwd, envFile } = envDirectory('NEXT_PUBLIC_DEV_NO_AUTH=false\n');
    const first = runScript(cwd, ['url']);
    expect(first.status).toBe(0);
    const secretKey = valueOf(envFile, 'DAY0_NANGO_SECRET_KEY') ?? '';
    const encryptionKey = valueOf(envFile, 'DAY0_NANGO_ENCRYPTION_KEY') ?? '';
    const password = valueOf(envFile, 'DAY0_NANGO_DB_PASSWORD') ?? '';
    expect(secretKey).toMatch(UUID_V4);
    expect(Buffer.from(encryptionKey, 'base64')).toHaveLength(32);
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const value of [secretKey, encryptionKey, password]) {
      expect(first.output).not.toContain(value);
    }
    const written = readFileSync(envFile, 'utf8');
    expect(runScript(cwd, ['url']).status).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toBe(written);
  });

  it('never asks the deployment for a Nango key and never replaces one the file holds', (): void => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const { cwd, envFile } = envDirectory(
      `NEXT_PUBLIC_DEV_NO_AUTH=false\n${SELF_HOSTED}DAY0_CREDENTIAL_KEY=${DEPLOYMENT_KEY}\nDAY0_NOTION_MCP_AUTH_TOKEN=${DEPLOYMENT_TOKEN}\nDAY0_NANGO_ENCRYPTION_KEY=${encryptionKey}\n`,
    );
    const run = runScript(cwd, ['surface-keys', '--force'], { unreachable: true });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([]);
    expect(valueOf(envFile, 'DAY0_NANGO_ENCRYPTION_KEY')).toBe(encryptionKey);
    expect(valueOf(envFile, 'DAY0_NANGO_SECRET_KEY')).toMatch(UUID_V4);
  });

  it('writes the Nango keys in init as well', (): void => {
    const { cwd, envFile } = envDirectory('NEXT_PUBLIC_DEV_NO_AUTH=true\n');
    expect(runScript(cwd, ['init']).status).toBe(0);
    expect(valueOf(envFile, 'DAY0_NANGO_SECRET_KEY')).toMatch(UUID_V4);
  });
});

describe('rotation', (): void => {
  const complete =
    'NEXT_PUBLIC_DEV_NO_AUTH=true\nDEV_NO_AUTH_SECRET=old-secret\nDEV_NO_AUTH_SIGNING_KEY=old-signing\n' +
    `DEV_NO_AUTH_JWKS=old-jwks\nDAY0_CREDENTIAL_KEY=${DEPLOYMENT_KEY}\nDAY0_NOTION_MCP_AUTH_TOKEN=${DEPLOYMENT_TOKEN}\n`;

  it('rotates the unlock secret alone, leaving the credential key and the signing key', (): void => {
    const { cwd, envFile } = envDirectory(complete);
    const run = runScript(cwd, ['init', '--rotate-unlock']);
    expect(run.status).toBe(0);
    expect(valueOf(envFile, 'DEV_NO_AUTH_SECRET')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(valueOf(envFile, 'DEV_NO_AUTH_SIGNING_KEY')).toBe('old-signing');
    expect(valueOf(envFile, 'DEV_NO_AUTH_JWKS')).toBe('old-jwks');
    expect(valueOf(envFile, 'DAY0_CREDENTIAL_KEY')).toBe(DEPLOYMENT_KEY);
    expect(valueOf(envFile, 'DAY0_NOTION_MCP_AUTH_TOKEN')).toBe(DEPLOYMENT_TOKEN);
    expect(run.output).toContain('every unlocked browser is signed out');
  });

  it('regenerates the three no-auth values on --force and keeps the credential key and the Notion token (U4 decision 3)', (): void => {
    const { cwd, envFile } = envDirectory(complete);
    const run = runScript(cwd, ['init', '--force']);
    expect(run.status).toBe(0);
    expect(valueOf(envFile, 'DEV_NO_AUTH_SECRET')).not.toBe('old-secret');
    expect(valueOf(envFile, 'DEV_NO_AUTH_SIGNING_KEY')).not.toBe('old-signing');
    expect(valueOf(envFile, 'DEV_NO_AUTH_JWKS')).not.toBe('old-jwks');
    expect(valueOf(envFile, 'DAY0_CREDENTIAL_KEY')).toBe(DEPLOYMENT_KEY);
    expect(valueOf(envFile, 'DAY0_NOTION_MCP_AUTH_TOKEN')).toBe(DEPLOYMENT_TOKEN);
    expect(run.output).toContain('DAY0_CREDENTIAL_KEY is unchanged');
    expect(run.output).toContain('scripts/rotate-credential-key.ts');
  });

  it('regenerates only the Notion token on surface-keys --force, and adopts a missing credential key rather than minting one', (): void => {
    const kept = envDirectory(complete);
    const forced = runScript(kept.cwd, ['surface-keys', '--force']);
    expect(forced.status).toBe(0);
    expect(valueOf(kept.envFile, 'DAY0_CREDENTIAL_KEY')).toBe(DEPLOYMENT_KEY);
    expect(valueOf(kept.envFile, 'DAY0_NOTION_MCP_AUTH_TOKEN')).not.toBe(DEPLOYMENT_TOKEN);

    const missing = envDirectory(`DAY0_SURFACE_MODE=real\n${SELF_HOSTED}`);
    const adopted = runScript(missing.cwd, ['surface-keys', '--force'], {
      listing: `DAY0_CREDENTIAL_KEY=${DEPLOYMENT_KEY}`,
    });
    expect(adopted.status).toBe(0);
    expect(adopted.calls).toEqual(['convex env list']);
    expect(valueOf(missing.envFile, 'DAY0_CREDENTIAL_KEY')).toBe(DEPLOYMENT_KEY);
  });
});
