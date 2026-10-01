/**
 * The customer-local profile's browser session (decision S1): a sealed,
 * httpOnly, `SameSite=Lax` cookie holding the person's refresh token and
 * current ID token, sealed with `DAY0_SESSION_SECRET`. No session table: the
 * cookie is the session, and rotating the secret ends every one at once.
 *
 * Sealed means encrypted and authenticated (AES-256-GCM under a key derived
 * from the secret with HKDF, one key per purpose), so the browser can neither
 * read the refresh token nor change a byte without the seal failing to open.
 * The sign-in transaction (state, nonce, PKCE verifier) is sealed the same way
 * under another purpose, so neither cookie can stand in for the other.
 *
 * Web Crypto only, so the proxy and the route handlers open it alike.
 */

/** The session cookie's name; a long session is split across `.0`, `.1`, ... */
export const CUSTOMER_SESSION_COOKIE = 'day0_session';

/** The sign-in transaction's cookie, read only by the callback. */
export const SIGN_IN_TRANSACTION_COOKIE = 'day0_sign_in';

/** The path the transaction cookie is sent on: the callback alone. */
export const SIGN_IN_TRANSACTION_PATH = '/api/auth/oidc/callback';

/**
 * How long a session lasts from sign-in, whatever the issuer's refresh token
 * would allow: a working day, after which the person signs in again (through
 * the issuer's own session, usually without a prompt).
 */
export const CUSTOMER_SESSION_MAX_SECONDS = 12 * 60 * 60;

/** How long a sign-in may take at the issuer before its transaction is refused. */
export const SIGN_IN_TRANSACTION_SECONDS = 10 * 60;

/** The longest value one cookie carries; browsers keep at least 4,096 bytes per cookie. */
export const COOKIE_CHUNK_LENGTH = 3_800;

/** The most chunks a session is split into: a session past this is refused, never truncated. */
export const MAX_COOKIE_CHUNKS = 6;

/** The shortest secret accepted: 32 random bytes in base64url. */
export const MIN_SESSION_SECRET_LENGTH = 43;

/** What a sealed value is for; each purpose has its own key. */
export type SealPurpose = 'session' | 'sign-in' | 'sign-in-check';

/** A person's signed-in session. */
export interface CustomerSession {
  readonly version: 1;
  /** The current ID token: what Convex receives. */
  readonly idToken: string;
  /** The ID token's `exp`, in milliseconds. */
  readonly idTokenExpiresAt: number;
  /** Absent when the issuer granted none: the session then ends with the ID token. */
  readonly refreshToken?: string;
  /** When the person signed in, in milliseconds. */
  readonly startedAt: number;
  /** When the session ends whatever happens, in milliseconds. */
  readonly expiresAt: number;
}

/** What the login route hands the callback, through the browser, sealed. */
export interface SignInTransaction {
  readonly version: 1;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  /** The same-origin path to land on once signed in. */
  readonly returnTo: string;
  /**
   * Set when `pnpm check:sign-in` started this sign-in: the callback reports the
   * claims to the check on this machine instead of signing anyone in.
   */
  readonly check?: { readonly id: string; readonly reportTo: string };
  readonly expiresAt: number;
}

const SEAL_VERSION = 'v1';
const SALT = new TextEncoder().encode('day0-customer-session');

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  bytes.set(decoded);
  return bytes;
}

/**
 * Why a session secret cannot seal anything, or undefined when it can.
 *
 * @param secret - The configured secret.
 */
export function sessionSecretGap(secret: string | undefined): string | undefined {
  const value = secret?.trim() ?? '';
  if (value === '') return 'DAY0_SESSION_SECRET is not set.';
  if (value.length < MIN_SESSION_SECRET_LENGTH) {
    return (
      `DAY0_SESSION_SECRET is ${value.length} characters; it must be at least ` +
      `${MIN_SESSION_SECRET_LENGTH} (32 random bytes). \`./setup.sh sign-in\` generates one.`
    );
  }
  return undefined;
}

/** The AES-GCM key for one purpose, derived from the secret. */
async function purposeKey(secret: string, purpose: SealPurpose): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret.trim()),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: new TextEncoder().encode(purpose) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Seal a value for one purpose.
 *
 * @param secret - `DAY0_SESSION_SECRET`.
 * @param purpose - What the value is for; it opens only under the same one.
 * @param payload - Anything JSON can carry.
 * @returns `v1.<iv>.<ciphertext>`, cookie-safe.
 * @throws Error when the secret is unusable.
 */
export async function seal(
  secret: string,
  purpose: SealPurpose,
  payload: unknown,
): Promise<string> {
  const gap = sessionSecretGap(secret);
  if (gap) throw new Error(gap);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose) },
    await purposeKey(secret, purpose),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `${SEAL_VERSION}.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

/**
 * Open a sealed value, or undefined when it is not one this secret sealed for
 * this purpose: malformed, tampered with, sealed under another secret or
 * purpose. Never throws on what the browser sent.
 *
 * @param secret - `DAY0_SESSION_SECRET`.
 * @param purpose - The purpose it was sealed for.
 * @param sealed - The value as the browser returned it.
 */
export async function unseal(
  secret: string | undefined,
  purpose: SealPurpose,
  sealed: string | undefined,
): Promise<unknown> {
  if (sessionSecretGap(secret) !== undefined || secret === undefined || !sealed) return undefined;
  const parts = sealed.split('.');
  if (parts.length !== 3 || parts[0] !== SEAL_VERSION) return undefined;
  const iv = fromBase64Url(parts[1]);
  const ciphertext = fromBase64Url(parts[2]);
  if (!iv || iv.length !== 12 || !ciphertext) return undefined;
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose) },
      await purposeKey(secret, purpose),
      ciphertext,
    );
  } catch {
    // The authentication tag did not verify: another secret, another purpose, or tampering.
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  } catch {
    // Sealed by this secret, so written by this code; a value that is not JSON is not a session.
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCheck(value: unknown): value is { id: string; reportTo: string } {
  return isRecord(value) && typeof value.id === 'string' && typeof value.reportTo === 'string';
}

/**
 * Seal a session.
 *
 * @param secret - `DAY0_SESSION_SECRET`.
 * @param session - The session.
 */
export async function sealSession(secret: string, session: CustomerSession): Promise<string> {
  return seal(secret, 'session', session);
}

/**
 * The live session a cookie value carries, or undefined: unsealable, not a
 * session, or past its absolute end. An ID token past its own expiry still
 * opens; the token route refreshes it.
 *
 * @param secret - `DAY0_SESSION_SECRET`.
 * @param sealed - The cookie value, its chunks joined.
 * @param now - The current time in milliseconds.
 */
export async function openSession(
  secret: string | undefined,
  sealed: string | undefined,
  now: number = Date.now(),
): Promise<CustomerSession | undefined> {
  const value = await unseal(secret, 'session', sealed);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.idToken !== 'string' ||
    typeof value.idTokenExpiresAt !== 'number' ||
    typeof value.startedAt !== 'number' ||
    typeof value.expiresAt !== 'number' ||
    (value.refreshToken !== undefined && typeof value.refreshToken !== 'string')
  ) {
    return undefined;
  }
  if (value.expiresAt <= now) return undefined;
  return {
    version: 1,
    idToken: value.idToken,
    idTokenExpiresAt: value.idTokenExpiresAt,
    ...(typeof value.refreshToken === 'string' ? { refreshToken: value.refreshToken } : {}),
    startedAt: value.startedAt,
    expiresAt: value.expiresAt,
  };
}

/**
 * Seal a sign-in transaction.
 *
 * @param secret - `DAY0_SESSION_SECRET`.
 * @param transaction - The transaction.
 */
export async function sealTransaction(
  secret: string,
  transaction: SignInTransaction,
): Promise<string> {
  return seal(secret, 'sign-in', transaction);
}

/**
 * The live sign-in transaction a cookie value carries, or undefined.
 *
 * @param secret - `DAY0_SESSION_SECRET`.
 * @param sealed - The cookie value.
 * @param now - The current time in milliseconds.
 */
export async function openTransaction(
  secret: string | undefined,
  sealed: string | undefined,
  now: number = Date.now(),
): Promise<SignInTransaction | undefined> {
  const value = await unseal(secret, 'sign-in', sealed);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.state !== 'string' ||
    typeof value.nonce !== 'string' ||
    typeof value.codeVerifier !== 'string' ||
    typeof value.returnTo !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    (value.check !== undefined && !isCheck(value.check))
  ) {
    return undefined;
  }
  if (value.expiresAt <= now) return undefined;
  return {
    version: 1,
    state: value.state,
    nonce: value.nonce,
    codeVerifier: value.codeVerifier,
    returnTo: value.returnTo,
    ...(isCheck(value.check)
      ? { check: { id: value.check.id, reportTo: value.check.reportTo } }
      : {}),
    expiresAt: value.expiresAt,
  };
}

/** One cookie to write. */
export interface CookieWrite {
  readonly name: string;
  readonly value: string;
}

/**
 * Split a value across numbered cookies when it is longer than one cookie
 * holds: `name` alone when it fits, else `name.0`, `name.1`, ... An Entra
 * refresh token and ID token together can pass 4 KB.
 *
 * @param name - The cookie's base name.
 * @param value - The sealed value.
 * @returns The cookies to write, in order.
 * @throws Error when the value needs more than {@link MAX_COOKIE_CHUNKS} chunks.
 */
export function chunkCookie(name: string, value: string): readonly CookieWrite[] {
  if (value.length <= COOKIE_CHUNK_LENGTH) return [{ name, value }];
  const count = Math.ceil(value.length / COOKIE_CHUNK_LENGTH);
  if (count > MAX_COOKIE_CHUNKS) {
    throw new Error(
      `The session is ${value.length} characters, past what ${MAX_COOKIE_CHUNKS} cookies carry.`,
    );
  }
  return Array.from({ length: count }, (_unused, index) => ({
    name: `${name}.${index}`,
    value: value.slice(index * COOKIE_CHUNK_LENGTH, (index + 1) * COOKIE_CHUNK_LENGTH),
  }));
}

/**
 * Join a value written by {@link chunkCookie}: the whole cookie when present,
 * else its chunks in order up to the first missing one.
 *
 * @param name - The cookie's base name.
 * @param read - Reads one cookie's value.
 */
export function joinCookie(
  name: string,
  read: (cookieName: string) => string | undefined,
): string | undefined {
  const whole = read(name);
  if (whole) return whole;
  const chunks: string[] = [];
  for (let index = 0; index < MAX_COOKIE_CHUNKS; index += 1) {
    const chunk = read(`${name}.${index}`);
    if (!chunk) break;
    chunks.push(chunk);
  }
  return chunks.length > 0 ? chunks.join('') : undefined;
}

/**
 * Every name a value written under `name` may occupy, so a shorter session
 * written over a longer one clears the chunks it no longer uses.
 *
 * @param name - The cookie's base name.
 */
export function cookieNames(name: string): readonly string[] {
  return [
    name,
    ...Array.from({ length: MAX_COOKIE_CHUNKS }, (_unused, index) => `${name}.${index}`),
  ];
}
