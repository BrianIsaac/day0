/// <reference types="node" />

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { auth } from '@clerk/nextjs/server';
import { ConvexHttpClient } from 'convex/browser';
import { serverConvexUrl } from './convex-url';
import { CUSTOMER_SESSION_COOKIE, joinCookie, openSession } from './customer-session';
import { CUSTOMER_SIGN_IN } from './customer-sign-in';
import { DEV_NO_AUTH } from './dev-auth';
import {
  DEV_NO_AUTH_COOKIE,
  devNoAuthSessionId,
  establishCaller,
  mintDevNoAuthToken,
} from './dev-auth-server';

/**
 * The one seam a server route acts on Convex through, as the caller.
 *
 * Server-only. A route that spends the owner's keys or writes the owner's rows
 * establishes the caller here and nowhere else: which issuer signed them in,
 * and how their Convex token is obtained, is this module's business and not the
 * route's. That keeps the next identity provider (A7's customer issuer on the
 * app half) a change to one file rather than to every route.
 */

/** A Convex client authenticated as the established caller, or the refusal to answer with. */
export type ConvexCaller =
  | { ok: true; client: ConvexHttpClient }
  | { ok: false; refusal: NextResponse };

/** The established caller's Convex token, or null when their issuer gave none. */
async function convexToken(): Promise<string | null> {
  if (DEV_NO_AUTH) {
    const jar = await cookies();
    return mintDevNoAuthToken(await devNoAuthSessionId(jar.get(DEV_NO_AUTH_COOKIE)?.value));
  }
  const { getToken } = await auth();
  return getToken({ template: 'convex' });
}

/** How long a session's ID token must still be good for to act on Convex with. */
const CUSTOMER_TOKEN_MARGIN_MS = 10_000;

/**
 * The ID token of the customer session the browser holds, while it is still
 * good, or null. The browser keeps it fresh through the token route, which
 * rewrites the session; a route that finds it stale answers 401 and the
 * browser's next token fetch refreshes it.
 */
async function customerSessionToken(now: number = Date.now()): Promise<string | null> {
  const jar = await cookies();
  const session = await openSession(
    process.env.DAY0_SESSION_SECRET,
    joinCookie(CUSTOMER_SESSION_COOKIE, (name) => jar.get(name)?.value),
    now,
  );
  if (!session || session.idTokenExpiresAt - now <= CUSTOMER_TOKEN_MARGIN_MS) return null;
  return session.idToken;
}

/**
 * Establish the caller the way the running mode does and hand back a Convex
 * client that acts as them. Under the customer-local profile that is the
 * session the company sign-in sealed, whose ID token the deployment verifies
 * against the customer's issuer; Clerk is never asked.
 *
 * @returns The client, or a 401/403 refusal before any body has been read.
 */
export async function establishConvexCaller(): Promise<ConvexCaller> {
  if (CUSTOMER_SIGN_IN) return withToken(await customerSessionToken());
  const caller = await establishCaller();
  if (!caller.ok) return caller;
  return withToken(await convexToken());
}

/** A client acting with the token, or the 401 when there is none. */
function withToken(token: string | null): ConvexCaller {
  if (!token) {
    return {
      ok: false,
      refusal: NextResponse.json({ error: 'not authenticated' }, { status: 401 }),
    };
  }
  const client = new ConvexHttpClient(serverConvexUrl());
  client.setAuth(token);
  return { ok: true, client };
}
