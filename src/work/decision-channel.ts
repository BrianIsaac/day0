import { decisionButtonsFor, type ButtonsCard } from '../surfaces/slack-socket';

/** A card as the choice of the manager's decision channel reads it. */
export interface DecisionChannelCard extends ButtonsCard {
  readonly displayName: string;
  readonly waterfallPosition?: number;
  readonly createdAt: number;
}

/**
 * The card an employee's decision requests go through, among the manager channels it can be asked
 * through now: the first in the documented order, then the oldest. The request's claim
 * (`work.prepareDecisionRequest`) and the roster read the same choice.
 *
 * @param channels - The employee's cards that can carry a request now.
 */
export function decisionChannelOf<Card extends DecisionChannelCard>(
  channels: readonly Card[],
): Card | undefined {
  return [...channels].sort(
    (left, right) =>
      (left.waterfallPosition ?? Number.MAX_SAFE_INTEGER) -
        (right.waterfallPosition ?? Number.MAX_SAFE_INTEGER) || left.createdAt - right.createdAt,
  )[0];
}

/** Where an employee's decisions reach the manager: a chat DM, with or without buttons, or here. */
export type DecisionsReach =
  | { readonly kind: 'dashboard' }
  | { readonly kind: 'dm'; readonly channel: string; readonly buttons: boolean };

/**
 * Where an employee's decisions reach the manager (wave 12, 12-M; H D6): the dashboard always,
 * and the DM of its decision channel when it has one, with Approve and Reject buttons where that
 * channel carries them.
 *
 * @param channel - The employee's decision channel, if any ({@link decisionChannelOf}).
 * @param bridgeConfigured - Whether the deployment runs the Socket Mode bridge.
 */
export function decisionsReachOf(
  channel: DecisionChannelCard | undefined,
  bridgeConfigured: boolean,
): DecisionsReach {
  if (channel === undefined) return { kind: 'dashboard' };
  return {
    kind: 'dm',
    channel: channel.displayName,
    buttons: decisionButtonsFor(channel, bridgeConfigured).available,
  };
}
