/**
 * Which of the bot's messages a rehearsal may delete: only those carrying this
 * bed's work-item provenance. The client is in `scripts/lib/slack.ts`.
 */

import type { SlackMessage } from '../../lib/slack';

/** A terminal server provenance trailer attributes a write to this isolated bed. */
export function belongsToWorkItems(text: string, workItemIds: readonly string[]): boolean {
  const match = /(?:^|\n)-- [^\n]+ \(Day0\) · run ([^/\s]+)\/[^/\s]+\s*$/.exec(text);
  return match !== null && workItemIds.includes(match[1]!);
}

/**
 * Only messages with both the bot identity and this bed's work-item provenance
 * may be deleted; timestamps alone do not establish ownership.
 *
 * Args:
 *   messages: A conversation history.
 *   botId: The bot the token belongs to.
 *   startTs: The run start as a Slack timestamp.
 *
 * Returns:
 *   The messages to delete, in the order given.
 */
export function botMessagesSince(
  messages: readonly SlackMessage[],
  botId: string,
  startTs: string,
  workItemIds: readonly string[] = [],
): SlackMessage[] {
  const start = Number.parseFloat(startTs);
  return messages.filter(
    (message: SlackMessage): boolean =>
      message.botId === botId &&
      Number.parseFloat(message.ts) >= start &&
      belongsToWorkItems(message.text, workItemIds),
  );
}
