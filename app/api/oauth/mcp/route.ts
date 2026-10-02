import { NextResponse } from 'next/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';
import { serverConvexUrl } from '@/lib/convex-url';
import { mcpAuthorisationLanding, readMcpRedirect } from '@/surfaces/mcp-oauth-redirect';

/**
 * The redirect an MCP server's authorisation returns to (wave 11, 11-AM).
 *
 * The manager started the authorisation from the card and the authorisation server sends the
 * manager's own browser back here (Q13: Day0 has no inbound endpoint). The route carries no caller
 * identity to the deployment: what it carries is the `state` this deployment signed, bound to one
 * card, expiring in fifteen minutes and single-use because the card holds its nonce, beside the
 * PKCE verifier sealed in the same row. The deployment checks the response's `iss` before the code
 * goes anywhere, then exchanges it. Nothing the authorisation server wrote is echoed: the browser
 * is sent to the card with the outcome and the deployment's own reason.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const publicUrl = process.env.DAY0_PUBLIC_URL?.trim() || new URL(request.url).origin;
  const response = readMcpRedirect(new URL(request.url).searchParams);
  const result =
    response === undefined
      ? 'invalid'
      : await new ConvexHttpClient(serverConvexUrl()).action(
          api.mcpOauthActions.completeAuthorisation,
          response,
        );
  return NextResponse.redirect(mcpAuthorisationLanding(publicUrl, result), {
    status: 307,
    headers: { 'cache-control': 'no-store' },
  });
}
