import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BACKEND_IMAGE,
  backendImageState,
  layersInspect,
  pinnedNodeImage,
  redactorVolumeClone,
  REDACTOR_VOLUME_SUFFIXES,
} from '../../../scripts/lib/docker';

const COMPOSE_FILE = readFileSync('docker-compose.yml', 'utf8');

describe('the redactor volume copy', (): void => {
  it('takes the pinned node image off the compose file so a volume copy never pulls', (): void => {
    const image = pinnedNodeImage(COMPOSE_FILE);
    expect(image.startsWith('node:22-alpine@sha256:')).toBe(true);
    expect(() => pinnedNodeImage('services:\n  x:\n    image: node:22\n')).toThrow('pin');
  });

  it('clones the two redactor volumes with compose labels and never from or into a protected project', (): void => {
    const plan = redactorVolumeClone(
      'day0-redactor-warm',
      'day0-rehearsal-1',
      'node:22-alpine@sha256:abc',
    );
    expect(REDACTOR_VOLUME_SUFFIXES).toEqual(['redactor_venv', 'redactor_models']);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.create).toEqual([
      'volume',
      'create',
      '--label',
      'com.docker.compose.project=day0-rehearsal-1',
      '--label',
      'com.docker.compose.volume=redactor_venv',
      'day0-rehearsal-1_redactor_venv',
    ]);
    expect(plan[0]!.copy).toContain('day0-redactor-warm_redactor_venv:/from:ro');
    expect(plan[0]!.copy).toContain('day0-rehearsal-1_redactor_venv:/to');
    expect(plan[0]!.copy.join(' ')).toContain('cp -a /from/. /to/');
    expect(() => redactorVolumeClone('day0', 'day0-rehearsal-1', 'img')).toThrow('protected');
    expect(() => redactorVolumeClone('day0-redactor-warm', 'day0-demo-7c65e7', 'img')).toThrow(
      'protected',
    );
  });
});

describe('the backend image on this machine (W14-R17)', (): void => {
  const answer = (layers: readonly string[]) => ({
    status: 0,
    stdout: `${JSON.stringify(layers)}\n`,
  });
  const base = ['sha256:base-1', 'sha256:base-2'];

  it('asks Docker for an image\u2019s layers as JSON', (): void => {
    expect(layersInspect(BACKEND_IMAGE)).toEqual([
      'image',
      'inspect',
      'day0-convex-backend:git',
      '--format',
      '{{json .RootFS.Layers}}',
    ]);
  });

  it('reads an image whose layers start with the pinned base\u2019s as current, another as stale, and none as missing', (): void => {
    expect(backendImageState(answer([...base, 'sha256:git']), answer(base))).toBe('current');
    expect(backendImageState(answer(['sha256:older', 'sha256:git']), answer(base))).toBe('stale');
    expect(backendImageState(answer([...base, 'sha256:git']), { status: 1, stdout: '' })).toBe(
      'stale',
    );
    expect(backendImageState(answer([...base, 'sha256:git']), undefined)).toBe('stale');
    expect(backendImageState(answer(base), answer(base))).toBe('stale');
    expect(backendImageState({ status: 0, stdout: 'not json' }, answer(base))).toBe('stale');
    expect(backendImageState({ status: 1, stdout: '' }, answer(base))).toBe('missing');
  });
});
