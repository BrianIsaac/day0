import { NextRequest, NextResponse } from 'next/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';
import { establishConvexCaller } from '@/lib/convex-caller';
import { serverConvexUrl } from '@/lib/convex-url';
import { redirectCaller, type RedirectCaller } from '@/lib/customer-oidc-routes';
import { CUSTOMER_SIGN_IN } from '@/lib/customer-sign-in';
import { log } from '@/lib/logger';
import {
  MCP_AUTHORISATION_UNAVAILABLE,
  mcpAuthorisationLanding,
  readMcpRedirect,
  type McpAuthorisationResult,
} from '@/surfaces/mcp-oauth-redirect';
import { safeFailureMessage } from '@/surfaces/redact';

/**
 * The redirect an MCP server's authorisation returns to (wave 11, 11-AM).
 *
 * The manager started the authorisation from the card and the authorisation server sends the
 * manager's own browser back here (Q13: Day0 has no inbound endpoint). The route asks the
 * deployment as the browser's signed-in caller, and the deployment completes it only for the card's
 * manager (the wave 11 review's M2, decision 3 (a)): a consent given in another person's browser
 * never lands on the card. A browser with no session (which the proxy lets reach here only where
 * no sign-in is configured) asks with no token, and the deployment refuses it: the rule is the
 * deployment's, in one place. Beside the caller it carries the `state` this deployment signed, bound
 * to one card, expiring in fifteen minutes and single-use because the card holds its nonce, beside
 * the PKCE verifier sealed in the same row. The deployment checks the response's `iss` before the
 * code goes anywhere, then exchanges it. Nothing the authorisation server wrote is echoed: the
 * browser is sent to the card with the outcome and the deployment's own reason. Under the company
 * sign-in the session is refreshed here when its ID token lapsed during the consent, and the
 * refreshed session goes back on the redirect (`redirectCaller`).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const publicUrl = process.env.DAY0_PUBLIC_URL?.trim() || new URL(request.url).origin;
  const response = readMcpRedirect(new URL(request.url).searchParams);
  let result: McpAuthorisationResult | 'invalid' = 'invalid';
  let session: RedirectCaller | undefined;
  if (response !== undefined) {
    try {
      let client: ConvexHttpClient;
      if (CUSTOMER_SIGN_IN) {
        session = await redirectCaller(new NextRequest(request));
        client = new ConvexHttpClient(serverConvexUrl());
        if (session.idToken !== null) client.setAuth(session.idToken);
      } else {
        const caller = await establishConvexCaller();
        client = caller.ok ? caller.client : new ConvexHttpClient(serverConvexUrl());
      }
      result = await client.action(api.mcpOauthActions.completeAuthorisation, response);
    } catch (error) {
      // The deployment could not be asked, or failed before it answered: the manager is sent back
      // to start again rather than shown a server error, and the cause is logged without the query.
      log.error('mcp authorisation completion failed', {
        error: safeFailureMessage(error, response.code ?? '', 'unknown error'),
      });
      result = { ok: false, reason: MCP_AUTHORISATION_UNAVAILABLE };
    }
  }
  const redirect = NextResponse.redirect(mcpAuthorisationLanding(publicUrl, result), {
    status: 307,
    headers: { 'cache-control': 'no-store' },
  });
  await session?.finish(redirect);
  return redirect;
}
