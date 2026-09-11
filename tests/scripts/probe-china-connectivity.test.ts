import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/probe-china-connectivity.sh');

/**
 * Run the probe without touching the network.
 *
 * Args:
 *   args: Command-line arguments handed to the script.
 *   env: Extra environment variables for the child process.
 *
 * Returns:
 *   Exit status, standard output and standard error.
 */
function runProbe(
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), 'day0-probe-china-'));
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, FEATHERLESS_API_KEY: '', ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('probe-china-connectivity.sh', (): void => {
  it('parses under bash and prints usage', (): void => {
    const syntax = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
    const { status, stdout } = runProbe(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--env-file');
    expect(stdout).toContain('Reachability is a network fact');
  });

  it('reads the key from an env file without printing it', (): void => {
    const directory = mkdtempSync(join(tmpdir(), 'day0-probe-china-env-'));
    const envFile = join(directory, '.env.local');
    const secret = ['fl', 'test', 'secret-value-9f1a'].join('-');
    writeFileSync(envFile, `OTHER=1\nFEATHERLESS_API_KEY="${secret}"\n`, 'utf8');
    const { status, stdout, stderr } = runProbe(['--env-file', envFile, '--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toContain('key         present, from');
    expect(stdout).toContain(`${secret.length} characters`);
    expect(stdout).not.toContain(secret);
    expect(stderr).not.toContain(secret);
    expect(stdout).toContain('dry run: no request made');
  });

  it('reports an absent key as pending rather than failing', (): void => {
    const { status, stdout } = runProbe(['--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toContain('authenticated steps are pending');
  });

  it('derives the host from an alternate base URL and key variable', (): void => {
    const { status, stdout } = runProbe([
      '--base-url',
      'https://api.z.ai/api/paas/v4/',
      '--model',
      'glm-5.3-flash',
      '--key-var',
      'ZAI_API_KEY',
      '--dry-run',
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('base URL    https://api.z.ai/api/paas/v4\n');
    expect(stdout).toContain('host        api.z.ai');
    expect(stdout).toContain('set ZAI_API_KEY');
  });

  it('rejects unknown options and bad values with a usage error', (): void => {
    expect(runProbe(['--bogus']).status).toBe(64);
    expect(runProbe(['--thinking', 'maybe', '--dry-run']).status).toBe(64);
    expect(runProbe(['--timeout', 'soon', '--dry-run']).status).toBe(64);
  });
});
