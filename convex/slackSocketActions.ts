'use node';

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { assertOwnsAgentAction, getCallerOrThrow } from './ownership';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../src/lib/organisation-key';
import { assertRealMode } from '../src/lib/surface-mode';
import { decryptCredential } from '../src/surfaces/credentials';
import { safeFailureMessage } from '../src/surfaces/redact';
import { slackApiUrl } from '../src/surfaces/slack-endpoint';
import {
  appLevelTokenRefused,
  isAppLevelTokenShape,
  NO_OWN_APP_FOR_TOKEN,
  NOT_AN_APP_LEVEL_TOKEN,
} from '../src/surfaces/slack-socket';
import { KEPT_APP_TAKES_NO_TOKEN } from '../src/surfaces/kept-app';

/** How long Slack's `apps.connections.open` may take. */
const OPEN_TIMEOUT_MS = 20_000;

/**
 * Ask Slack for a Socket Mode URL with an app-level token (`apps.connections.open`, K1): the
 * bridge's connection, and the landing's check that the token works.
 *
 * @throws Error with Slack's refusal or the HTTP status; the caller redacts the token.
 */
async function openSocketUrl(token: string): Promise<string> {
  const response = await fetch(slackApiUrl('apps.connections.open'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
  });
  const payload: unknown = await response.json().catch((): unknown => ({}));
  const body =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  if (!response.ok || body.ok !== true || typeof body.url !== 'string') {
    throw new Error(
      typeof body.error === 'string'
        ? `Slack apps.connections.open failed: ${body.error}`
        : `Slack apps.connections.open returned HTTP ${response.status}.`,
    );
  }
  return body.url;
}

/** What opening one app's connection answers: the URL, or why not. */
type OpenedConnection =
  | { readonly url: string }
  | { readonly error: string; readonly missing: boolean };

/**
 * Internal, the bridge's connection route's: ask Slack for a fresh Socket Mode URL for one app
 * with its app-level token (`apps.connections.open`, K1), so the token itself never leaves the
 * backend and the bridge holds only the short-lived URL. A card that carries no presses answers
 * `missing`; a refusal from Slack answers its reason, the token redacted.
 */
export const openConnection = internalAction({
  args: { surfaceId: v.string() },
  handler: async (ctx, args): Promise<OpenedConnection> => {
    const target = await ctx.runQuery(internal.slackSocket.connectionTarget, args);
    if (target === null) return { error: 'this card carries no presses', missing: true };
    let token = '';
    try {
      token = await decryptCredential(ctx, target.credentialId);
      return { url: await openSocketUrl(token) };
    } catch (error) {
      return {
        error: safeFailureMessage(error, token, 'The Socket Mode connection could not be opened.'),
        missing: false,
      };
    }
  },
});

/**
 * Check a pasted app-level token with Slack, store it held by the organisation (as the employee's
 * own app's other secrets are, so a handover keeps it), and point the app at it. The new row is
 * ended in Day0 when the card refuses it, so no live secret is left with nothing naming it.
 */
async function landToken(
  ctx: ActionCtx,
  target: { readonly surfaceId: Id<'surfaces'>; readonly appId: string; readonly appName: string },
  token: string,
): Promise<void> {
  try {
    await openSocketUrl(token);
  } catch (error) {
    throw new ConvexError(
      appLevelTokenRefused(
        target.appName,
        safeFailureMessage(error, token, 'Slack could not be asked').replace(/\.$/, ''),
      ),
    );
  }
  const credentialId: Id<'credentials'> = await ctx.runAction(internal.credentials.store, {
    userId: ORGANISATION_OWNER_KEY,
    holder: ORGANISATION_HOLDER,
    kind: 'value',
    label: `${target.appName} app-level token`,
    plaintext: token,
    source: 'entered',
    appId: target.appId,
  });
  try {
    await ctx.runMutation(internal.slackSocket.recordAppLevelToken, {
      surfaceId: target.surfaceId,
      appId: target.appId,
      credentialId,
    });
  } catch (error) {
    await ctx.runMutation(internal.credentials.revokeInternal, { credentialId });
    throw error;
  }
}

/**
 * Land the app-level token a person generated for an employee's own Slack app (wave 12, 12-M;
 * RM3 (a); K2: no API issues one), so the app's decision requests carry Approve and Reject buttons
 * over Socket Mode. Public: a caller with no identity is refused first (`getCallerOrThrow`, before
 * the card or the mode is read), then owner-checked (`assertOwnsAgentAction`); real mode only. The
 * token is checked by opening a Socket Mode connection with it before anything is kept; it is
 * never logged and never returned, and any refusal names Slack's reason without it. Writes a
 * credentials row held by the organisation, the card's `provisioning.appLevelTokenCredentialId`,
 * and a `surface.socket-token-landed` event; an earlier token's row is ended in Day0. Refused, with
 * nothing asked of Slack, on a card whose own app IT's revoke ended (W12X-4).
 */
export const landAppLevelToken = action({
  args: { surfaceId: v.id('surfaces'), token: v.string() },
  handler: async (ctx, args): Promise<{ landed: true }> => {
    await getCallerOrThrow(ctx);
    const target = await ctx.runQuery(internal.slackSocket.appLevelTokenTarget, {
      surfaceId: args.surfaceId,
    });
    if (target === null) throw new ConvexError('Surface not found.');
    await assertOwnsAgentAction(ctx, target.agentId);
    assertRealMode('Slack buttons');
    if (target.app === null) throw new ConvexError(NO_OWN_APP_FOR_TOKEN);
    if (target.keptAppEnded) throw new ConvexError(KEPT_APP_TAKES_NO_TOKEN);
    const token = args.token.trim();
    if (!isAppLevelTokenShape(token)) throw new ConvexError(NOT_AN_APP_LEVEL_TOKEN);
    await landToken(ctx, { surfaceId: args.surfaceId, ...target.app }, token);
    return { landed: true };
  },
});
