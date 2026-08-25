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
});
