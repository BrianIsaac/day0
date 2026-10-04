import { SLACK_APP_HOME } from './slack-manifest';

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

/**
 * How Day0 knows an app takes messages: `created` from a manifest that opens the tab; `opened` by
 * Day0's own `apps.manifest.update`; `found-open` when Day0 read the app's manifest and someone had
 * opened it already; `confirmed` on the manager's word, for an app Day0 cannot read.
 */
export const MESSAGES_TAB_OPEN_HOWS = ['created', 'opened', 'found-open', 'confirmed'] as const;

/** One of {@link MESSAGES_TAB_OPEN_HOWS}. */
export type MessagesTabOpenHow = (typeof MESSAGES_TAB_OPEN_HOWS)[number];

/** Slack's App Home setting a person turns on by hand, in the words of the app's settings page. */
export const MESSAGES_TAB_TOGGLE =
  'Allow users to send Slash commands and messages from the messages tab';

/**
 * Whether a manager's typed code can reach the app their decision requests come from:
 * `open` when it takes messages (or the card's app is not one Day0 created, which Day0 cannot
 * read, as before this release); `day0-opens` when Day0 can open its messages tab with the
 * configuration connection that created it, at the card's next check; `needs-toggle` when only a
 * person who manages the app in Slack can.
 */
export type TypedCodeReach =
  | { readonly state: 'open' }
  | { readonly state: 'day0-opens'; readonly appName: string }
  | { readonly state: 'needs-toggle'; readonly appName: string };

/** The fields of a chat card and its app the typed code's reach depends on. */
export interface TypedCodeCard {
  readonly provisioning?: {
    readonly appName: string;
    readonly organisationConnectionId?: unknown;
  };
}

/**
 * Whether a card's typed code reaches its app.
 *
 * @param card - The chat card the decision requests go through.
 * @param known.opened - Whether the app's record says it takes messages (a
 *   `surface.app-messages-open` event for its app).
 * @param known.creatorActive - Whether the configuration connection that created the app is still
 *   active, so Day0 can read and update its manifest.
 */
export function typedCodeReachFor(
  card: TypedCodeCard,
  known: { readonly opened: boolean; readonly creatorActive: boolean },
): TypedCodeReach {
  const app = card.provisioning;
  if (app === undefined || known.opened) return { state: 'open' };
  return known.creatorActive
    ? { state: 'day0-opens', appName: app.appName }
    : { state: 'needs-toggle', appName: app.appName };
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
