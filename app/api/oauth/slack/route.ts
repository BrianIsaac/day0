import { NextResponse } from 'next/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';

/**
 * The redirect a dedicated Slack app's install returns to.
 *
 * This is the second route in the product meant to be reached from off this
 * machine, and like the ElevenLabs webhook it carries no caller identity: the
 * administrator who clicks the install link is not signed in to Day0 and is
 * often not the manager. What it carries instead is the `state` this deployment
 * signed when it registered the app - bound to one surface, expiring in fifteen
 * minutes, and single-use because the surface holds the nonce and the exchange
 * consumes it. A request without a valid state is refused here and never
 * reaches the provider.
 *
 * Nothing is echoed back to the caller: the browser is sent to the dashboard's
 * Surfaces tab, where the card carries the outcome. A failure that this route
 * can name (Slack's own `error` parameter, a state that was never ours) is put
 * on the redirect as a short reason so the card can say what happened without
 * the caller having to read a status code.
 */

const SURFACES_HASH = '#surfaces';

function dashboardUrl(path: string, params: Record<string, string>): URL {
  const base = process.env.DAY0_PUBLIC_URL?.trim() || 'http://localhost:3000';
  const url = new URL(path, base);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.hash = SURFACES_HASH;
  return url;
}

export async function GET(request: Request): Promise<NextResponse> {
  const query = new URL(request.url).searchParams;
  const state = query.get('state') ?? '';
  const declined = query.get('error');

  // Slack sends the administrator back with `error` when they cancel the
  // install or the workspace refuses it. There is no code to exchange, so the
  // state is left unspent and the existing link still works.
  if (declined) {
    return NextResponse.redirect(dashboardUrl('/', { install: 'declined', reason: declined }));
  }

  const code = query.get('code') ?? '';
  if (!state || !code) {
    return NextResponse.redirect(dashboardUrl('/', { install: 'invalid' }));
  }

  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error('NEXT_PUBLIC_CONVEX_URL not set');
  const result = await new ConvexHttpClient(url).action(api.slackProvisionActions.completeInstall, {
    state,
    code,
  });

  if (!result.ok || !result.agentId) {
    return NextResponse.redirect(
      dashboardUrl('/', {
        install: 'failed',
        ...(result.reason ? { reason: result.reason } : {}),
      }),
    );
  }
  return NextResponse.redirect(
    dashboardUrl(`/agent/${result.agentId}`, {
      install: 'installed',
      ...(result.surfaceSlug ? { surface: result.surfaceSlug } : {}),
    }),
  );
}
