import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gateEnvironment, gateSteps, type GateStep } from '../../scripts/gate';

const WORKFLOW = readFileSync(new URL('../../.github/workflows/gate.yml', import.meta.url), 'utf8');

describe('gateSteps', () => {
  it("runs the workflow's own commands after the install, in order", () => {
    expect(gateSteps(WORKFLOW).map((step) => step.run)).toEqual([
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'NEXT_PUBLIC_DEV_NO_AUTH= pnpm build',
    ]);
  });

  it("gives each step the job's zone and the build its placeholder deployment", () => {
    const steps = gateSteps(WORKFLOW);
    for (const step of steps) expect(step.env.TZ).toBe('UTC');
    const build = steps.at(-1)!;
    expect(build.env.NEXT_PUBLIC_CONVEX_URL).toBe('https://convex.example.invalid');
    expect(steps[0]!.env.NEXT_PUBLIC_CONVEX_URL).toBeUndefined();
  });

  it('refuses a workflow with no install step to start after', () => {
    expect(() => gateSteps('jobs:\n  gate:\n    steps:\n      - run: pnpm test\n')).toThrow(
      /no pnpm install step/,
    );
  });
});

describe('gateEnvironment', () => {
  const step: GateStep = { name: 'Test', run: 'pnpm test', env: { TZ: 'UTC' } };

  it("drops a coding agent's variables and a shell's deployment keys, as the runner has neither", () => {
    const env = gateEnvironment(
      {
        HOME: '/home/someone',
        PATH: '/usr/bin',
        CLAUDECODE: '1',
        AI_AGENT: 'claude-code',
        CONVEX_DEPLOYMENT: 'local:dev',
        NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210',
      },
      step,
    );
    expect(env).toEqual({ HOME: '/home/someone', PATH: '/usr/bin', CI: 'true', TZ: 'UTC' });
  });

  it("runs in the workflow's zone whatever the host's, and keeps the temporary directory", () => {
    expect(
      gateEnvironment({ PATH: '/usr/bin', TMPDIR: '/tmp/x', TZ: 'Asia/Singapore' }, step),
    ).toEqual({
      PATH: '/usr/bin',
      TMPDIR: '/tmp/x',
      CI: 'true',
      TZ: 'UTC',
    });
  });
});
