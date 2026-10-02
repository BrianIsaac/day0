import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isOrganisationOwnerKey, ORGANISATION_OWNER_KEY } from './organisation-key';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A sealed credential value: base64 ciphertext with its tag appended, and the base64 IV. */
export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
}

/**
 * What every path that cannot open a stored credential tells a person.
 *
 * The deployment's key is the usual cause: a value sealed under an earlier
 * `DAY0_CREDENTIAL_KEY` cannot be read under the current one. AES-GCM cannot
 * tell that apart from a value altered or moved since it was stored, so the
 * message names both and says what fixes either.
 */
export const CREDENTIAL_KEY_CHANGED_MESSAGE =
  'the credential key changed: this value was sealed under a different DAY0_CREDENTIAL_KEY, or altered since it was stored, so it cannot be read; enter the credential again';

/**
 * The associated data that binds a sealed value to its owner. A row the organisation holds is
 * bound by {@link credentialOrganisationBinding} instead ({@link credentialBindingOf}).
 *
 * A credential row's id does not exist when its value is sealed, and its
 * label, kind and page reference move with every documentation sync, so the
 * owner is the one stable thing a value can be bound to: ciphertext copied
 * onto another owner's row does not open there (decision Q15).
 *
 * @param userId - The credential row's `userId`.
 */
export function credentialOwnerBinding(userId: string): string {
  return `day0-credential:v1:owner:${userId}`;
}

/**
 * The associated data that binds a sealed value to the organisation (F18, AC12): the reserved
 * key, in a namespace of its own, so a value sealed for an owner (whatever the owner key's
 * spelling) never opens as the organisation's, nor the organisation's on an owner's row.
 */
export function credentialOrganisationBinding(): string {
  return `day0-credential:v1:organisation:${ORGANISATION_OWNER_KEY}`;
}

/**
 * The binding a row's value is sealed under, by the row's `userId`: the organisation's for the
 * reserved key (the only key an organisation row carries, and one no caller is ever keyed on),
 * the owner's for every other.
 *
 * @param userId - The credential row's `userId`.
 */
export function credentialBindingOf(userId: string): string {
  return isOrganisationOwnerKey(userId)
    ? credentialOrganisationBinding()
    : credentialOwnerBinding(userId);
}

/**
 * Decode and validate an AES-256 key.
 *
 * Args:
 *   keyBase64: Standard base64 containing exactly 32 bytes.
 *
 * Returns:
 *   The decoded key.
 *
 * Raises:
 *   Error: If the input is not canonical 32-byte base64.
 */
function decodeKey(keyBase64: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(keyBase64)) {
    throw new Error('DAY0_CREDENTIAL_KEY must be a base64-encoded 32-byte key.');
  }
  const key = Buffer.from(keyBase64, 'base64');
  const canonical = Buffer.from(key).toString('base64');
  const supplied = Buffer.from(keyBase64);
  const expected = Buffer.from(canonical);
  if (
    key.length !== 32 ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new Error('DAY0_CREDENTIAL_KEY must be a base64-encoded 32-byte key.');
  }
  return key;
}

/**
 * Encrypt credential plaintext with AES-256-GCM.
 *
 * The authentication tag is appended to the encrypted bytes so the public
 * contract remains exactly `{ ciphertext, iv }`.
 *
 * @param plaintext - Credential value to protect.
 * @param keyBase64 - Standard base64 containing exactly 32 key bytes.
 * @param associatedData - Authenticated with the value and needed to open it
 *   again (`credentialOwnerBinding`); omitted, the value is sealed unbound.
 * @returns Base64 ciphertext plus tag and a fresh base64 IV.
 */
export function encrypt(
  plaintext: string,
  keyBase64: string,
  associatedData?: string,
): EncryptedCredential {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (associatedData !== undefined) cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([encrypted, cipher.getAuthTag()]);
  return { ciphertext: payload.toString('base64'), iv: iv.toString('base64') };
}

/**
 * Decrypt and authenticate an AES-256-GCM credential.
 *
 * @param encrypted - Base64 ciphertext/tag and IV returned by `encrypt`.
 * @param keyBase64 - Standard base64 containing exactly 32 key bytes.
 * @param associatedData - The associated data the value was sealed under, if any.
 * @returns Original credential plaintext.
 * @throws Error naming `CREDENTIAL_KEY_CHANGED_MESSAGE` when the key, IV,
 *   ciphertext, tag or associated data does not match.
 */
export function decrypt(
  encrypted: EncryptedCredential,
  keyBase64: string,
  associatedData?: string,
): string {
  try {
    const key = decodeKey(keyBase64);
    const iv = Buffer.from(encrypted.iv, 'base64');
    const payload = Buffer.from(encrypted.ciphertext, 'base64');
    if (iv.length !== IV_BYTES || payload.length < TAG_BYTES) {
      throw new Error('invalid encrypted credential');
    }
    const ciphertext = payload.subarray(0, -TAG_BYTES);
    const tag = payload.subarray(-TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    if (associatedData !== undefined) decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(`Credential decryption failed: ${CREDENTIAL_KEY_CHANGED_MESSAGE}.`);
  }
}

/** What derives a key's public id from the key, so the id never serves as key material. */
const KEY_ID_DERIVATION_LABEL = 'day0-credential-key-id-v1';

/** Hex characters of the derived digest a key id keeps: 64 bits, enough to tell a deployment's keys apart. */
const KEY_ID_LENGTH = 16;

/**
 * The public id of a credential key, written on every row it seals.
 *
 * Derived one way from the key, so the id is safe to store and print and says
 * which key a row needs without trying to open it.
 *
 * @param keyBase64 - Standard base64 containing exactly 32 key bytes.
 * @throws Error when the key is not canonical 32-byte base64.
 */
export function credentialKeyId(keyBase64: string): string {
  return createHmac('sha256', decodeKey(keyBase64))
    .update(KEY_ID_DERIVATION_LABEL)
    .digest('hex')
    .slice(0, KEY_ID_LENGTH);
}

/** What derives the key a value's fingerprint is taken under, apart from sealing and key ids. */
const FINGERPRINT_DERIVATION_LABEL = 'day0-credential-ref-v1';

/** Hex characters a fingerprint keeps: 128 bits, far past a collision among one page's values. */
const FINGERPRINT_LENGTH = 32;

/**
 * A value's fingerprint under the deployment's key, for keying a page-derived
 * credential by what it is rather than where or under which label the page
 * states it.
 *
 * An HMAC under a key derived from the credential key, so a fingerprint shown
 * in a ref or an export cannot be tested against a guessed value by anyone
 * without the key; the owner is part of what is hashed, so one value held by
 * two owners gives two fingerprints and a ref never says that two owners
 * share a value. Lower-case hex, so a value-keyed ref never has the `-` every
 * earlier position-and-label ref carries. It changes with the key: after a
 * rotation a page's next sync moves each row to its new fingerprint by value.
 *
 * @param plaintext - The credential value.
 * @param keyBase64 - Standard base64 containing exactly 32 key bytes.
 * @param userId - The owner of the row the value is stored on.
 * @throws Error when the key is not canonical 32-byte base64.
 */
export function credentialValueFingerprint(
  plaintext: string,
  keyBase64: string,
  userId: string,
): string {
  const fingerprintKey = createHmac('sha256', decodeKey(keyBase64))
    .update(FINGERPRINT_DERIVATION_LABEL)
    .digest();
  return createHmac('sha256', fingerprintKey)
    .update(credentialBindingOf(userId), 'utf8')
    .update('\0', 'utf8')
    .update(plaintext, 'utf8')
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
}

/**
 * The keys a deployment can open stored values with: the current one, which
 * seals every new value, and during a rotation the one before it, until the
 * rotation's re-seal has moved every row onto the current key.
 */
export interface CredentialKeyring {
  readonly current: string;
  readonly previous?: string;
}

/** A value sealed for its owner, with the id of the key that sealed it. */
export interface SealedCredential extends EncryptedCredential {
  keyId: string;
}

/** The parts of a stored credential row that opening its value reads. */
export interface StoredSeal {
  readonly ciphertext: string;
  readonly iv: string;
  readonly userId: string;
  /** Absent on a row sealed before key ids existed, which may also be unbound. */
  readonly keyId?: string;
}

/**
 * Seal a value for its owner under the keyring's current key, bound to the owner, or to the
 * organisation for the reserved key ({@link credentialBindingOf}).
 *
 * @param plaintext - Credential value to protect.
 * @param keyring - The deployment's keys; only the current one seals.
 * @param userId - The owner of the row the value is stored on.
 */
export function sealForOwner(
  plaintext: string,
  keyring: CredentialKeyring,
  userId: string,
): SealedCredential {
  return {
    ...encrypt(plaintext, keyring.current, credentialBindingOf(userId)),
    keyId: credentialKeyId(keyring.current),
  };
}

/**
 * The keyring's key with this id, if it holds one.
 *
 * @param keyring - The deployment's keys.
 * @param keyId - A row's `keyId`.
 */
function keyWithId(keyring: CredentialKeyring, keyId: string): string | undefined {
  return [keyring.current, keyring.previous].find(
    (key): key is string => key !== undefined && credentialKeyId(key) === keyId,
  );
}

/**
 * Open the value on one stored row, as its owner.
 *
 * A row with a key id was sealed bound to its owner under that key (by the
 * store or the re-seal), so it opens only with that key and only bound to its
 * own owner. A row without one was sealed before key ids existed, perhaps
 * unbound; it is tried under each key bound to its owner, and unbound only
 * while `allowUnbound` holds, which is until the deployment's re-seal has
 * bound every row (decision Q15). After that an unbound value can only have
 * been put there since, and it is refused; a keyless row the re-seal skipped
 * because its key was missing still opens bound under that key once it is
 * restored, and is re-sealed then (wave 3.5 review M14).
 *
 * @param stored - The row's ciphertext, IV, owner and key id.
 * @param keyring - The deployment's keys.
 * @param options.allowUnbound - Whether a row without a key id may still open.
 * @returns The plaintext.
 * @throws Error naming `CREDENTIAL_KEY_CHANGED_MESSAGE` when the row's key is
 *   not in the keyring, or no permitted way opens it.
 */
export function openOwnedCredential(
  stored: StoredSeal,
  keyring: CredentialKeyring,
  options: { readonly allowUnbound: boolean },
): string {
  const sealed = { ciphertext: stored.ciphertext, iv: stored.iv };
  const binding = credentialBindingOf(stored.userId);
  if (stored.keyId !== undefined) {
    const key = keyWithId(keyring, stored.keyId);
    if (key === undefined) {
      throw new Error(`Credential decryption failed: ${CREDENTIAL_KEY_CHANGED_MESSAGE}.`);
    }
    return decrypt(sealed, key, binding);
  }
  const keys = [keyring.current, keyring.previous].filter(
    (key): key is string => key !== undefined,
  );
  // Every organisation row was sealed bound, so none opens unbound whatever the policy.
  const bindings =
    options.allowUnbound && !isOrganisationOwnerKey(stored.userId)
      ? [binding, undefined]
      : [binding];
  for (const key of keys) {
    for (const associatedData of bindings) {
      try {
        return decrypt(sealed, key, associatedData);
      } catch {
        // Not this key or not this binding: a legacy row may be either, so the
        // next pair is tried; the last failure is the error below.
      }
    }
  }
  throw new Error(`Credential decryption failed: ${CREDENTIAL_KEY_CHANGED_MESSAGE}.`);
}
