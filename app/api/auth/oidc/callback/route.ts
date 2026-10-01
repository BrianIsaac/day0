import type { NextRequest, NextResponse } from 'next/server';
import { callbackRoute } from '@/lib/customer-oidc-routes';

/**
 * Where the customer's issuer sends the browser back: the code is exchanged,
 * the ID token and the domain rule are checked, and the session is sealed.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return callbackRoute(request);
}
