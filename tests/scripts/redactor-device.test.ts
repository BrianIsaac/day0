import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  redactorGpuDecision,
  REQUIREMENTS_FILES,
  requirementsDigests,
  STAMP_FILE,
  venvDevice,
  venvStampCommand,
} from '../../scripts/redactor-device';

const START_SCRIPT = readFileSync('redactor/start.sh', 'utf8');

describe('the stamp the start script keeps', (): void => {
  it('digests the two requirements files the way sha256sum does', (): void => {
    const digests = requirementsDigests(process.cwd());
    const expected = createHash('sha256').update(readFileSync(REQUIREMENTS_FILES.cpu)).digest('hex');
    expect(digests.cpu).toBe(expected);
    expect(digests.cuda).not.toBe(digests.cpu);
    expect(digests.cpu).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads the file the start script writes, at the path it writes it', (): void => {
    expect(START_SCRIPT).toContain(`STAMP="$VENV/${STAMP_FILE}"`);
    expect(START_SCRIPT).toContain('sha256sum "$REQUIREMENTS"');
    expect(START_SCRIPT).toContain('cuda) REQUIREMENTS=/opt/day0/requirements-cuda.txt');
    const command = venvStampCommand('day0-x_redactor_venv', 'node:22-alpine@sha256:abc');
    expect(command).toEqual([
      'run',
      '--rm',
      '-v',
      'day0-x_redactor_venv:/venv:ro',
      'node:22-alpine@sha256:abc',
      'cat',
      `/venv/${STAMP_FILE}`,
    ]);
  });

  it('names the device from the stamp, and says when there is none', (): void => {
    const digests = { cpu: 'a'.repeat(64), cuda: 'b'.repeat(64) };
    expect(venvDevice(`${'a'.repeat(64)}\n`, digests)).toBe('cpu');
    expect(venvDevice('b'.repeat(64), digests)).toBe('cuda');
    expect(venvDevice('', digests)).toBe('none');
    expect(venvDevice(undefined, digests)).toBe('none');
    expect(venvDevice('c'.repeat(64), digests)).toBe('unknown');
  });
});

describe('the GPU decision for the redactor', (): void => {
  it('keeps a warm CPU venv on the CPU under auto, even beside a driver', (): void => {
    const decision = redactorGpuDecision({ gpu: 'auto', driver: true, venv: 'cpu' });
    expect(decision.mode).toBe('off');
    expect(decision.device).toBe('cpu');
    expect(decision.rebuilds).toBe(false);
    expect(decision.reason).toContain('--gpu on');
  });

  it('says a CPU venv will be emptied before an explicit --gpu on starts it', (): void => {
    const decision = redactorGpuDecision({ gpu: 'on', driver: true, venv: 'cpu' });
    expect(decision.mode).toBe('on');
    expect(decision.rebuilds).toBe(true);
    expect(decision.reason).toContain('empties it');
    expect(decision.reason).toContain('--gpu off');
  });

  it('honours --gpu off whatever the venv, naming the rebuild when there is one', (): void => {
    expect(redactorGpuDecision({ gpu: 'off', driver: true, venv: 'cuda' })).toMatchObject({
      mode: 'off',
      device: 'cpu',
      rebuilds: true,
    });
    expect(redactorGpuDecision({ gpu: 'off', driver: true, venv: 'cpu' })).toMatchObject({
      mode: 'off',
      rebuilds: false,
    });
    expect(redactorGpuDecision({ gpu: 'off', driver: false, venv: 'none' }).rebuilds).toBe(true);
  });

  it('follows the driver when there is no venv to protect', (): void => {
    expect(redactorGpuDecision({ gpu: 'auto', driver: true, venv: 'none' })).toMatchObject({
      mode: 'auto',
      device: 'cuda',
      rebuilds: true,
    });
    expect(redactorGpuDecision({ gpu: 'auto', driver: false, venv: 'none' })).toMatchObject({
      mode: 'off',
      device: 'cpu',
    });
  });

  it('uses a CUDA venv on a GPU machine and rebuilds it on a machine without one', (): void => {
    expect(redactorGpuDecision({ gpu: 'auto', driver: true, venv: 'cuda' })).toMatchObject({
      mode: 'on',
      rebuilds: false,
    });
    expect(redactorGpuDecision({ gpu: 'auto', driver: false, venv: 'cuda' })).toMatchObject({
      mode: 'off',
      rebuilds: true,
    });
  });
});
