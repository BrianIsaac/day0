import type { NextRequest, NextResponse } from 'next/server';
import { signOutRoute, signedOutRoute } from '@/lib/customer-oidc-routes';

/** Ends the session, and the issuer's through its `end_session_endpoint` when it has one. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return signOutRoute(request);
}

/** The signed-out page the issuer sends the person back to. */
export function GET(): NextResponse {
  return signedOutRoute();
}
