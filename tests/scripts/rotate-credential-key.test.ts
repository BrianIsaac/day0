import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  COUNT_LIMIT,
  PREVIOUS_KEY_NAME,
  RESTART_MESSAGE,
  rotateCredentialKey,
  rotationQuestion,
  storedCredentialCount,
  type RotationDeployment,
  type RotationIo,
  type RotationOutcome,
} from '../../scripts/rotate-credential-key';
import { credentialKeyId, encrypt } from '../../src/lib/credential-crypto';
import { allConvexModules } from '../convex/all-modules';
import { temporaryDirectories } from '../setup/temporary-directories';

const temporary = temporaryDirectories();

const SCRIPT = resolve('scripts/rotate-credential-key.ts');
const TSX = resolve('node_modules/.bin/tsx');
const OLD_KEY = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU=';
const SELF_HOSTED =
  'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|0123\n';
const KEY = 'DAY0_CREDENTIAL_KEY';

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Run the rotation in a directory with a stand-in `npx` that records its
 * calls, holds the old key on the deployment, answers the credential listing
 * with the rows given, and reports keys the backend has not yet picked up.
 */
function rotate(
  args: readonly string[],
  input: string,
  stored: number,
): { status: number | null; output: string; calls: string[]; key: string | undefined } {
  const cwd = temporary('day0-rotate-');
  writeFileSync(join(cwd, '.env.local'), `${SELF_HOSTED}${KEY}=${OLD_KEY}\n`, 'utf8');
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const log = join(cwd, 'calls.log');
  const rows = Array.from({ length: stored }, (_, index) => `{"_id":"c${index}"}`).join('\n');
  writeFileSync(
    join(bin, 'npx'),
    [
      '#!/bin/sh',
      `echo "$*" >> "${log}"`,
      'case "$2" in',
      `  data) printf '%s\\n' '${rows}' ;;`,
      `  env) if [ "$3" = "list" ]; then printf '%s\\n' '${KEY}=${OLD_KEY}'; fi ;;`,
      `  run) printf '%s\\n' '{"current":"0000000000000000"}' ;;`,
      'esac',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(join(bin, 'npx'), 0o755);
  const result = spawnSync(TSX, [SCRIPT, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    // The stand-in was never called.
  }
  const key = new RegExp(`^${KEY}=(.*)$`, 'm').exec(
    readFileSync(join(cwd, '.env.local'), 'utf8'),
  )?.[1];
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls, key };
}

/** A fresh AES-256 key. */
function newKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * A deployment backed by the functions themselves. Its environment is what
 * `convex env` holds; the backend reads it only after `restart()`, as a
 * self-hosted backend does, unless `restartsItself` is set.
 */
class FunctionDeployment implements RotationDeployment {
  readonly env = new Map<string, string>();
  readonly harness: TestConvex<typeof schema> = convexTest(schema, allConvexModules());
  restartsItself = false;

  /** Apply the deployment's environment to what the functions read. */
  restart(): void {
    vi.unstubAllEnvs();
    for (const [name, value] of this.env) vi.stubEnv(name, value);
  }

  async envGet(name: string): Promise<string | undefined> {
    return this.env.get(name);
  }

  async envSet(name: string, value: string): Promise<void> {
    this.env.set(name, value);
    if (this.restartsItself) this.restart();
  }

  async envRemove(name: string): Promise<void> {
    this.env.delete(name);
    if (this.restartsItself) this.restart();
  }

  async storedCount(): Promise<number> {
    return await this.harness.run(
      async (ctx) => (await ctx.db.query('credentials').take(COUNT_LIMIT)).length,
    );
  }

  async keyIds(): Promise<{ current: string; previous?: string }> {
    return await this.harness.action(internal.credentialCryptoActions.keyIds, {});
  }

  async reseal(cursor: string | null): ReturnType<RotationDeployment['reseal']> {
    return await this.harness.action(internal.credentialCryptoActions.resealAll, { cursor });
  }

  async keyCounts(cursor: string | null): ReturnType<RotationDeployment['keyCounts']> {
    return await this.harness.query(internal.credentials.keyCounts, { cursor });
  }
}

/** Rotation input around a deployment: confirms, records the file and the log. */
function io(
  deployment: RotationDeployment,
  fileKey: string,
  confirm = true,
): RotationIo & { file: { key: string }; lines: string[]; asked: string[] } {
  const file = { key: fileKey };
  const lines: string[] = [];
  const asked: string[] = [];
  return {
    deployment,
    fileKey,
    file,
    lines,
    asked,
    confirm: async (question) => {
      asked.push(question);
      return confirm;
    },
    writeFileKey: (key) => {
      file.key = key;
    },
    newKey,
    log: (line) => lines.push(line),
  };
}

/** A deployment holding `key`, with rows stored the ways earlier releases stored them. */
async function storedUnder(key: string): Promise<{
  deployment: FunctionDeployment;
  rows: Record<'stored' | 'unbound' | 'lost', Id<'credentials'>>;
}> {
  const deployment = new FunctionDeployment();
  deployment.env.set(KEY, key);
  deployment.restart();
  const stored = await deployment.harness.action(internal.credentials.store, {
    userId: 'owner',
    kind: 'value',
    label: 'Linear token',
    plaintext: 'stored-value',
    source: 'entered',
  });
  const insert = async (label: string, sealed: { ciphertext: string; iv: string }) =>
    await deployment.harness.run(
      async (ctx) =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label,
          source: 'entered',
          createdAt: 1,
          ...sealed,
        }),
    );
  return {
    deployment,
    rows: {
      stored,
      unbound: await insert('Before binding', encrypt('unbound-value', key)),
      lost: await insert('Lost key', encrypt('lost-value', newKey())),
    },
  };
}

/** Each row's value, read the way a surface reads it, or the refusal. */
async function readable(
  deployment: FunctionDeployment,
  ids: readonly Id<'credentials'>[],
): Promise<string[]> {
  return await Promise.all(
    ids.map(async (credentialId) => {
      try {
        return await deployment.harness.action(internal.credentials.decrypt, { credentialId });
      } catch (error) {
        return `refused: ${error instanceof Error ? error.message : String(error)}`;
      }
    }),
  );
}

describe('rotating the credential key on purpose', (): void => {
  it('says how many stored credentials the rotation re-seals before it asks', (): void => {
    expect(storedCredentialCount('{"_id":"a"}\n{"_id":"b"}\n')).toBe(2);
    expect(storedCredentialCount('')).toBe(0);
    expect(rotationQuestion(2, true)).toContain('stores 2 credential row(s)');
    expect(rotationQuestion(2, true)).toContain('stays readable');
    expect(rotationQuestion(COUNT_LIMIT, true)).toContain(`at least ${COUNT_LIMIT}`);
    expect(rotationQuestion(0, true)).toContain('nothing to re-seal');
    expect(rotationQuestion(0, false)).toContain('only .env.local changes');
  });

  it('re-seals every stored row under the new key, leaves each readable with its key id, and drops the old key', async (): Promise<void> => {
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const { deployment, rows } = await storedUnder(OLD_KEY);
    deployment.restartsItself = true;
    const run = io(deployment, OLD_KEY);

    const outcome = await rotateCredentialKey(run);

    expect(outcome).toEqual<RotationOutcome>({ kind: 'rotated', resealed: 2, unreadable: 1 });
    const key = deployment.env.get(KEY) ?? '';
    expect(key).not.toBe(OLD_KEY);
    expect(run.file.key).toBe(key);
    expect(deployment.env.has(PREVIOUS_KEY_NAME)).toBe(false);
    const after = await deployment.harness.run(
      async (ctx) => await Promise.all([rows.stored, rows.unbound].map((id) => ctx.db.get(id))),
    );
    expect(after.map((row) => row?.keyId)).toEqual([credentialKeyId(key), credentialKeyId(key)]);
    // Only the new key is on the deployment now, and both values open under it.
    expect(await readable(deployment, [rows.stored, rows.unbound])).toEqual([
      'stored-value',
      'unbound-value',
    ]);
    expect(run.lines.join('\n')).toContain('1 row(s) no key could open');
    expect(run.lines.join('\n')).not.toContain(key);
  });

  it('stops for a restart while the backend reads the old keys, and carries on when run again', async (): Promise<void> => {
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const { deployment, rows } = await storedUnder(OLD_KEY);
    const first = io(deployment, OLD_KEY);

    expect(await rotateCredentialKey(first)).toEqual<RotationOutcome>({ kind: 'restart-needed' });
    expect(first.lines).toContain(RESTART_MESSAGE);
    const key = deployment.env.get(KEY) ?? '';
    expect(deployment.env.get(PREVIOUS_KEY_NAME)).toBe(OLD_KEY);
    expect(first.file.key).toBe(key);
    // Nothing was re-sealed under a key the backend does not read.
    expect(
      (await deployment.harness.run(async (ctx) => await ctx.db.get(rows.stored)))?.keyId,
    ).toBe(credentialKeyId(OLD_KEY));

    deployment.restart();
    // While both keys are held, a row still under the old key opens.
    expect(await readable(deployment, [rows.stored])).toEqual(['stored-value']);
    const second = io(deployment, key);
    expect(await rotateCredentialKey(second)).toMatchObject({ kind: 'rotated', resealed: 2 });
    expect(second.asked).toEqual([]);
    expect(deployment.env.has(PREVIOUS_KEY_NAME)).toBe(false);
    deployment.restart();
    expect(await readable(deployment, [rows.stored, rows.unbound])).toEqual([
      'stored-value',
      'unbound-value',
    ]);
  });

  it('carries on after a run that set the new key on the deployment and stopped before the file', async (): Promise<void> => {
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const { deployment } = await storedUnder(OLD_KEY);
    const key = newKey();
    deployment.env.set(PREVIOUS_KEY_NAME, OLD_KEY);
    deployment.env.set(KEY, key);
    deployment.restart();
    const run = io(deployment, OLD_KEY);

    expect(await rotateCredentialKey(run)).toMatchObject({ kind: 'rotated' });
    expect(run.file.key).toBe(key);
    expect(run.asked).toEqual([]);
  });

  it('puts back a set-aside key an interrupted run left without a new one, then rotates', async (): Promise<void> => {
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const { deployment, rows } = await storedUnder(OLD_KEY);
    deployment.env.set(PREVIOUS_KEY_NAME, OLD_KEY);
    deployment.restartsItself = true;
    deployment.restart();

    expect(await rotateCredentialKey(io(deployment, OLD_KEY))).toMatchObject({
      kind: 'rotated',
      resealed: 2,
    });
    expect(deployment.env.has(PREVIOUS_KEY_NAME)).toBe(false);
    expect(await readable(deployment, [rows.stored])).toEqual(['stored-value']);
  });

  it('keeps the old key on the deployment while a row still names it', async (): Promise<void> => {
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const { deployment, rows } = await storedUnder(OLD_KEY);
    deployment.restartsItself = true;
    // A re-seal that stopped short: it reports the table done and touched nothing.
    deployment.reseal = async () => ({
      read: 0,
      changed: 0,
      skipped: 0,
      cursor: null,
      isDone: true,
    });

    const outcome = await rotateCredentialKey(io(deployment, OLD_KEY));

    expect(outcome).toMatchObject({ kind: 'refused' });
    expect(deployment.env.get(PREVIOUS_KEY_NAME)).toBe(OLD_KEY);
    expect(await readable(deployment, [rows.stored])).toEqual(['stored-value']);
  });

  it('refuses from a file whose key the deployment does not hold, and changes nothing', async (): Promise<void> => {
    const { deployment } = await storedUnder(OLD_KEY);
    const run = io(deployment, newKey());

    expect(await rotateCredentialKey(run)).toMatchObject({ kind: 'refused' });
    expect(run.asked).toEqual([]);
    expect(deployment.env.get(KEY)).toBe(OLD_KEY);
    expect(deployment.env.has(PREVIOUS_KEY_NAME)).toBe(false);
  });

  it('changes nothing unless the word is typed', (): void => {
    const declined = rotate([], 'y\n', 3);
    expect(declined.status).toBe(0);
    expect(declined.output).toContain('stores 3 credential row(s)');
    expect(declined.output).toContain('Not rotated');
    expect(declined.key).toBe(OLD_KEY);
    expect(declined.calls.some((call) => call.startsWith('convex env set'))).toBe(false);
  });

  it('sets the old key aside and the new one on the deployment, each value after --, and writes the file', (): void => {
    const done = rotate([], 'rotate\n', 3);
    expect(done.key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(done.key).not.toBe(OLD_KEY);
    const sets = done.calls.filter((call) => call.startsWith('convex env set'));
    expect(sets).toEqual([
      `convex env set ${PREVIOUS_KEY_NAME} -- ${OLD_KEY}`,
      `convex env set ${KEY} -- ${done.key}`,
    ]);
    expect(done.output).not.toContain(done.key!);
    // The stand-in backend still reads the old keys: the script stops for a restart.
    expect(done.status).toBe(1);
    expect(done.output).toContain(RESTART_MESSAGE);
    expect(rotate(['--yes'], '', 0).key).not.toBe(OLD_KEY);
  });
});
