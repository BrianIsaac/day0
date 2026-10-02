import type { NextRequest, NextResponse } from 'next/server';
import { signInRoute } from '@/lib/customer-oidc-routes';

/**
 * Starts a company sign-in through the customer's own issuer: state, nonce and
 * PKCE sealed for the callback, then a redirect to the issuer. Answers only in
 * a build with the customer-local profile.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return signInRoute(request);
}
