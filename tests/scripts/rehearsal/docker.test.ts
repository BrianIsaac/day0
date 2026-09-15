import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BED_PROFILES,
  bedComposeArgs,
  parseLines,
  pinnedNodeImage,
  redactorVolumeClone,
  REDACTOR_VOLUME_SUFFIXES,
} from '../../../scripts/rehearsal/docker';

const COMPOSE_FILE = readFileSync('docker-compose.yml', 'utf8');

describe('compose invocation for the bed', (): void => {
  it('names the project, the env file and the five real-mode profiles', (): void => {
    expect(BED_PROFILES).toEqual(['real', 'sandbox', 'browser', 'demo', 'redactor']);
    const args = bedComposeArgs('day0-rehearsal-1', '/tmp/c/.env.local');
    expect(args.slice(0, 5)).toEqual(['compose', '-p', 'day0-rehearsal-1', '--env-file', '/tmp/c/.env.local']);
    expect(args.filter((a) => a === '--profile')).toHaveLength(5);
  });

  it('takes the pinned node image off the compose file so a volume copy never pulls', (): void => {
    const image = pinnedNodeImage(COMPOSE_FILE);
    expect(image.startsWith('node:22-alpine@sha256:')).toBe(true);
    expect(() => pinnedNodeImage('services:\n  x:\n    image: node:22\n')).toThrow('pin');
  });

  it('clones the two redactor volumes with compose labels and never from or into a protected project', (): void => {
    const plan = redactorVolumeClone('day0-redactor-warm', 'day0-rehearsal-1', 'node:22-alpine@sha256:abc');
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
    expect(() => redactorVolumeClone('day0-redactor-warm', 'day0-demo-7c65e7', 'img')).toThrow('protected');
  });

  it('splits docker list output into trimmed non-empty lines', (): void => {
    expect(parseLines(' a \n\nb\n')).toEqual(['a', 'b']);
  });
});
