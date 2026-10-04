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
