import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
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
 * Args:
 *   plaintext: Credential value to protect.
 *   keyBase64: Standard base64 containing exactly 32 key bytes.
 *
 * Returns:
 *   Base64 ciphertext plus tag and a fresh base64 IV.
 */
export function encrypt(plaintext: string, keyBase64: string): EncryptedCredential {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([encrypted, cipher.getAuthTag()]);
  return { ciphertext: payload.toString('base64'), iv: iv.toString('base64') };
}

/**
 * Decrypt and authenticate an AES-256-GCM credential.
 *
 * Args:
 *   encrypted: Base64 ciphertext/tag and IV returned by `encrypt`.
 *   keyBase64: Standard base64 containing exactly 32 key bytes.
 *
 * Returns:
 *   Original credential plaintext.
 *
 * Raises:
 *   Error: If the key, IV, ciphertext or authentication tag is invalid.
 */
export function decrypt(encrypted: EncryptedCredential, keyBase64: string): string {
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
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Credential decryption failed.');
  }
}
