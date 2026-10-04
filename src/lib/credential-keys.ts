/**
 * The key names under which a stored value is a credential, whatever its shape (the wave 6
 * review's m30, built in wave 12).
 *
 * The structural floor blanks a value by its shape only (`redactTokenShapes`), and has no entropy
 * rule by design, so a hex key or a password in plain words under `apiKey` or `password` passed
 * through as stored. The record's payload disclosure and the audit export both blank the value
 * under one of these names, read from this one list, as the export drops the value under a
 * personal key.
 */

/** What a screen or an export shows in place of a value under a credential-class key. */
export const CREDENTIAL_VALUE_REDACTION = '<redacted: credential>';

/** The credential-class key names, each in its normalised form (`credentialKeyWords`). */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'accesskey',
  'accesstoken',
  'apikey',
  'apisecret',
  'appleveltoken',
  'apptoken',
  'authorization',
  'bearer',
  'bottoken',
  'clientsecret',
  'cookie',
  'idtoken',
  'passphrase',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'secretaccesskey',
  'secretkey',
  'sessiontoken',
  'signingsecret',
  'token',
  'webhooksecret',
  'webhooktoken',
]);

/** A key name as the list holds it: lower case, without separators (`API-KEY`, `api_key`, `apiKey`). */
function credentialKeyWords(key: string): string {
  return key.toLowerCase().replace(/[-_\s.]/g, '');
}

/**
 * Whether a value under this key is a credential.
 *
 * @param key - An object key from a stored payload.
 */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(credentialKeyWords(key));
}

/**
 * The value with whatever sits under a credential-class key replaced by
 * {@link CREDENTIAL_VALUE_REDACTION}, at any depth; every other value as it is.
 *
 * @param value - A stored payload or any part of one.
 */
export function withCredentialValuesBlanked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withCredentialValuesBlanked);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isCredentialKey(key) ? CREDENTIAL_VALUE_REDACTION : withCredentialValuesBlanked(entry),
    ]),
  );
}
