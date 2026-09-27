import { describe, expect, it } from 'vitest';
import { fnv1a32, shortHash } from '../../../src/lib/short-hash';

describe('fnv1a32', () => {
  it('matches the published FNV-1a test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('hashes the UTF-8 bytes, so two Chinese names differ', () => {
    expect(fnv1a32('飞书')).not.toBe(fnv1a32('钉钉'));
  });
});

describe('shortHash', () => {
  it('is seven lowercase base-36 characters for every input', () => {
    for (const text of ['', 'a', '运维/刷新看板.md', 'x'.repeat(500)]) {
      expect(shortHash(text)).toMatch(/^[0-9a-z]{7}$/);
    }
  });

  it('is stable across calls', () => {
    expect(shortHash('规则.md')).toBe(shortHash('规则.md'));
  });
});
