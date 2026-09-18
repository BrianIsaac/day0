/** @vitest-environment node */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verdictFor, type AuthorSkillArgs, type SkillSandboxRun } from '../../src/lib/skill-sandbox';
import {
  RECORDED_ASSERTION_LINE,
  RECORDED_BODY_2026_09_18,
  reconstructedSmokeTest,
  recordedAssertion,
  rehearsalSmokeIds,
} from '../fixtures/skill-smoke-assertion-2026-09-18';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

/**
 * Run a program the way both sandboxes do: SKILL.md beside smoke.py and
 * `python smoke.py` in that directory, judged by the shared verdict rule.
 */
async function runInPython(args: AuthorSkillArgs): Promise<SkillSandboxRun> {
  const dir = mkdtempSync(join(tmpdir(), 'day0-smoke-'));
  try {
    writeFileSync(join(dir, 'SKILL.md'), args.skillBody);
    writeFileSync(join(dir, 'smoke.py'), args.smokeTest);
    const run = spawnSync('python3', ['smoke.py'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    return verdictFor('local', {
      sandboxId: 'local:test',
      exitCode: run.status ?? 1,
      stdout: run.stdout,
      stderr: run.stderr,
      timedOut: run.signal !== null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Verify with the authoring module as the surface mode stubbed beforehand loads it. */
async function verifyAsLoaded(smokeTest: string) {
  const { verifyAuthoredSkill } = await import('../../convex/skillActions');
  return await verifyAuthoredSkill(
    { skillName: 'kanban-comment-and-close', skillBody: RECORDED_BODY_2026_09_18, smokeTest },
    runInPython,
  );
}

describe("the rehearsal's kanban-comment-and-close authoring (F2, 18 Sep)", (): void => {
  afterEach((): void => {
    restoreSurfaceMode();
  });

  it('carries the recorded assertion at the line the sandbox named', (): void => {
    const ids = rehearsalSmokeIds();
    const lines = reconstructedSmokeTest(ids).split('\n');
    expect(lines[RECORDED_ASSERTION_LINE - 1]).toBe(recordedAssertion(ids.asserted));
    expect(RECORDED_BODY_2026_09_18).not.toContain(ids.asserted);
  });

  it('fails in mock mode exactly as the rehearsal saw it, because the program runs as written', async (): Promise<void> => {
    const ids = rehearsalSmokeIds();
    const smokeTest = reconstructedSmokeTest(ids);

    useSurfaceMode('mock');
    const verification = await verifyAsLoaded(smokeTest);

    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    expect(verification.smokeTest).toBe(smokeTest);
    expect(verification.result.ok).toBe(false);
    expect(verification.result.failureReason).toBe('smoke test exited 1');
    expect(verification.result.stderr).toContain(`line ${RECORDED_ASSERTION_LINE}, in <module>`);
    expect(verification.result.stderr).toContain(recordedAssertion(ids.asserted));
    expect(verification.result.stderr).toContain('AssertionError');
  });

  it('registers first time in real mode: no assertion the author wrote decides the verdict', async (): Promise<void> => {
    const ids = rehearsalSmokeIds();
    const smokeTest = reconstructedSmokeTest(ids);

    useSurfaceMode('real');
    const verification = await verifyAsLoaded(smokeTest);

    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    // The row keeps what the author wrote; the harness is only what ran.
    expect(verification.smokeTest).toBe(smokeTest);
    expect(verification.result.failureReason).toBeUndefined();
    expect(verification.result.ok).toBe(true);
    expect(verification.result.stdout).toContain(ids.asserted);
    expect(verification.result.stdout).toContain(ids.other);
  });
});
