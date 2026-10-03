import { safeFailureMessage } from './redact';

/*
 * The words a card's intake skip carries when a poll failed. A card shows Day0's words: the MCP
 * client's own text ("Failed to connect to MCP server surface: Error: Error POSTing to endpoint:
 * {...}", the real-vendor walk, 3 October 2026, R41V-9) is the client's, not the manager's, and is
 * named here by what it means. Any other failure keeps its own redacted, bounded line.
 */

/** How an MCP client or a vendor says the bearer it was shown is no longer a token. */
const TOKEN_REFUSED = /\bHTTP\s+401\b|\binvalid_token\b|\b401\b.*\bunauthori[sz]ed\b/i;

/** How the MCP client words a connection it could not make. */
const MCP_CONNECTION_FAILED = /^Failed to connect to MCP server\b/;

/** The text of a thrown value, whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The words for a card's failed poll: a token the system refused, an MCP server not reached, or
 * the failure's own line with the credential redacted.
 *
 * @param input.system - The system's name as the card shows it (`Linear`).
 * @param input.error - What the poll threw.
 * @param input.credential - The bearer the poll held, which never reaches the words.
 * @param input.fallback - The words when the failure carries none of its own.
 */
export function intakeFailureWords(input: {
  readonly system: string;
  readonly error: unknown;
  readonly credential: string;
  readonly fallback: string;
}): string {
  const message = messageOf(input.error);
  if (TOKEN_REFUSED.test(message)) {
    return (
      `${input.system} refused the token Day0 holds for this card, so nothing was read; the ` +
      "card's next check renews the token or ends the card with the reason."
    );
  }
  if (MCP_CONNECTION_FAILED.test(message)) {
    return (
      `${input.system}'s MCP server could not be reached, so nothing was read; intake tries ` +
      'again at its next poll.'
    );
  }
  return safeFailureMessage(input.error, input.credential, input.fallback);
}
