/// <reference types="node" />

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { auth } from '@clerk/nextjs/server';
import { DEV_NO_AUTH_SUBJECT } from '@convex/devAuth';
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
 *     `pnpm dev` prints; the browser then keeps a session of its own, signed
 *     with the secret, in an httpOnly cookie. The secret never sits in a
 *     cookie, and rotating it (`pnpm dev:no-auth-key --rotate-unlock`) ends
 *     every session at once. Without a session `proxy.ts` refuses every route,
 *     so an attacker who can reach the dev server gets a 403 and nothing else.
 *   - `DEV_NO_AUTH_SIGNING_KEY` signs the short-lived token Convex accepts. The
 *     deployment holds only its public half, so an attacker who can reach the
 *     Convex socket directly — bypassing this process entirely — still cannot
 *     produce a token it will verify.
 *
 * Neither is an inference about where a caller sits. Both are facts the checking
 * side can observe, which is the property the bind-address guards they replace
 * could never have.
 */

/** Carries this browser's no-auth session after the first unlock. httpOnly, so page scripts cannot read it. */
export const DEV_NO_AUTH_COOKIE = 'day0_dev_no_auth';

/** How long one browser's session lasts before the unlock URL is needed again. */
export const DEV_NO_AUTH_SESSION_SECONDS = 60 * 60 * 24 * 30;

/** Carries `DEV_NO_AUTH_SECRET` on the unlock URL `pnpm dev` prints. */
export const DEV_NO_AUTH_UNLOCK_PARAM = 'day0_key';

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

const SESSION_VERSION = 'v1';
const SESSION_CONTEXT = 'day0-no-auth-session';

/** The HMAC key a session is signed with: the unlock secret, so rotating it ends every session. */
async function sessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  // A length of one past a multiple of four is not base64 at all, and `atob` throws on it.
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return undefined;
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Mint a session for one browser that has just shown the unlock secret.
 *
 * The value is a random id and an expiry, signed with the secret. It proves
 * the browser once held the secret without carrying it, so a copied cookie
 * never reveals the key that unlocks every other browser, and rotating the
 * secret ends every session without any state on the server.
 *
 * @param now - The current time in milliseconds.
 * @returns The cookie value.
 * @throws Error when no unlock secret is configured; the proxy refuses before this is reached.
 */
export async function mintDevNoAuthSession(now: number = Date.now()): Promise<string> {
  const secret = process.env.DEV_NO_AUTH_SECRET;
  if (!secret) throw new Error('DEV_NO_AUTH_SECRET is not set, so no session can be signed.');
  const id = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = Math.floor(now / 1000) + DEV_NO_AUTH_SESSION_SECONDS;
  const payload = `${SESSION_VERSION}.${id}.${expires}`;
  const signature = await crypto.subtle.sign(
    'HMAC',
    await sessionKey(secret),
    new TextEncoder().encode(`${SESSION_CONTEXT}.${payload}`),
  );
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * The id of the live session a cookie value carries, signed with this
 * machine's current unlock secret, or undefined. The signature is checked by
 * `crypto.subtle.verify`, which does not leak how much of it matched; an unset
 * secret, a malformed value, an expired session and the raw secret itself all
 * answer undefined.
 *
 * @param candidate - The cookie value the browser sent.
 * @param now - The current time in milliseconds.
 */
export async function devNoAuthSessionId(
  candidate: string | null | undefined,
  now: number = Date.now(),
): Promise<string | undefined> {
  const secret = process.env.DEV_NO_AUTH_SECRET;
  if (!secret || !candidate) return undefined;
  const parts = candidate.split('.');
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return undefined;
  const [version, id, expiresText, signatureText] = parts;
  const expires = Number(expiresText);
  if (!/^\d{1,12}$/.test(expiresText) || expires * 1000 <= now) return undefined;
  const signature = fromBase64Url(signatureText);
  if (!id || !signature) return undefined;
  const valid = await crypto.subtle.verify(
    'HMAC',
    await sessionKey(secret),
    signature,
    new TextEncoder().encode(`${SESSION_CONTEXT}.${version}.${id}.${expiresText}`),
  );
  return valid ? id : undefined;
}

/**
 * Whether a cookie value is a live session signed with this machine's current
 * unlock secret (see {@link devNoAuthSessionId}).
 *
 * @param candidate - The cookie value the browser sent.
 * @param now - The current time in milliseconds.
 */
export async function isDevNoAuthSession(
  candidate: string | null | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  return (await devNoAuthSessionId(candidate, now)) !== undefined;
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
 * The no-auth branch re-checks the session the proxy already checked, as the
 * routes that mint Convex tokens do: a boundary this far in front of the
 * owner's keys should not rest on a matcher pattern continuing to cover it.
 */
export async function establishCaller(): Promise<Caller> {
  if (DEV_NO_AUTH) {
    const jar = await cookies();
    if (!(await isDevNoAuthSession(jar.get(DEV_NO_AUTH_COOKIE)?.value))) {
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
export { mintDevNoAuthToken } from './dev-auth-token';
