import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/probe-mcp.ts');
const TSX = resolve('node_modules/.bin/tsx');

describe('pnpm probe:mcp', (): void => {
  it('names its one argument and fails before it calls the backend when the source id is missing', (): void => {
    const result = spawnSync(TSX, [SCRIPT], {
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '' },
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('FAIL  Usage: pnpm probe:mcp <docSourceId>\n');
    expect(result.stdout).toBe('');
  });
});
