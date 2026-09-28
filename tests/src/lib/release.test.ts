import { describe, expect, it } from 'vitest';
import { compareReleases, NEWEST_MIGRATION_RELEASE, releaseParts } from '../../../src/lib/release';

describe('the release facts the code carries', (): void => {
  it('names the newest migration release as three numbers', (): void => {
    expect(releaseParts(NEWEST_MIGRATION_RELEASE)).toBeDefined();
  });

  it('reads a release as three numbers and nothing else', (): void => {
    expect(releaseParts('0.10.0')).toEqual([0, 10, 0]);
    for (const shape of ['v0.6.0', '0.6', '0.6.0-rc1', 'latest', '01.2.3', '']) {
      expect(releaseParts(shape), shape).toBeUndefined();
    }
  });

  it('compares releases numerically, and refuses a shape that is not one', (): void => {
    expect(compareReleases('0.5.0', '0.6.0')).toBeLessThan(0);
    expect(compareReleases('0.6.0', '0.6.0')).toBe(0);
    expect(compareReleases('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareReleases('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(() => compareReleases('v0.6.0', '0.6.0')).toThrow('not a release');
    expect(() => compareReleases('0.6.0', 'latest')).toThrow('not a release');
  });
});
