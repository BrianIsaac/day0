import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { inheritedProductVariables } from './clean-env';

/** The addresses a machine that runs a local model exports in its shell. */
const MODEL_SHELL = {
  OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
  CONVEX_OPENAI_BASE_URL: 'http://host.docker.internal:11434/v1',
  OLLAMA_HOST: '127.0.0.1:11434',
  OPENAI_MODEL: 'qwen3:8b',
};

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
    const run = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--project',
        'node',
        'tests/src/evaluation/harness-parity.test.ts',
        'tests/src/lib/mastra-temperature.test.ts',
      ],
      { env: { ...process.env, ...MODEL_SHELL }, encoding: 'utf8', timeout: 60_000 },
    );
    expect(run.stdout + run.stderr).toMatch(/Test Files {2}2 passed/);
    expect(run.status).toBe(0);
  }, 70_000);
});
