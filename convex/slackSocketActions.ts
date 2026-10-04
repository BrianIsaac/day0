'use node';

import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction } from './_generated/server';
import { decryptCredential } from '../src/surfaces/credentials';
import { safeFailureMessage } from '../src/surfaces/redact';
import { slackApiUrl } from '../src/surfaces/slack-endpoint';

/** How long Slack's `apps.connections.open` may take. */
const OPEN_TIMEOUT_MS = 20_000;

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
      return { url: body.url };
    } catch (error) {
      return {
        error: safeFailureMessage(error, token, 'The Socket Mode connection could not be opened.'),
        missing: false,
      };
    }
  },
});
