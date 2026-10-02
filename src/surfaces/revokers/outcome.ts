/*
 * What one end of access did at the vendor, as the ledger line `credential.revoked-at-source`
 * records it (11-AR; the access plan, section 4.4: "Linear: revoked at Linear, 14:02"; "Slack app
 * deleted, 14:02"; "Zendesk: no revocation endpoint; Day0's copy deleted").
 */

/**
 * The outcomes a ledger line records: the token revoked, the app deleted or uninstalled, nothing
 * left to revoke, an attempt failed with another to follow, the last attempt failed, no call the
 * system offers, a token the app's other employees share, an end that calls no vendor, and a
 * pasted key, which is never sent to one (D5, AC4).
 */
export const SOURCE_REVOCATION_OUTCOMES = [
  'token-revoked',
  'app-deleted',
  'app-uninstalled',
  'already-gone',
  'retrying',
  'failed',
  'not-supported',
  'shared',
  'not-at-vendor',
  'pasted-key',
] as const;

/** One of {@link SOURCE_REVOCATION_OUTCOMES}. */
export type SourceRevocationOutcome = (typeof SOURCE_REVOCATION_OUTCOMES)[number];

/** The systems Day0 names as they name themselves. */
const SYSTEM_NAMES: Readonly<Record<string, string>> = { slack: 'Slack', linear: 'Linear' };

/**
 * A system's name as a sentence gives it: Slack and Linear as they write themselves, an MCP
 * system (`mcp:<host>`) by its host, and any other as it is stored.
 *
 * @param system - `issuedBy.system`, or the card's name for a pasted key.
 */
export function systemDisplayName(system: string): string {
  if (system.startsWith('mcp:')) return system.slice('mcp:'.length);
  return SYSTEM_NAMES[system] ?? system;
}
