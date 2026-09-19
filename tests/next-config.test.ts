import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';

describe('next.config.mjs', (): void => {
  it('draws no development badge: the recording is taken from `next dev`, and the badge was in every frame', (): void => {
    expect(nextConfig.devIndicators).toBe(false);
  });
});
