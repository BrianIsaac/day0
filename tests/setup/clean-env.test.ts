import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inheritedProductVariables } from './clean-env';

/** The addresses a machine that runs a local model exports in its shell. */
const MODEL_SHELL = {
  OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
  CONVEX_OPENAI_BASE_URL: 'http://host.docker.internal:11434/v1',
  OLLAMA_HOST: '127.0.0.1:11434',
  OPENAI_MODEL: 'qwen3:8b',
};

/** The part of vitest's JSON report the nested run is judged on. */
interface NestedReport {
  readonly testResults: ReadonlyArray<{ readonly name: string; readonly status: string }>;
}

describe('the suite environment', (): void => {
  it('names every product variable a shell carries and keeps the rest', (): void => {
    expect(
      inheritedProductVariables({
        ...MODEL_SHELL,
        DAY0_SURFACE_MODE: 'real',
        NEXT_PUBLIC_DEV_NO_AUTH: 'true',
        DEV_NO_AUTH_SECRET: 'local',
        SKILL_SANDBOX_SOCKET: '/tmp/sandbox.sock',
        PORT: '4999',
        PATH: '/usr/bin',
        HOME: '/home/someone',
        NODE_ENV: 'test',
        TZ: 'UTC',
      }),
    ).toEqual([
      'CONVEX_OPENAI_BASE_URL',
      'DAY0_SURFACE_MODE',
      'DEV_NO_AUTH_SECRET',
      'NEXT_PUBLIC_DEV_NO_AUTH',
      'OLLAMA_HOST',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
      'PORT',
      'SKILL_SANDBOX_SOCKET',
    ]);
  });

  it('starts every test file with none of them', (): void => {
    expect(inheritedProductVariables(process.env)).toEqual([]);
  });

  it('passes the model-address tests from a shell that exports a local model', (): void => {
    // The two files that read the model address at import, run as the gate runs them.
    // The outcome is read from the JSON report, not the console summary: the
    // summary is coloured on a CI runner and plain under a coding agent. The
    // console output stays as the message a failure prints.
    const reportDir = mkdtempSync(join(tmpdir(), 'clean-env-'));
    const reportFile = join(reportDir, 'report.json');
    try {
      const run = spawnSync(
        process.execPath,
        [
          'node_modules/vitest/vitest.mjs',
          'run',
          '--project',
          'node',
          '--reporter=default',
          '--reporter=json',
          `--outputFile.json=${reportFile}`,
          'tests/src/evaluation/harness-parity.test.ts',
          'tests/src/lib/mastra-temperature.test.ts',
        ],
        { env: { ...process.env, ...MODEL_SHELL }, encoding: 'utf8', timeout: 60_000 },
      );
      expect(run.status, run.stdout + run.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportFile, 'utf8')) as NestedReport;
      expect(
        report.testResults
          .map((file) => [relative(process.cwd(), file.name), file.status])
          .sort(([left], [right]) => left.localeCompare(right)),
      ).toEqual([
        ['tests/src/evaluation/harness-parity.test.ts', 'passed'],
        ['tests/src/lib/mastra-temperature.test.ts', 'passed'],
      ]);
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  }, 70_000);
});
