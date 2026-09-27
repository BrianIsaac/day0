import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The repository root, found from this file rather than the working directory. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const SCRIPT = join(ROOT, 'scripts/probe-docs-source.ts');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

describe('pnpm probe:docs-source', (): void => {
  it('names its one argument and fails before it calls the backend when the source id is missing', (): void => {
    const result = spawnSync(TSX, [SCRIPT], {
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '' },
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('FAIL  Usage: pnpm probe:docs-source <docSourceId>\n');
    expect(result.stdout).toBe('');
  });
});
