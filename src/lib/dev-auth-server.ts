/// <reference types="node" />

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { auth } from '@clerk/nextjs/server';
import {
  DEV_NO_AUTH_ALGORITHM,
  DEV_NO_AUTH_AUDIENCE,
  DEV_NO_AUTH_ISSUER,
  DEV_NO_AUTH_KEY_ID,
  DEV_NO_AUTH_SUBJECT,
} from '@convex/devAuth';
import { DEV_NO_AUTH } from './dev-auth';

/**
 * No-auth development mode — possession of this machine's local key.
 *
 * Server-only. Never import this from a client component: it reads the two
 * secrets the mode turns on, and `NEXT_PUBLIC_*` is the only thing the browser
 * may be handed.
 *
 * The mode serves every request as one fixed user who owns every row, so the
 * only question that matters is who is allowed to be that user. Reachability
 * cannot answer it. A dev server bound to loopback is still reachable from
 * another machine through an SSH forward, a reverse proxy or a two-line relay,
 * and the `Host` header a forwarder sends is whatever it decides to send. Both
 * previous attempts at this boundary were defeated exactly there.
 *
 * So the answer is possession, of two secrets generated together by
 * `pnpm dev:no-auth-key` and kept in `.env.local`:
 *
 *   - `DEV_NO_AUTH_SECRET` unlocks the app itself. It arrives once in the URL
 *     `pnpm dev` prints, and is kept in an httpOnly cookie afterwards. Without
 *     it `proxy.ts` refuses every route, so an attacker who can reach the dev
 *     server gets a 403 and nothing else.
 *   - `DEV_NO_AUTH_SIGNING_KEY` signs the short-lived token Convex accepts. The
 *     deployment holds only its public half, so an attacker who can reach the
 *     Convex socket directly — bypassing this process entirely — still cannot
 *     produce a token it will verify.
 *
 * Neither is an inference about where a caller sits. Both are facts the checking
 * side can observe, which is the property the bind-address guards they replace
 * could never have.
 */

/** Carries `DEV_NO_AUTH_SECRET` after the first unlock. httpOnly, so page scripts cannot read it. */
export const DEV_NO_AUTH_COOKIE = 'day0_dev_no_auth';

/** Carries `DEV_NO_AUTH_SECRET` on the unlock URL `pnpm dev` prints. */
export const DEV_NO_AUTH_UNLOCK_PARAM = 'day0_key';

const TOKEN_LIFETIME_SECONDS = 3600;

/** Which of the two secrets are missing, or null when both are present. */
export function devNoAuthKeyGaps(): string[] | null {
  const gaps: string[] = [];
  if (!process.env.DEV_NO_AUTH_SECRET) gaps.push('DEV_NO_AUTH_SECRET');
  if (!process.env.DEV_NO_AUTH_SIGNING_KEY) gaps.push('DEV_NO_AUTH_SIGNING_KEY');
  return gaps.length > 0 ? gaps : null;
}

/**
 * Whether a caller-supplied value is this machine's unlock secret. Compares in
 * time independent of how much of the secret was guessed correctly, and treats
 * an unset secret as matching nothing — the failure mode of the whole mode has
 * to be refusal, never an open door.
 */
export function isDevNoAuthSecret(candidate: string | null | undefined): boolean {
  const secret = process.env.DEV_NO_AUTH_SECRET;
  if (!secret || !candidate) return false;

  const encoder = new TextEncoder();
  const a = encoder.encode(candidate);
  const b = encoder.encode(secret);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0;
}

/** The caller a handler is running for, or the refusal to answer with. */
export type Caller = { ok: true; userId: string } | { ok: false; refusal: NextResponse };

/**
 * Who this request is running as, established the way the running mode
 * establishes callers.
 *
 * Both modes authenticate somebody before a handler runs; they differ only in
 * who did it. Under Clerk it is the session `clerkMiddleware` resolved. In
 * no-auth mode it is `proxy.ts`, which refuses everyone who cannot show this
 * machine's unlock secret and deliberately never invokes Clerk at all - so
 * `auth()` there does not answer "anonymous", it throws for want of middleware
 * state. Every handler that spends the owner's provider keys asks this instead
 * of picking one of the two checks, so the boundary holds in whichever mode is
 * running rather than in the one the handler was written for.
 *
 * The no-auth branch re-reads the cookie the proxy already checked, as the
 * routes that mint Convex tokens do: a boundary this far in front of the
 * owner's keys should not rest on a matcher pattern continuing to cover it.
 */
export async function establishCaller(): Promise<Caller> {
  if (DEV_NO_AUTH) {
    const jar = await cookies();
    if (!isDevNoAuthSecret(jar.get(DEV_NO_AUTH_COOKIE)?.value)) {
      return {
        ok: false,
        refusal: NextResponse.json({ error: 'not authenticated' }, { status: 403 }),
      };
    }
    return { ok: true, userId: DEV_NO_AUTH_SUBJECT };
  }

  const { userId } = await auth();
  if (!userId) {
    return {
      ok: false,
      refusal: NextResponse.json({ error: 'not authenticated' }, { status: 401 }),
    };
  }
  return { ok: true, userId };
}

/**
 * A short-lived token for the fixed local subject, signed with this machine's
 * private key. Throws when the key is absent rather than returning an
 * unauthenticated client to the caller.
 */
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
  // WebCrypto rather than node:crypto so the one module can be read by the proxy
  // (edge runtime) and the route handlers (node runtime) alike.
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
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
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
