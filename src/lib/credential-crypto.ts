import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

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
 * The associated data that binds a sealed value to its owner.
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

/**
 * Open a credential value stored on one owner's row.
 *
 * A value sealed bound to the owner opens only for that owner. A value sealed
 * without associated data opens unbound; that fallback is the one way a moved
 * value still opens. It can end only once a re-seal (not built yet) has bound
 * every row and a marker on the row says so. `convex/credentials.ts` seals
 * with the owner and opens as the row's owner; a bound value never opens
 * through an unbound call.
 *
 * @param encrypted - The row's ciphertext and IV.
 * @param keyBase64 - The deployment's credential key.
 * @param userId - The row's owner.
 * @returns The plaintext.
 * @throws Error naming `CREDENTIAL_KEY_CHANGED_MESSAGE` when neither opens it.
 */
export function openOwnedCredential(
  encrypted: EncryptedCredential,
  keyBase64: string,
  userId: string,
): string {
  try {
    return decrypt(encrypted, keyBase64, credentialOwnerBinding(userId));
  } catch {
    // Not bound to this owner: either sealed before binding existed, which the
    // unbound open below reads, or not this owner's value, which it refuses.
    return decrypt(encrypted, keyBase64);
  }
}
