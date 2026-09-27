import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { USAGE } from '../../../scripts/bed/rehearsal/options';

const SCRIPT = resolve('scripts/bed/rehearse.ts');
const TSX = resolve('node_modules/.bin/tsx');

/** Run the entry as `pnpm bed:rehearse` does, with nothing from the shell but PATH. */
function rehearse(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(TSX, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '' },
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('pnpm bed:rehearse', (): void => {
  it('prints its options and exits 0 on --help, before it reads git, docker or a secret', (): void => {
    const run = rehearse(['--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(USAGE);
    expect(USAGE).toContain('pnpm bed:rehearse');
  });

  it('refuses to start without a secrets file and says which option is missing', (): void => {
    const run = rehearse([]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--secrets <file> is required.');
  });
});
