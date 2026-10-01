import type { NextRequest, NextResponse } from 'next/server';
import { tokenRoute } from '@/lib/customer-oidc-routes';

/**
 * Hands the signed-in browser the ID token Convex receives, refreshing it in
 * its last minutes; a refused refresh ends the session.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return tokenRoute(request);
}
