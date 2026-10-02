import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_KEY_CHANGED_MESSAGE,
  credentialBindingOf,
  credentialKeyId,
  credentialOrganisationBinding,
  credentialOwnerBinding,
  credentialValueFingerprint,
  decrypt,
  encrypt,
  openOwnedCredential,
  sealForOwner,
} from '../../../src/lib/credential-crypto';
import { ORGANISATION_OWNER_KEY } from '../../../src/lib/organisation-key';

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
    const keyring = { current: key() };
    const sealed = sealForOwner('local test credential', keyring, 'owner-a');
    expect(() =>
      openOwnedCredential({ ...sealed, userId: 'owner-b' }, keyring, { allowUnbound: true }),
    ).toThrow('Credential decryption failed');
    expect(
      openOwnedCredential({ ...sealed, userId: 'owner-a' }, keyring, { allowUnbound: false }),
    ).toBe('local test credential');
  });

  it('still opens a value sealed before associated data existed, until the re-seal has bound every row', (): void => {
    const keyring = { current: key() };
    const legacy = { ...encrypt('local test credential', keyring.current), userId: 'owner-a' };
    expect(openOwnedCredential(legacy, keyring, { allowUnbound: true })).toBe(
      'local test credential',
    );
    expect(() => openOwnedCredential(legacy, keyring, { allowUnbound: false })).toThrow(
      CREDENTIAL_KEY_CHANGED_MESSAGE,
    );
  });

  it('opens a keyless row bound to its owner under a restored key after the re-seal, and refuses only an unbound one', (): void => {
    const lost = key();
    const bound = {
      ...encrypt('bound under the lost key', lost, credentialOwnerBinding('owner-a')),
      userId: 'owner-a',
    };
    const unbound = { ...encrypt('unbound under the lost key', lost), userId: 'owner-a' };
    const withoutIt = { current: key() };
    expect(() => openOwnedCredential(bound, withoutIt, { allowUnbound: false })).toThrow(
      CREDENTIAL_KEY_CHANGED_MESSAGE,
    );
    const restored = { current: withoutIt.current, previous: lost };
    expect(openOwnedCredential(bound, restored, { allowUnbound: false })).toBe(
      'bound under the lost key',
    );
    expect(() =>
      openOwnedCredential({ ...bound, userId: 'owner-b' }, restored, { allowUnbound: false }),
    ).toThrow(CREDENTIAL_KEY_CHANGED_MESSAGE);
    expect(() => openOwnedCredential(unbound, restored, { allowUnbound: false })).toThrow(
      CREDENTIAL_KEY_CHANGED_MESSAGE,
    );
    expect(openOwnedCredential(unbound, restored, { allowUnbound: true })).toBe(
      'unbound under the lost key',
    );
  });

  it('never opens a keyed row unbound, even while legacy rows may still open that way', (): void => {
    const keyring = { current: key() };
    const unbound = encrypt('local test credential', keyring.current);
    expect(() =>
      openOwnedCredential(
        { ...unbound, userId: 'owner-a', keyId: credentialKeyId(keyring.current) },
        keyring,
        { allowUnbound: true },
      ),
    ).toThrow(CREDENTIAL_KEY_CHANGED_MESSAGE);
  });

  it('says the credential key changed when the key cannot open a value', (): void => {
    const sealed = sealForOwner('local test credential', { current: key() }, 'owner-a');
    expect(() =>
      openOwnedCredential(
        { ...sealed, userId: 'owner-a' },
        { current: key() },
        {
          allowUnbound: true,
        },
      ),
    ).toThrow(CREDENTIAL_KEY_CHANGED_MESSAGE);
    expect(CREDENTIAL_KEY_CHANGED_MESSAGE).toMatch(/credential key changed/);
  });
});

describe('credential key ids and the keyring', (): void => {
  it('names a key by a stable id that is not the key and differs between keys', (): void => {
    const first = key();
    const id = credentialKeyId(first);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(credentialKeyId(first)).toBe(id);
    expect(credentialKeyId(key())).not.toBe(id);
    expect(first).not.toContain(id);
  });

  it('seals under the current key and writes its id', (): void => {
    const keyring = { current: key(), previous: key() };
    const sealed = sealForOwner('local test credential', keyring, 'owner-a');
    expect(sealed.keyId).toBe(credentialKeyId(keyring.current));
    expect(decrypt(sealed, keyring.current, credentialOwnerBinding('owner-a'))).toBe(
      'local test credential',
    );
  });

  it('opens a row sealed under the previous key while a rotation is under way, and not after', (): void => {
    const old = key();
    const sealed = {
      ...sealForOwner('local test credential', { current: old }, 'owner-a'),
      userId: 'owner-a',
    };
    const rotating = { current: key(), previous: old };
    expect(openOwnedCredential(sealed, rotating, { allowUnbound: false })).toBe(
      'local test credential',
    );
    expect(() =>
      openOwnedCredential(sealed, { current: rotating.current }, { allowUnbound: false }),
    ).toThrow(CREDENTIAL_KEY_CHANGED_MESSAGE);
  });

  it('opens a legacy row sealed under the previous key, bound or not, while unbound rows may open', (): void => {
    const old = key();
    const rotating = { current: key(), previous: old };
    const unbound = { ...encrypt('unbound value', old), userId: 'owner-a' };
    const bound = {
      ...encrypt('bound value', old, credentialOwnerBinding('owner-a')),
      userId: 'owner-a',
    };
    expect(openOwnedCredential(unbound, rotating, { allowUnbound: true })).toBe('unbound value');
    expect(openOwnedCredential(bound, rotating, { allowUnbound: true })).toBe('bound value');
  });
});

describe('credential value fingerprints', (): void => {
  it('keys a value by what it is, the same wherever it is found, and differs for another value, owner or key', (): void => {
    const credentialKey = key();
    const fingerprint = credentialValueFingerprint('hunter2-value', credentialKey, 'owner-a');
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(credentialValueFingerprint('hunter2-value', credentialKey, 'owner-a')).toBe(fingerprint);
    expect(credentialValueFingerprint('hunter3-value', credentialKey, 'owner-a')).not.toBe(
      fingerprint,
    );
    expect(credentialValueFingerprint('hunter2-value', credentialKey, 'owner-b')).not.toBe(
      fingerprint,
    );
    expect(credentialValueFingerprint('hunter2-value', key(), 'owner-a')).not.toBe(fingerprint);
  });

  it('is neither the key id nor a plain hash of the value, so it names no key and cannot be tested without one', (): void => {
    const credentialKey = key();
    const fingerprint = credentialValueFingerprint('hunter2-value', credentialKey, 'owner-a');
    expect(fingerprint).not.toContain(credentialKeyId(credentialKey));
    expect(createHash('sha256').update('hunter2-value').digest('hex')).not.toContain(fingerprint);
  });

  it('refuses a key that is not 32 bytes of canonical base64', (): void => {
    expect(() => credentialValueFingerprint('value', 'not-a-key', 'owner-a')).toThrow(
      'must be a base64-encoded 32-byte key',
    );
  });
});

describe('the organisation seal (F18, AC12)', (): void => {
  it('binds an organisation row to the reserved key in its own namespace, never as an owner', (): void => {
    expect(credentialBindingOf(ORGANISATION_OWNER_KEY)).toBe(credentialOrganisationBinding());
    expect(credentialOrganisationBinding()).toContain(ORGANISATION_OWNER_KEY);
    expect(credentialOrganisationBinding()).not.toBe(
      credentialOwnerBinding(ORGANISATION_OWNER_KEY),
    );
    expect(credentialBindingOf('owner')).toBe(credentialOwnerBinding('owner'));
  });

  it('opens what it sealed for the organisation, and nothing sealed as an owner or moved from one', (): void => {
    const keyring = { current: key() };
    const sealed = sealForOwner('xoxe-1234567890-abcdefghij', keyring, ORGANISATION_OWNER_KEY);
    const asOrganisation = { ...sealed, userId: ORGANISATION_OWNER_KEY };
    expect(openOwnedCredential(asOrganisation, keyring, { allowUnbound: false })).toBe(
      'xoxe-1234567890-abcdefghij',
    );
    // The organisation's ciphertext copied onto an owner's row does not open there.
    expect(() =>
      openOwnedCredential({ ...sealed, userId: 'owner' }, keyring, { allowUnbound: true }),
    ).toThrow(CREDENTIAL_KEY_CHANGED_MESSAGE);
    // A value sealed under the owner binding of the reserved key's spelling is not the organisation's.
    const forged = {
      ...encrypt('forged', keyring.current, credentialOwnerBinding(ORGANISATION_OWNER_KEY)),
      keyId: credentialKeyId(keyring.current),
      userId: ORGANISATION_OWNER_KEY,
    };
    expect(() => openOwnedCredential(forged, keyring, { allowUnbound: true })).toThrow(
      CREDENTIAL_KEY_CHANGED_MESSAGE,
    );
  });

  it('never opens an organisation row unbound, even while legacy owner rows may', (): void => {
    const keyring = { current: key() };
    const unbound = { ...encrypt('legacy', keyring.current), userId: ORGANISATION_OWNER_KEY };
    expect(() => openOwnedCredential(unbound, keyring, { allowUnbound: true })).toThrow(
      CREDENTIAL_KEY_CHANGED_MESSAGE,
    );
  });

  it('fingerprints an organisation value apart from the same value an owner holds', (): void => {
    const credentialKey = key();
    expect(credentialValueFingerprint('shared', credentialKey, ORGANISATION_OWNER_KEY)).not.toBe(
      credentialValueFingerprint('shared', credentialKey, 'owner'),
    );
  });
});
