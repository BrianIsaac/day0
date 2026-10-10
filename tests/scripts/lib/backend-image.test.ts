import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BACKEND_BASE_LABEL,
  dockerfileBaseLabel,
  dockerfilePinnedDigest,
  referenceDigest,
} from '../../../scripts/lib/backend-image';

const DIGEST = `sha256:${'d7'.repeat(32)}`;

describe('the backend image and its base', (): void => {
  it('reads the digest a Dockerfile pins its first FROM by, with or without a platform', (): void => {
    expect(
      dockerfilePinnedDigest(`# a comment\nFROM example/base:latest@${DIGEST}\nRUN true\n`),
    ).toBe(DIGEST);
    expect(
      dockerfilePinnedDigest(`FROM --platform=linux/amd64 example/base@${DIGEST} AS build\n`),
    ).toBe(DIGEST);
    expect(dockerfilePinnedDigest('FROM example/base:latest\n')).toBeUndefined();
    expect(dockerfilePinnedDigest('RUN true\n')).toBeUndefined();
  });

  it('reads the same digest off the shipped Dockerfile’s FROM line and its label (W14-R20)', (): void => {
    const dockerfile = readFileSync('docker/backend.Dockerfile', 'utf8');
    const pinned = dockerfilePinnedDigest(dockerfile);
    expect(pinned).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(dockerfileBaseLabel(dockerfile)).toBe(pinned);
    expect(BACKEND_BASE_LABEL).toBe('dev.dayzer0.backend.base');
  });

  it('takes a digest only from a reference that ends on one', (): void => {
    expect(referenceDigest(`example/base:latest@${DIGEST}`)).toBe(DIGEST);
    expect(referenceDigest(`example/base@${DIGEST}-suffix`)).toBeUndefined();
  });
});
