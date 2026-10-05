'use node';

import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { internalAction, type ActionCtx } from './_generated/server';
import {
  callSlack,
  provisionDependencies,
  slackErrorOf,
  withConfigurationToken,
  type ProvisionDependencies,
} from './slackProvisionActions';
import { log } from '../src/lib/logger';
import { safeFailureMessage } from '../src/surfaces/redact';
import {
  manifestTakesMessages,
  slackRefusalIsDefinite,
  withMessagesTabOpen,
} from '../src/surfaces/slack-messages-tab';

/*
 * Bringing an app Day0 created before this release over to taking messages (W12V-7). An app Day0
 * created through the organisation's Slack configuration connection is one that connection's
 * service account is a collaborator on, so Day0 reads its manifest with `apps.manifest.export` and,
 * when its messages tab is closed or read-only, opens it with `apps.manifest.update`, changing
 * nothing else (no scope moves, so Slack asks for no reinstall). It runs at the card's probe, the
 * card's Check the connection and the hourly re-probe alike, until the record says the app takes
 * messages; each call is on the connection's ledger. An app created with a configuration token
 * pasted on the card, or by a connection IT has since revoked, is not Day0's to update: the card
 * names the app and the one toggle a person turns on.
 */

/** What opening a card's app came to. */
export type OpenMessagesTabOutcome =
  /** Nothing to do: the app takes messages, is not Day0's, or no active connection created it. */
  | { readonly kind: 'not-needed' }
  /** Day0 read the app's manifest and its messages tab was open already. */
  | { readonly kind: 'found-open' }
  /** Day0 opened the messages tab. */
  | { readonly kind: 'opened' };

/** The manifest `apps.manifest.export` answered, as an object. */
function exportedManifest(reply: Record<string, unknown>): Record<string, unknown> {
  const manifest = reply.manifest;
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Slack apps.manifest.export answered with no manifest.');
  }
  return manifest as Record<string, unknown>;
}

/**
 * Open the messages tab of the card's app when Day0 can and it is not open yet, recording each
 * configuration-token call on the connection's ledger and, once the app takes messages, the card's
 * `open` state and `surface.app-messages-open`. Slack's own refusal of either call is recorded on
 * the card (`refused`, one more attempt), after which only a person's ask (`asked`) tries again; a
 * limit, a fault on Slack's side or a timeout is not, so the next check asks again (13-FS).
 *
 * @param surfaceId - The chat card whose app is brought over.
 * @param options.asked - The manager pressed Check the connection, so a refused opening is tried
 *   again.
 * @throws Error with Slack's refusal (safe to show), after it is on the ledger and the card.
 */
export async function runOpenMessagesTab(
  ctx: ActionCtx,
  surfaceId: Id<'surfaces'>,
  options: { readonly asked: boolean } = { asked: false },
  dependencies: ProvisionDependencies = provisionDependencies,
): Promise<OpenMessagesTabOutcome> {
  const target = await ctx.runQuery(internal.slackMessagesTab.forOpening, {
    surfaceId,
    asked: options.asked,
  });
  if (target === null) return { kind: 'not-needed' };
  const { appId, organisationConnectionId } = target;
  const ledger = async (
    method: 'apps.manifest.export' | 'apps.manifest.update',
    failure: string | undefined,
  ): Promise<void> => {
    await ctx.runMutation(internal.slackProvision.recordConfigurationUse, {
      organisationConnectionId,
      method,
      outcome: failure === undefined ? 'done' : 'failed',
      ...(failure === undefined ? {} : { reason: failure }),
      appId,
      now: dependencies.now(),
    });
  };
  const call = async (
    token: string,
    method: 'apps.manifest.export' | 'apps.manifest.update',
    form: Record<string, string>,
  ): Promise<Record<string, unknown>> => {
    let reply: Record<string, unknown>;
    try {
      reply = await callSlack(dependencies.fetch, method, { token, form });
    } catch (error: unknown) {
      const reason = safeFailureMessage(error, token, `Slack ${method} failed.`);
      // Both writes are made whatever the other does: the ledger keeps every call, and only Slack's
      // own refusal is recorded on the card, so a limit or a fault is asked again next time.
      await Promise.all([
        ledger(method, reason),
        slackRefusalIsDefinite(slackErrorOf(error))
          ? ctx.runMutation(internal.slackMessagesTab.recordRefused, { surfaceId, appId, reason })
          : Promise.resolve(null),
      ]);
      throw error;
    }
    await ledger(method, undefined);
    return reply;
  };
  const how = await withConfigurationToken(
    ctx,
    organisationConnectionId,
    dependencies,
    async (token): Promise<'found-open' | 'opened'> => {
      const manifest = exportedManifest(
        await call(token, 'apps.manifest.export', { app_id: appId }),
      );
      if (manifestTakesMessages(manifest)) return 'found-open';
      const updated = await call(token, 'apps.manifest.update', {
        app_id: appId,
        manifest: JSON.stringify(withMessagesTabOpen(manifest)),
      });
      // The update changes no scope, so Slack should ask for no reinstall; say so if it does.
      if (updated.permissions_updated === true) {
        log.warn('slack app messages tab opened, and Slack says its permissions changed', {
          appId,
        });
      }
      return 'opened';
    },
  );
  await ctx.runMutation(internal.slackMessagesTab.recordOpened, { surfaceId, appId, how });
  return { kind: how };
}

/**
 * Internal: open the messages tab of one card's app now, as a person's Check the connection does
 * (W12V-7), a refused opening included. For an operator's `npx convex run` and the tests; the
 * probe calls `runOpenMessagesTab` itself.
 */
export const openMessagesTab = internalAction({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<OpenMessagesTabOutcome> =>
    await runOpenMessagesTab(ctx, args.surfaceId, { asked: true }),
});
