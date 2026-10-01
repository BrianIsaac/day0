/// <reference types="node" />

import { DEFAULT_LOCAL_MANAGER_ADDRESS, normaliseManagerAddress } from '../agent/manager-address';
import {
  DEV_NO_AUTH_ALGORITHM,
  DEV_NO_AUTH_AUDIENCE,
  DEV_NO_AUTH_ISSUER,
  DEV_NO_AUTH_KEY_ID,
  DEV_NO_AUTH_SESSION_CLAIM,
  DEV_NO_AUTH_SUBJECT,
} from './dev-auth-issuer';

const TOKEN_LIFETIME_SECONDS = 3600;

/** The name the operator configures the local manager's address under. */
export const LOCAL_MANAGER_ADDRESS_VAR = 'NEXT_PUBLIC_DEMO_BOSS_EMAIL';

/**
 * The manager address the local issuer vouches for: the operator's configured
 * address, trimmed and lower-cased, or the local default. Read on the server,
 * so the token's `email` is the operator's word and never the browser's.
 *
 * @param values - Environment values to read; the process's own by default.
 * @throws Error naming the variable, not its value, when it is set to something
 *   that is not an address: a token naming no address would leave the operator
 *   unable to deploy, for a reason the deploy could only guess at.
 */
export function localManagerAddress(
  values: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = values[LOCAL_MANAGER_ADDRESS_VAR]?.trim();
  if (!configured) return DEFAULT_LOCAL_MANAGER_ADDRESS;
  const address = normaliseManagerAddress(configured);
  if (address === undefined) {
    throw new Error(
      `${LOCAL_MANAGER_ADDRESS_VAR} is not an email address. Set it to the manager's address, ` +
        `such as name@company.com, or leave it empty for ${DEFAULT_LOCAL_MANAGER_ADDRESS}.`,
    );
  }
  return address;
}

/**
 * Mint the short-lived owner token used by no-auth development clients. It
 * carries the manager's address as a verified `email`: whoever holds the
 * signing key is the operator, and the operator configured the address
 * (the transfer plan, section 3.2).
 *
 * @param sessionId - The browser session the token is for, carried as `sid` so the
 *   backend can tell two browsers of the one local owner apart.
 * @param encodedSigningKey - The base64 PKCS#8 private key; the Next.js server
 *   reads it from `DEV_NO_AUTH_SIGNING_KEY`, a script passes the value it read.
 * @param managerAddress - The address the token names; the configured one
 *   ({@link localManagerAddress}) by default.
 */
export async function mintDevNoAuthToken(
  sessionId?: string,
  encodedSigningKey: string | undefined = process.env.DEV_NO_AUTH_SIGNING_KEY,
  managerAddress: string = localManagerAddress(),
): Promise<string> {
  const key = await signingKey(encodedSigningKey);
  const issuedAt = Math.floor(Date.now() / 1000);

  const header = { alg: DEV_NO_AUTH_ALGORITHM, typ: 'JWT', kid: DEV_NO_AUTH_KEY_ID };
  const payload = {
    sub: DEV_NO_AUTH_SUBJECT,
    iss: DEV_NO_AUTH_ISSUER,
    aud: DEV_NO_AUTH_AUDIENCE,
    iat: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
    email: managerAddress,
    email_verified: true,
    ...(sessionId ? { [DEV_NO_AUTH_SESSION_CLAIM]: sessionId } : {}),
  };

  const signingInput = `${base64UrlText(JSON.stringify(header))}.${base64UrlText(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

/** Imported keys by their encoded form: one import per key, however many tokens it signs. */
const importedKeys = new Map<string, Promise<CryptoKey>>();

function signingKey(encoded: string | undefined): Promise<CryptoKey> {
  if (!encoded) return importSigningKey(encoded);
  let imported = importedKeys.get(encoded);
  if (!imported) {
    imported = importSigningKey(encoded);
    importedKeys.set(encoded, imported);
  }
  return imported;
}

async function importSigningKey(encoded: string | undefined): Promise<CryptoKey> {
  if (!encoded) {
    throw new Error(
      'DEV_NO_AUTH_SIGNING_KEY is not set, so no-auth dev mode cannot produce a ' +
        'token this deployment will accept. Run `pnpm dev:no-auth-key`.',
    );
  }
  return crypto.subtle.importKey(
    'pkcs8',
    decodeBase64(encoded),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value.trim());
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlText(value: string): string {
  return base64UrlBytes(new TextEncoder().encode(value));
}
