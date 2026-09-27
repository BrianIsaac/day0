import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/model-up.ts');
const TSX = resolve('node_modules/.bin/tsx');
const created: string[] = [];

afterEach((): void => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('pnpm model:up', (): void => {
  it('refuses a service the GPU overlay reserves no device for, before it runs docker', (): void => {
    // A stand-in docker first on PATH leaves a mark if the script ever reaches it.
    const bin = mkdtempSync(join(tmpdir(), 'model-up-bin-'));
    created.push(bin);
    const mark = join(bin, 'docker-was-called');
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\ntouch "${mark}"\n`);
    chmodSync(join(bin, 'docker'), 0o755);
    const result = spawnSync(TSX, [SCRIPT, 'backend'], {
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '"backend" is not a service docker-compose.gpu.yml reserves a device for: model, redactor.',
    );
    expect(existsSync(mark)).toBe(false);
  });
});
