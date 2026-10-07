import { isSlackApiEndpoint } from './slack-endpoint';
import type { SurfaceRecord } from './types';

/*
 * What a Slack card may call is split in two (wave 13, 13-S; 13-FS's design 1, option (b), the
 * operator's "recommended decisions" of 6 October). The work's methods are read from the
 * customer's documentation page, as before, and stored as the card's `toolAllowlist`. Day0's own
 * manager channel on an app Day0 created is Day0's, not the work's: its methods are this constant,
 * always allowed on such a card and never stored, so the executor's check of the work reads the
 * page's half alone.
 */

/**
 * The Slack methods Day0's own manager channel calls on an app it created: who the bot is, who the
 * manager is, the manager's DM, Day0's own posts there, and the edit of its own request message.
 */
export const SLACK_CHANNEL_METHODS = [
  'auth.test',
  'users.lookupByEmail',
  'conversations.open',
  'chat.postMessage',
  'chat.update',
] as const;

/** The fields of a stored card the own-app question reads. */
export interface OwnSlackAppCard {
  readonly class: string;
  readonly path?: string;
  readonly endpoint?: string;
  readonly credentialId?: unknown;
  readonly credentialKind?: string;
  readonly provisioning?: { readonly installedAt?: number };
}

/**
 * Whether a card acts as an app Day0 created for its employee: a Slack chat card on the documented
 * API whose app was installed and which holds that install's own token (`oauth`), not a pasted
 * workspace token.
 *
 * @param card - The stored card.
 */
export function holdsOwnSlackApp(card: OwnSlackAppCard): boolean {
  return (
    card.class === 'chat' &&
    card.path === 'documented-api' &&
    isSlackApiEndpoint(card.endpoint) &&
    card.credentialId !== undefined &&
    card.credentialKind === 'oauth' &&
    card.provisioning?.installedAt !== undefined
  );
}

/**
 * The methods Day0's own manager channel may call through a card: the work's, read from the page,
 * and on an app Day0 created its own channel's as well.
 *
 * @param surface - The executor's record of the card.
 */
export function channelAllowlist(
  surface: Pick<SurfaceRecord, 'toolAllowlist' | 'ownSlackApp'>,
): string[] {
  const work = surface.toolAllowlist ?? [];
  if (surface.ownSlackApp !== true) return [...work];
  return [...work, ...SLACK_CHANNEL_METHODS.filter((method) => !work.includes(method))];
}

/**
 * The record Day0's own manager channel sends through: the card with {@link channelAllowlist} as
 * its allowlist, so the gate and the transport admit the channel's methods on an app Day0 created.
 * Never handed to the work's executor, whose check reads the page's half alone.
 *
 * @param surface - The executor's record of the card.
 */
export function withChannelMethods(surface: SurfaceRecord): SurfaceRecord {
  return surface.ownSlackApp === true
    ? { ...surface, toolAllowlist: channelAllowlist(surface) }
    : surface;
}
