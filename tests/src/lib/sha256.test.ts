import { describe, expect, it } from 'vitest';
import { sha256Hex, sha256OfText } from '../../../src/lib/sha256';

describe('sha256', (): void => {
  it('answers the FIPS 180-4 test vectors', (): void => {
    expect(sha256OfText('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256OfText('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256OfText('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('digests bytes as their text is encoded, UTF-8', (): void => {
    expect(sha256Hex(new TextEncoder().encode('Grüße'))).toBe(sha256OfText('Grüße'));
  });
});
