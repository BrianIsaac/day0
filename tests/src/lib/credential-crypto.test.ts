import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../../../src/lib/credential-crypto';

/** Generate one valid AES-256 key for a test case. */
function key(): string {
  return randomBytes(32).toString('base64');
}

describe('credential crypto', (): void => {
  it('round-trips plaintext with a fresh IV', (): void => {
    const credentialKey = key();
    const first = encrypt('local test credential', credentialKey);
    const second = encrypt('local test credential', credentialKey);
    expect(decrypt(first, credentialKey)).toBe('local test credential');
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('refuses a wrong key', (): void => {
    const encrypted = encrypt('local test credential', key());
    expect(() => decrypt(encrypted, key())).toThrow('Credential decryption failed');
  });

  it('refuses tampered ciphertext', (): void => {
    const credentialKey = key();
    const encrypted = encrypt('local test credential', credentialKey);
    const payload = Buffer.from(encrypted.ciphertext, 'base64');
    payload[0] ^= 1;
    expect(() =>
      decrypt({ ...encrypted, ciphertext: payload.toString('base64') }, credentialKey),
    ).toThrow('Credential decryption failed');
  });

  it('refuses a wrong IV', (): void => {
    const credentialKey = key();
    const encrypted = encrypt('local test credential', credentialKey);
    const iv = Buffer.from(encrypted.iv, 'base64');
    iv[0] ^= 1;
    expect(() => decrypt({ ...encrypted, iv: iv.toString('base64') }, credentialKey)).toThrow(
      'Credential decryption failed',
    );
  });

  it('refuses a key that is not canonical 32-byte base64', (): void => {
    for (const invalid of [
      '',
      'short',
      randomBytes(16).toString('base64'),
      randomBytes(48).toString('base64'),
      `${randomBytes(32).toString('base64').slice(0, 43)}A`,
      randomBytes(32).toString('base64url'),
    ]) {
      expect(() => encrypt('local test credential', invalid)).toThrow('32-byte key');
    }
  });

  it('rejects an empty ciphertext or a payload too short to hold a tag', (): void => {
    const credentialKey = key();
    const iv = encrypt('local test credential', credentialKey).iv;
    expect(() => decrypt({ ciphertext: '', iv }, credentialKey)).toThrow(
      'Credential decryption failed',
    );
    expect(() =>
      decrypt({ ciphertext: Buffer.alloc(4).toString('base64'), iv }, credentialKey),
    ).toThrow('Credential decryption failed');
  });

  it('round-trips an empty string and multi-byte content', (): void => {
    const credentialKey = key();
    for (const plaintext of ['', 'nt' + 'n_'.repeat(24), '柑橘 secret 🍊']) {
      expect(decrypt(encrypt(plaintext, credentialKey), credentialKey)).toBe(plaintext);
    }
  });
});
