import { NextResponse } from 'next/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';
import { serverConvexUrl } from '@/lib/convex-url';
import { log } from '@/lib/logger';
import { errorMessage } from '@/lib/errors';
import {
  MCP_AUTHORISATION_UNAVAILABLE,
  mcpAuthorisationLanding,
  readMcpRedirect,
  type McpAuthorisationResult,
} from '@/surfaces/mcp-oauth-redirect';

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
  let result: McpAuthorisationResult | 'invalid' = 'invalid';
  if (response !== undefined) {
    try {
      result = await new ConvexHttpClient(serverConvexUrl()).action(
        api.mcpOauthActions.completeAuthorisation,
        response,
      );
    } catch (error) {
      // The deployment could not be asked, or failed before it answered: the manager is sent back
      // to start again rather than shown a server error, and the cause is logged without the query.
      log.error('mcp authorisation completion failed', { error: errorMessage(error) });
      result = { ok: false, reason: MCP_AUTHORISATION_UNAVAILABLE };
    }
  }
  return NextResponse.redirect(mcpAuthorisationLanding(publicUrl, result), {
    status: 307,
    headers: { 'cache-control': 'no-store' },
  });
}
