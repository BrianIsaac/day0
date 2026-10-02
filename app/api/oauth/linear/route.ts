import { NextResponse } from 'next/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';
import { serverConvexUrl } from '@/lib/convex-url';
import { log } from '@/lib/logger';
import {
  LINEAR_INSTALL_UNAVAILABLE,
  linearInstallLanding,
  readLinearRedirect,
  type LinearInstallResult,
} from '@/surfaces/identity-issuers/linear-redirect';
import { safeFailureMessage } from '@/surfaces/redact';

/**
 * The redirect an employee's own Linear app's installation returns to (wave 11, 11-AL).
 *
 * A Linear administrator installs the app with `actor=app` from the link the card or the
 * organisation page gave them, and Linear sends that browser back here (Q13: Day0 has no inbound
 * endpoint). The route carries no caller identity to the deployment: the `state` this deployment
 * signed is what authenticates it, bound to one card, expiring in fifteen minutes and single-use
 * because the card holds its nonce beside the sealed PKCE verifier. Nothing Linear wrote is echoed:
 * the browser is sent to the card with the outcome and the deployment's own reason.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const publicUrl = process.env.DAY0_PUBLIC_URL?.trim() || new URL(request.url).origin;
  const answer = readLinearRedirect(new URL(request.url).searchParams);
  let result: LinearInstallResult | 'invalid' = 'invalid';
  if (answer !== undefined) {
    try {
      result = await new ConvexHttpClient(serverConvexUrl()).action(
        api.linearIdentityActions.completeAuthorisation,
        answer,
      );
    } catch (error) {
      // The deployment could not be asked, or failed before it answered: the administrator is sent
      // back to start again rather than shown a server error, and the cause is logged without the query.
      log.error('linear installation completion failed', {
        error: safeFailureMessage(error, answer.code ?? '', 'unknown error'),
      });
      result = { ok: false, reason: LINEAR_INSTALL_UNAVAILABLE };
    }
  }
  return NextResponse.redirect(linearInstallLanding(publicUrl, result), {
    status: 307,
    headers: { 'cache-control': 'no-store' },
  });
}
