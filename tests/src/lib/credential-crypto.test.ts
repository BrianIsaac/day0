import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_KEY_CHANGED_MESSAGE,
  credentialOwnerBinding,
  decrypt,
  encrypt,
  openOwnedCredential,
} from '../../../src/lib/credential-crypto';

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

describe('credential crypto associated data', (): void => {
  it('opens a value only with the associated data it was sealed under', (): void => {
    const credentialKey = key();
    const sealed = encrypt(
      'local test credential',
      credentialKey,
      credentialOwnerBinding('owner-a'),
    );
    expect(decrypt(sealed, credentialKey, credentialOwnerBinding('owner-a'))).toBe(
      'local test credential',
    );
    expect(() => decrypt(sealed, credentialKey, credentialOwnerBinding('owner-b'))).toThrow(
      'Credential decryption failed',
    );
    expect(() => decrypt(sealed, credentialKey)).toThrow('Credential decryption failed');
  });

  it('binds a value to its owner so ciphertext moved to another owner does not open', (): void => {
    const credentialKey = key();
    const sealed = encrypt(
      'local test credential',
      credentialKey,
      credentialOwnerBinding('owner-a'),
    );
    expect(() => openOwnedCredential(sealed, credentialKey, 'owner-b')).toThrow(
      'Credential decryption failed',
    );
    expect(openOwnedCredential(sealed, credentialKey, 'owner-a')).toBe('local test credential');
  });

  it('still opens a value sealed before associated data existed', (): void => {
    const credentialKey = key();
    const legacy = encrypt('local test credential', credentialKey);
    expect(openOwnedCredential(legacy, credentialKey, 'owner-a')).toBe('local test credential');
  });

  it('says the credential key changed when the key cannot open a value', (): void => {
    const sealed = encrypt('local test credential', key(), credentialOwnerBinding('owner-a'));
    expect(() => openOwnedCredential(sealed, key(), 'owner-a')).toThrow(
      CREDENTIAL_KEY_CHANGED_MESSAGE,
    );
    expect(CREDENTIAL_KEY_CHANGED_MESSAGE).toMatch(/credential key changed/);
  });
});
