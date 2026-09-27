import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writePrivateEnv } from '../../scripts/private-env';

const created: string[] = [];

afterEach((): void => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'private-env-'));
  created.push(path);
  return path;
}

describe('writing a secret file', (): void => {
  it('publishes the whole text readable by its owner only, and leaves no temporary file', (): void => {
    const root = directory();
    const path = join(root, '.env.local');
    writePrivateEnv(path, 'OPENAI_API_KEY=synthetic\n');
    expect(readFileSync(path, 'utf8')).toBe('OPENAI_API_KEY=synthetic\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(['.env.local']);
  });

  it('replaces a file that was readable by others with one that is not', (): void => {
    const root = directory();
    const path = join(root, '.env.local');
    writeFileSync(path, 'OLD=1\n', { mode: 0o644 });
    writePrivateEnv(path, 'NEW=1\n');
    expect(readFileSync(path, 'utf8')).toBe('NEW=1\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
