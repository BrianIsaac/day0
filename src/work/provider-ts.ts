/**
 * Order two provider message timestamps without losing microsecond precision.
 *
 * Slack timestamps are `<seconds>.<fraction>` strings; a float comparison at
 * 1.7e9 seconds rounds the last microsecond, so compare the parts as digits.
 */
export function compareProviderTs(left: string, right: string): number {
  const [leftWhole = '', leftFraction = ''] = left.split('.', 2);
  const [rightWhole = '', rightFraction = ''] = right.split('.', 2);
  const width = Math.max(leftWhole.length, rightWhole.length);
  const wholes = leftWhole.padStart(width, '0').localeCompare(rightWhole.padStart(width, '0'));
  if (wholes !== 0) return wholes;
  const scale = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(scale, '0').localeCompare(rightFraction.padEnd(scale, '0'));
}

/**
 * Read a chat provider's message timestamp as epoch milliseconds.
 *
 * Slack and the Slack-shaped MCP tools give `seconds.fraction`; a generic
 * history tool may give an ISO date. Anything else reads as unknown, so a
 * provider with an unfamiliar clock keeps today's behaviour rather than
 * having its replies dropped.
 *
 * Args:
 *   ts: The provider's message timestamp as received.
 *
 * Returns:
 *   Epoch milliseconds, or null when the string is not a timestamp.
 */
export function providerTsToMs(ts: string): number | null {
  if (/^\d+(\.\d+)?$/.test(ts)) return Number(ts) * 1_000;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? null : parsed;
}
