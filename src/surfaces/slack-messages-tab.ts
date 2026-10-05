import { SLACK_APP_HOME } from './slack-manifest';
import type { MessagesTabOpenHow } from './slack-messages-tab-hows';

/*
 * Whether a manager can send an employee's own Slack app a message (W12V-7, the walk on real
 * Slack, 5 October 2026). The typed code a manager replies to a decision request is a message to
 * the app in its DM; an app whose App Home messages tab is read-only answers that DM with "Sending
 * messages to this app has been turned off." and offers no composer, so nothing Day0 sends may
 * tell the manager to reply with a code until the app takes messages. Apps created from this
 * release's manifest do; an app created before it is opened by Day0 with `apps.manifest.update`
 * when the configuration connection that created it is still active, and otherwise by a person's
 * one toggle in the app's settings.
 */

export { MESSAGES_TAB_OPEN_HOWS, type MessagesTabOpenHow } from './slack-messages-tab-hows';

/** Slack's App Home setting a person turns on by hand, in the words of the app's settings page. */
export const MESSAGES_TAB_TOGGLE =
  'Allow users to send Slash commands and messages from the messages tab';

/**
 * Whether a manager's typed code can reach the app their decision requests come from:
 * `open` when it takes messages (or the card's app is not one Day0 created, which Day0 cannot
 * read, as before this release); `day0-opens` when Day0 can open its messages tab with the
 * configuration connection that created it, at the card's next check; `refused` when Slack refused
 * Day0's opening, which Day0 then tries again only when a person asks (13-FS); `needs-toggle` when
 * only a person who manages the app in Slack can.
 */
export type TypedCodeReach =
  | { readonly state: 'open' }
  | { readonly state: 'day0-opens'; readonly appName: string }
  | { readonly state: 'refused'; readonly appName: string; readonly reason: string }
  | { readonly state: 'needs-toggle'; readonly appName: string };

/** What a card records of its app's messages tab (`surfaces.provisioning.messagesTab`). */
export type MessagesTabState =
  | { readonly state: 'open'; readonly how: MessagesTabOpenHow; readonly at: number }
  | {
      readonly state: 'refused';
      readonly reason: string;
      readonly at: number;
      readonly attempts: number;
    };

/** The fields of a chat card and its app the typed code's reach depends on. */
export interface TypedCodeCard {
  readonly provisioning?: {
    readonly appName: string;
    readonly organisationConnectionId?: unknown;
    readonly messagesTab?: MessagesTabState;
  };
}

/**
 * Whether a card's typed code reaches its app, read from the card's own record of its messages tab
 * (13-FS; W12V-7), which every writer of the opening writes.
 *
 * @param card - The chat card the decision requests go through.
 * @param known.creatorActive - Whether the configuration connection that created the app is still
 *   active, so Day0 can read and update its manifest.
 */
export function typedCodeReachFor(
  card: TypedCodeCard,
  known: { readonly creatorActive: boolean },
): TypedCodeReach {
  const app = card.provisioning;
  if (app === undefined || app.messagesTab?.state === 'open') return { state: 'open' };
  if (!known.creatorActive) return { state: 'needs-toggle', appName: app.appName };
  return app.messagesTab?.state === 'refused'
    ? { state: 'refused', appName: app.appName, reason: app.messagesTab.reason }
    : { state: 'day0-opens', appName: app.appName };
}

/** Whether a manager can reply with a typed code: only while the app takes messages. */
export function typedCodeReaches(reach: TypedCodeReach): boolean {
  return reach.state === 'open';
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Whether a manifest, as `apps.manifest.export` answers it, lets a person send the app messages:
 * its messages tab on and not read-only.
 */
export function manifestTakesMessages(manifest: unknown): boolean {
  const home = record(record(record(manifest).features).app_home);
  return home.messages_tab_enabled === true && home.messages_tab_read_only_enabled === false;
}

/**
 * The manifest an app exports, with its messages tab opened for writing and nothing else changed:
 * the update Day0 sends for an app it created before this release, so its scopes, redirect and
 * settings stay as they are and no reinstall is asked for.
 *
 * @param manifest - The manifest `apps.manifest.export` answered.
 */
export function withMessagesTabOpen(manifest: Record<string, unknown>): Record<string, unknown> {
  const features = record(manifest.features);
  const home = record(features.app_home);
  return {
    ...manifest,
    features: {
      ...features,
      app_home: {
        ...home,
        home_tab_enabled:
          typeof home.home_tab_enabled === 'boolean'
            ? home.home_tab_enabled
            : SLACK_APP_HOME.home_tab_enabled,
        messages_tab_enabled: SLACK_APP_HOME.messages_tab_enabled,
        messages_tab_read_only_enabled: SLACK_APP_HOME.messages_tab_read_only_enabled,
      },
    },
  };
}
