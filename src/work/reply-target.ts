import type { ReplyTarget } from './types';

/** A Slack mention's external id: `<channel id>:<message ts>`. */
const SLACK_EXTERNAL_ID = /^([CDG][A-Z0-9]+):(\d+\.\d+)$/;
const MENTION_TITLE = /#([^\s#]+)/;

/**
 * The reply target of a work item row, deriving one for rows seeded before it was stored.
 *
 * A Slack mention seeded before `replyTarget` existed still carries the
 * channel and message timestamp in its external id, and the channel name in
 * its title (`Slack mention in #team-asks`), so the reply can be addressed
 * without re-polling the provider.
 *
 * Args:
 *   row: The work item's stored target, category, external id and title.
 *
 * Returns:
 *   The stored target, a derived one for a legacy Slack mention, or undefined.
 */
export function replyTargetFor(row: {
  replyTarget?: ReplyTarget;
  sourceCategory: string;
  externalId: string;
  title: string;
}): ReplyTarget | undefined {
  const match =
    row.sourceCategory === 'event-stream'
      ? SLACK_EXTERNAL_ID.exec(row.externalId)
      : null;
  if (row.replyTarget) {
    return match
      ? { ...row.replyTarget, channel: match[1], threadTs: match[2] }
      : row.replyTarget;
  }
  if (!match) return undefined;
  const channelName = MENTION_TITLE.exec(row.title)?.[1];
  return { channel: match[1], threadTs: match[2], ...(channelName ? { channelName } : {}) };
}

/**
 * The prompt line that tells the planner and the skill where a public reply belongs.
 *
 * Args:
 *   target: The work item's reply target.
 *
 * Returns:
 *   `Reply target: channel C0… (#team-asks), thread_ts 1787…`.
 */
export function replyTargetLine(target: ReplyTarget): string {
  const name = target.channelName ? ` (#${target.channelName})` : '';
  const thread = target.threadTs ? `, thread_ts ${target.threadTs}` : ', top-level post';
  return `Reply target: channel ${target.channel}${name}${thread}`;
}
