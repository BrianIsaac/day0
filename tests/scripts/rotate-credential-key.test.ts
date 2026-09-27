import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COUNT_LIMIT,
  rotationQuestion,
  storedCredentialCount,
} from '../../scripts/rotate-credential-key';

const SCRIPT = resolve('scripts/rotate-credential-key.ts');
const TSX = resolve('node_modules/.bin/tsx');
const OLD_KEY = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU=';
const SELF_HOSTED =
  'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|0123\n';

/**
 * Run the rotation in a directory with a stand-in `npx` that records its
 * calls and answers the credential listing with the rows given.
 */
function rotate(
  args: readonly string[],
  input: string,
  stored: number,
): { status: number | null; output: string; calls: string[]; key: string | undefined } {
  const cwd = mkdtempSync(join(tmpdir(), 'day0-rotate-'));
  writeFileSync(join(cwd, '.env.local'), `${SELF_HOSTED}DAY0_CREDENTIAL_KEY=${OLD_KEY}\n`, 'utf8');
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const log = join(cwd, 'calls.log');
  const rows = Array.from({ length: stored }, (_, index) => `{"_id":"c${index}"}`).join('\n');
  writeFileSync(
    join(bin, 'npx'),
    `#!/bin/sh\necho "$*" >> "${log}"\nif [ "$2" = "data" ]; then printf '%s\\n' '${rows}'; fi\n`,
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
  const key = /^DAY0_CREDENTIAL_KEY=(.*)$/m.exec(
    readFileSync(join(cwd, '.env.local'), 'utf8'),
  )?.[1];
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls, key };
}

describe('rotating the credential key on purpose', (): void => {
  it('says how many stored credentials the rotation leaves unreadable before it asks', (): void => {
    expect(storedCredentialCount('{"_id":"a"}\n{"_id":"b"}\n')).toBe(2);
    expect(storedCredentialCount('')).toBe(0);
    expect(rotationQuestion(2, true)).toContain('stores 2 credential row(s)');
    expect(rotationQuestion(COUNT_LIMIT, true)).toContain(`at least ${COUNT_LIMIT}`);
    expect(rotationQuestion(0, true)).toContain('nothing becomes unreadable');
    expect(rotationQuestion(0, false)).toContain('only .env.local changes');
  });

  it('changes nothing unless the word is typed', (): void => {
    const declined = rotate([], 'y\n', 3);
    expect(declined.status).toBe(0);
    expect(declined.output).toContain('stores 3 credential row(s)');
    expect(declined.output).toContain('Not rotated');
    expect(declined.key).toBe(OLD_KEY);
    expect(declined.calls.some((call) => call.startsWith('convex env set'))).toBe(false);
  });

  it('writes a new key to the file and the deployment on the confirmation, the value after --', (): void => {
    const done = rotate([], 'rotate\n', 3);
    expect(done.status).toBe(0);
    expect(done.key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(done.key).not.toBe(OLD_KEY);
    expect(done.calls).toContain(`convex env set DAY0_CREDENTIAL_KEY -- ${done.key}`);
    expect(done.output).not.toContain(done.key!);
    expect(rotate(['--yes'], '', 0).key).not.toBe(OLD_KEY);
  });
});
