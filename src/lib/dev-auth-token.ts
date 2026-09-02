/// <reference types="node" />

import {
  DEV_NO_AUTH_ALGORITHM,
  DEV_NO_AUTH_AUDIENCE,
  DEV_NO_AUTH_ISSUER,
  DEV_NO_AUTH_KEY_ID,
  DEV_NO_AUTH_SUBJECT,
} from '@convex/devAuth';

const TOKEN_LIFETIME_SECONDS = 3600;

/** Mint the short-lived owner token used by no-auth development clients. */
export async function mintDevNoAuthToken(): Promise<string> {
  const key = await signingKey();
  const issuedAt = Math.floor(Date.now() / 1000);

  const header = { alg: DEV_NO_AUTH_ALGORITHM, typ: 'JWT', kid: DEV_NO_AUTH_KEY_ID };
  const payload = {
    sub: DEV_NO_AUTH_SUBJECT,
    iss: DEV_NO_AUTH_ISSUER,
    aud: DEV_NO_AUTH_AUDIENCE,
    iat: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
  };

  const signingInput = `${base64UrlText(JSON.stringify(header))}.${base64UrlText(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

let cachedSigningKey: Promise<CryptoKey> | null = null;

function signingKey(): Promise<CryptoKey> {
  if (!cachedSigningKey) cachedSigningKey = importSigningKey();
  return cachedSigningKey;
}

async function importSigningKey(): Promise<CryptoKey> {
  const encoded = process.env.DEV_NO_AUTH_SIGNING_KEY;
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
