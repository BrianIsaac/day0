import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BACKEND_BASE_LABEL,
  BACKEND_IMAGE,
  backendImageState,
  baseLabelInspect,
  dockerfileBaseLabel,
  layersInspect,
  referenceDigest,
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

  it('trusts the built image by its base label, whether or not the base image is on this machine (W14-R20)', (): void => {
    const digest = `sha256:${'d7'.repeat(32)}`;
    const labelled = (value: string): { status: number; stdout: string } => ({
      status: 0,
      stdout: `${value}\n`,
    });
    const built = answer([...base, 'sha256:git']);
    const gone = { status: 1, stdout: '' };
    // A built image loaded from a file (`docker load`): its base was never pulled here.
    expect(backendImageState(built, gone, { inspected: labelled(digest), digest })).toBe('current');
    expect(backendImageState(built, undefined, { inspected: labelled(digest), digest })).toBe(
      'current',
    );
    // Built from another pin: stale by its label, even though some layers of the base match.
    expect(
      backendImageState(built, answer(base), {
        inspected: labelled(`sha256:${'0a'.repeat(32)}`),
        digest,
      }),
    ).toBe('stale');
    // Built before the label: the layers decide, as before.
    expect(backendImageState(built, answer(base), { inspected: labelled(''), digest })).toBe(
      'current',
    );
    expect(backendImageState(built, gone, { inspected: labelled('<no value>'), digest })).toBe(
      'stale',
    );
    expect(backendImageState(gone, answer(base), { inspected: gone, digest })).toBe('missing');
  });

  it('reads the base digest off a pinned reference and off the Dockerfile\u2019s label, and asks Docker for the label', (): void => {
    const digest = `sha256:${'d7'.repeat(32)}`;
    expect(referenceDigest(`ghcr.io/get-convex/convex-backend:latest@${digest}`)).toBe(digest);
    expect(referenceDigest('ghcr.io/get-convex/convex-backend:latest')).toBeUndefined();
    expect(referenceDigest(undefined)).toBeUndefined();
    expect(dockerfileBaseLabel(`FROM x@${digest}\nLABEL ${BACKEND_BASE_LABEL}="${digest}"\n`)).toBe(
      digest,
    );
    expect(dockerfileBaseLabel(`FROM x@${digest}\n`)).toBeUndefined();
    expect(baseLabelInspect(BACKEND_IMAGE)).toEqual([
      'image',
      'inspect',
      'day0-convex-backend:git',
      '--format',
      '{{index .Config.Labels "dev.dayzer0.backend.base"}}',
    ]);
  });
});
