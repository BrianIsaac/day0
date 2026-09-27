/// <reference types="node" />
/**
 * Rotate the credential key on purpose, after a confirmation, and re-seal
 * every stored credential under the new key.
 *
 *   pnpm exec tsx scripts/rotate-credential-key.ts          asks first
 *   pnpm exec tsx scripts/rotate-credential-key.ts --yes    for a script that has already asked
 *
 * `DAY0_CREDENTIAL_KEY` sealed every credential the deployment stores, and each
 * row names the key that sealed it (`keyId`). The rotation sets the old key on
 * the deployment as `DAY0_CREDENTIAL_KEY_PREVIOUS`, sets the new one, writes it
 * into `.env.local`, re-seals every row under the new key in pages
 * (`credentialCryptoActions:resealAll`), and drops the old key only once no
 * row names it, so every credential stays readable throughout and after. A
 * self-hosted backend reads a changed environment only after a restart; the
 * script checks which keys the backend reads before it re-seals, and says to
 * restart and run it again, which carries on where it stopped. The env sync
 * still refuses to replace a key over stored credentials (decision Q12); the
 * rotation is the one path that changes it.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { credentialKeyId } from '../src/lib/credential-crypto';
import { writePrivateEnv } from './private-env';

const ENV_FILE = '.env.local';
const KEY_NAME = 'DAY0_CREDENTIAL_KEY';

/** Where the deployment keeps the key a rotation replaced, until no row needs it. */
export const PREVIOUS_KEY_NAME = 'DAY0_CREDENTIAL_KEY_PREVIOUS';

/** The most stored rows the count reads before it says "at least". */
export const COUNT_LIMIT = 1_000;

/** The word the confirmation asks for, so a stray Enter cannot rotate the key. */
export const CONFIRMATION_WORD = 'rotate';

/** What the restart step tells a person whose backend still reads the old keys. */
export const RESTART_MESSAGE =
  'The backend still reads the keys it had before this rotation. Restart it (`pnpm convex:restart`), ' +
  'then run this script again: it carries on from here.';

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
      ? 'The deployment stores no credentials, so there is nothing to re-seal.'
      : `The deployment stores ${count >= COUNT_LIMIT ? `at least ${COUNT_LIMIT}` : count} credential row(s); ` +
        'each is sealed again under the new key, and stays readable throughout.';
  return `Rotate ${KEY_NAME}? ${stored} Type "${CONFIRMATION_WORD}" to go on: `;
}

/** What one `credentialCryptoActions:resealAll` call reports. */
interface ResealRun {
  readonly read: number;
  readonly changed: number;
  readonly skipped: number;
  readonly cursor: string | null;
  readonly isDone: boolean;
}

/** One page of `credentials:keyCounts`. */
interface KeyCountPage {
  readonly byKeyId: Readonly<Record<string, number>>;
  readonly unkeyed: number;
  readonly cursor: string;
  readonly isDone: boolean;
}

/**
 * The deployment as the rotation drives it. `npxDeployment` is the real one;
 * a test passes one backed by the functions themselves.
 */
export interface RotationDeployment {
  /** The deployment's environment variable, or undefined when it is not set. */
  envGet(name: string): Promise<string | undefined>;
  /** Set a variable; throws when the deployment refuses. */
  envSet(name: string, value: string): Promise<void>;
  /** Remove a variable; throws when the deployment refuses. */
  envRemove(name: string): Promise<void>;
  /** Credential rows stored, up to `COUNT_LIMIT`. */
  storedCount(): Promise<number>;
  /** The ids of the keys the backend reads now. */
  keyIds(): Promise<{ current: string; previous?: string }>;
  /** Re-seal from a cursor for one time budget. */
  reseal(cursor: string | null): Promise<ResealRun>;
  /** One page of the stored values counted by key. */
  keyCounts(cursor: string | null): Promise<KeyCountPage>;
}

/** What the rotation reads and writes beside the deployment. */
export interface RotationIo {
  /** Undefined when no deployment is configured: only the file changes. */
  readonly deployment: RotationDeployment | undefined;
  /** The key `.env.local` holds now. */
  readonly fileKey: string | undefined;
  /** Whether the person confirmed the question (or `--yes` was given). */
  confirm(question: string): Promise<boolean>;
  /** Write the key into `.env.local`. */
  writeFileKey(key: string): void;
  /** A fresh 32-byte key, base64. */
  newKey(): string;
  log(line: string): void;
}

/** How a rotation ended. */
export type RotationOutcome =
  | { readonly kind: 'declined' }
  | { readonly kind: 'rotated'; readonly resealed: number; readonly unreadable: number }
  | { readonly kind: 'restart-needed' }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Run the re-seal to the end of the table, page budget by page budget.
 *
 * @returns Rows re-sealed and rows no key could open, summed over every call.
 */
async function resealEveryRow(
  deployment: RotationDeployment,
): Promise<{ changed: number; skipped: number }> {
  let cursor: string | null = null;
  let changed = 0;
  let skipped = 0;
  for (;;) {
    const run: ResealRun = await deployment.reseal(cursor);
    changed += run.changed;
    skipped += run.skipped;
    if (run.isDone) return { changed, skipped };
    cursor = run.cursor;
  }
}

/** How many stored values still name one key, over the whole table. */
async function rowsNamingKey(deployment: RotationDeployment, keyId: string): Promise<number> {
  let cursor: string | null = null;
  let rows = 0;
  for (;;) {
    const page: KeyCountPage = await deployment.keyCounts(cursor);
    rows += page.byKeyId[keyId] ?? 0;
    if (page.isDone) return rows;
    cursor = page.cursor;
  }
}

/**
 * Carry a rotation whose new key the deployment holds to its end: check the
 * backend reads both keys, re-seal every row, and drop the old key once no
 * row names it.
 *
 * @param deployment - The deployment being rotated.
 * @param current - The new key, already the deployment's `DAY0_CREDENTIAL_KEY`.
 * @param previous - The key it replaced, the deployment's `DAY0_CREDENTIAL_KEY_PREVIOUS`.
 */
async function finishRotation(
  deployment: RotationDeployment,
  current: string,
  previous: string,
  log: (line: string) => void,
): Promise<RotationOutcome> {
  const reads = await deployment.keyIds();
  const previousId = credentialKeyId(previous);
  if (reads.current !== credentialKeyId(current) || reads.previous !== previousId) {
    log(RESTART_MESSAGE);
    return { kind: 'restart-needed' };
  }
  const { changed, skipped } = await resealEveryRow(deployment);
  const left = await rowsNamingKey(deployment, previousId);
  if (left > 0) {
    const reason =
      `${left} credential row(s) still name the old key, so ${PREVIOUS_KEY_NAME} stays on the deployment; ` +
      'run this script again to re-seal them.';
    log(reason);
    return { kind: 'refused', reason };
  }
  await deployment.envRemove(PREVIOUS_KEY_NAME);
  log(
    `Re-sealed ${changed} credential row(s) under the new key and removed ${PREVIOUS_KEY_NAME}.` +
      (skipped > 0
        ? ` ${skipped} row(s) no key could open were left as they were (their ids are in the function logs); ` +
          'land those credentials again from their cards.'
        : ''),
  );
  return { kind: 'rotated', resealed: changed, unreadable: skipped };
}

/** Refuse to rotate from a file whose key the deployment does not hold. */
function refuseForeignFileKey(io: RotationIo): RotationOutcome {
  const reason =
    `${KEY_NAME} in ${ENV_FILE} is not the key this deployment holds; adopt the deployment's key ` +
    `(\`npx convex env get ${KEY_NAME}\`) into ${ENV_FILE} before rotating.`;
  io.log(reason);
  return { kind: 'refused', reason };
}

/**
 * Rotate the credential key: ask, set the new key beside the old one, and
 * re-seal every stored row, or carry on a rotation an earlier run began.
 *
 * @returns How the rotation ended; only `rotated` and `declined` leave nothing to do.
 */
export async function rotateCredentialKey(io: RotationIo): Promise<RotationOutcome> {
  const { deployment } = io;
  if (deployment === undefined) {
    if (!(await io.confirm(rotationQuestion(0, false)))) {
      io.log('Not rotated. Nothing was changed.');
      return { kind: 'declined' };
    }
    io.writeFileKey(io.newKey());
    io.log(`Rotated ${KEY_NAME} in ${ENV_FILE}.`);
    return { kind: 'rotated', resealed: 0, unreadable: 0 };
  }
  const held = await deployment.envGet(KEY_NAME);
  const inFlight = await deployment.envGet(PREVIOUS_KEY_NAME);
  if (held !== undefined && inFlight !== undefined && inFlight !== held) {
    if (io.fileKey !== held && io.fileKey !== inFlight) return refuseForeignFileKey(io);
    if (io.fileKey !== held) {
      // The earlier run set the new key on the deployment and stopped before the file.
      io.writeFileKey(held);
      io.log(`Wrote the deployment's new ${KEY_NAME} into ${ENV_FILE}.`);
    }
    io.log('A rotation is under way on this deployment; carrying on with its re-seal.');
    return await finishRotation(deployment, held, inFlight, io.log);
  }
  if (inFlight !== undefined) {
    // An earlier run set the old key aside and never set a new one: nothing is re-sealed yet.
    await deployment.envRemove(PREVIOUS_KEY_NAME);
  }
  if (held !== undefined && held !== io.fileKey) return refuseForeignFileKey(io);
  const count = await deployment.storedCount();
  if (!(await io.confirm(rotationQuestion(count, true)))) {
    io.log('Not rotated. Nothing was changed.');
    return { kind: 'declined' };
  }
  const key = io.newKey();
  if (held === undefined) {
    // No key on the deployment: nothing it stores could have been sealed.
    await deployment.envSet(KEY_NAME, key);
    io.writeFileKey(key);
    io.log(`Set ${KEY_NAME} in ${ENV_FILE} and on the deployment.`);
    return { kind: 'rotated', resealed: 0, unreadable: 0 };
  }
  // The old key goes on first, so no moment exists in which a row's key is missing.
  await deployment.envSet(PREVIOUS_KEY_NAME, held);
  try {
    await deployment.envSet(KEY_NAME, key);
  } catch (error) {
    await deployment.envRemove(PREVIOUS_KEY_NAME);
    throw error;
  }
  io.writeFileKey(key);
  io.log(
    `Set the new ${KEY_NAME} in ${ENV_FILE} and on the deployment, with the old one beside it.`,
  );
  return await finishRotation(deployment, key, held, io.log);
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

/**
 * Run one `npx convex` command and hand back its output.
 *
 * @throws Error carrying the command's last line when it fails; never the arguments,
 *   which may hold a key.
 */
function npxConvex(args: readonly string[], what: string): string {
  const result = spawnSync('npx', ['convex', ...args], { encoding: 'utf8', timeout: 600_000 });
  if (result.status !== 0) {
    const last = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split('\n').slice(-1)[0];
    throw new Error(`${what} failed${last ? `: ${last}` : ''}`);
  }
  return result.stdout ?? '';
}

/** Run a deployed internal function and parse the JSON `convex run` prints. */
function npxConvexRun(name: string, args: Record<string, unknown>): unknown {
  return JSON.parse(npxConvex(['run', name, JSON.stringify(args)], name)) as unknown;
}

/** The deployment through `npx convex`, as the operator's checkout reaches it. */
export const npxDeployment: RotationDeployment = {
  envGet: async (name) => {
    for (const line of npxConvex(['env', 'list'], 'convex env list').split('\n')) {
      const at = line.indexOf('=');
      if (at > 0 && line.slice(0, at).trim() === name)
        return line.slice(at + 1).trim() || undefined;
    }
    return undefined;
  },
  // `--` before the value, as the env sync does, so no value is ever read as an option.
  envSet: async (name, value) => {
    npxConvex(['env', 'set', name, '--', value], `convex env set ${name}`);
  },
  envRemove: async (name) => {
    npxConvex(['env', 'remove', name], `convex env remove ${name}`);
  },
  storedCount: async () =>
    storedCredentialCount(
      npxConvex(
        ['data', 'credentials', '--limit', String(COUNT_LIMIT), '--format', 'jsonl'],
        'reading the stored credentials',
      ),
    ),
  keyIds: async () =>
    npxConvexRun('credentialCryptoActions:keyIds', {}) as { current: string; previous?: string },
  reseal: async (cursor) =>
    npxConvexRun('credentialCryptoActions:resealAll', { cursor }) as ResealRun,
  keyCounts: async (cursor) => npxConvexRun('credentials:keyCounts', { cursor }) as KeyCountPage,
};

/** Stop with a message and a failing status. */
function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Ask, then rotate the key in the file and on the deployment, and re-seal. */
async function main(): Promise<void> {
  const assumeYes = process.argv.slice(2).includes('--yes');
  if (!existsSync(ENV_FILE)) fail(`${ENV_FILE} not found; there is no key to rotate.`);
  const values = readEnvFile();
  const configured =
    (!!values.CONVEX_SELF_HOSTED_URL && !!values.CONVEX_SELF_HOSTED_ADMIN_KEY) ||
    !!values.CONVEX_DEPLOYMENT;
  let outcome: RotationOutcome;
  try {
    outcome = await rotateCredentialKey({
      deployment: configured ? npxDeployment : undefined,
      fileKey: values[KEY_NAME],
      confirm: async (question) => {
        if (assumeYes) return true;
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await prompt.question(question);
        prompt.close();
        return answer.trim().toLowerCase() === CONFIRMATION_WORD;
      },
      writeFileKey: writeKey,
      newKey: () => randomBytes(32).toString('base64'),
      log: (line) => console.log(line),
    });
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}. ` +
        'Run this script again: a rotation that set its keys carries on where it stopped.',
    );
  }
  if (outcome.kind === 'restart-needed' || outcome.kind === 'refused') process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
