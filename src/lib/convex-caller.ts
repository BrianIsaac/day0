/// <reference types="node" />

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ConvexHttpClient } from 'convex/browser';
import { DEV_NO_AUTH } from './dev-auth';
import { establishCaller, mintDevNoAuthToken } from './dev-auth-server';

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

/**
 * The address a server route dials the backend on.
 *
 * `NEXT_PUBLIC_CONVEX_URL` is the browser's address and is inlined into the
 * bundle at build. A server process may need a different one (a compose
 * service name, a private address), so `CONVEX_URL` names it when set.
 *
 * @param values - Environment values to read.
 * @returns `CONVEX_URL`, else `NEXT_PUBLIC_CONVEX_URL`.
 * @throws Error when neither is set.
 */
export function serverConvexUrl(values: Partial<Record<string, string>> = process.env): string {
  const url = values.CONVEX_URL?.trim() || values.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!url) throw new Error('Neither CONVEX_URL nor NEXT_PUBLIC_CONVEX_URL is set.');
  return url;
}

/** The established caller's Convex token, or null when their issuer gave none. */
async function convexToken(): Promise<string | null> {
  if (DEV_NO_AUTH) return mintDevNoAuthToken();
  const { getToken } = await auth();
  return getToken({ template: 'convex' });
}

/**
 * Establish the caller the way the running mode does and hand back a Convex
 * client that acts as them.
 *
 * @returns The client, or a 401/403 refusal before any body has been read.
 */
export async function establishConvexCaller(): Promise<ConvexCaller> {
  const caller = await establishCaller();
  if (!caller.ok) return caller;
  const token = await convexToken();
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
