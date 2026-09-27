/// <reference types="node" />
/**
 * Rotate the credential key on purpose, after a confirmation.
 *
 *   pnpm exec tsx scripts/rotate-credential-key.ts          asks first
 *   pnpm exec tsx scripts/rotate-credential-key.ts --yes    for a script that has already asked
 *
 * `DAY0_CREDENTIAL_KEY` sealed every credential the deployment stores, and a
 * new key cannot open them: each one has to be landed again afterwards, from
 * its card or by the next documentation sync. That is why `--force` on the key
 * script no longer does this (decision Q12: a confirmation on every
 * destructive command). The script counts what the deployment stores, says
 * what will be lost, and on a yes writes the new key into `.env.local` and
 * sets it on the deployment itself, so the env sync that refuses to replace a
 * key over stored credentials finds the two already agreeing. Restart the
 * backend afterwards so running modules read it.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { writePrivateEnv } from './private-env';

const ENV_FILE = '.env.local';
const KEY_NAME = 'DAY0_CREDENTIAL_KEY';

/** The most stored rows the count reads before it says "at least". */
export const COUNT_LIMIT = 1_000;

/** The word the confirmation asks for, so a stray Enter cannot rotate the key. */
export const CONFIRMATION_WORD = 'rotate';

/**
 * How many credential rows the CLI's JSON-lines listing holds.
 *
 * @param stdout - `npx convex data credentials --format jsonl` output; empty when there are none.
 */
export function storedCredentialCount(stdout: string): number {
  return stdout.split('\n').filter((line) => line.trim().startsWith('{')).length;
}

/**
 * The question the rotation asks before it changes anything.
 *
 * @param count - Credential rows the deployment stores, up to `COUNT_LIMIT`.
 * @param deployment - Whether a deployment is configured at all.
 */
export function rotationQuestion(count: number, deployment: boolean): string {
  const stored = !deployment
    ? 'No deployment is configured, so only .env.local changes.'
    : count === 0
      ? 'The deployment stores no credentials, so nothing becomes unreadable.'
      : `The deployment stores ${count >= COUNT_LIMIT ? `at least ${COUNT_LIMIT}` : count} credential row(s) ` +
        'sealed under the current key; after this none of them can be read, and each has to be landed again.';
  return `Rotate ${KEY_NAME}? ${stored} Type "${CONFIRMATION_WORD}" to go on: `;
}

/** The env file's values, as the key script reads them. */
function readEnvFile(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return values;
}

/** Replace or append one line of the env file, keeping everything else as it is. */
function writeKey(value: string): void {
  const lines = readFileSync(ENV_FILE, 'utf8').split('\n');
  const index = lines.findIndex((line) => new RegExp(`^\\s*${KEY_NAME}\\s*=`).test(line));
  if (index >= 0) lines[index] = `${KEY_NAME}=${value}`;
  else lines.push(`${KEY_NAME}=${value}`);
  writePrivateEnv(ENV_FILE, lines.join('\n'));
}

/** Stop with a message and a failing status. */
function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Ask, then rotate the key in the file and on the deployment. */
async function main(): Promise<void> {
  const assumeYes = process.argv.slice(2).includes('--yes');
  if (!existsSync(ENV_FILE)) fail(`${ENV_FILE} not found; there is no key to rotate.`);
  const values = readEnvFile();
  const deployment =
    (!!values.CONVEX_SELF_HOSTED_URL && !!values.CONVEX_SELF_HOSTED_ADMIN_KEY) ||
    !!values.CONVEX_DEPLOYMENT;
  let count = 0;
  if (deployment) {
    const listed = spawnSync(
      'npx',
      ['convex', 'data', 'credentials', '--limit', String(COUNT_LIMIT), '--format', 'jsonl'],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (listed.status !== 0) {
      fail(
        'the deployment could not be read, so what the rotation would lose cannot be said; ' +
          `nothing was changed. (${(listed.stderr ?? '').trim().split('\n').slice(-1)[0] ?? ''})`,
      );
    }
    count = storedCredentialCount(listed.stdout ?? '');
  }
  if (!assumeYes) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(rotationQuestion(count, deployment));
    prompt.close();
    if (answer.trim().toLowerCase() !== CONFIRMATION_WORD) {
      console.log('Not rotated. Nothing was changed.');
      return;
    }
  }
  const key = randomBytes(32).toString('base64');
  if (deployment) {
    // `--` before the value, as the env sync does, so no value is ever read as an option.
    const set = spawnSync('npx', ['convex', 'env', 'set', KEY_NAME, '--', key], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (set.status !== 0) {
      fail(`the deployment refused the new key; ${ENV_FILE} was not changed.`);
    }
  }
  writeKey(key);
  console.log(
    `Rotated ${KEY_NAME} in ${ENV_FILE}${deployment ? ' and on the deployment' : ''}. ` +
      `${deployment ? 'Restart the backend so running modules read it: `pnpm convex:restart`. ' : ''}` +
      'Land each stored credential again from its card, or let the next documentation sync find it.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
